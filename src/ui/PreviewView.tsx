import type { Recipe } from '../domain/recipe';

interface Props {
  recipe: Recipe;
  onStart: () => void;
  onBack: () => void;
}

export default function PreviewView({ recipe, onStart, onBack }: Props) {
  return (
    <section>
      <h2>配方校验通过</h2>
      <table data-testid="preview-steps" className="data-table">
        <thead>
          <tr>
            <th>#</th>
            <th>编号</th>
            <th>目标量</th>
            <th>容差</th>
          </tr>
        </thead>
        <tbody>
          {recipe.steps.map((s, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td>{s.id}</td>
              <td>{s.targetMg} mg</td>
              <td>±{s.toleranceMg} mg</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">批次开始后配方不可替换。</p>
      <div className="actions">
        <button data-testid="start-batch-button" onClick={onStart}>
          开始批次
        </button>
        <button data-testid="back-to-import-button" type="button" className="secondary" onClick={onBack}>
          返回修改
        </button>
      </div>
    </section>
  );
}
