import { expect, test, type Page } from '@playwright/test';

/**
 * 稳定读数策略端到端：
 *  - 合法/非法配方（策略字段）；
 *  - 扫描条码后逐录入、非法读数不入窗口、仅保留最后 N 项；
 *  - 收满显示极差/趋势/候选，失败按顺序同时反馈且步骤与日志不变；
 *  - 偶数窗口双中位项均值向下取整，日志保存读数证据；
 *  - 稳定步骤与旧单次称量步骤混合；
 *  - afterPrepare / afterCommit 崩溃恢复。
 */

const RECIPE = {
  steps: [
    // 步骤 1：稳定读数 N=5，极差 ≤4，每次采样漂移 ≤1
    {
      id: 'NaCl-500',
      barcode: 'BC-NACL-01',
      targetMg: 500,
      toleranceMg: 10,
      samples: 5,
      maxRangeMg: 4,
      maxDriftMg: 1,
    },
    // 步骤 2：旧单次称量
    { id: 'KCl-200', barcode: 'BC-KCL-02', targetMg: 200, toleranceMg: 0 },
    // 步骤 3：稳定读数偶数窗口 N=4
    {
      id: 'GLU-1000',
      barcode: 'BC-GLU-03',
      targetMg: 1000,
      toleranceMg: 20,
      samples: 4,
      maxRangeMg: 4,
      maxDriftMg: 1,
    },
  ],
};

async function gotoImport(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('recipe-input')).toBeVisible();
}

async function importAndStart(page: Page, recipe: unknown = RECIPE) {
  await gotoImport(page);
  await page.getByTestId('recipe-input').fill(JSON.stringify(recipe));
  await page.getByTestId('import-button').click();
  await expect(page.getByTestId('start-batch-button')).toBeVisible();
  await page.getByTestId('start-batch-button').click();
  await expect(page.getByTestId('stable-barcode-input')).toBeVisible();
}

async function scanBarcode(page: Page, barcode: string) {
  await page.getByTestId('stable-barcode-input').fill(barcode);
}

async function addReading(page: Page, value: string) {
  await page.getByTestId('reading-input').fill(value);
  await page.getByTestId('add-reading-button').click();
}

async function addReadings(page: Page, values: Array<number | string>) {
  for (const v of values) {
    await addReading(page, String(v));
  }
}

async function armFault(page: Page, kind: 'afterPrepare' | 'afterCommit') {
  await page.waitForFunction(() => (window as any).__verify !== undefined);
  await page.evaluate((k) => {
    const v = (window as any).__verify;
    if (k === 'afterPrepare') v.armAfterPrepare();
    else v.armAfterCommit();
  }, kind);
}

test('非法稳定策略并入配方错误清单，批次不得开始', async ({ page }) => {
  await gotoImport(page);
  const bad = {
    steps: [
      // samples 越界、缺 maxDriftMg、maxRangeMg 为负
      { id: 'S1', barcode: 'BC-1', targetMg: 100, toleranceMg: 10, samples: 2, maxRangeMg: -1 },
      // 仅声明 maxDriftMg
      { id: 'S2', barcode: 'BC-2', targetMg: 100, toleranceMg: 10, maxDriftMg: 1.5 },
    ],
  };
  await page.getByTestId('recipe-input').fill(JSON.stringify(bad));
  await page.getByTestId('import-button').click();

  const items = page.getByTestId('import-errors').locator('li');
  await expect(items).toHaveCount(6);
  await expect(items.nth(0)).toContainText('步骤 1：samples');
  await expect(items.nth(1)).toContainText('步骤 1：maxRangeMg');
  await expect(items.nth(2)).toContainText('缺少 maxDriftMg');
  await expect(items.nth(3)).toContainText('缺少 samples');
  await expect(items.nth(4)).toContainText('缺少 maxRangeMg');
  await expect(items.nth(5)).toContainText('步骤 2：maxDriftMg');
  await expect(page.getByTestId('start-batch-button')).toHaveCount(0);
});

test('稳定读数：非法读数不入窗口、仅保留最后 N 项、收满才显示汇总并可确认', async ({
  page,
}) => {
  await importAndStart(page);

  await expect(page.getByTestId('step-indicator')).toHaveText('步骤 1 / 3');
  await expect(page.getByTestId('policy-samples')).toHaveText('5');
  await expect(page.getByTestId('policy-range')).toHaveText('4 mg');
  await expect(page.getByTestId('policy-drift')).toHaveText('1 mg');

  // 未扫对条码前不能录入读数
  await expect(page.getByTestId('reading-input')).toBeDisabled();
  await scanBarcode(page, 'BC-WRONG');
  await expect(page.getByTestId('stable-barcode-error')).toContainText('条码');
  await expect(page.getByTestId('reading-input')).toBeDisabled();

  await scanBarcode(page, 'BC-NACL-01');
  await expect(page.getByTestId('stable-barcode-error')).toHaveCount(0);

  // 非法读数不进入窗口
  for (const bad of ['-1', 'abc', '1.5', '1e3']) {
    await addReading(page, bad);
    await expect(page.getByTestId('reading-input-error')).toContainText('非负安全整数');
  }
  await expect(page.getByTestId('window-empty')).toBeVisible();
  await expect(page.getByTestId('window-count')).toHaveText('已收 0 / 5 项');

  // 未收满：无汇总、确认按钮禁用
  await addReadings(page, [500, 501]);
  await expect(page.getByTestId('stability-summary')).toHaveCount(0);
  await expect(page.getByTestId('stable-confirm-button')).toBeDisabled();

  // 录入超过 N 项：界面仅保留最后 5 项（最后五项为 502,503,504,505,506）
  await addReadings(page, [502, 503, 504, 505, 506, 507]);
  const lis = page.getByTestId('reading-window').locator('li');
  await expect(lis).toHaveCount(5);
  await expect(
    lis.evaluateAll((nodes) => nodes.map((n) => n.textContent)),
  ).resolves.toEqual(['503 mg', '504 mg', '505 mg', '506 mg', '507 mg']);
  await expect(page.getByTestId('window-count')).toHaveText('已收 5 / 5 项');

  // 收满显示极差、趋势、候选
  await expect(page.getByTestId('summary-range')).toHaveText('4 mg');
  await expect(page.getByTestId('summary-trend')).toHaveText('合格');
  await expect(page.getByTestId('summary-candidate')).toHaveText('505 mg');
});

test('极差与趋势同时失败时按顺序同时反馈，步骤与日志不变；合格后确认前进', async ({
  page,
}) => {
  await importAndStart(page);
  await scanBarcode(page, 'BC-NACL-01');

  // 500..508 步长 2：极差 8（>4）、斜率 2（>1），候选 504 在区间内
  await addReadings(page, [500, 502, 504, 506, 508]);
  await expect(page.getByTestId('summary-trend')).toHaveText('超差');
  await page.getByTestId('stable-confirm-button').click();

  const errs = page.getByTestId('stability-errors').locator('li');
  await expect(errs).toHaveCount(2);
  await expect(errs.nth(0)).toContainText('极差');
  await expect(errs.nth(1)).toContainText('趋势');

  // 失败：步骤与日志不变
  await expect(page.getByTestId('step-indicator')).toHaveText('步骤 1 / 3');
  await expect(page.getByTestId('log-empty')).toBeVisible();

  // 录入合格窗口 500..504（极差 4、斜率边界 1、候选 502），确认后前进
  for (const v of [500, 501, 502, 503, 504]) {
    await addReading(page, String(v));
  }
  await page.getByTestId('stable-confirm-button').click();

  // 进入旧单次称量步骤
  await expect(page.getByTestId('step-indicator')).toHaveText('步骤 2 / 3');
  await expect(page.getByTestId('barcode-input')).toBeVisible();
  await expect(page.getByTestId('stable-barcode-input')).toHaveCount(0);

  // 日志含读数证据
  const row1 = page.getByTestId('dose-log').locator('tbody tr').nth(0);
  await expect(row1).toContainText('NaCl-500');
  await expect(row1).toContainText('502 mg');
  await expect(page.getByTestId('log-readings-1')).toHaveText(
    '500 mg，501 mg，502 mg，503 mg，504 mg',
  );
});

test('旧单次称量步骤后接偶数稳定窗口：双中位项均值向下取整并保存证据', async ({ page }) => {
  await importAndStart(page);
  await scanBarcode(page, 'BC-NACL-01');
  await addReadings(page, [500, 500, 500, 500, 500]);
  await page.getByTestId('stable-confirm-button').click();

  // 步骤 2：旧流程
  await expect(page.getByTestId('step-indicator')).toHaveText('步骤 2 / 3');
  await page.getByTestId('barcode-input').fill('BC-KCL-02');
  await page.getByTestId('dose-input').fill('200');
  await page.getByTestId('confirm-button').click();

  // 步骤 3：偶数 N=4。读数 1000,1000,1001,1001：两中位项 1000 与 1001，
  // 均值 1000.5 整除 2 向下取整为 1000。
  await expect(page.getByTestId('step-indicator')).toHaveText('步骤 3 / 3');
  await scanBarcode(page, 'BC-GLU-03');
  await addReadings(page, [1000, 1000, 1001, 1001]);
  await expect(page.getByTestId('summary-range')).toHaveText('1 mg');
  await expect(page.getByTestId('summary-candidate')).toHaveText('1000 mg');
  await page.getByTestId('stable-confirm-button').click();

  await expect(page.getByTestId('complete-banner')).toBeVisible();
  const rows = page.getByTestId('dose-log').locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(page.getByTestId('log-readings-3')).toHaveText(
    '1000 mg，1000 mg，1001 mg，1001 mg',
  );
  await expect(rows.nth(2)).toContainText('1000 mg');
  // 旧步骤无读数证据
  await expect(page.getByTestId('log-readings-2')).toHaveText('—');
});

test('稳定步骤 afterPrepare 崩溃：丢弃未提交记录，刷新后仍在原步骤且窗口可重录', async ({
  page,
}) => {
  await importAndStart(page);
  await armFault(page, 'afterPrepare');
  await scanBarcode(page, 'BC-NACL-01');
  await addReadings(page, [500, 501, 502, 503, 504]);
  await page.getByTestId('stable-confirm-button').click();
  await expect(page.getByTestId('crash-banner')).toBeVisible();
  await expect(page.getByTestId('crash-banner')).toContainText('afterPrepare');

  await page.reload();
  await expect(page.getByTestId('step-indicator')).toHaveText('步骤 1 / 3');
  await expect(page.getByTestId('log-empty')).toBeVisible();

  // 重新录入并确认成功
  await scanBarcode(page, 'BC-NACL-01');
  await addReadings(page, [500, 500, 500, 500, 500]);
  await page.getByTestId('stable-confirm-button').click();
  await expect(page.getByTestId('step-indicator')).toHaveText('步骤 2 / 3');
});

test('稳定步骤 afterCommit 崩溃：仅重放一次已提交记录，刷新后落到下一步且证据一致', async ({
  page,
}) => {
  await importAndStart(page);
  await armFault(page, 'afterCommit');
  await scanBarcode(page, 'BC-NACL-01');
  await addReadings(page, [500, 501, 502, 503, 504]);
  await page.getByTestId('stable-confirm-button').click();
  await expect(page.getByTestId('crash-banner')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('step-indicator')).toHaveText('步骤 2 / 3');
  await expect(page.getByTestId('dose-log').locator('tbody tr')).toHaveCount(1);
  await expect(page.getByTestId('log-readings-1')).toHaveText(
    '500 mg，501 mg，502 mg，503 mg，504 mg',
  );
  await expect(page.getByTestId('dose-log')).toContainText('502 mg');

  // 继续完成批次：序号 2、3 正常，无重复
  await page.getByTestId('barcode-input').fill('BC-KCL-02');
  await page.getByTestId('dose-input').fill('200');
  await page.getByTestId('confirm-button').click();

  await scanBarcode(page, 'BC-GLU-03');
  await addReadings(page, [1000, 1000, 1001, 1001]);
  await page.getByTestId('stable-confirm-button').click();
  await expect(page.getByTestId('complete-banner')).toBeVisible();
  await expect(page.getByTestId('dose-log').locator('tbody tr')).toHaveCount(3);
});
