import { expect, test, type Page } from '@playwright/test';

/**
 * e2e 复现核心场景：导入校验、称量确认、失败不变、
 * 刷新/断电（afterPrepare、afterCommit 故障钩子）后的恢复。
 */

const RECIPE = {
  steps: [
    { id: 'NaCl-500', barcode: 'BC-NACL-01', targetMg: 500, toleranceMg: 10 },
    { id: 'KCl-200', barcode: 'BC-KCL-02', targetMg: 200, toleranceMg: 0 },
    { id: 'GLU-1000', barcode: 'BC-GLU-03', targetMg: 1000, toleranceMg: 1000 },
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
  await expect(page.getByTestId('barcode-input')).toBeVisible();
}

async function confirmDose(page: Page, barcode: string, dose: string) {
  await page.getByTestId('barcode-input').fill(barcode);
  await page.getByTestId('dose-input').fill(dose);
  await page.getByTestId('confirm-button').click();
}

async function armFault(page: Page, kind: 'afterPrepare' | 'afterCommit') {
  await page.waitForFunction(() => (window as any).__verify !== undefined);
  await page.evaluate((k) => {
    const v = (window as any).__verify;
    if (k === 'afterPrepare') v.armAfterPrepare();
    else v.armAfterCommit();
  }, kind);
}

test('配方错误一次全部返回并按步骤位置排序，批次不得开始', async ({ page }) => {
  await gotoImport(page);

  // JSON 语法错误
  await page.getByTestId('recipe-input').fill('{not json');
  await page.getByTestId('import-button').click();
  await expect(page.getByTestId('import-errors').locator('li')).toHaveCount(1);
  await expect(page.getByTestId('import-errors')).toContainText('JSON 解析失败');

  // 多步多处错误：步骤 2 三处、步骤 3 两处，须按位置稳定排序
  const bad = {
    steps: [
      { id: 'OK-1', barcode: 'BC-1', targetMg: 100, toleranceMg: 10 },
      { id: '', barcode: 'BC-2', targetMg: 0, toleranceMg: -1 },
      { id: 'OK-1', barcode: 'BC-3', targetMg: 50, toleranceMg: 60 },
    ],
  };
  await page.getByTestId('recipe-input').fill(JSON.stringify(bad));
  await page.getByTestId('import-button').click();

  const items = page.getByTestId('import-errors').locator('li');
  await expect(items).toHaveCount(5);
  await expect(items.nth(0)).toContainText('步骤 2：编号');
  await expect(items.nth(1)).toContainText('步骤 2：目标量');
  await expect(items.nth(2)).toContainText('步骤 2：容差');
  await expect(items.nth(3)).toContainText('步骤 3：编号 "OK-1" 与步骤 1 重复');
  await expect(items.nth(4)).toContainText('步骤 3：容差不得超过目标量');

  // 批次不得开始：仍在导入界面
  await expect(page.getByTestId('recipe-input')).toBeVisible();
  await expect(page.getByTestId('start-batch-button')).toHaveCount(0);
});

test('称量全流程：失败时步骤与日志均不改变，闭区间边界可确认，最终完成', async ({ page }) => {
  await importAndStart(page);

  await expect(page.getByTestId('step-indicator')).toHaveText('步骤 1 / 3');
  await expect(page.getByTestId('current-step-id')).toHaveText('NaCl-500');
  await expect(page.getByTestId('acceptable-range')).toHaveText('[490, 510] mg');

  // 条码不一致 → 步骤与日志不变
  await confirmDose(page, 'BC-WRONG', '500');
  await expect(page.getByTestId('weigh-error')).toContainText('条码');
  await expect(page.getByTestId('step-indicator')).toHaveText('步骤 1 / 3');
  await expect(page.getByTestId('log-empty')).toBeVisible();

  // 超出闭区间 → 步骤与日志不变
  await confirmDose(page, 'BC-NACL-01', '511');
  await expect(page.getByTestId('weigh-error')).toContainText('闭区间');
  await expect(page.getByTestId('step-indicator')).toHaveText('步骤 1 / 3');
  await expect(page.getByTestId('log-empty')).toBeVisible();

  // 非整数 → 步骤与日志不变
  await confirmDose(page, 'BC-NACL-01', '500.5');
  await expect(page.getByTestId('weigh-error')).toContainText('整数');
  await expect(page.getByTestId('log-empty')).toBeVisible();

  // 下边界（闭区间）→ 确认成功
  await confirmDose(page, 'BC-NACL-01', '490');
  await expect(page.getByTestId('step-indicator')).toHaveText('步骤 2 / 3');
  await expect(page.getByTestId('current-step-id')).toHaveText('KCl-200');

  // 容差为 0：仅目标量可确认
  await confirmDose(page, 'BC-KCL-02', '199');
  await expect(page.getByTestId('weigh-error')).toContainText('闭区间');
  await confirmDose(page, 'BC-KCL-02', '200');
  await expect(page.getByTestId('step-indicator')).toHaveText('步骤 3 / 3');

  // 容差等于目标量：0 mg 在下边界上，可确认
  await confirmDose(page, 'BC-GLU-03', '0');
  await expect(page.getByTestId('complete-banner')).toBeVisible();

  const rows = page.getByTestId('dose-log').locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(page.getByTestId('dose-log')).toContainText('490 mg');
  await expect(page.getByTestId('dose-log')).toContainText('200 mg');
});

test('刷新页面后从已提交前缀恢复，且配方不可替换', async ({ page }) => {
  await importAndStart(page);
  await confirmDose(page, 'BC-NACL-01', '500');
  await expect(page.getByTestId('step-indicator')).toHaveText('步骤 2 / 3');

  await page.reload();
  // 直接回到称量界面（配方已锁定，不再出现导入界面）
  await expect(page.getByTestId('step-indicator')).toHaveText('步骤 2 / 3');
  await expect(page.getByTestId('recipe-input')).toHaveCount(0);
  await expect(page.getByTestId('dose-log')).toContainText('NaCl-500');
  await expect(page.getByTestId('dose-log')).toContainText('500 mg');
});

test('afterPrepare 崩溃：悬空预备记录被清理，不跳过原料也不重复剂量', async ({ page }) => {
  await importAndStart(page);
  await armFault(page, 'afterPrepare');

  await confirmDose(page, 'BC-NACL-01', '500');
  await expect(page.getByTestId('crash-banner')).toBeVisible();
  await expect(page.getByTestId('crash-banner')).toContainText('afterPrepare');

  // 刷新（模拟重启）：悬空预备记录被删除，仍在步骤 1，日志为空
  await page.reload();
  await expect(page.getByTestId('step-indicator')).toHaveText('步骤 1 / 3');
  await expect(page.getByTestId('log-empty')).toBeVisible();

  // 可正常继续：既不跳过当前原料，也不重复已确认剂量
  await confirmDose(page, 'BC-NACL-01', '500');
  await expect(page.getByTestId('step-indicator')).toHaveText('步骤 2 / 3');
  await expect(page.getByTestId('dose-log').locator('tbody tr')).toHaveCount(1);
});

test('afterCommit 崩溃：标记已落盘，恢复后该剂量生效且不会重复加入', async ({ page }) => {
  await importAndStart(page);
  await armFault(page, 'afterCommit');

  await confirmDose(page, 'BC-NACL-01', '500');
  await expect(page.getByTestId('crash-banner')).toBeVisible();
  await expect(page.getByTestId('crash-banner')).toContainText('afterCommit');

  // 刷新：提交标记齐全的序号 1 被重放，界面直接落在步骤 2
  await page.reload();
  await expect(page.getByTestId('step-indicator')).toHaveText('步骤 2 / 3');
  await expect(page.getByTestId('dose-log').locator('tbody tr')).toHaveCount(1);
  await expect(page.getByTestId('dose-log')).toContainText('500 mg');

  // 继续完成剩余步骤，确认序号递增、无重复
  await confirmDose(page, 'BC-KCL-02', '200');
  await confirmDose(page, 'BC-GLU-03', '1500');
  await expect(page.getByTestId('complete-banner')).toBeVisible();
  await expect(page.getByTestId('dose-log').locator('tbody tr')).toHaveCount(3);
});
