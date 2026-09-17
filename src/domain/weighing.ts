import type { RecipeStep } from './recipe';

/**
 * 称量输入校验：界面仅接受当前步骤的条码和整数称量值。
 * 条码完全一致，且数值落在 [目标量 - 容差, 目标量 + 容差] 闭区间，才可确认。
 */

export type WeighingCheck =
  | { ok: true; doseMg: number }
  | { ok: false; reason: string };

const INTEGER_PATTERN = /^\d+$/;

export function acceptableRange(step: RecipeStep): { lo: number; hi: number } {
  return { lo: step.targetMg - step.toleranceMg, hi: step.targetMg + step.toleranceMg };
}

export function checkWeighingInput(
  step: RecipeStep,
  barcodeInput: string,
  doseInput: string,
): WeighingCheck {
  if (barcodeInput !== step.barcode) {
    return { ok: false, reason: '条码与当前原料不一致，请扫描当前步骤的原料条码' };
  }
  if (!INTEGER_PATTERN.test(doseInput)) {
    return { ok: false, reason: '称量值须为非负整数毫克' };
  }
  const dose = Number(doseInput);
  if (!Number.isSafeInteger(dose)) {
    return { ok: false, reason: '称量值超出可表示的整数范围' };
  }
  const { lo, hi } = acceptableRange(step);
  if (dose < lo || dose > hi) {
    return { ok: false, reason: `称量值 ${dose} mg 超出可接受区间 [${lo}, ${hi}] mg（闭区间）` };
  }
  return { ok: true, doseMg: dose };
}
