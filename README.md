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
| `samples` | 可选，稳定读数采样数 N：3 至 9 的整数 |
| `maxRangeMg` | 可选，窗口读数最大极差：非负安全整数毫克 |
| `maxDriftMg` | 可选，每次采样最大漂移：非负安全整数毫克 |

三个稳定策略字段**要么全部缺省（旧配方，单次称量），要么同时声明**；任一出现即视为声明策略，非法（部分声明、越界、类型错误）并入同一份配方错误清单。

校验**一次返回全部错误**，并按步骤输入位置**稳定排序**（全局错误在前）；存在任何错误时批次不得开始。批次开始后配方不可替换。

### 称量规则

- **单次称量步骤**（未声明策略的旧配方）：界面仅接受**当前步骤**的条码与整数称量值：条码**完全一致**且数值落在 `[targetMg − toleranceMg, targetMg + toleranceMg]` **闭区间**才可确认；失败时步骤与日志均不改变（不产生任何写入）。
- **稳定读数步骤**（声明策略）：操作员先扫描当前原料条码，再**逐个录入**非负安全整数毫克读数；非法读数不进入窗口，界面仅保留**最后 N 项**。收满 N 项后显示极差、趋势与候选剂量并允许确认。

稳定判定一律采用 `x = 0 … N−1` 的最后 N 项，全部乘加使用 **BigInt**：

1. 数量：窗口须收满 N 项；
2. 极差：`max − min ≤ maxRangeMg`；
3. 趋势（最小二乘斜率绝对值）：
   `|N·Σxy − Σx·Σy| ≤ maxDriftMg × [N·Σx² − (Σx)²]`；
4. 候选剂量：读数升序排序后**两中位项之和整除 2**（偶数窗口即双中位项均值向下取整），且须落入步骤闭区间。

确认时**剂量由领域层依据读数证据重新计算**，界面无法注入候选值；不足 N 项、极差、趋势、剂量区间失败按此顺序**一次性同时反馈**且不写库；稳定步骤调用旧单次确认路径（或反之）一律拒绝。预备记录保存所用读数（恰为最后 N 项）与候选剂量，恢复时重算证据，证据缺失、数量不符、判定失败或剂量与证据不一致都会停止重放。

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
  domain/       recipe.ts（配方校验，含可选稳定策略）、weighing.ts（单次称量校验）、
                stability.ts（稳定读数：最后 N 项、极差、BigInt 趋势、两中位项候选剂量）
  persistence/  db.ts（IndexedDB 原语）、journal.ts（两阶段写入、稳定确认领域重算与恢复）、faults.ts（故障钩子）
  ui/           ImportView / PreviewView / BatchView（单次与稳定读数两种称量面板）
tests/
  recipe.test.ts、weighing.test.ts、stability.test.ts、journal.test.ts（Vitest + fake-indexeddb）
  e2e/workbench.spec.ts、stability.spec.ts（Playwright，含 afterPrepare / afterCommit 崩溃恢复复现）
```
