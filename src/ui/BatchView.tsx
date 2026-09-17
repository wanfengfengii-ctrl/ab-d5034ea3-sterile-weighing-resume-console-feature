import { useState, type FormEvent } from 'react';
import type { Recipe, RecipeStep } from '../domain/recipe';
import { acceptableRange } from '../domain/weighing';
import {
  computeStableStats,
  parseReadingInput,
  type StableFailureKind,
} from '../domain/stable';
import type { PrepareRecord } from '../persistence/journal';

interface Props {
  recipe: Recipe;
  applied: PrepareRecord[];
  weighError: string | null;
  stableErrors: string[] | null;
  onConfirm: (barcode: string, dose: string) => Promise<void>;
  onConfirmStable: (barcode: string, readings: number[]) => Promise<void>;
  onClearStableErrors: () => void;
}

/** 批次视图：显示当前原料或完成态，以及由已提交前缀派生的剂量日志。 */
export default function BatchView({
  recipe,
  applied,
  weighError,
  stableErrors,
  onConfirm,
  onConfirmStable,
  onClearStableErrors,
}: Props) {
  const complete = applied.length >= recipe.steps.length;
  const step = complete ? null : recipe.steps[applied.length];

  return (
    <section>
      {complete || !step ? (
        <div className="panel complete-panel">
          <h2 data-testid="complete-banner">批次完成</h2>
          <p className="hint">全部 {recipe.steps.length} 个步骤已确认，配液完成。</p>
        </div>
      ) : step.stable ? (
        <StableWeighingPanel
          key={applied.length}
          step={step}
          index={applied.length}
          total={recipe.steps.length}
          errors={stableErrors}
          onConfirmStable={onConfirmStable}
          onClearErrors={onClearStableErrors}
        />
      ) : (
        <WeighingPanel
          key={applied.length}
          step={step}
          index={applied.length}
          total={recipe.steps.length}
          weighError={weighError}
          onConfirm={onConfirm}
        />
      )}
      <DoseLog applied={applied} />
    </section>
  );
}

interface PanelProps {
  step: RecipeStep;
  index: number;
  total: number;
  weighError: string | null;
  onConfirm: (barcode: string, dose: string) => Promise<void>;
}

function WeighingPanel({ step, index, total, weighError, onConfirm }: PanelProps) {
  const [barcode, setBarcode] = useState('');
  const [dose, setDose] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { lo, hi } = acceptableRange(step);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    void onConfirm(barcode, dose).finally(() => setSubmitting(false));
  };

  return (
    <div className="panel">
      <p data-testid="step-indicator" className="step-indicator">
        步骤 {index + 1} / {total}
      </p>
      <dl className="step-card">
        <div>
          <dt>当前原料</dt>
          <dd data-testid="current-step-id">{step.id}</dd>
        </div>
        <div>
          <dt>目标量</dt>
          <dd data-testid="target-mg">{step.targetMg} mg</dd>
        </div>
        <div>
          <dt>容差</dt>
          <dd data-testid="tolerance-mg">±{step.toleranceMg} mg</dd>
        </div>
        <div>
          <dt>可接受区间</dt>
          <dd data-testid="acceptable-range">
            [{lo}, {hi}] mg
          </dd>
        </div>
      </dl>
      <form onSubmit={submit}>
        <label htmlFor="barcode-input">扫描/输入当前原料条码</label>
        <input
          id="barcode-input"
          data-testid="barcode-input"
          value={barcode}
          onChange={(e) => setBarcode(e.target.value)}
          autoComplete="off"
          autoFocus
        />
        <label htmlFor="dose-input">称量值（整数 mg）</label>
        <input
          id="dose-input"
          data-testid="dose-input"
          value={dose}
          onChange={(e) => setDose(e.target.value)}
          inputMode="numeric"
          autoComplete="off"
        />
        {weighError && (
          <p role="alert" data-testid="weigh-error" className="error">
            {weighError}
          </p>
        )}
        <button type="submit" data-testid="confirm-button" disabled={submitting}>
          确认剂量
        </button>
      </form>
    </div>
  );
}

interface StablePanelProps {
  step: RecipeStep;
  index: number;
  total: number;
  errors: string[] | null;
  onConfirmStable: (barcode: string, readings: number[]) => Promise<void>;
  onClearErrors: () => void;
}

function StableWeighingPanel({
  step,
  index,
  total,
  errors,
  onConfirmStable,
  onClearErrors,
}: StablePanelProps) {
  const strategy = step.stable!;
  const n = strategy.samples;
  const { lo, hi } = acceptableRange(step);

  const [barcode, setBarcode] = useState('');
  const [readingText, setReadingText] = useState('');
  // 录入窗口：仅保留最后 N 项（合法读数）。
  const [windowReadings, setWindowReadings] = useState<number[]>([]);
  const [inputError, setInputError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const barcodeMatched = barcode === step.barcode;
  const full = windowReadings.length === n;
  const stats = full ? computeStableStats(windowReadings, strategy) : null;
  const failedKinds = new Set<StableFailureKind>();
  if (stats) {
    if (stats.rangeMg > strategy.maxRangeMg) failedKinds.add('range');
    if (!stats.trendOk) failedKinds.add('trend');
    if (stats.candidateMg < lo || stats.candidateMg > hi) failedKinds.add('doseRange');
  }

  const addReading = (e: FormEvent) => {
    e.preventDefault();
    if (!barcodeMatched) {
      setInputError('条码与当前原料不一致，请先扫描当前步骤的原料条码');
      return;
    }
    const parsed = parseReadingInput(readingText);
    if (!parsed.ok) {
      // 非法读数不进入窗口。
      setInputError(parsed.reason);
      return;
    }
    setInputError(null);
    onClearErrors();
    // 界面仅保留最后 N 项：新读数入窗后截掉超出的旧读数。
    setWindowReadings((prev) => [...prev, parsed.value].slice(-n));
    setReadingText('');
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (submitting || !full) return;
    setSubmitting(true);
    void onConfirmStable(barcode, windowReadings).finally(() => setSubmitting(false));
  };

  return (
    <div className="panel">
      <p data-testid="step-indicator" className="step-indicator">
        步骤 {index + 1} / {total}（稳定读数）
      </p>
      <dl className="step-card">
        <div>
          <dt>当前原料</dt>
          <dd data-testid="current-step-id">{step.id}</dd>
        </div>
        <div>
          <dt>目标量</dt>
          <dd data-testid="target-mg">{step.targetMg} mg</dd>
        </div>
        <div>
          <dt>可接受区间</dt>
          <dd data-testid="acceptable-range">
            [{lo}, {hi}] mg
          </dd>
        </div>
        <div>
          <dt>稳定策略</dt>
          <dd data-testid="stable-strategy">
            N={n} · 极差≤{strategy.maxRangeMg} mg · 漂移≤{strategy.maxDrift} mg/次
          </dd>
        </div>
      </dl>

      <form onSubmit={addReading}>
        <label htmlFor="stable-barcode-input">扫描当前原料条码</label>
        <input
          id="stable-barcode-input"
          data-testid="stable-barcode-input"
          value={barcode}
          onChange={(e) => {
            setBarcode(e.target.value);
            onClearErrors();
          }}
          autoComplete="off"
          autoFocus
        />
        {!barcodeMatched && barcode.length > 0 && (
          <p className="error" role="alert">
            条码与当前原料不一致，请扫描当前步骤的原料条码
          </p>
        )}
        <label htmlFor="stable-reading-input">逐个录入读数（非负整数 mg，仅保留最后 {n} 项）</label>
        <input
          id="stable-reading-input"
          data-testid="stable-reading-input"
          value={readingText}
          onChange={(e) => setReadingText(e.target.value)}
          inputMode="numeric"
          autoComplete="off"
          disabled={!barcodeMatched}
        />
        {inputError && (
          <p role="alert" data-testid="stable-input-error" className="error">
            {inputError}
          </p>
        )}
        <button
          type="submit"
          data-testid="stable-add-button"
          className="secondary"
          disabled={!barcodeMatched}
        >
          录入读数
        </button>
      </form>

      <div className="stable-window">
        <p className="hint" data-testid="stable-count">
          已收读数 {windowReadings.length} / {n}
        </p>
        <ol data-testid="stable-window" className="stable-readings">
          {windowReadings.map((value, i) => (
            <li key={i}>
              <span className="reading-index">x={i}</span>
              <span className="reading-value" data-testid="stable-reading-item">
                {value} mg
              </span>
            </li>
          ))}
        </ol>

        {stats && (
          <dl className="stable-stats" data-testid="stable-stats">
            <div className={failedKinds.has('range') ? 'stat-fail' : 'stat-ok'}>
              <dt>极差</dt>
              <dd data-testid="stable-range">
                {stats.rangeMg} mg（≤ {strategy.maxRangeMg} mg）
                {failedKinds.has('range') ? ' ✗ 超差' : ' ✓'}
              </dd>
            </div>
            <div className={failedKinds.has('trend') ? 'stat-fail' : 'stat-ok'}>
              <dt>趋势</dt>
              <dd data-testid="stable-trend">
                每次采样漂移 ≤ {strategy.maxDrift} mg
                {stats.trendOk ? ' ✓' : ' ✗ 超差'}
              </dd>
            </div>
            <div className={failedKinds.has('doseRange') ? 'stat-fail' : 'stat-ok'}>
              <dt>候选剂量</dt>
              <dd data-testid="stable-candidate">
                {stats.candidateMg} mg（[{lo}, {hi}] mg）
                {failedKinds.has('doseRange') ? ' ✗ 超区间' : ' ✓'}
              </dd>
            </div>
          </dl>
        )}

        {errors && errors.length > 0 && (
          <ul className="errors-list" data-testid="stable-errors" role="alert">
            {errors.map((message, i) => (
              <li key={i} className="error">
                {message}
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={submit}>
          <button
            type="submit"
            data-testid="stable-confirm-button"
            disabled={submitting || !full}
          >
            {full ? '确认稳定剂量' : `收满 ${n} 项后可确认`}
          </button>
        </form>
      </div>
    </div>
  );
}

function DoseLog({ applied }: { applied: PrepareRecord[] }) {
  return (
    <div className="panel">
      <h3>剂量日志</h3>
      {applied.length === 0 ? (
        <p data-testid="log-empty" className="hint">
          暂无已确认剂量
        </p>
      ) : (
        <table data-testid="dose-log" className="data-table">
          <thead>
            <tr>
              <th>序号</th>
              <th>原料编号</th>
              <th>确认剂量</th>
              <th>读数证据</th>
            </tr>
          </thead>
          <tbody>
            {applied.map((r) => (
              <tr key={r.seq}>
                <td>{r.seq}</td>
                <td>{r.stepId}</td>
                <td>{r.doseMg} mg</td>
                <td data-testid="dose-evidence">
                  {r.stableReadings ? r.stableReadings.join(', ') + ' mg' : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
