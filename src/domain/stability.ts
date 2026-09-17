import { acceptableRange } from './weighing';
import type { RecipeStep, StabilityPolicy } from './recipe';

/**
 * 稳定读数判定（领域层）。
 *
 * 操作员在扫描当前原料条码后逐个录入非负安全整数毫克读数；界面只保留最后
 * N（= policy.samples）项。判定一律采用 x = 0 … N−1 的最后 N 项：
 *
 *  1. 数量：窗口必须收满 N 项；
 *  2. 极差：max − min 不得超过配置的 maxRangeMg；
 *  3. 趋势（最小二乘斜率，以绝对值计）：
 *       |N·Σxy − Σx·Σy| ≤ maxDriftMg · [N·Σx² − (Σx)²]
 *     全部乘加使用 BigInt，杜绝浮点误差与中间溢出；
 *  4. 候选剂量：读数升序排序后两中位项之和整除 2（BigInt 整除，偶数窗口
 *     即向下取整的双中位项均值），且必须落入步骤 [target−tol, target+tol]
 *     闭区间。
 *
 * 四类失败按 数量 → 极差 → 趋势 → 剂量区间 的顺序判定，但一次反馈全部
 * 命中的失败（reason 列表保持该顺序）。剂量是领域层从读数证据重算的结果，
 * 任何外部传入的候选值都不可信。
 */

export type StabilityFailureKind = 'count' | 'range' | 'trend' | 'doseRange';

/** 稳定判定未通过时抛出；reasons 已按 count → range → trend → doseRange 排序。 */
export class StabilityRejectedError extends Error {
  readonly failures: StabilityFailureKind[];
  readonly reasons: string[];

  constructor(evaluation: StabilityEvaluation) {
    super(evaluation.reasons.join('；') || '稳定读数判定未通过');
    this.name = 'StabilityRejectedError';
    this.failures = evaluation.failures;
    this.reasons = evaluation.reasons;
  }
}

export interface StabilityEvaluation {
  /** 是否四项判定全部通过。 */
  ok: boolean;
  /** 失败项，按 count → range → trend → doseRange 顺序；通过时为空数组。 */
  failures: StabilityFailureKind[];
  /** 人类可读的失败原因，顺序与 failures 一致；通过时为空数组。 */
  reasons: string[];
  /** 候选剂量（毫克）；仅在窗口收满时计算（无论后续判定是否通过），否则为 null。 */
  candidateMg: number | null;
  /** 实际参与判定的最后 N 项读数（收满时长度恰为 N，否则为现有全部）。 */
  window: number[];
  /** 窗口极差（max−min）；收满前为 null。 */
  rangeMg: number | null;
}

/** 非负安全整数毫克读数（数值层面）。 */
export function isSafeReading(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 非负整数读数字符串（含安全整数范围）校验，供界面逐录入使用。 */
export function parseReading(input: string): number | null {
  if (!/^\d+$/.test(input)) return null;
  const value = Number(input);
  return Number.isSafeInteger(value) ? value : null;
}

/** 仅保留最后 N 项；非法读数不应进入窗口（由 parseReading 在录入处拦截）。 */
export function lastN(readings: number[], n: number): number[] {
  return readings.length <= n ? readings.slice() : readings.slice(readings.length - n);
}

/**
 * 候选剂量：升序排序后两中位项之和整除 2（BigInt）。
 * - 奇数窗口：两中位项为同一项，(m+m)/2 = m；
 * - 偶数窗口：(mLow + mHigh) / 2 向下取整。
 */
export function candidateDose(sortedAsc: number[]): bigint {
  const n = sortedAsc.length;
  const right = Math.floor(n / 2);
  const left = Math.ceil(n / 2) - 1;
  const lo = BigInt(sortedAsc[left]);
  const hi = BigInt(sortedAsc[right]);
  return (lo + hi) / 2n;
}

/**
 * 重算稳定读数结果。readings 可长于 N：只有最后 N 项参与判定。
 * 纯函数，不做任何持久化；持久层确认时必须再次调用本函数。
 */
export function evaluateStability(
  step: RecipeStep,
  policy: StabilityPolicy,
  readings: number[],
): StabilityEvaluation {
  const n = policy.samples;
  const window = lastN(readings, n);
  const failures: StabilityFailureKind[] = [];
  const reasons: string[] = [];

  if (window.length < n) {
    failures.push('count');
    reasons.push(`读数不足：需要 ${n} 项，当前仅 ${window.length} 项`);
    return { ok: false, failures, reasons, candidateMg: null, window, rangeMg: null };
  }

  // 极差（BigInt 计算差值，避免任何隐患）。
  const ys = window.map(BigInt);
  let min = ys[0];
  let max = ys[0];
  for (const y of ys) {
    if (y < min) min = y;
    if (y > max) max = y;
  }
  const range = max - min;
  const rangeMg = Number(range);
  if (range > BigInt(policy.maxRangeMg)) {
    failures.push('range');
    reasons.push(
      `读数极差 ${rangeMg} mg 超过最大极差 ${policy.maxRangeMg} mg（${n} 项读数）`,
    );
  }

  // 趋势：x = 0 … N−1。全部乘加用 BigInt。
  const nb = BigInt(n);
  let sumX = 0n;
  let sumY = 0n;
  let sumXY = 0n;
  let sumX2 = 0n;
  for (let i = 0; i < n; i += 1) {
    const x = BigInt(i);
    const y = ys[i];
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }
  const lhs = nb * sumXY - sumX * sumY;
  const absLhs = lhs < 0n ? -lhs : lhs;
  const rhs = BigInt(policy.maxDriftMg) * (nb * sumX2 - sumX * sumX);
  if (absLhs > rhs) {
    failures.push('trend');
    reasons.push(
      `读数趋势漂移超差：|N·Σxy−Σx·Σy|=${absLhs.toString()} 超过 ${policy.maxDriftMg}×[N·Σx²−(Σx)²]=${rhs.toString()}`,
    );
  }

  // 候选剂量：排序后两中位项之和整除 2。
  const sorted = window.slice().sort((a, b) => a - b);
  const candidate = candidateDose(sorted);
  const candidateMg = Number(candidate);
  const { lo, hi } = acceptableRange(step);
  if (candidate < BigInt(lo) || candidate > BigInt(hi)) {
    failures.push('doseRange');
    reasons.push(
      `候选剂量 ${candidateMg} mg 超出可接受区间 [${lo}, ${hi}] mg（闭区间）`,
    );
  }

  return {
    ok: failures.length === 0,
    failures,
    reasons,
    candidateMg,
    window,
    rangeMg,
  };
}
