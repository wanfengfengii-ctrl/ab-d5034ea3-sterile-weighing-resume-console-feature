import { afterEach, describe, expect, it } from 'vitest';
import { applyRecordOnce, Journal, SimulatedCrashError } from '../src/persistence/journal';
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
