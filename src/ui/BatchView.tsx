import { useState, type FormEvent } from 'react';
import type { Recipe, RecipeStep } from '../domain/recipe';
import { acceptableRange } from '../domain/weighing';
import type { PrepareRecord } from '../persistence/journal';

interface Props {
  recipe: Recipe;
  applied: PrepareRecord[];
  weighError: string | null;
  onConfirm: (barcode: string, dose: string) => Promise<void>;
}

/** 批次视图：显示当前原料或完成态，以及由已提交前缀派生的剂量日志。 */
export default function BatchView({ recipe, applied, weighError, onConfirm }: Props) {
  const complete = applied.length >= recipe.steps.length;
  const step = complete ? null : recipe.steps[applied.length];

  return (
    <section>
      {complete || !step ? (
        <div className="panel complete-panel">
          <h2 data-testid="complete-banner">批次完成</h2>
          <p className="hint">全部 {recipe.steps.length} 个步骤已确认，配液完成。</p>
        </div>
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
            </tr>
          </thead>
          <tbody>
            {applied.map((r) => (
              <tr key={r.seq}>
                <td>{r.seq}</td>
                <td>{r.stepId}</td>
                <td>{r.doseMg} mg</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
