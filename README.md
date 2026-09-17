# 无菌配液称量工作台

纯前端称量工作台（TypeScript + React + Vite + CSS），**仅以 IndexedDB 持久化**，无业务后端、无在线调用。面向"刷新浏览器 / 终端断电"场景设计：操作员既不能跳过未确认原料，也不能重复加入已确认剂量。

## 核心机制

### 两阶段写入协议

每次确认以递增序号执行**两次相互独立的事务**：

1. 写入**预备记录**（含步骤与剂量）到 `prepares` 仓库；
2. 写入**提交标记**（仅序号）到 `commits` 仓库。

只有提交标记写入成功后，记录才进入内存中的已提交前缀，**界面随后才更新**。

### 崩溃恢复

每次启动（`Journal.open`）执行恢复：

1. **删除**无提交标记的**悬空预备记录**；
2. 从序号 1 起，只**重放**预备记录与提交标记**齐全**的**最长连续前缀**；
3. 界面状态完全由该前缀派生，每个序号最多应用一次（`applyRecordOnce` 幂等）。

### 故障钩子（供 verify 调用）

持久层提供 `afterPrepare`、`afterCommit` 两个故障钩子，分别模拟两次写入完成后的**立即终止**；每种钩子**每次启动仅触发一次**，触发后持久层拒绝后续一切操作。

- Vitest：`journal.armFault('afterPrepare' | 'afterCommit')`
- 浏览器 / Playwright：`window.__verify.armAfterPrepare()` / `window.__verify.armAfterCommit()`

### 配方规则

导入 JSON（`{ "steps": [...] }` 或顶层数组），1–30 个有序步骤：

| 字段 | 规则 |
| --- | --- |
| `id` | 唯一、非空 ASCII 字符串（可打印 ASCII） |
| `barcode` | 非空 ASCII 字符串 |
| `targetMg` | 至少 1 的整数毫克 |
| `toleranceMg` | 0 至目标量的整数 |

校验**一次返回全部错误**，并按步骤输入位置**稳定排序**（全局错误在前）；存在任何错误时批次不得开始。批次开始后配方不可替换。

### 称量规则

界面仅接受**当前步骤**的条码与整数称量值：条码**完全一致**且数值落在
`[targetMg − toleranceMg, targetMg + toleranceMg]` **闭区间**才可确认；
失败时步骤与日志均不改变（不产生任何写入）。

## 本地运行

```bash
npm ci
npm run dev        # 开发服务器 http://localhost:5173
npm run verify     # Vitest 单元测试 + Playwright 端到端测试（自动构建并以 vite preview 静态服务）
```

## Docker

```bash
# 静态 Web 应用（nginx），宿主端口可由 WEB_PORT 覆盖（默认 8080）
WEB_PORT=9000 docker compose up --build web

# 一次性 verify 服务：在容器内运行 Vitest 与 Playwright，随后退出
docker compose run --build --rm verify
```

## 目录结构

```
src/
  domain/       recipe.ts（配方校验）、weighing.ts（称量输入校验）
  persistence/  db.ts（IndexedDB 原语）、journal.ts（两阶段写入与恢复）、faults.ts（故障钩子）
  ui/           ImportView / PreviewView / BatchView
tests/
  recipe.test.ts、weighing.test.ts、journal.test.ts（Vitest + fake-indexeddb）
  e2e/workbench.spec.ts（Playwright，含 afterPrepare / afterCommit 崩溃恢复复现）
```
