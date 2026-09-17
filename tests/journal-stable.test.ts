import { afterEach, describe, expect, it } from 'vitest';
import {
  applyRecordOnce,
  Journal,
  SimulatedCrashError,
  StableConfirmationRejectedError,
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
import type { Recipe } from '../src/domain/recipe';

const STABLE_RECIPE: Recipe = {
  steps: [
    { id: 'A', barcode: 'BC-A', targetMg: 100, toleranceMg: 10 },
    // N=4，极差≤5，每次采样漂移≤1，候选剂量闭区间 [90,110]
    {
      id: 'B',
      barcode: 'BC-B',
      targetMg: 100,
      toleranceMg: 10,
      stable: { samples: 4, maxRangeMg: 5, maxDrift: 1 },
    },
  ],
};

const LEGACY_RECIPE: Recipe = {
  steps: [{ id: 'A', barcode: 'BC-A', targetMg: 100, toleranceMg: 10 }],
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

async function rawStores() {
  const db = await openDatabase();
  const prepares = await getAllPrepares(db);
  const commits = await getAllCommits(db);
  db.close();
  return { prepares, commits };
}

describe('稳定步骤确认', () => {
  it('通过领域重算确认，预备记录保存读数证据与候选剂量', async () => {
    const j = await open();
    await j.startBatch(STABLE_RECIPE);
    await j.confirmExpected(100); // 步骤 A（旧路径）
    expect(j.currentStep?.id).toBe('B');

    const rec = await j.confirmStable([100, 100, 101, 101]);
    // 候选剂量 (100+101)/2 向下取整 = 100
    expect(rec).toEqual({
      seq: 2,
      stepId: 'B',
      doseMg: 100,
      stableReadings: [100, 100, 101, 101],
    });
    expect(j.isComplete).toBe(true);

    const stores = await rawStores();
    expect(stores.prepares).toEqual([
      { seq: 1, stepId: 'A', doseMg: 100 },
      { seq: 2, stepId: 'B', doseMg: 100, stableReadings: [100, 100, 101, 101] },
    ]);
    expect(stores.commits).toEqual([{ seq: 1 }, { seq: 2 }]);
  });

  it('稳定步骤拒绝旧确认路径；单次步骤拒绝稳定路径', async () => {
    const j = await open();
    await j.startBatch(STABLE_RECIPE);
    // 当前步骤 A 是单次步骤
    await expect(j.confirmStable([100, 100, 100, 100])).rejects.toThrow('未配置稳定读数策略');
    await j.confirmExpected(100);
    // 当前步骤 B 是稳定步骤：旧路径直接拒绝
    await expect(j.confirmExpected(100)).rejects.toThrow('稳定读数窗口');
  });

  it('不足 N 项、极差、趋势、剂量区间按顺序同时反馈，且不写库、步骤与日志不变', async () => {
    const j = await open();
    await j.startBatch(STABLE_RECIPE);
    await j.confirmExpected(100);

    const rejected = async (readings: number[]): Promise<StableConfirmationRejectedError> =>
      j.confirmStable(readings).then(
        () => {
          throw new Error('应当被拒绝');
        },
        (e: unknown) => {
          expect(e).toBeInstanceOf(StableConfirmationRejectedError);
          return e as StableConfirmationRejectedError;
        },
      );

    const e1 = await rejected([100, 100, 100]);
    expect(e1.failures).toEqual(['insufficient']);
    const e2 = await rejected([100, 100, 120, 120]);
    expect(e2.failures).toEqual(['range', 'trend']);
    const e3 = await rejected([70, 70, 90, 90]);
    expect(e3.failures).toEqual(['range', 'trend', 'doseRange']);
    const e4 = await rejected([85, 85, 86, 86]);
    expect(e4.failures).toEqual(['doseRange']);

    // 全部拒绝后：仍在步骤 B，日志仅有步骤 A，无任何预备记录/标记写入
    expect(j.currentStep?.id).toBe('B');
    expect(j.snapshot.applied.map((r) => r.seq)).toEqual([1]);
    const stores = await rawStores();
    expect(stores.prepares).toEqual([{ seq: 1, stepId: 'A', doseMg: 100 }]);
    expect(stores.commits).toEqual([{ seq: 1 }]);
  });

  it('同一窗口并发触发极差与趋势失败时步骤和日志不变（并发拒绝）', async () => {
    const j = await open();
    await j.startBatch(STABLE_RECIPE);
    await j.confirmExpected(100);
    const results = await Promise.allSettled([
      j.confirmStable([100, 100, 120, 120]),
      j.confirmStable([100, 100, 120, 120]),
    ]);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(StableConfirmationRejectedError);
    }
    expect(j.currentStep?.id).toBe('B');
    expect(j.snapshot.applied).toHaveLength(1);
    const stores = await rawStores();
    expect(stores.prepares).toHaveLength(1);
    expect(stores.commits).toHaveLength(1);
  });

  it('篡改候选值无效：剂量始终由读数重算，无法注入', async () => {
    const j = await open();
    await j.startBatch(STABLE_RECIPE);
    await j.confirmExpected(100);
    // 接口不接受剂量参数：读数 [100,100,101,101] 的重算剂量只能是 100（向下取整），
    // 即便操作员意图 101，也无法写入 101。
    const rec = await j.confirmStable([100, 100, 101, 101]);
    expect(rec.doseMg).toBe(100);
  });

  it('非法读数证据（负数、非整数、非数组）被拒绝且不写库', async () => {
    const j = await open();
    await j.startBatch(STABLE_RECIPE);
    await j.confirmExpected(100);
    for (const bad of [[-1, 1, 2, 3], [1.5, 1, 2, 3], ['1', '2', '3', '4']]) {
      await expect(j.confirmStable(bad as unknown as number[])).rejects.toThrow('读数证据非法');
    }
    const stores = await rawStores();
    expect(stores.prepares).toHaveLength(1);
  });

  it('afterPrepare 故障：含读数的预备记录未提交，刷新后丢弃，可重新确认', async () => {
    const j1 = await open();
    await j1.startBatch(STABLE_RECIPE);
    await j1.confirmExpected(100);
    j1.armFault('afterPrepare');
    await expect(j1.confirmStable([100, 100, 100, 100])).rejects.toBeInstanceOf(
      SimulatedCrashError,
    );

    const j2 = await open();
    expect(j2.snapshot.applied.map((r) => r.seq)).toEqual([1]);
    expect(j2.currentStep?.id).toBe('B');
    const stores = await rawStores();
    expect(stores.prepares).toEqual([{ seq: 1, stepId: 'A', doseMg: 100 }]);
    expect(stores.commits).toEqual([{ seq: 1 }]);

    const rec = await j2.confirmStable([100, 100, 100, 100]);
    expect(rec.seq).toBe(2);
    expect(rec.doseMg).toBe(100);
    expect(j2.isComplete).toBe(true);
  });

  it('afterCommit 故障：提交已落盘，刷新后仅重放一次，读数证据与剂量一致', async () => {
    const j1 = await open();
    await j1.startBatch(STABLE_RECIPE);
    await j1.confirmExpected(100);
    j1.armFault('afterCommit');
    await expect(j1.confirmStable([100, 100, 101, 101])).rejects.toBeInstanceOf(
      SimulatedCrashError,
    );

    const j2 = await open();
    const applied = j2.snapshot.applied;
    expect(applied).toHaveLength(2);
    expect(applied[1]).toEqual({
      seq: 2,
      stepId: 'B',
      doseMg: 100,
      stableReadings: [100, 100, 101, 101],
    });
    expect(j2.isComplete).toBe(true);

    // 再开一次：同一已提交记录仍只重放一次
    j2.close();
    openJournals.pop();
    const j3 = await open();
    expect(j3.snapshot.applied).toHaveLength(2);
    expect(j3.isComplete).toBe(true);
  });
});

describe('恢复时的证据一致性', () => {
  it('稳定步骤预备记录缺读数证据：停止重放', async () => {
    const db = await openDatabase();
    await putMeta(db, 'recipe', STABLE_RECIPE);
    await putPrepareRecord(db, { seq: 1, stepId: 'A', doseMg: 100 });
    await putCommitMarker(db, 1);
    // seq 2 是稳定步骤 B 却没有 stableReadings
    await putPrepareRecord(db, { seq: 2, stepId: 'B', doseMg: 100 });
    await putCommitMarker(db, 2);
    db.close();

    const j = await open();
    expect(j.snapshot.applied.map((r) => r.seq)).toEqual([1]);
    expect(j.currentStep?.id).toBe('B');
  });

  it('篡改预备记录剂量（与读数重算值不一致）：停止重放', async () => {
    const db = await openDatabase();
    await putMeta(db, 'recipe', STABLE_RECIPE);
    await putPrepareRecord(db, { seq: 1, stepId: 'A', doseMg: 100 });
    await putCommitMarker(db, 1);
    // 读数重算候选为 100，却写 109
    await putPrepareRecord(db, {
      seq: 2,
      stepId: 'B',
      doseMg: 109,
      stableReadings: [100, 100, 101, 101],
    });
    await putCommitMarker(db, 2);
    db.close();

    const j = await open();
    expect(j.snapshot.applied.map((r) => r.seq)).toEqual([1]);
    expect(j.currentStep?.id).toBe('B');
  });

  it('单次步骤的历史预备记录不带读数证据，恢复正常', async () => {
    const db = await openDatabase();
    await putMeta(db, 'recipe', LEGACY_RECIPE);
    await putPrepareRecord(db, { seq: 1, stepId: 'A', doseMg: 100, stableReadings: [1, 2, 3, 4] });
    await putCommitMarker(db, 1);
    db.close();
    // 单次步骤携带证据：视为篡改，不重放
    const j = await open();
    expect(j.snapshot.applied).toEqual([]);
    expect(j.currentStep?.id).toBe('A');
  });

  it('旧配方（无 stable 字段）历史数据正常重放', async () => {
    const db = await openDatabase();
    await putMeta(db, 'recipe', LEGACY_RECIPE);
    await putPrepareRecord(db, { seq: 1, stepId: 'A', doseMg: 95 });
    await putCommitMarker(db, 1);
    db.close();

    const j = await open();
    expect(j.snapshot.applied).toEqual([{ seq: 1, stepId: 'A', doseMg: 95 }]);
    expect(j.isComplete).toBe(true);
    // 完成后旧路径/稳定路径均不可再确认
    await expect(j.confirmExpected(100)).rejects.toThrow('没有待确认的步骤');
  });
});

describe('applyRecordOnce 兼容读数证据', () => {
  it('证据随记录应用且同序号幂等', () => {
    const rec = { seq: 2, stepId: 'B', doseMg: 100, stableReadings: [100, 100, 101, 101] };
    const s1 = applyRecordOnce([{ seq: 1, stepId: 'A', doseMg: 100 }], rec);
    expect(s1).toHaveLength(2);
    expect(applyRecordOnce(s1, rec)).toBe(s1);
  });
});
