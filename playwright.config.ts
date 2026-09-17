import { defineConfig } from '@playwright/test';

/**
 * e2e 针对生产构建（vite preview 静态服务）运行，与 Docker 中 verify 服务的行为一致。
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    // 受限容器（无沙箱权限）中可设置 PLAYWRIGHT_NO_SANDBOX=1；默认行为不变。
    launchOptions: process.env.PLAYWRIGHT_NO_SANDBOX
      ? { args: ['--no-sandbox', '--disable-dev-shm-usage'] }
      : undefined,
  },
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});
