import { validateRecipe, type Recipe, type RecipeStep } from '../domain/recipe';
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
    prefix.push(record);
    seq += 1;
  }
  return prefix;
}
