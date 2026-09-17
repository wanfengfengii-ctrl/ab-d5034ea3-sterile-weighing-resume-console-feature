import { describe, expect, it } from 'vitest';
import { acceptableRange, checkWeighingInput } from '../src/domain/weighing';
import type { RecipeStep } from '../src/domain/recipe';

const step: RecipeStep = { id: 'A', barcode: 'BC-A', targetMg: 100, toleranceMg: 10 };

describe('称量输入校验', () => {
  it('条码必须完全一致（大小写、空白均敏感）', () => {
    expect(checkWeighingInput(step, 'BC-A', '100').ok).toBe(true);
    expect(checkWeighingInput(step, 'bc-a', '100').ok).toBe(false);
    expect(checkWeighingInput(step, 'BC-A ', '100').ok).toBe(false);
    expect(checkWeighingInput(step, ' BC-A', '100').ok).toBe(false);
    expect(checkWeighingInput(step, '', '100').ok).toBe(false);
  });

  it('称量值须为整数字符串', () => {
    for (const bad of ['', 'abc', '1.5', '100.0', '-5', '1e3', ' 100', '100 ']) {
      expect(checkWeighingInput(step, 'BC-A', bad).ok).toBe(false);
    }
    expect(checkWeighingInput(step, 'BC-A', '100').ok).toBe(true);
  });

  it('数值落在目标量加减容差的闭区间才可确认', () => {
    expect(acceptableRange(step)).toEqual({ lo: 90, hi: 110 });
    expect(checkWeighingInput(step, 'BC-A', '90').ok).toBe(true);
    expect(checkWeighingInput(step, 'BC-A', '110').ok).toBe(true);
    expect(checkWeighingInput(step, 'BC-A', '89').ok).toBe(false);
    expect(checkWeighingInput(step, 'BC-A', '111').ok).toBe(false);
  });

  it('容差为 0 时仅接受目标量', () => {
    const s: RecipeStep = { ...step, toleranceMg: 0 };
    expect(checkWeighingInput(s, 'BC-A', '100').ok).toBe(true);
    expect(checkWeighingInput(s, 'BC-A', '99').ok).toBe(false);
    expect(checkWeighingInput(s, 'BC-A', '101').ok).toBe(false);
  });

  it('容差等于目标量时下界为 0，0 mg 可接受', () => {
    const s: RecipeStep = { ...step, toleranceMg: 100 };
    expect(acceptableRange(s)).toEqual({ lo: 0, hi: 200 });
    expect(checkWeighingInput(s, 'BC-A', '0').ok).toBe(true);
    expect(checkWeighingInput(s, 'BC-A', '201').ok).toBe(false);
  });

  it('确认成功时返回整数剂量', () => {
    const result = checkWeighingInput(step, 'BC-A', '095');
    expect(result).toEqual({ ok: true, doseMg: 95 });
  });
});
