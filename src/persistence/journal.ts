import { validateRecipe, type Recipe, type RecipeStep } from '../domain/recipe';
import {
  evaluateReadings,
  isValidReadingSequence,
  type StableFailureKind,
} from '../domain/stable';
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

/** 界面可见的日志快照；界面状态完全由 applied（已提交前缀）派生。 */
export interface JournalSnapshot {
  recipe: Recipe | null;
  applied: PrepareRecord[];
}

/** 稳定步骤确认未通过领域判定；不会产生任何写入，步骤与日志均不变。 */
export class StableConfirmationRejectedError extends Error {
  readonly failures: StableFailureKind[];
  readonly readings: number[];

  constructor(failures: StableFailureKind[], readings: number[]) {
    super(`稳定读数确认被拒绝：${failures.join('、')}`);
    this.name = 'StableConfirmationRejectedError';
    this.failures = failures;
    this.readings = readings;
  }
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
   * 为当前步骤确认剂量。仅在提交标记写入成功后返回；
   * 若故障钩子触发，抛出 SimulatedCrashError，此后本实例拒绝一切操作。
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
    if (step.stable) {
      // 稳定读数步骤不得走单次称量旧路径：必须由 confirmStable 重新计算。
      throw new Error('当前步骤要求稳定读数确认，请使用稳定读数窗口提交');
    }
    this.inFlight = true;
    try {
      const record: PrepareRecord = {
        seq: this.applied.length + 1,
        stepId: step.id,
        doseMg,
      };
      // 第一次独立写入：预备记录（含步骤与剂量）。
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

  /**
   * 为配置了稳定读数策略的当前步骤确认：候选剂量不由调用方提供，
   * 而由领域层依据 readings 重新计算；不足 N 项或极差、趋势、剂量区间
   * 失败按固定顺序同时反馈，抛出 StableConfirmationRejectedError，
   * 不执行任何写入。直接调用旧路径 confirmExpected 处理稳定步骤同样被拒绝。
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
    if (!step.stable) {
      // 稳定确认路径只能用于配置了策略的步骤；单次步骤仍走旧路径。
      throw new Error('当前步骤未配置稳定读数策略');
    }
    // 证据形式复查：非法读数（含非整数、负数、非数字、非数组）一律拒绝且不写库。
    if (!isValidReadingSequence(readings)) {
      throw new Error('读数证据非法：每项须为非负安全整数毫克');
    }

    const result = evaluateReadings(step, readings);
    if (!result.ok) {
      throw new StableConfirmationRejectedError(result.failures, result.readings);
    }

    this.inFlight = true;
    try {
      const record: PrepareRecord = {
        seq: this.applied.length + 1,
        stepId: step.id,
        // 剂量为领域层重算结果，调用方无法注入。
        doseMg: result.doseMg,
        // 预备记录保存所用读数证据，与候选剂量一致。
        stableReadings: result.readings,
      };
      await putPrepareRecord(this.db, record);
      this.runHook('afterPrepare');
      await putCommitMarker(this.db, record.seq);
      this.runHook('afterCommit');
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
 *  3. 防御：预备记录的步骤须与配方对应位置一致，否则停止重放。
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
    if (expectedStep && record.stepId !== expectedStep.id) {
      break;
    }
    // 证据一致性：稳定步骤的预备记录须保存所用读数，且候选剂量必须
    // 能由该证据原样重算；单次步骤不得携带读数证据。任一不符视为
    // 被篡改的记录，停止重放且不应用。
    if (expectedStep && !recordEvidenceConsistent(expectedStep, record)) {
      break;
    }
    prefix.push(record);
    seq += 1;
  }
  return prefix;
}

/** 恢复时校验预备记录的读数证据与剂量是否与配方步骤一致。 */
function recordEvidenceConsistent(step: RecipeStep, record: PrepareRecord): boolean {
  if (step.stable) {
    if (!isValidReadingSequence(record.stableReadings)) {
      return false;
    }
    const result = evaluateReadings(step, record.stableReadings);
    return result.ok && result.doseMg === record.doseMg;
  }
  return record.stableReadings === undefined;
}
