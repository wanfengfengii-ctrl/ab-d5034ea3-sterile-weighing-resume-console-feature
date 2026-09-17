import { afterEach, describe, expect, it } from 'vitest';
import {
  applyRecordOnce,
  Journal,
  SimulatedCrashError,
  StabilityRejectedError,
} from '../src/persistence/journal';
import {
  deleteDatabase,
  getAllCommits,
  getAllPrepares,
  openDatabase,
  putCommitMarker,
  putMeta,
  putPrepareRecord,
} from '../src/persistence/db';
import { FaultInjector } from '../src/persistence/faults';
import type { Recipe } from '../src/domain/recipe';

const RECIPE: Recipe = {
  steps: [
    { id: 'A', barcode: 'BC-A', targetMg: 100, toleranceMg: 10 },
    { id: 'B', barcode: 'BC-B', targetMg: 50, toleranceMg: 0 },
  ],
};

// 步骤 A 为稳定读数步骤：N=5，极差 ≤4，漂移 ≤1；步骤 B 为旧单次称量。
const STABLE_RECIPE: Recipe = {
  steps: [
    {
      id: 'A',
      barcode: 'BC-A',
      targetMg: 100,
      toleranceMg: 5,
      stability: { samples: 5, maxRangeMg: 4, maxDriftMg: 1 },
    },
    { id: 'B', barcode: 'BC-B', targetMg: 50, toleranceMg: 0 },
  ],
};

let openJournals: Journal[] = [];

async function open(): Promise<Journal> {
  const j = await Journal.open();
  openJournals.push(j);
  return j;
}

afterEach(async () => {
  for (const j of openJournals) j.close();
  openJournals = [];
  await deleteDatabase();
});

describe('故障钩子', () => {
  it('每次启动每种钩子最多触发一次', () => {
    const f = new FaultInjector();
    expect(f.consume('afterPrepare')).toBe(false);
    f.arm('afterPrepare');
    expect(f.consume('afterPrepare')).toBe(true);
    // 同一次启动内：已触发后不再触发，重新武装也无效
    expect(f.consume('afterPrepare')).toBe(false);
    f.arm('afterPrepare');
    expect(f.consume('afterPrepare')).toBe(false);
    // 另一种钩子互不影响
    f.arm('afterCommit');
    expect(f.consume('afterCommit')).toBe(true);
  });
});

describe('批次与配方', () => {
  it('配方随批次开始落盘，之后不可替换（含跨启动）', async () => {
    const j1 = await open();
    expect(j1.snapshot.recipe).toBeNull();
    await j1.startBatch(RECIPE);
    await expect(j1.startBatch(RECIPE)).rejects.toThrow('不可替换');

    const j2 = await open();
    expect(j2.snapshot.recipe).toEqual(RECIPE);
    await expect(
      j2.startBatch({ steps: [{ id: 'X', barcode: 'BC-X', targetMg: 1, toleranceMg: 0 }] }),
    ).rejects.toThrow('不可替换');
  });

  it('无效配方不得开始批次', async () => {
    const j = await open();
    await expect(j.startBatch({ steps: [] })).rejects.toThrow('配方无效');
    expect(j.snapshot.recipe).toBeNull();
  });
});

describe('两阶段写入与恢复', () => {
  it('确认后预备记录与提交标记均落盘，重开后状态一致', async () => {
    const j1 = await open();
    await j1.startBatch(RECIPE);
    const rec = await j1.confirmExpected(100);
    expect(rec).toEqual({ seq: 1, stepId: 'A', doseMg: 100 });
    expect(j1.currentStep?.id).toBe('B');

    const db = await openDatabase();
    try {
      expect(await getAllPrepares(db)).toEqual([{ seq: 1, stepId: 'A', doseMg: 100 }]);
      expect(await getAllCommits(db)).toEqual([{ seq: 1 }]);
    } finally {
      db.close();
    }

    const j2 = await open();
    expect(j2.snapshot.applied).toEqual([{ seq: 1, stepId: 'A', doseMg: 100 }]);
    expect(j2.currentStep?.id).toBe('B');

    await j2.confirmExpected(50);
    expect(j2.isComplete).toBe(true);
    await expect(j2.confirmExpected(50)).rejects.toThrow('没有待确认的步骤');
  });

  it('afterPrepare 崩溃：预备记录无标记，恢复时删除且不应用，序号可复用', async () => {
    const j1 = await open();
    await j1.startBatch(RECIPE);
    j1.armFault('afterPrepare');
    await expect(j1.confirmExpected(100)).rejects.toBeInstanceOf(SimulatedCrashError);
    // 终止后拒绝后续一切操作
    await expect(j1.confirmExpected(100)).rejects.toBeInstanceOf(SimulatedCrashError);

    const j2 = await open();
    expect(j2.snapshot.applied).toEqual([]);
    expect(j2.currentStep?.id).toBe('A');

    const db = await openDatabase();
    try {
      expect(await getAllPrepares(db)).toEqual([]); // 悬空预备记录已删除
      expect(await getAllCommits(db)).toEqual([]);
    } finally {
      db.close();
    }

    // 恢复后可继续确认，序号从 1 复用
    const rec = await j2.confirmExpected(100);
    expect(rec.seq).toBe(1);
    expect(j2.currentStep?.id).toBe('B');
  });

  it('afterCommit 崩溃：标记已落盘但界面未更新，恢复时重放该记录', async () => {
    const j1 = await open();
    await j1.startBatch(RECIPE);
    j1.armFault('afterCommit');
    await expect(j1.confirmExpected(105)).rejects.toBeInstanceOf(SimulatedCrashError);
    // 崩溃发生在标记成功之后、应用记录之前：本实例快照仍为空
    expect(j1.snapshot.applied).toEqual([]);

    const j2 = await open();
    expect(j2.snapshot.applied).toEqual([{ seq: 1, stepId: 'A', doseMg: 105 }]);
    expect(j2.currentStep?.id).toBe('B');

    const rec = await j2.confirmExpected(50);
    expect(rec.seq).toBe(2);
    expect(j2.isComplete).toBe(true);
  });

  it('只重放预备记录与标记齐全的最长连续前缀', async () => {
    const db = await openDatabase();
    await putMeta(db, 'recipe', RECIPE);
    await putPrepareRecord(db, { seq: 1, stepId: 'A', doseMg: 100 });
    await putCommitMarker(db, 1);
    await putPrepareRecord(db, { seq: 2, stepId: 'B', doseMg: 50 }); // 悬空：无标记
    await putPrepareRecord(db, { seq: 3, stepId: 'B', doseMg: 51 });
    await putCommitMarker(db, 3); // 序号 3 齐全，但前缀在 2 处断裂
    db.close();

    const j = await open();
    expect(j.snapshot.applied).toEqual([{ seq: 1, stepId: 'A', doseMg: 100 }]);
    expect(j.currentStep?.id).toBe('B');

    const db2 = await openDatabase();
    try {
      const seqs = (await getAllPrepares(db2)).map((p) => p.seq);
      expect(seqs).toEqual([1, 3]); // 悬空的 2 已删除；3 保留但不在前缀内
    } finally {
      db2.close();
    }
  });

  it('预备记录与配方步骤不一致时停止重放', async () => {
    const db = await openDatabase();
    await putMeta(db, 'recipe', RECIPE);
    await putPrepareRecord(db, { seq: 1, stepId: 'X', doseMg: 1 });
    await putCommitMarker(db, 1);
    db.close();

    const j = await open();
    expect(j.snapshot.applied).toEqual([]);
    expect(j.currentStep?.id).toBe('A');
  });

  it('崩溃钩子每次启动仅触发一次：重开后需重新武装', async () => {
    const j1 = await open();
    await j1.startBatch(RECIPE);
    j1.armFault('afterCommit');
    await expect(j1.confirmExpected(100)).rejects.toBeInstanceOf(SimulatedCrashError);

    // 新的启动：钩子未武装，确认正常完成
    const j2 = await open();
    const rec = await j2.confirmExpected(50);
    expect(rec.seq).toBe(2);
    expect(j2.isComplete).toBe(true);
  });
});

describe('applyRecordOnce', () => {
  it('每个序号最多应用一次', () => {
    const rec = { seq: 1, stepId: 'A', doseMg: 100 };
    const s1 = applyRecordOnce([], rec);
    const s2 = applyRecordOnce(s1, rec);
    expect(s2).toBe(s1); // 重复序号：原样返回
    const s3 = applyRecordOnce(s2, { seq: 2, stepId: 'B', doseMg: 50 });
    expect(s3.map((r) => r.seq)).toEqual([1, 2]);
    const s4 = applyRecordOnce(s3, { seq: 2, stepId: 'B', doseMg: 50 });
    expect(s4).toBe(s3);
  });
});

describe('稳定读数确认', () => {
  it('稳定窗口确认：领域层重算剂量，预备记录保存读数证据', async () => {
    const j = await open();
    await j.startBatch(STABLE_RECIPE);
    const rec = await j.confirmStable([100, 101, 102, 103, 104]);
    expect(rec).toEqual({
      seq: 1,
      stepId: 'A',
      doseMg: 102,
      readings: [100, 101, 102, 103, 104],
    });
    expect(j.currentStep?.id).toBe('B');

    const db = await openDatabase();
    try {
      expect(await getAllPrepares(db)).toEqual([
        { seq: 1, stepId: 'A', doseMg: 102, readings: [100, 101, 102, 103, 104] },
      ]);
      expect(await getAllCommits(db)).toEqual([{ seq: 1 }]);
    } finally {
      db.close();
    }

    // 后续旧步骤走单次称量路径
    const rec2 = await j.confirmExpected(50);
    expect(rec2).toEqual({ seq: 2, stepId: 'B', doseMg: 50 });
    expect(j.isComplete).toBe(true);
  });

  it('稳定步骤只采用最后 N 项，前置多余读数不影响结果', async () => {
    const j = await open();
    await j.startBatch(STABLE_RECIPE);
    const rec = await j.confirmStable([0, 999, 100, 100, 100, 100, 100]);
    expect(rec.doseMg).toBe(100);
    expect(rec.readings).toEqual([100, 100, 100, 100, 100]);
  });

  it('稳定步骤禁止走旧单次称量路径，且不写库', async () => {
    const j = await open();
    await j.startBatch(STABLE_RECIPE);
    await expect(j.confirmExpected(100)).rejects.toThrow('稳定读数确认');
    expect(j.snapshot.applied).toEqual([]);
    const db = await openDatabase();
    try {
      expect(await getAllPrepares(db)).toEqual([]);
      expect(await getAllCommits(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('旧单次称量步骤禁止走稳定确认路径', async () => {
    const j = await open();
    await j.startBatch(RECIPE);
    await expect(j.confirmStable([100, 100, 100, 100, 100])).rejects.toThrow('单次称量');
  });

  it('不足 N 项 / 极差 / 趋势 / 剂量区间失败按顺序同时反馈，且不写库', async () => {
    const j = await open();
    await j.startBatch(STABLE_RECIPE);

    // 不足 N 项
    let err: unknown;
    try {
      await j.confirmStable([100, 100, 100]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StabilityRejectedError);
    expect((err as StabilityRejectedError).failures).toEqual(['count']);

    // 极差与趋势同时超差且候选越界：顺序 range → trend → doseRange
    try {
      await j.confirmStable([120, 122, 124, 126, 128]);
    } catch (e) {
      err = e;
    }
    expect((err as StabilityRejectedError).failures).toEqual(['range', 'trend', 'doseRange']);

    // 仅极差超差
    try {
      await j.confirmStable([100, 100, 100, 100, 105]);
    } catch (e) {
      err = e;
    }
    expect((err as StabilityRejectedError).failures).toEqual(['range']);

    // 全部失败期间步骤与日志不变、无任何写入
    expect(j.snapshot.applied).toEqual([]);
    expect(j.currentStep?.id).toBe('A');
    const db = await openDatabase();
    try {
      expect(await getAllPrepares(db)).toEqual([]);
      expect(await getAllCommits(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('非法读数数组被拒绝且不写库', async () => {
    const j = await open();
    await j.startBatch(STABLE_RECIPE);
    await expect(j.confirmStable([100, -1, 100, 100, 100])).rejects.toThrow('非负安全整数');
    await expect(
      j.confirmStable([100, 1.5, 100, 100, 100] as unknown as number[]),
    ).rejects.toThrow('非负安全整数');
    expect(j.snapshot.applied).toEqual([]);
  });

  it('稳定确认的 afterPrepare 崩溃：悬空记录（含证据）被删除，可重新确认', async () => {
    const j1 = await open();
    await j1.startBatch(STABLE_RECIPE);
    j1.armFault('afterPrepare');
    await expect(j1.confirmStable([100, 101, 102, 103, 104])).rejects.toBeInstanceOf(
      SimulatedCrashError,
    );

    const j2 = await open();
    expect(j2.snapshot.applied).toEqual([]);
    expect(j2.currentStep?.id).toBe('A');
    const db = await openDatabase();
    try {
      expect(await getAllPrepares(db)).toEqual([]);
      expect(await getAllCommits(db)).toEqual([]);
    } finally {
      db.close();
    }

    const rec = await j2.confirmStable([100, 100, 100, 100, 100]);
    expect(rec).toEqual({
      seq: 1,
      stepId: 'A',
      doseMg: 100,
      readings: [100, 100, 100, 100, 100],
    });
  });

  it('稳定确认的 afterCommit 崩溃：已提交记录仅重放一次，读数证据与剂量一致', async () => {
    const j1 = await open();
    await j1.startBatch(STABLE_RECIPE);
    j1.armFault('afterCommit');
    await expect(j1.confirmStable([100, 101, 102, 103, 104])).rejects.toBeInstanceOf(
      SimulatedCrashError,
    );

    const j2 = await open();
    expect(j2.snapshot.applied).toEqual([
      { seq: 1, stepId: 'A', doseMg: 102, readings: [100, 101, 102, 103, 104] },
    ]);
    expect(j2.currentStep?.id).toBe('B');

    // 再开一次：同一已提交记录不得被重复应用
    const j3 = await open();
    openJournals.push(j3);
    expect(j3.snapshot.applied).toHaveLength(1);
  });

  it('恢复时篡改已提交记录的候选剂量：证据与剂量不一致则停止重放', async () => {
    const db = await openDatabase();
    await putMeta(db, 'recipe', STABLE_RECIPE);
    // readings 重算候选为 102，但记录剂量被改为 999
    await putPrepareRecord(db, {
      seq: 1,
      stepId: 'A',
      doseMg: 999,
      readings: [100, 101, 102, 103, 104],
    });
    await putCommitMarker(db, 1);
    db.close();

    const j = await open();
    expect(j.snapshot.applied).toEqual([]);
    expect(j.currentStep?.id).toBe('A');
  });

  it('恢复时读数证据缺失、数量不符或判定失败：停止重放', async () => {
    async function seed(record: Record<string, unknown>) {
      const db = await openDatabase();
      await putMeta(db, 'recipe', STABLE_RECIPE);
      await putPrepareRecord(db, record as never);
      await putCommitMarker(db, 1);
      db.close();
    }

    await seed({ seq: 1, stepId: 'A', doseMg: 102 }); // 缺 readings
    let j = await open();
    expect(j.snapshot.applied).toEqual([]);
    j.close();
    await deleteDatabase();

    await seed({ seq: 1, stepId: 'A', doseMg: 100, readings: [100, 100, 100] }); // 仅 3 项
    j = await open();
    expect(j.snapshot.applied).toEqual([]);
    j.close();
    await deleteDatabase();

    // 证据本身极差超差：判定不通过
    await seed({ seq: 1, stepId: 'A', doseMg: 100, readings: [100, 100, 100, 100, 105] });
    j = await open();
    expect(j.snapshot.applied).toEqual([]);
    j.close();
    await deleteDatabase();

    // 单次称量步骤记录携带 readings：不一致
    const db = await openDatabase();
    await putMeta(db, 'recipe', RECIPE);
    await putPrepareRecord(db, { seq: 1, stepId: 'A', doseMg: 100, readings: [100] });
    await putCommitMarker(db, 1);
    db.close();
    j = await open();
    expect(j.snapshot.applied).toEqual([]);
  });
});
