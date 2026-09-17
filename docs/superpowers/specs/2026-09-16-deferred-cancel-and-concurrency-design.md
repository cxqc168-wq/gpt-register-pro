# 后台延迟取消 + 并发注册 设计方案

日期：2026-09-16
状态：已批准（用户确认"按这个方案来"）

## 背景与问题

当前碰到"手机号已存在账号"（`PHONE_ALREADY_REGISTERED`）时，主流程在
[index.js#L1926-L1931](file:///d:/My_Codeproject/gpt-register-clean-main/gpt-register-clean-main/index.js#L1926-L1931)
同步执行 `await smsProvider.cancel()`。

对于 Grizzly 服务商，`src/grizzlySmsProvider.js` 的 `cancel()` 会在号码创建不足 2 分钟时
收到 `EARLY_CANCEL_DENIED`，并每 15s 轮询重试直到取消失败或超过 5 分钟窗口。这会导致主流程
被阻塞近 2 分钟，白白拖慢整批注册速度。

此外，当前 `startBatch` 的注册主循环是严格串行的（每次一个 `runSingleRegistration()`，
各自独立浏览器实例），吞吐有限。

## 目标

1. 遇到 `PHONE_ALREADY_REGISTERED` 时**直接跳过取消轮询**，立即进入下一个号码的注册。
2. **记住该时刻**，在 2 分钟之后由**后台任务**补做取消，保证退款不遗漏、不阻塞主流程。
3. **新增并发运行**：多个注册任务并行执行（默认 3，可配置），每个任务独立浏览器实例。
4. 程序跑完（达到目标数量）时，**退出前等待所有待取消号码排空**，确保退款。

## 架构与改动

### 1. 新增模块 `src/deferredCancelManager.js`

一个后台延迟取消管理器，负责把"已注册号码"的取消从主流程剥离：

- `schedule(provider, { readyAtMs, phone })`：注册一个待取消号码，**立即返回、不阻塞**。
  内部启动后台任务，等到 `readyAtMs` 后调用 `provider.cancel()`。
  - 后台定时器默认 keep reference（不 `unref`），因此主流程继续跑下一个号码时，
    取消任务也会在后台自然完成。
  - 返回一个在取消完成时 resolve 的 Promise（供 `flush()` 汇总）。
- `flush()`：等待所有已排队的取消完成。对尚未到 `readyAtMs` 的项，先等到点再取消；
  确保退款不遗漏。
- 约束：
  - 同一号码/同一 `provider` 不允许被重复取消（用 `cancelling` 标记 + 完成后从集合移除防重）。
  - `cancel()` 内部的异常被吞掉并打印 warn（沿用现有容错语义：号码到期后自动退款，不阻塞）。

### 2. 修改 `index.js` 的 `runSingleRegistration` 取消逻辑

把 [index.js#L1926-L1931](file:///d:/My_Codeproject/gpt-register-clean-main/gpt-register-clean-main/index.js#L1926-L1931)
中同步的取删除，改为后台调度：

```js
if (error?.code === 'PHONE_ALREADY_REGISTERED' && smsProvider?.activationId) {
    console.warn('[SMS] 当前号码已存在账号，改由后台在 2 分钟后取消，不阻塞本轮...');
    deferredCancelManager.schedule(smsProvider, {
        readyAtMs: Date.now() + SMS_CANCEL_GRACE_MS, // 2 分钟
        phone: smsProvider.getPhone?.(),
    });
}
```

- 删除原有 `await smsProvider.cancel()` 及 try/catch。
- 新增模块级常量 `SMS_CANCEL_GRACE_MS = 2 * 60 * 1000`。
- 时间语义：`readyAtMs = 检测到已注册的时刻 + 2 分钟`。
  号码是在本轮开始时创建的，故取消时刻必然晚于"创建后 2 分钟"，可规避 `EARLY_CANCEL_DENIED`；
  若已注册更晚才被检测到，取消时刻只会更晚、更安全。

### 3. 并发 worker 池改造 `startBatch`

- 新增并发参数：`--concurrency N`（CLI）或环境变量 `CONCURRENCY`，默认值 `3`。
  - 解析方式：显式解析 `--concurrency <n>`，与现有"裸数字参数作为 TARGET_COUNT"互不冲突。
- 把 [在主循环](file:///d:/My_Codeproject/gpt-register-clean-main/gpt-register-clean-main/index.js#L2293-L2317)
  与 Phase2 分支（[L2263-L2291](file:///d:/My_Codeproject/gpt-register-clean-main/gpt-register-clean-main/index.js#L2263-L2291)）
  的"单线程 `await runSingleRegistration()`"改为固定 N 个 worker 的并发池：
  - 每个 worker 独立调用 `runSingleRegistration()`（各自独立浏览器实例）。
  - 共享目标判定（token 数 / Phase2 数量）；达到目标后停止拉起新任务，
    `Promise.allSettled` 等待当前在跑任务收尾。
  - 每个任务成功/失败分别计入 `BATCH_FAILURES`，沿用现有重试/立即续跑逻辑。
  - 循环退出前调用 `deferredCancelManager.flush()`，再打印失败汇总、返回。

## 错误处理

- 后台取消失败：吞掉异常、打印 warn（`[SMS] 后台取消号码失败: ...`），由号码到期自动退款兜底。
- 并发下共享文件写入：见下面的风险，需在 plan 阶段确认原子性。

## 测试

1. `npm run check:desktop`（或现有的语法检查命令）通过。
2. 单测/手工验证：
   - 后台取消：构造 `PHONE_ALREADY_REGISTERED`，确认主流程立即返回进入下一号码，
     且在约 2 分钟后 `deferredCancelManager` 调用 `cancel()` 并成功退款。
   - 并发：`CONCURRENCY=2` 启动，观察两个注册任务并行执行、目标达成后正确收尾。
3. `--concurrency 1` 时应退化为原串行行为。

## 风险与注意点

- **共享文件并发写竞争**：`accounts.json`、Outlook 池、token 统计等可能被多个 worker 并发读写。
  需在实现时确认写入是否原子（如临时文件 + rename、追加互斥），必要时加锁。
- **资源占用**：每个 worker 独立浏览器实例，内存/CPU 随并发数上升；默认 3，可调小。
- **并发数上限**：建议实现时做合理性钳制（至少为 1）。