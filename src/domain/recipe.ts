/**
 * 配方领域模型与导入校验。
 *
 * 配方 JSON 形如：
 *   { "steps": [ { "id": "NaCl-500", "barcode": "BC-NACL-01", "targetMg": 500, "toleranceMg": 10 }, ... ] }
 * 也接受顶层即为步骤数组的形式。
 *
 * 规则：
 *  - 1 至 30 个有序步骤；
 *  - 编号：唯一、非空 ASCII 字符串（可打印 ASCII，0x20–0x7E）；
 *  - 条码：非空 ASCII 字符串；
 *  - 目标量：至少 1 的整数毫克；
 *  - 容差：0 至目标量的整数。
 *  - 可选稳定读数策略 stable：声明后该步骤按多次采样确认，
 *    samples 为 3 至 9 的整数采样数，maxRangeMg（最大极差）与
 *    maxDrift（每次采样最大漂移，mg/次）均为非负安全整数；
 *    未声明 stable 的步骤仍按原有单次称量流程执行。
 * 校验一次返回全部错误，并按步骤输入位置稳定排序（全局错误排在最前）。
 */

export const MAX_STEPS = 30;
export const MIN_SAMPLES = 3;
export const MAX_SAMPLES = 9;

/** 稳定读数策略：收满 samples 项读数后按极差与趋势判定，候选剂量落入闭区间方可确认。 */
export interface StableStrategy {
  /** 采样数：3 至 9 的整数。 */
  samples: number;
  /** 最大极差（mg）：非负安全整数。 */
  maxRangeMg: number;
  /** 每次采样最大漂移（mg/次）：非负安全整数。 */
  maxDrift: number;
}

export interface RecipeStep {
  id: string;
  barcode: string;
  targetMg: number;
  toleranceMg: number;
  /** 未声明（undefined）时按单次称量流程；声明后按稳定读数流程。 */
  stable?: StableStrategy;
}

export interface Recipe {
  steps: RecipeStep[];
}

export interface RecipeError {
  /** 步骤在输入中的位置（0 起）；null 表示与具体步骤无关的全局错误。 */
  stepIndex: number | null;
  /** 出错字段；null 表示整条步骤或整体结构错误。 */
  field:
    | 'id'
    | 'barcode'
    | 'targetMg'
    | 'toleranceMg'
    | 'stable'
    | 'samples'
    | 'maxRangeMg'
    | 'maxDrift'
    | null;
  message: string;
}

export interface ValidationResult {
  recipe: Recipe | null;
  errors: RecipeError[];
}

/** 非空可打印 ASCII 字符串（0x20–0x7E）。 */
const ASCII_PATTERN = /^[\x20-\x7E]+$/;

function isNonEmptyAscii(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && ASCII_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 非负安全整数（Number.isSafeInteger 且 ≥ 0）。 */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 解析配方 JSON 文本；解析失败返回单个全局错误。 */
export function parseRecipeText(text: string): ValidationResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      recipe: null,
      errors: [{ stepIndex: null, field: null, message: `JSON 解析失败：${detail}` }],
    };
  }
  return validateRecipe(data);
}

/** 校验已解析的 JSON 数据；任何错误存在时 recipe 为 null，批次不得开始。 */
export function validateRecipe(data: unknown): ValidationResult {
  const errors: RecipeError[] = [];

  let rawSteps: unknown[];
  if (Array.isArray(data)) {
    rawSteps = data;
  } else if (isRecord(data) && Array.isArray(data.steps)) {
    rawSteps = data.steps;
  } else {
    return {
      recipe: null,
      errors: [
        {
          stepIndex: null,
          field: null,
          message: `配方必须是步骤数组，或含 steps 数组的对象（1 至 ${MAX_STEPS} 个有序步骤）`,
        },
      ],
    };
  }

  if (rawSteps.length < 1 || rawSteps.length > MAX_STEPS) {
    errors.push({
      stepIndex: null,
      field: null,
      message: `步骤数量须为 1 至 ${MAX_STEPS}，实际为 ${rawSteps.length}`,
    });
  }

  const seenIds = new Map<string, number>();
  const steps: RecipeStep[] = [];

  rawSteps.forEach((raw, index) => {
    const at = index + 1;
    if (!isRecord(raw)) {
      errors.push({ stepIndex: index, field: null, message: `步骤 ${at}：必须是对象` });
      return;
    }

    let id: string | null = null;
    if (!isNonEmptyAscii(raw.id)) {
      errors.push({ stepIndex: index, field: 'id', message: `步骤 ${at}：编号须为非空 ASCII 字符串` });
    } else {
      id = raw.id;
      const firstSeen = seenIds.get(id);
      if (firstSeen !== undefined) {
        errors.push({
          stepIndex: index,
          field: 'id',
          message: `步骤 ${at}：编号 "${id}" 与步骤 ${firstSeen + 1} 重复`,
        });
      } else {
        seenIds.set(id, index);
      }
    }

    let barcode: string | null = null;
    if (!isNonEmptyAscii(raw.barcode)) {
      errors.push({ stepIndex: index, field: 'barcode', message: `步骤 ${at}：条码须为非空 ASCII 字符串` });
    } else {
      barcode = raw.barcode;
    }

    const targetRaw = raw.targetMg;
    let targetMg: number | null = null;
    if (typeof targetRaw !== 'number' || !Number.isInteger(targetRaw) || targetRaw < 1) {
      errors.push({
        stepIndex: index,
        field: 'targetMg',
        message: `步骤 ${at}：目标量须为至少 1 的整数毫克`,
      });
    } else {
      targetMg = targetRaw;
    }

    const toleranceRaw = raw.toleranceMg;
    let toleranceMg: number | null = null;
    if (typeof toleranceRaw !== 'number' || !Number.isInteger(toleranceRaw) || toleranceRaw < 0) {
      errors.push({
        stepIndex: index,
        field: 'toleranceMg',
        message: `步骤 ${at}：容差须为 0 至目标量的整数`,
      });
    } else if (typeof targetRaw === 'number' && toleranceRaw > targetRaw) {
      // 与目标量的原始数值比较：目标量本身无效（如 0 或负数）时，
      // 容差超出它也要一并报告；仅当目标量不是数字（无法比较）时跳过。
      errors.push({
        stepIndex: index,
        field: 'toleranceMg',
        message: `步骤 ${at}：容差不得超过目标量`,
      });
    } else {
      toleranceMg = toleranceRaw;
    }

    // 可选稳定读数策略：未声明（缺省或 null）即按单次称量流程；
    // 一旦声明，samples/maxRangeMg/maxDrift 全部校验，错误并入本步骤错误清单。
    let stable: StableStrategy | null = null;
    if (raw.stable !== undefined && raw.stable !== null) {
      if (!isRecord(raw.stable)) {
        errors.push({
          stepIndex: index,
          field: 'stable',
          message: `步骤 ${at}：稳定策略 stable 须为对象`,
        });
      } else {
        const cfg = raw.stable as Record<string, unknown>;
        let samples: number | null = null;
        let maxRangeMg: number | null = null;
        let maxDrift: number | null = null;

        if (
          typeof cfg.samples !== 'number' ||
          !Number.isSafeInteger(cfg.samples) ||
          cfg.samples < MIN_SAMPLES ||
          cfg.samples > MAX_SAMPLES
        ) {
          errors.push({
            stepIndex: index,
            field: 'samples',
            message: `步骤 ${at}：采样数须为 ${MIN_SAMPLES} 至 ${MAX_SAMPLES} 的整数`,
          });
        } else {
          samples = cfg.samples;
        }

        if (!isNonNegativeSafeInteger(cfg.maxRangeMg)) {
          errors.push({
            stepIndex: index,
            field: 'maxRangeMg',
            message: `步骤 ${at}：最大极差须为非负安全整数`,
          });
        } else {
          maxRangeMg = cfg.maxRangeMg;
        }

        if (!isNonNegativeSafeInteger(cfg.maxDrift)) {
          errors.push({
            stepIndex: index,
            field: 'maxDrift',
            message: `步骤 ${at}：每次采样最大漂移须为非负安全整数`,
          });
        } else {
          maxDrift = cfg.maxDrift;
        }

        if (samples !== null && maxRangeMg !== null && maxDrift !== null) {
          stable = { samples, maxRangeMg, maxDrift };
        }
      }
    }

    if (id !== null && barcode !== null && targetMg !== null && toleranceMg !== null) {
      steps.push({ id, barcode, targetMg, toleranceMg, ...(stable ? { stable } : {}) });
    }
  });

  // 按步骤输入位置稳定排序；全局错误（stepIndex 为 null）排在最前。
  // Array.prototype.sort 自 ES2019 起为稳定排序，同位置错误保持检出顺序。
  errors.sort((a, b) => (a.stepIndex ?? -1) - (b.stepIndex ?? -1));

  if (errors.length > 0) {
    return { recipe: null, errors };
  }
  return { recipe: { steps }, errors: [] };
}
