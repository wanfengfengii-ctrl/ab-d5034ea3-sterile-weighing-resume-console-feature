import { useState } from 'react';
import type { RecipeError } from '../domain/recipe';

const SAMPLE_RECIPE = {
  steps: [
    { id: 'NaCl-500', barcode: 'BC-NACL-01', targetMg: 500, toleranceMg: 10 },
    { id: 'KCl-200', barcode: 'BC-KCL-02', targetMg: 200, toleranceMg: 0 },
    { id: 'GLU-1000', barcode: 'BC-GLU-03', targetMg: 1000, toleranceMg: 1000 },
  ],
};

interface Props {
  errors: RecipeError[];
  onImport: (text: string) => void;
}

export default function ImportView({ errors, onImport }: Props) {
  const [text, setText] = useState('');

  return (
    <section>
      <h2>导入配方</h2>
      <p className="hint">
        粘贴配方 JSON：1–30 个有序步骤；编号为唯一非空 ASCII 字符串，条码为非空 ASCII
        字符串，目标量为至少 1 的整数毫克，容差为 0 至目标量的整数。
      </p>
      <textarea
        data-testid="recipe-input"
        rows={10}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder='{"steps":[{"id":"NaCl-500","barcode":"BC-NACL-01","targetMg":500,"toleranceMg":10}]}'
        spellCheck={false}
      />
      <div className="actions">
        <button data-testid="import-button" onClick={() => onImport(text)}>
          校验并载入
        </button>
        <button
          data-testid="sample-button"
          type="button"
          className="secondary"
          onClick={() => setText(JSON.stringify(SAMPLE_RECIPE, null, 2))}
        >
          填入示例
        </button>
      </div>
      {errors.length > 0 && (
        <div className="errors" role="alert">
          <p>配方存在 {errors.length} 处错误，批次不得开始：</p>
          <ul data-testid="import-errors">
            {errors.map((err, i) => (
              <li key={i}>{err.message}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
