import { expect, test, type Page } from '@playwright/test';

/**
 * 稳定读数策略 e2e：策略校验、逐项录入（非法不入窗、仅留最后 N 项）、
 * 收满后显示极差/趋势/候选剂量、失败不前进、领域重算确认，
 * 以及 afterPrepare / afterCommit 后读数证据的丢弃与重放。
 */

const STABLE_RECIPE = {
  steps: [
    { id: 'NaCl-500', barcode: 'BC-NACL-01', targetMg: 500, toleranceMg: 10 },
    {
      id: 'KCl-200',
      barcode: 'BC-KCL-02',
      targetMg: 200,
      toleranceMg: 10,
      stable: { samples: 4, maxRangeMg: 5, maxDrift: 1 },
    },
  ],
};

async function gotoImport(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('recipe-input')).toBeVisible();
}

async function importAndStart(page: Page, recipe: unknown = STABLE_RECIPE) {
  await gotoImport(page);
  await page.getByTestId('recipe-input').fill(JSON.stringify(recipe));
  await page.getByTestId('import-button').click();
  await expect(page.getByTestId('start-batch-button')).toBeVisible();
  await page.getByTestId('start-batch-button').click();
  await expect(page.getByTestId('barcode-input')).toBeVisible();
}

async function confirmSingle(page: Page, barcode: string, dose: string) {
  await page.getByTestId('barcode-input').fill(barcode);
  await page.getByTestId('dose-input').fill(dose);
  await page.getByTestId('confirm-button').click();
}

async function scanStable(page: Page, barcode: string) {
  await page.getByTestId('stable-barcode-input').fill(barcode);
  await expect(page.getByTestId('stable-reading-input')).toBeEnabled();
}

async function addReading(page: Page, value: string) {
  await page.getByTestId('stable-reading-input').fill(value);
  await page.getByTestId('stable-add-button').click();
}

async function armFault(page: Page, kind: 'afterPrepare' | 'afterCommit') {
  await page.waitForFunction(() => (window as any).__verify !== undefined);
  await page.evaluate((k) => {
    const v = (window as any).__verify;
    if (k === 'afterPrepare') v.armAfterPrepare();
    else v.armAfterCommit();
  }, kind);
}

test('预览展示稳定策略；非法策略并入配方错误清单', async ({ page }) => {
  await gotoImport(page);

  // 非法 stable：samples 越界、极差为负、漂移非整数
  const bad = {
    steps: [
      {
        id: 'A',
        barcode: 'BC-A',
        targetMg: 100,
        toleranceMg: 10,
        stable: { samples: 2, maxRangeMg: -1, maxDrift: 1.5 },
      },
    ],
  };
  await page.getByTestId('recipe-input').fill(JSON.stringify(bad));
  await page.getByTestId('import-button').click();
  const items = page.getByTestId('import-errors').locator('li');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText('采样数须为 3 至 9');
  await expect(items.nth(1)).toContainText('最大极差须为非负安全整数');
  await expect(items.nth(2)).toContainText('每次采样最大漂移须为非负安全整数');
  await expect(page.getByTestId('start-batch-button')).toHaveCount(0);

  // 合法策略：预览中标出参数；无策略步骤显示单次称量
  await page.getByTestId('recipe-input').fill(JSON.stringify(STABLE_RECIPE));
  await page.getByTestId('import-button').click();
  const rows = page.getByTestId('preview-steps').locator('tbody tr');
  await expect(rows.nth(0).getByTestId('preview-stable')).toHaveText('单次称量');
  await expect(rows.nth(1).getByTestId('preview-stable')).toContainText('N=4');
  await expect(rows.nth(1).getByTestId('preview-stable')).toContainText('极差≤5 mg');
  await expect(rows.nth(1).getByTestId('preview-stable')).toContainText('漂移≤1 mg/次');
});

test('稳定读数：非法读数不入窗、仅保留最后 N 项，收满后显示极差/趋势/候选', async ({ page }) => {
  await importAndStart(page);
  await confirmSingle(page, 'BC-NACL-01', '500');

  await expect(page.getByTestId('step-indicator')).toContainText('步骤 2 / 2（稳定读数）');
  await expect(page.getByTestId('stable-strategy')).toContainText('N=4');

  // 未扫描当前原料：读数录入禁用
  await expect(page.getByTestId('stable-reading-input')).toBeDisabled();
  await scanStable(page, 'BC-KCL-02');

  // 非法读数不进入窗口，给出录入错误
  for (const bad of ['abc', '-5', '1.5', '']) {
    await addReading(page, bad);
    await expect(page.getByTestId('stable-input-error')).toBeVisible();
  }
  await expect(page.getByTestId('stable-count')).toHaveText('已收读数 0 / 4');

  // 先录入一项应被挤出窗口的旧读数，再录入 4 项合格读数
  await addReading(page, '999');
  await expect(page.getByTestId('stable-count')).toHaveText('已收读数 1 / 4');
  await addReading(page, '200');
  await addReading(page, '200');
  await expect(page.getByTestId('stable-count')).toHaveText('已收读数 3 / 4');
  // 收满前不显示统计、确认按钮不可用
  await expect(page.getByTestId('stable-stats')).toHaveCount(0);
  await expect(page.getByTestId('stable-confirm-button')).toBeDisabled();
  await addReading(page, '201'); // 第 4 项：窗口 999,200,200,201（临时收满）
  await addReading(page, '201'); // 第 5 项：999 被挤出，窗口仅留最后 4 项

  // 窗口仅保留最后 4 项（999 已被挤出），x=0…3
  const shown = page.getByTestId('stable-reading-item');
  await expect(shown).toHaveText(['200 mg', '200 mg', '201 mg', '201 mg']);
  // 候选 (200+201)/2 向下取整 = 200；极差 1；趋势合格
  await expect(page.getByTestId('stable-range')).toContainText('1 mg');
  await expect(page.getByTestId('stable-trend')).toContainText('✓');
  await expect(page.getByTestId('stable-candidate')).toContainText('200 mg');
});

test('稳定读数：极差与趋势同时失败时不前进、不写日志', async ({ page }) => {
  await importAndStart(page);
  await confirmSingle(page, 'BC-NACL-01', '500');
  await scanStable(page, 'BC-KCL-02');

  for (const v of ['200', '200', '220', '220']) await addReading(page, v);
  await expect(page.getByTestId('stable-range')).toContainText('20 mg');
  await expect(page.getByTestId('stable-range')).toContainText('超差');
  await expect(page.getByTestId('stable-trend')).toContainText('超差');
  // 候选 210 在闭区间 [190,210] 边界上，故仅极差、趋势两项失败
  await expect(page.getByTestId('stable-candidate')).toContainText('210 mg');

  // 即便点击确认，领域层拒绝并同时反馈两项，步骤与日志不变
  await page.getByTestId('stable-confirm-button').click();
  const errs = page.getByTestId('stable-errors').locator('li');
  await expect(errs).toHaveCount(2);
  await expect(errs.nth(0)).toContainText('极差 20 mg 超过最大极差 5 mg');
  await expect(errs.nth(1)).toContainText('读数趋势超过每次采样最大漂移 1 mg');
  await expect(page.getByTestId('step-indicator')).toContainText('步骤 2 / 2');
  const logRows = page.getByTestId('dose-log').locator('tbody tr');
  await expect(logRows).toHaveCount(1);
  await expect(logRows).toContainText('NaCl-500');
});

test('稳定读数成功：领域重算剂量并前进，日志保存读数证据', async ({ page }) => {
  await importAndStart(page);
  await confirmSingle(page, 'BC-NACL-01', '500');
  await scanStable(page, 'BC-KCL-02');
  for (const v of ['200', '200', '201', '201']) await addReading(page, v);
  await page.getByTestId('stable-confirm-button').click();

  await expect(page.getByTestId('complete-banner')).toBeVisible();
  const rows = page.getByTestId('dose-log').locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('NaCl-500');
  await expect(rows.nth(0)).toContainText('500 mg');
  await expect(rows.nth(0).getByTestId('dose-evidence')).toHaveText('—');
  await expect(rows.nth(1)).toContainText('KCl-200');
  await expect(rows.nth(1)).toContainText('200 mg'); // 偶数窗口向下取整
  await expect(rows.nth(1).getByTestId('dose-evidence')).toHaveText('200, 200, 201, 201 mg');
});

test('afterPrepare：稳定确认的未提交预备记录刷新后丢弃，可重新确认', async ({ page }) => {
  await importAndStart(page);
  await confirmSingle(page, 'BC-NACL-01', '500');
  await armFault(page, 'afterPrepare');
  await scanStable(page, 'BC-KCL-02');
  for (const v of ['200', '200', '201', '201']) await addReading(page, v);
  await page.getByTestId('stable-confirm-button').click();
  await expect(page.getByTestId('crash-banner')).toBeVisible();

  await page.reload();
  // 仍在稳定步骤，日志仅含步骤 1
  await expect(page.getByTestId('step-indicator')).toContainText('步骤 2 / 2（稳定读数）');
  await expect(page.getByTestId('dose-log').locator('tbody tr')).toHaveCount(1);
  await expect(page.getByTestId('stable-count')).toHaveText('已收读数 0 / 4');

  // 重新录入并确认后正常完成
  await scanStable(page, 'BC-KCL-02');
  for (const v of ['200', '200', '201', '201']) await addReading(page, v);
  await page.getByTestId('stable-confirm-button').click();
  await expect(page.getByTestId('complete-banner')).toBeVisible();
  await expect(page.getByTestId('dose-log').locator('tbody tr')).toHaveCount(2);
});

test('afterCommit：稳定记录已提交，刷新后重放一次，读数证据与剂量一致', async ({ page }) => {
  await importAndStart(page);
  await confirmSingle(page, 'BC-NACL-01', '500');
  await armFault(page, 'afterCommit');
  await scanStable(page, 'BC-KCL-02');
  for (const v of ['200', '200', '201', '201']) await addReading(page, v);
  await page.getByTestId('stable-confirm-button').click();
  await expect(page.getByTestId('crash-banner')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('complete-banner')).toBeVisible();
  const rows = page.getByTestId('dose-log').locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText('KCl-200');
  await expect(rows.nth(1)).toContainText('200 mg');
  await expect(rows.nth(1).getByTestId('dose-evidence')).toHaveText('200, 200, 201, 201 mg');

  // 再次刷新：同一已提交记录仍只重放一次，不重复加入
  await page.reload();
  await expect(page.getByTestId('dose-log').locator('tbody tr')).toHaveCount(2);
});
