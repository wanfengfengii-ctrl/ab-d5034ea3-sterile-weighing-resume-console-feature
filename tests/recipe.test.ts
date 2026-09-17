import { describe, expect, it } from 'vitest';
import { MAX_STEPS, parseRecipeText, validateRecipe } from '../src/domain/recipe';

interface StepOverrides {
  id?: unknown;
  barcode?: unknown;
  targetMg?: unknown;
  toleranceMg?: unknown;
  stable?: unknown;
}

function step(over: StepOverrides = {}) {
  return {
    id: 'A',
    barcode: 'BC-A',
    targetMg: 100,
    toleranceMg: 10,
    ...over,
  };
}

describe('配方校验', () => {
  it('接受 1 个步骤的最简配方（对象形式）', () => {
    const { recipe, errors } = validateRecipe({ steps: [step()] });
    expect(errors).toEqual([]);
    expect(recipe?.steps).toHaveLength(1);
  });

  it('接受顶层数组形式', () => {
    const { recipe, errors } = validateRecipe([step()]);
    expect(errors).toEqual([]);
    expect(recipe?.steps).toHaveLength(1);
  });

  it(`接受 ${MAX_STEPS} 个步骤，拒绝 ${MAX_STEPS + 1} 个`, () => {
    const steps = Array.from({ length: MAX_STEPS }, (_, i) => step({ id: `S${i + 1}` }));
    expect(validateRecipe({ steps }).errors).toEqual([]);

    const tooMany = [...steps, step({ id: `S${MAX_STEPS + 1}` })];
    const result = validateRecipe({ steps: tooMany });
    expect(result.recipe).toBeNull();
    expect(result.errors.some((e) => e.stepIndex === null && e.message.includes('1 至 30'))).toBe(
      true,
    );
  });

  it('拒绝 0 个步骤', () => {
    const { recipe, errors } = validateRecipe({ steps: [] });
    expect(recipe).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0].stepIndex).toBeNull();
  });

  it('非数组/非含 steps 对象返回全局错误', () => {
    for (const bad of [null, 42, 'x', {}, { steps: 'no' }]) {
      const { recipe, errors } = validateRecipe(bad);
      expect(recipe).toBeNull();
      expect(errors).toHaveLength(1);
      expect(errors[0].stepIndex).toBeNull();
    }
  });

  it('JSON 解析失败返回单个全局错误', () => {
    const { recipe, errors } = parseRecipeText('{oops');
    expect(recipe).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('JSON 解析失败');
  });

  it('编号须为非空 ASCII 字符串', () => {
    for (const id of ['', '编号', 'ABC\t', 7, null]) {
      const { errors } = validateRecipe({ steps: [step({ id })] });
      expect(errors.some((e) => e.field === 'id')).toBe(true);
    }
  });

  it('编号必须唯一，重复错误报在后出现的位置', () => {
    const { errors } = validateRecipe({
      steps: [step({ id: 'DUP' }), step({ id: 'OK' }), step({ id: 'DUP' })],
    });
    const dup = errors.filter((e) => e.field === 'id');
    expect(dup).toHaveLength(1);
    expect(dup[0].stepIndex).toBe(2);
    expect(dup[0].message).toContain('步骤 3');
    expect(dup[0].message).toContain('步骤 1');
  });

  it('条码须为非空 ASCII 字符串', () => {
    for (const barcode of ['', '条码', 5, undefined]) {
      const { errors } = validateRecipe({ steps: [step({ barcode })] });
      expect(errors.some((e) => e.field === 'barcode')).toBe(true);
    }
  });

  it('目标量须为至少 1 的整数毫克', () => {
    for (const targetMg of [0, -3, 1.5, '100', NaN, Infinity, null]) {
      const { errors } = validateRecipe({ steps: [step({ targetMg })] });
      expect(errors.some((e) => e.field === 'targetMg')).toBe(true);
    }
    expect(validateRecipe({ steps: [step({ targetMg: 1, toleranceMg: 1 })] }).errors).toEqual([]);
  });

  it('容差须为 0 至目标量的整数（含边界）', () => {
    expect(validateRecipe({ steps: [step({ toleranceMg: 0 })] }).errors).toEqual([]);
    // 容差 == 目标量：允许
    expect(validateRecipe({ steps: [step({ toleranceMg: 100 })] }).errors).toEqual([]);
    for (const toleranceMg of [-1, 0.5, 101, '5', null]) {
      const { errors } = validateRecipe({ steps: [step({ toleranceMg })] });
      expect(errors.some((e) => e.field === 'toleranceMg')).toBe(true);
    }
  });

  it('步骤不是对象时报对应位置', () => {
    const { errors } = validateRecipe({ steps: [step(), null, 'x'] });
    expect(errors.map((e) => e.stepIndex)).toEqual([1, 2]);
  });

  it('多项错误一次全部返回，并按步骤输入位置稳定排序', () => {
    const { recipe, errors } = validateRecipe({
      steps: [
        step({ id: 'S1', targetMg: 0, toleranceMg: 0 }), // 位置 0：targetMg（容差 0 未超过目标量 0）
        step({ id: 'S2' }), // 位置 1：无错误
        step({ id: '', targetMg: 0, toleranceMg: 0 }), // 位置 2：id、targetMg（保持检出顺序）
        step({ id: 'S4', barcode: '' }), // 位置 3：barcode
      ],
    });
    expect(recipe).toBeNull();
    expect(errors.map((e) => `${e.stepIndex}:${e.field}`)).toEqual([
      '0:targetMg',
      '2:id',
      '2:targetMg',
      '3:barcode',
    ]);
  });

  it('目标量无效且容差超过该目标量时，两个错误都返回', () => {
    for (const targetMg of [0, -3, 0.5]) {
      const { errors } = validateRecipe({ steps: [step({ targetMg, toleranceMg: 5 })] });
      expect(errors.map((e) => e.field)).toEqual(['targetMg', 'toleranceMg']);
      expect(errors[1].message).toContain('容差不得超过目标量');
    }
  });

  it('目标量非数字或容差未超过目标量时，不多报容差错误', () => {
    // 目标量不是数字，无法比较：仅目标量错误
    expect(
      validateRecipe({ steps: [step({ targetMg: 'abc', toleranceMg: 5 })] }).errors.map(
        (e) => e.field,
      ),
    ).toEqual(['targetMg']);
    // 容差 0 未超过无效目标量 0：仅目标量错误
    expect(
      validateRecipe({ steps: [step({ targetMg: 0, toleranceMg: 0 })] }).errors.map(
        (e) => e.field,
      ),
    ).toEqual(['targetMg']);
  });

  it('全局错误排在步骤错误之前', () => {
    const { errors } = validateRecipe({ steps: [step({ id: '' })] });
    // 构造同时含全局错误与步骤错误的情形：31 步且某步 id 为空
    const many = Array.from({ length: MAX_STEPS + 1 }, (_, i) =>
      step({ id: i === 5 ? '' : `S${i}` }),
    );
    const result = validateRecipe({ steps: many });
    expect(result.errors[0].stepIndex).toBeNull();
    expect(result.errors[1].stepIndex).toBe(5);
    expect(errors[0].stepIndex).toBe(0);
  });

  describe('稳定读数策略', () => {
    const validStable = { samples: 4, maxRangeMg: 5, maxDrift: 1 };

    it('未声明 stable 的旧配方不新增字段', () => {
      const { recipe } = validateRecipe({ steps: [step()] });
      expect(recipe?.steps[0].stable).toBeUndefined();
    });

    it('接受合法稳定策略（含边界 3、9 与零值极差/漂移）', () => {
      for (const samples of [3, 9]) {
        const { recipe, errors } = validateRecipe({
          steps: [step({ stable: { samples, maxRangeMg: 0, maxDrift: 0 } })],
        });
        expect(errors).toEqual([]);
        expect(recipe?.steps[0].stable).toEqual({ samples, maxRangeMg: 0, maxDrift: 0 });
      }
      expect(
        validateRecipe({ steps: [step({ stable: { ...validStable, maxRangeMg: 2 ** 53 - 1 } })] })
          .errors,
      ).toEqual([]);
    });

    it('显式 null 的 stable 视为未声明（旧流程）', () => {
      const { recipe, errors } = validateRecipe({ steps: [step({ stable: null })] });
      expect(errors).toEqual([]);
      expect(recipe?.steps[0].stable).toBeUndefined();
    });

    it('stable 不是对象时报 stable 结构错误', () => {
      for (const stable of ['x', 5, []]) {
        const { errors } = validateRecipe({ steps: [step({ stable })] });
        expect(errors.map((e) => e.field)).toContain('stable');
      }
    });

    it('samples 须为 3 至 9 的整数', () => {
      for (const samples of [2, 10, 0, -1, 4.5, '4', null, undefined, NaN, Infinity]) {
        const { errors } = validateRecipe({
          steps: [step({ stable: { ...validStable, samples } })],
        });
        expect(errors.some((e) => e.field === 'samples'), `samples=${String(samples)}`).toBe(true);
      }
    });

    it('maxRangeMg 与 maxDrift 须为非负安全整数', () => {
      for (const bad of [-1, 0.5, '0', null, undefined, NaN, Infinity, 2 ** 53]) {
        expect(
          validateRecipe({
            steps: [step({ stable: { ...validStable, maxRangeMg: bad } })],
          }).errors.some((e) => e.field === 'maxRangeMg'),
          `maxRangeMg=${String(bad)}`,
        ).toBe(true);
        expect(
          validateRecipe({
            steps: [step({ stable: { ...validStable, maxDrift: bad } })],
          }).errors.some((e) => e.field === 'maxDrift'),
          `maxDrift=${String(bad)}`,
        ).toBe(true);
      }
    });

    it('策略多项非法时错误全部并入该步骤错误清单并保持检出顺序', () => {
      const { errors } = validateRecipe({
        steps: [
          step({ stable: { samples: 2, maxRangeMg: -1, maxDrift: 1.5 } }),
          step({ id: 'B' }),
        ],
      });
      expect(errors.map((e) => `${e.stepIndex}:${e.field}`)).toEqual([
        '0:samples',
        '0:maxRangeMg',
        '0:maxDrift',
      ]);
    });

    it('步骤其他字段非法时稳定策略不被写入该步骤', () => {
      const { recipe, errors } = validateRecipe({
        steps: [step({ id: '', stable: validStable })],
      });
      expect(recipe).toBeNull();
      expect(errors.map((e) => e.field)).toEqual(['id']);
    });
  });
});
