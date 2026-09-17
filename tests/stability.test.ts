import { describe, expect, it } from 'vitest';
import {
  candidateDose,
  evaluateStability,
  lastN,
  parseReading,
} from '../src/domain/stability';
import type { RecipeStep } from '../src/domain/recipe';

const step: RecipeStep = { id: 'A', barcode: 'BC-A', targetMg: 100, toleranceMg: 5 };
const policy = { samples: 5, maxRangeMg: 4, maxDriftMg: 1 };

describe('读数录入解析', () => {
  it('仅接受非负安全整数', () => {
    for (const ok of ['0', '5', '500', String(Number.MAX_SAFE_INTEGER), '007']) {
      expect(parseReading(ok)).not.toBeNull();
    }
    for (const bad of ['', '-1', '1.5', 'abc', '1e3', ' 1', '1 ', '9007199254740992']) {
      expect(parseReading(bad)).toBeNull();
    }
  });

  it('lastN 仅保留最后 N 项且不改变原数组', () => {
    expect(lastN([1, 2, 3], 5)).toEqual([1, 2, 3]);
    const src = [1, 2, 3, 4, 5, 6, 7];
    expect(lastN(src, 5)).toEqual([3, 4, 5, 6, 7]);
    expect(src).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(lastN([], 3)).toEqual([]);
  });
});

describe('候选剂量（两中位项之和整除 2）', () => {
  it('奇数窗口取正中位项', () => {
    expect(candidateDose([100, 101, 102, 103, 104])).toBe(102n);
  });

  it('偶数窗口为两中位项均值向下取整', () => {
    expect(candidateDose([100, 101, 102, 103])).toBe(101n); // (101+102)/2 = 101
    expect(candidateDose([100, 100, 103, 104])).toBe(101n); // (100+103)/2 = 101 向下取整
  });
});

describe('evaluateStability', () => {
  it('稳定的 5 项读数通过：极差边界 4、斜率边界 1', () => {
    // y = 100..104：极差 4；斜率恰为 1（|lhs| = rhs = 50）；候选 102
    const r = evaluateStability(step, policy, [100, 101, 102, 103, 104]);
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.rangeMg).toBe(4);
    expect(r.candidateMg).toBe(102);
    expect(r.window).toEqual([100, 101, 102, 103, 104]);
  });

  it('常量读数趋势为 0，通过', () => {
    const r = evaluateStability(step, policy, [100, 100, 100, 100, 100]);
    expect(r.ok).toBe(true);
    expect(r.candidateMg).toBe(100);
  });

  it('不足 N 项仅报 count，且无候选/极差', () => {
    const r = evaluateStability(step, policy, [100, 100, 100]);
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(['count']);
    expect(r.candidateMg).toBeNull();
    expect(r.rangeMg).toBeNull();
    expect(r.window).toEqual([100, 100, 100]);
  });

  it('空窗口报 count', () => {
    const r = evaluateStability(step, policy, []);
    expect(r.failures).toEqual(['count']);
  });

  it('极差超过配置值时报 range', () => {
    const r = evaluateStability(step, policy, [100, 100, 100, 100, 105]);
    expect(r.failures).toContain('range');
    expect(r.rangeMg).toBe(5);
    // 趋势仍合格，故不含 trend
    expect(r.failures).not.toContain('trend');
  });

  it('趋势斜率超差时报 trend（斜率 2 > 最大漂移 1）', () => {
    // 100,102,104,106,108：极差 8 同时超 range；斜率 2 超 drift
    const r = evaluateStability(step, policy, [100, 102, 104, 106, 108]);
    expect(r.failures).toContain('range');
    expect(r.failures).toContain('trend');
  });

  it('极差合格但趋势超差：仅报 trend', () => {
    // 104,104,100,100,100：极差 4 合格；OLS 斜率 −1.2（|lhs|=60 > rhs=50）
    const r = evaluateStability(step, policy, [104, 104, 100, 100, 100]);
    expect(r.failures).not.toContain('range');
    expect(r.failures).toContain('trend');
    expect(r.failures).not.toContain('doseRange');
  });

  it('候选剂量超出步骤闭区间时报 doseRange', () => {
    // 全部稳定但中心在 110，超出 [95,105]
    const r = evaluateStability(step, policy, [108, 109, 110, 111, 112]);
    expect(r.failures).toContain('doseRange');
    expect(r.candidateMg).toBe(110);
  });

  it('候选剂量落在闭区间边界可通过', () => {
    // 中心 105（上界），常量
    const r = evaluateStability(step, policy, [105, 105, 105, 105, 105]);
    expect(r.ok).toBe(true);
    expect(r.candidateMg).toBe(105);
  });

  it('多失败同时返回且按 count → range → trend → doseRange 排序', () => {
    // 极差与趋势都超差、候选也越界：[100,102,104,106,108] 中心 104 在区间内，
    // 改用偏移窗口使候选越界：[120,122,124,126,128]
    const r = evaluateStability(step, policy, [120, 122, 124, 126, 128]);
    expect(r.failures).toEqual(['range', 'trend', 'doseRange']);
    expect(r.reasons).toHaveLength(3);
  });

  it('仅采用最后 N 项判定（窗口滑动）', () => {
    // 前面是垃圾值，最后 5 项稳定合格
    const r = evaluateStability(step, policy, [0, 0, 99, 100, 100, 100, 100, 100]);
    expect(r.window).toEqual([100, 100, 100, 100, 100]);
    expect(r.ok).toBe(true);
  });

  it('偶数 N=4 时趋势分母与向下取整候选正确', () => {
    const p4 = { samples: 4, maxRangeMg: 3, maxDriftMg: 1 };
    // 100..103：斜率 1（|lhs|=rhs=20，边界合格），极差 3，候选 (101+102)/2=101
    const r = evaluateStability(step, p4, [100, 101, 102, 103]);
    expect(r.ok).toBe(true);
    expect(r.candidateMg).toBe(101);
  });

  it('BigInt 乘加：极大读数不溢出且判定正确', () => {
    const big = Number.MAX_SAFE_INTEGER;
    const p = { samples: 3, maxRangeMg: 0, maxDriftMg: 0 };
    const r = evaluateStability(step, p, [big, big, big]);
    // 常量：趋势 0 合格、极差 0 合格，但候选越界（目标 100±5）
    expect(r.failures).toEqual(['doseRange']);
    expect(r.candidateMg).toBe(big);
  });

  it('N=3 与 N=9 均可判定', () => {
    const p3 = { samples: 3, maxRangeMg: 2, maxDriftMg: 1 };
    expect(evaluateStability(step, p3, [100, 100, 100]).ok).toBe(true);
    const p9 = { samples: 9, maxRangeMg: 8, maxDriftMg: 1 };
    expect(
      evaluateStability(step, p9, [100, 101, 102, 103, 104, 105, 106, 107, 108]).ok,
    ).toBe(true);
  });
});
