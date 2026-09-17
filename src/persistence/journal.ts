import { validateRecipe, type Recipe, type RecipeStep } from '../domain/recipe';
import {
  evaluateStability,
  isSafeReading,
  StabilityRejectedError,
} from '../domain/stability';
import {
  deletePrepareRecord,
  getAllCommits,
  getAllPrepares,
  getMeta,
  openDatabase,
  putCommitMarker,
  putMeta,
  putPrepareRecord,
  type PrepareRecord,
} from './db';
import { FaultInjector, SimulatedCrashError, type FaultHookKind } from './faults';

export type { PrepareRecord } from './db';
export { SimulatedCrashError } from './faults';
export type { FaultHookKind } from './faults';
export { StabilityRejectedError } from '../domain/stability';

/** 界面可见的日志快照；界面状态完全由 applied（已提交前缀）派生。 */
export interface JournalSnapshot {
  recipe: Recipe | null;
  applied: PrepareRecord[];
}

/**
 * 将一条预备记录应用到已应用序列；每个序号最多应用一次。
 * 未发生变化时返回原数组，便于调用方做引用比较。
 */
export function applyRecordOnce(
  applied: PrepareRecord[],
  record: PrepareRecord,
): PrepareRecord[] {
  if (applied.some((r) => r.seq === record.seq)) {
    return applied;
  }
  const next = [...applied, record];
  next.sort((a, b) => a.seq - b.seq);
  return next;
}

/**
 * 称量日志（两阶段写入协议）：
 *
 * 确认当前步骤时，以递增序号先独立写入含步骤及剂量的预备记录，
 * 再独立写入提交标记；只有标记写入成功后，记录才进入 applied，
 * 调用方才允许更新界面。
 *
 * 恢复（open）时：删除无提交标记的悬空预备记录，并从序号 1 起
 * 只重放预备记录与提交标记齐全的最长连续前缀。
 */
export class Journal {
  private readonly faults = new FaultInjector();
  private terminatedBy: FaultHookKind | null = null;
  private inFlight = false;

  private constructor(
    private readonly db: IDBDatabase,
    private recipe: Recipe | null,
    private applied: PrepareRecord[],
  ) {}

  static async open(): Promise<Journal> {
    const db = await openDatabase();
    try {
      const recipe = await getMeta<Recipe>(db, 'recipe');
      const applied = await recoverPrefix(db, recipe);
      return new Journal(db, recipe, applied);
    } catch (err) {
      db.close();
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  /** verify 可调用的故障钩子入口；每种钩子每次启动最多触发一次。 */
  armFault(kind: FaultHookKind): void {
    this.faults.arm(kind);
  }

  get snapshot(): JournalSnapshot {
    return { recipe: this.recipe, applied: [...this.applied] };
  }

  get currentStep(): RecipeStep | null {
    if (!this.recipe) return null;
    return this.recipe.steps[this.applied.length] ?? null;
  }

  get isComplete(): boolean {
    return this.recipe !== null && this.applied.length >= this.recipe.steps.length;
  }

  /** 开始批次：配方落盘后不可替换。 */
  async startBatch(recipe: Recipe): Promise<void> {
    this.ensureAlive();
    if (this.recipe !== null) {
      throw new Error('批次已开始，配方不可替换');
    }
    const { errors } = validateRecipe(recipe);
    if (errors.length > 0) {
      throw new Error(`配方无效，批次不得开始：${errors.map((e) => e.message).join('；')}`);
    }
    await putMeta(this.db, 'recipe', recipe);
    this.recipe = recipe;
  }

  /**
   * 为当前步骤确认剂量（旧配方的单次称量路径）。仅当当前步骤**未**声明稳定
   * 读数策略时可用；稳定步骤走此路径一律拒绝且不写库。仅在提交标记写入成功
   * 后返回；故障钩子触发时抛 SimulatedCrashError，此后本实例拒绝一切操作。
   */
  async confirmExpected(doseMg: number): Promise<PrepareRecord> {
    this.ensureAlive();
    if (this.inFlight) {
      throw new Error('已有确认在进行中');
    }
    const step = this.currentStep;
    if (!this.recipe || !step) {
      throw new Error('没有待确认的步骤');
    }
    if (step.stability !== undefined) {
      throw new Error('当前步骤要求稳定读数确认，单次称量路径不可用');
    }
    const record: PrepareRecord = {
      seq: this.applied.length + 1,
      stepId: step.id,
      doseMg,
    };
    return this.commit(record);
  }

  /**
   * 为声明稳定读数策略的当前步骤确认。剂量不由调用方给出，而由领域层依据
   * 读数证据重新计算（篡改候选值无从注入）；readings 可长于 N，仅最后 N 项
   * 参与判定。不足 N 项或极差、趋势、剂量区间任一失败均抛
   * StabilityRejectedError（一次携带全部命中原因）且不写库。无策略的旧步骤
   * 走此路径同样被拒绝。
   */
  async confirmStable(readings: number[]): Promise<PrepareRecord> {
    this.ensureAlive();
    if (this.inFlight) {
      throw new Error('已有确认在进行中');
    }
    const step = this.currentStep;
    if (!this.recipe || !step) {
      throw new Error('没有待确认的步骤');
    }
    const policy = step.stability;
    if (policy === undefined) {
      throw new Error('当前步骤为单次称量步骤，稳定读数确认不可用');
    }
    if (!Array.isArray(readings) || !readings.every((r) => isSafeReading(r))) {
      throw new Error('读数必须全部为非负安全整数毫克');
    }

    // 领域层重算：数量 → 极差 → 趋势 → 候选剂量区间。
    const evaluation = evaluateStability(step, policy, readings);
    if (!evaluation.ok || evaluation.candidateMg === null) {
      throw new StabilityRejectedError(evaluation);
    }

    const record: PrepareRecord = {
      seq: this.applied.length + 1,
      stepId: step.id,
      doseMg: evaluation.candidateMg,
      // 保存所用读数证据（恰为最后 N 项），与剂量严格一致。
      readings: evaluation.window,
    };
    return this.commit(record);
  }

  /** 两阶段写入；返回写入并应用后的记录。 */
  private async commit(record: PrepareRecord): Promise<PrepareRecord> {
    this.inFlight = true;
    try {
      // 第一次独立写入：预备记录（含步骤、剂量及读数证据）。
      await putPrepareRecord(this.db, record);
      this.runHook('afterPrepare');
      // 第二次独立写入：提交标记。
      await putCommitMarker(this.db, record.seq);
      this.runHook('afterCommit');
      // 标记成功后才应用记录（界面由调用方据此更新）。
      this.applied = applyRecordOnce(this.applied, record);
      return record;
    } finally {
      this.inFlight = false;
    }
  }

  private runHook(kind: FaultHookKind): void {
    if (this.faults.consume(kind)) {
      this.terminatedBy = kind;
      throw new SimulatedCrashError(kind);
    }
  }

  private ensureAlive(): void {
    if (this.terminatedBy !== null) {
      throw new SimulatedCrashError(this.terminatedBy);
    }
  }
}

/**
 * 恢复流程：
 *  1. 删除无提交标记的悬空预备记录；
 *  2. 从序号 1 起，只重放预备记录与提交标记齐全的最长连续前缀；
 *  3. 防御：预备记录的步骤须与配方对应位置一致，否则停止重放；
 *  4. 防御：稳定步骤的读数证据须合法（恰 N 项非负安全整数），且由证据重算
 *     的候选剂量与记录剂量一致、四项判定全部通过，否则停止重放。
 */
async function recoverPrefix(db: IDBDatabase, recipe: Recipe | null): Promise<PrepareRecord[]> {
  const prepares = await getAllPrepares(db);
  const committedSeqs = new Set((await getAllCommits(db)).map((m) => m.seq));

  for (const p of prepares) {
    if (!committedSeqs.has(p.seq)) {
      await deletePrepareRecord(db, p.seq);
    }
  }

  const committedBySeq = new Map<number, PrepareRecord>();
  for (const p of prepares) {
    if (committedSeqs.has(p.seq)) {
      committedBySeq.set(p.seq, p);
    }
  }

  const prefix: PrepareRecord[] = [];
  let seq = 1;
  while (committedBySeq.has(seq)) {
    const record = committedBySeq.get(seq)!;
    const expectedStep = recipe?.steps[prefix.length];
    if (expectedStep && !recordMatchesStep(record, expectedStep)) {
      break;
    }
    prefix.push(record);
    seq += 1;
  }
  return prefix;
}

/**
 * 校验一条已提交预备记录与配方对应步骤一致：
 * 步骤编号一致；稳定步骤须带读数证据，证据合法、判定通过且重算剂量等于记录
 * 剂量；单次称量步骤不得携带读数证据。
 */
function recordMatchesStep(record: PrepareRecord, step: RecipeStep): boolean {
  if (record.stepId !== step.id) return false;
  const policy = step.stability;
  if (policy === undefined) {
    return record.readings === undefined;
  }
  const readings = record.readings;
  if (!Array.isArray(readings) || readings.length !== policy.samples) return false;
  if (!readings.every((r) => isSafeReading(r))) return false;
  const evaluation = evaluateStability(step, policy, readings);
  return evaluation.ok && evaluation.candidateMg === record.doseMg;
}
