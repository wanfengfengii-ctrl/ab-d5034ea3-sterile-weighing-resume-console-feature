import type { RecipeStep, StableStrategy } from './recipe';
import { acceptableRange } from './weighing';

/**
 * 稳定读数策略的领域判定。
 *
 * 操作员逐个录入非负安全整数毫克读数，界面只保留最后 N 项；
 * 收满 N 项后按以下顺序同时给出失败反馈：
 *  1. 不足 N 项（insufficient）；
 *  2. 极差超过配置（range）：max(y) − min(y) ≤ maxRangeMg；
 *  3. 趋势超差（trend）：以 x = 0…N−1 做最小二乘斜率判定，
 *     |N·Σxy − Σx·Σy| ≤ maxDrift × [N·Σx² − (Σx)²]，
 *     全部乘加使用 BigInt，避免大整数读数丢精度；
 *  4. 候选剂量超出步骤闭区间（doseRange）。
 *
 * 候选剂量为读数升序排序后两个中位项之和整除 2（偶数窗口向下取整；
 * 奇数窗口取正中位项），并须落入 [目标量 − 容差, 目标量 + 容差] 闭区间。
 */

export type StableFailureKind = 'insufficient' | 'range' | 'trend' | 'doseRange';

/** 失败反馈的固定顺序；界面与日志均按此顺序展示。 */
export const STABLE_FAILURE_ORDER: StableFailureKind[] = [
  'insufficient',
  'range',
  'trend',
  'doseRange',
];

export interface StableSuccess {
  ok: true;
  /** 领域层重新计算出的候选剂量（mg）。 */
  doseMg: number;
  /** 判定所用读数（录入顺序，x = 0…N−1）。 */
  readings: number[];
  rangeMg: number;
  trendOk: true;
}

export interface StableFailure {
  ok: false;
  /** 全部失败项，按 STABLE_FAILURE_ORDER 排序，可同时含多项。 */
  failures: StableFailureKind[];
  readings: number[];
  /** 收满 N 项时给出统计；不足 N 项时为 null。 */
  rangeMg: number | null;
  trendOk: boolean | null;
  candidateMg: number | null;
}

export type StableResult = StableSuccess | StableFailure;

const INTEGER_PATTERN = /^\d+$/;

/** 解析一次录入：非负安全整数毫克；非法读数不进入窗口。 */
export function parseReadingInput(text: string): { ok: true; value: number } | { ok: false; reason: string } {
  if (!INTEGER_PATTERN.test(text)) {
    return { ok: false, reason: '读数须为非负整数毫克' };
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    return { ok: false, reason: '读数超出可表示的整数范围' };
  }
  return { ok: true, value };
}

/** 校验一份读数证据：每项都必须是非负安全整数（领域层复查，防篡改）。 */
export function isValidReadingSequence(values: unknown): values is number[] {
  return (
    Array.isArray(values) &&
    values.every((v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)
  );
}

/**
 * 排序后的中位候选剂量：奇数窗口取正中位项；
 * 偶数窗口取两个中位项之和整除 2（向下取整，BigInt 防止求和溢出安全整数）。
 */
export function medianCandidate(sortedReadings: number[]): number {
  const n = sortedReadings.length;
  const mid = n >> 1;
  if (n % 2 === 1) {
    return sortedReadings[mid];
  }
  const lower = BigInt(sortedReadings[mid - 1]);
  const upper = BigInt(sortedReadings[mid]);
  return Number((lower + upper) / 2n);
}

/**
 * 趋势判定（最小二乘斜率绝对值 ≤ maxDrift）。
 * 全部乘加使用 BigInt：读数虽为安全整数，N·Σxy 等中间项可能超出安全整数范围。
 */
export function trendWithinDrift(readings: number[], maxDrift: number): boolean {
  let sumX = 0n;
  let sumY = 0n;
  let sumXY = 0n;
  let sumX2 = 0n;
  readings.forEach((y, x) => {
    const xb = BigInt(x);
    const yb = BigInt(y);
    sumX += xb;
    sumY += yb;
    sumXY += xb * yb;
    sumX2 += xb * xb;
  });
  const n = BigInt(readings.length);
  const numerator = n * sumXY - sumX * sumY;
  const lhs = numerator < 0n ? -numerator : numerator;
  const rhs = BigInt(maxDrift) * (n * sumX2 - sumX * sumX);
  return lhs <= rhs;
}

export interface StableStats {
  rangeMg: number;
  trendOk: boolean;
  candidateMg: number;
}

/** 收满 N 项后的统计：极差、趋势、候选剂量。入组长度须恰好为 N。 */
export function computeStableStats(readings: number[], strategy: StableStrategy): StableStats {
  const sorted = [...readings].sort((a, b) => a - b);
  const rangeMg = sorted[sorted.length - 1] - sorted[0];
  return {
    rangeMg,
    trendOk: trendWithinDrift(readings, strategy.maxDrift),
    candidateMg: medianCandidate(sorted),
  };
}

/**
 * 领域层重新计算稳定步骤的确认结果。
 * 不接受调用方给出的候选剂量——剂量一律由读数重算，防止篡改。
 * 失败时按 不足N项 → 极差 → 趋势 → 剂量区间 的顺序同时返回全部失败项。
 */
export function evaluateReadings(step: RecipeStep, readings: number[]): StableResult {
  const strategy = step.stable;
  if (!strategy) {
    throw new Error('该步骤未配置稳定读数策略');
  }
  if (!isValidReadingSequence(readings)) {
    throw new Error('读数证据非法：每项须为非负安全整数毫克');
  }

  if (readings.length !== strategy.samples) {
    return {
      ok: false,
      failures: ['insufficient'],
      readings: [...readings],
      rangeMg: null,
      trendOk: null,
      candidateMg: null,
    };
  }

  const stats = computeStableStats(readings, strategy);
  const { lo, hi } = acceptableRange(step);

  const failures: StableFailureKind[] = [];
  if (stats.rangeMg > strategy.maxRangeMg) {
    failures.push('range');
  }
  if (!stats.trendOk) {
    failures.push('trend');
  }
  if (stats.candidateMg < lo || stats.candidateMg > hi) {
    failures.push('doseRange');
  }

  if (failures.length > 0) {
    return {
      ok: false,
      failures,
      readings: [...readings],
      rangeMg: stats.rangeMg,
      trendOk: stats.trendOk,
      candidateMg: stats.candidateMg,
    };
  }
  return {
    ok: true,
    doseMg: stats.candidateMg,
    readings: [...readings],
    rangeMg: stats.rangeMg,
    trendOk: true,
  };
}

/** 失败项到操作员可读信息（含实际值与配置值）。 */
export function describeStableFailure(
  kind: StableFailureKind,
  step: RecipeStep,
  result: StableFailure,
): string {
  const strategy = step.stable!;
  switch (kind) {
    case 'insufficient':
      return `稳定读数须恰好收满 ${strategy.samples} 项，当前为 ${result.readings.length} 项`;
    case 'range':
      return `读数极差 ${result.rangeMg} mg 超过最大极差 ${strategy.maxRangeMg} mg`;
    case 'trend':
      return `读数趋势超过每次采样最大漂移 ${strategy.maxDrift} mg`;
    case 'doseRange': {
      const { lo, hi } = acceptableRange(step);
      return `候选剂量 ${result.candidateMg} mg 超出可接受区间 [${lo}, ${hi}] mg（闭区间）`;
    }
  }
}
