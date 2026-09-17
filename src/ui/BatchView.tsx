import { useState, type FormEvent } from 'react';
import type { Recipe, RecipeStep } from '../domain/recipe';
import { acceptableRange } from '../domain/weighing';
import { evaluateStability, lastN, parseReading } from '../domain/stability';
import type { PrepareRecord } from '../persistence/journal';

interface Props {
  recipe: Recipe;
  applied: PrepareRecord[];
  weighError: string | null;
  /** 稳定步骤确认失败时，领域层按顺序返回的全部命中原因。 */
  stabilityErrors: string[] | null;
  onConfirm: (barcode: string, dose: string) => Promise<void>;
  onConfirmStable: (readings: number[]) => Promise<void>;
}

/** 批次视图：显示当前原料或完成态，以及由已提交前缀派生的剂量日志。 */
export default function BatchView({
  recipe,
  applied,
  weighError,
  stabilityErrors,
  onConfirm,
  onConfirmStable,
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
      ) : step.stability === undefined ? (
        <WeighingPanel
          key={applied.length}
          step={step}
          index={applied.length}
          total={recipe.steps.length}
          weighError={weighError}
          onConfirm={onConfirm}
        />
      ) : (
        <StableWeighingPanel
          key={applied.length}
          step={step}
          index={applied.length}
          total={recipe.steps.length}
          errors={stabilityErrors}
          onConfirmStable={onConfirmStable}
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
      <StepCard step={step} lo={lo} hi={hi} mode="single" />
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
  onConfirmStable: (readings: number[]) => Promise<void>;
}

function StableWeighingPanel({ step, index, total, errors, onConfirmStable }: StablePanelProps) {
  const policy = step.stability!;
  const n = policy.samples;
  const { lo, hi } = acceptableRange(step);

  const [barcode, setBarcode] = useState('');
  const [readings, setReadings] = useState<number[]>([]);
  const [readingInput, setReadingInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const barcodeMatched = barcode === step.barcode;
  // 界面仅保留最后 N 项。
  const windowReadings = lastN(readings, n);
  const full = windowReadings.length === n;
  // 收满后实时显示极差、趋势与候选剂量。
  const evaluation = full ? evaluateStability(step, policy, windowReadings) : null;

  const addReading = (e: FormEvent) => {
    e.preventDefault();
    if (!barcodeMatched) {
      setInputError('请先扫描当前步骤的原料条码');
      return;
    }
    const value = parseReading(readingInput);
    if (value === null) {
      // 非法读数不进入窗口。
      setInputError('读数须为非负安全整数毫克');
      return;
    }
    setInputError(null);
    setReadings((prev) => lastN([...prev, value], n));
    setReadingInput('');
  };

  const confirm = () => {
    if (submitting || !full) return;
    setSubmitting(true);
    void onConfirmStable(windowReadings).finally(() => setSubmitting(false));
  };

  return (
    <div className="panel">
      <p data-testid="step-indicator" className="step-indicator">
        步骤 {index + 1} / {total}
      </p>
      <StepCard step={step} lo={lo} hi={hi} mode="stable" />
      <dl className="step-card" data-testid="stability-policy">
        <div>
          <dt>采样数 N</dt>
          <dd data-testid="policy-samples">{n}</dd>
        </div>
        <div>
          <dt>最大极差</dt>
          <dd data-testid="policy-range">{policy.maxRangeMg} mg</dd>
        </div>
        <div>
          <dt>每次采样最大漂移</dt>
          <dd data-testid="policy-drift">{policy.maxDriftMg} mg</dd>
        </div>
      </dl>

      <label htmlFor="stable-barcode-input">扫描当前原料条码</label>
      <input
        id="stable-barcode-input"
        data-testid="stable-barcode-input"
        value={barcode}
        onChange={(e) => setBarcode(e.target.value)}
        autoComplete="off"
        autoFocus
      />
      {barcode && !barcodeMatched && (
        <p role="alert" data-testid="stable-barcode-error" className="error">
          条码与当前原料不一致，请扫描当前步骤的原料条码
        </p>
      )}

      <form onSubmit={addReading}>
        <label htmlFor="reading-input">逐个录入读数（非负整数 mg，仅保留最后 {n} 项）</label>
        <input
          id="reading-input"
          data-testid="reading-input"
          value={readingInput}
          onChange={(e) => setReadingInput(e.target.value)}
          inputMode="numeric"
          autoComplete="off"
          disabled={!barcodeMatched}
        />
        {inputError && (
          <p role="alert" data-testid="reading-input-error" className="error">
            {inputError}
          </p>
        )}
        <button
          type="submit"
          data-testid="add-reading-button"
          className="secondary"
          disabled={!barcodeMatched}
        >
          录入读数
        </button>
      </form>

      <div className="window-block">
        <h3>读数窗口（最后 {n} 项）</h3>
        <p data-testid="window-count" className="hint">
          已收 {windowReadings.length} / {n} 项
        </p>
        {windowReadings.length === 0 ? (
          <p data-testid="window-empty" className="hint">
            暂无读数
          </p>
        ) : (
          <ol data-testid="reading-window" className="reading-window">
            {windowReadings.map((r, i) => (
              <li key={i}>{r} mg</li>
            ))}
          </ol>
        )}

        {evaluation && (
          <dl className="step-card" data-testid="stability-summary">
            <div>
              <dt>极差</dt>
              <dd data-testid="summary-range">{evaluation.rangeMg} mg</dd>
            </div>
            <div>
              <dt>趋势漂移</dt>
              <dd data-testid="summary-trend">
                {evaluation.failures.includes('trend') ? '超差' : '合格'}
              </dd>
            </div>
            <div>
              <dt>候选剂量</dt>
              <dd data-testid="summary-candidate">{evaluation.candidateMg} mg</dd>
            </div>
          </dl>
        )}
      </div>

      {errors && errors.length > 0 && (
        <div role="alert" data-testid="stability-errors" className="errors">
          <ul>
            {errors.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      <button
        type="button"
        data-testid="stable-confirm-button"
        onClick={confirm}
        disabled={submitting || !full}
      >
        确认稳定剂量
      </button>
      {!full && (
        <p data-testid="confirm-hint" className="hint">
          收满 {n} 项读数后才可确认
        </p>
      )}
    </div>
  );
}

function StepCard({
  step,
  lo,
  hi,
  mode,
}: {
  step: RecipeStep;
  lo: number;
  hi: number;
  mode: 'single' | 'stable';
}) {
  return (
    <dl className="step-card">
      <div>
        <dt>当前原料{mode === 'stable' ? '（稳定读数）' : ''}</dt>
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
                <td data-testid={`log-readings-${r.seq}`}>
                  {r.readings ? r.readings.map((x) => `${x} mg`).join('，') : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
