import { describe, expect, it } from 'vitest';
import {
  computeStableStats,
  describeStableFailure,
  evaluateReadings,
  isValidReadingSequence,
  medianCandidate,
  parseReadingInput,
  trendWithinDrift,
  type StableFailure,
} from '../src/domain/stable';
import type { RecipeStep } from '../src/domain/recipe';

/** N=4，极差≤5，每次采样漂移≤1；候选剂量闭区间 [90,110]。 */
const STABLE_STEP: RecipeStep = {
  id: 'B',
  barcode: 'BC-B',
  targetMg: 100,
  toleranceMg: 10,
  stable: { samples: 4, maxRangeMg: 5, maxDrift: 1 },
};

const STABLE_STEP_3: RecipeStep = {
  ...STABLE_STEP,
  stable: { samples: 3, maxRangeMg: 5, maxDrift: 1 },
};

describe('读数录入解析', () => {
  it('仅接受非负安全整数毫克，非法读数不进入窗口', () => {
    for (const ok of ['0', '007', '9007199254740991']) {
      const r = parseReadingInput(ok);
      expect(r.ok).toBe(true);
    }
    for (const bad of ['', '-1', '1.5', '1e3', 'abc', ' 1', '1 ', '9007199254740992']) {
      expect(parseReadingInput(bad).ok).toBe(false);
    }
  });

  it('isValidReadingSequence 复查证据', () => {
    expect(isValidReadingSequence([0, 1, 9007199254740991])).toBe(true);
    for (const bad of [[-1], [1.5], ['1'], null, {}, [NaN], [Infinity]]) {
      expect(isValidReadingSequence(bad)).toBe(false);
    }
  });
});

describe('候选剂量（中位项）', () => {
  it('奇数窗口取正中位项（入参须已排序）', () => {
    expect(medianCandidate([100, 101, 102])).toBe(101);
  });

  it('偶数窗口取两中位项之和整除 2（向下取整）', () => {
    expect(medianCandidate([100, 101, 102, 103])).toBe(101); // (101+102)/2 = 101.5 → 101
    expect(medianCandidate([0, 0, 1, 1])).toBe(0);
    expect(medianCandidate([1, 2, 3, 4])).toBe(2); // (2+3)/2 = 2.5 → 2
  });
});

describe('趋势判定（BigInt 乘加）', () => {
  it('恒定序列在零漂移下通过', () => {
    expect(trendWithinDrift([100, 100, 100, 100], 0)).toBe(true);
  });

  it('线性序列斜率绝对值等于最大漂移时通过（闭区间）', () => {
    expect(trendWithinDrift([0, 1, 2, 3], 1)).toBe(true);
    expect(trendWithinDrift([3, 2, 1, 0], 1)).toBe(true);
    expect(trendWithinDrift([0, 1, 2, 3], 0)).toBe(false);
  });

  it('接近安全整数上界的读数仍精确判定（普通 number 乘加会溢出）', () => {
    const M = Number.MAX_SAFE_INTEGER;
    expect(trendWithinDrift([M, M, M], 0)).toBe(true);
    // y = [M, M, M-9]，最小二乘斜率为 -4.5：漂移 4 不通过、5 通过。
    expect(trendWithinDrift([M, M, M - 9], 4)).toBe(false);
    expect(trendWithinDrift([M, M, M - 9], 5)).toBe(true);
  });
});

describe('evaluateReadings 稳定判定', () => {
  it('不足 N 项仅报 insufficient', () => {
    const r = evaluateReadings(STABLE_STEP, [100, 100, 101]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failures).toEqual(['insufficient']);
      expect(r.rangeMg).toBeNull();
      expect(r.trendOk).toBeNull();
      expect(r.candidateMg).toBeNull();
    }
  });

  it('极差失败', () => {
    // [100,106,106,100]：极差 6 > 5，但最佳拟合斜率为 0。
    const r = evaluateReadings(STABLE_STEP, [100, 106, 106, 100]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failures).toEqual(['range']);
      expect(r.rangeMg).toBe(6);
      expect(r.trendOk).toBe(true);
      expect(r.candidateMg).toBe(103);
    }
  });

  it('趋势失败（极差合格）', () => {
    // [100,100,100,105]：极差 5 合格，斜率 0.9/采样…超漂移 1 的判定边界
    const r = evaluateReadings(STABLE_STEP, [100, 100, 100, 105]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures).toEqual(['trend']);
  });

  it('候选剂量超出闭区间', () => {
    const r = evaluateReadings(STABLE_STEP, [85, 85, 86, 86]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failures).toEqual(['doseRange']);
      expect(r.candidateMg).toBe(85);
    }
  });

  it('同一窗口极差与趋势同时失败时按顺序同时反馈', () => {
    const r = evaluateReadings(STABLE_STEP, [100, 100, 120, 120]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures).toEqual(['range', 'trend']);
  });

  it('极差、趋势、剂量区间三项同时失败', () => {
    const r = evaluateReadings(STABLE_STEP, [70, 70, 90, 90]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures).toEqual(['range', 'trend', 'doseRange']);
  });

  it('全部通过：返回重算剂量（偶数窗口向下取整）与统计', () => {
    // [100,100,101,101]：极差 1，斜率 0.4，候选 (100+101)/2 → 201/2 向下取整 → 100
    const r = evaluateReadings(STABLE_STEP, [100, 100, 101, 101]);
    expect(r).toMatchObject({
      ok: true,
      doseMg: 100,
      rangeMg: 1,
      trendOk: true,
    });
  });

  it('奇数窗口取正中位项', () => {
    const r = evaluateReadings(STABLE_STEP_3, [100, 101, 102]);
    expect(r).toMatchObject({ ok: true, doseMg: 101, rangeMg: 2 });
  });

  it('闭区间边界候选剂量可接受', () => {
    expect(evaluateReadings(STABLE_STEP, [90, 90, 90, 90]).ok).toBe(true);
    expect(evaluateReadings(STABLE_STEP, [110, 110, 110, 110]).ok).toBe(true);
  });

  it('未配置策略的步骤不可评估；非法证据直接抛错', () => {
    const single: RecipeStep = { id: 'A', barcode: 'BC-A', targetMg: 100, toleranceMg: 10 };
    expect(() => evaluateReadings(single, [1, 2, 3, 4])).toThrow('未配置稳定读数策略');
    expect(() => evaluateReadings(STABLE_STEP, [-1, 1, 2, 3] as unknown as number[])).toThrow(
      '读数证据非法',
    );
  });

  it('失败文案包含实际值与配置值', () => {
    const r = evaluateReadings(STABLE_STEP, [70, 70, 90, 90]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const messages = r.failures.map((k) => describeStableFailure(k, STABLE_STEP, r as StableFailure));
      expect(messages[0]).toContain('极差 20');
      expect(messages[0]).toContain('5 mg');
      expect(messages[2]).toContain('候选剂量 80');
      expect(messages[2]).toContain('[90, 110]');
    }
  });
});

describe('computeStableStats', () => {
  it('按录入顺序计算趋势、按排序计算极差与候选', () => {
    const stats = computeStableStats([101, 100, 101, 100], STABLE_STEP.stable!);
    expect(stats.rangeMg).toBe(1);
    expect(stats.trendOk).toBe(true);
    expect(stats.candidateMg).toBe(100);
  });
});
