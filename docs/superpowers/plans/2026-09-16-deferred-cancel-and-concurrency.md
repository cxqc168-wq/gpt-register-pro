# 后台延迟取消 + 并发注册 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让"手机号已存在账号"时不再同步等待 2 分钟取消轮询，而是后台延迟补取消，并让整批注册并发运行（默认 3 个，可配置），提升整批注册进度。

**Architecture:** 新增两个小模块——`src/writeLock.js`（进程内按文件路径的异步互斥，保护并发下 JSON 读改写）与 `src/deferredCancelManager.js`（后台延迟取消）。改造 `index.js`：`PHONE_ALREADY_REGISTERED` 分支从 `await smsProvider.cancel()` 改为后台 `schedule()`；`startBatch` 两个循环改为固定 N worker 的并发池，结束前 `flush()` 排空后台取消。新参数 `--concurrency N` / 环境变量 `CONCURRENCY`（默认 3）。

**Tech Stack:** Node.js（CommonJS）、fs、Puppeteer 注册流水线。项目无已配置测试框架（`npm test` 仅报错），沿用既有约定：`node --check <file>` 语法校验 + 手工 CLI 跑批验证。

---

## 文件结构

- **Create `src/writeLock.js`** — 进程内基于文件名分组的 async 互斥锁，`withFileLock(filePath, fn)`。
- **Create `src/deferredCancelManager.js`** — `DeferredCancelManager`，`schedule()`/`flush()`。
- **Modify `index.js`** — 引入两个模块；新增常量 `SMS_CANCEL_GRACE_MS`、`CONCURRENCY`；把 `saveAccount`/`appendToJsonArrayFile` 改为 `async` 并加锁；`runSingleRegistration` 的取消改后台调度；`startBatch` 两个循环改并发池并在返回前 `flush()`，同时更新两个调用点加 `await`。
- **不新增文档/测试文件**（遵守项目惯例，纯逻辑模块用 `node -e` 内联断言验证）。

---

### Task 1: 创建 `src/writeLock.js`

**Files:**
- Create: `src/writeLock.js`

- [ ] **Step 1: 写出文件内容**

```js
/**
 * 进程内基于文件路径分组的异步互斥锁。
 * 并发 worker 池下，多个并行注册会对同一个 JSON 文件做"读-改-写"，
 * 必须串行化以避免覆盖丢失。锁按文件绝对路径分组，跨调用共享同一把锁。
 */
const locks = new Map();

/**
 * 在拿到 filePath 的锁后执行 fn，执行完毕释放锁。
 * @template T
 * @param {string} filePath 锁的依据路径（同一路径串行执行）
 * @param {() => T | Promise<T>} fn 临界区逻辑
 * @returns {Promise<T>}
 */
async function withFileLock(filePath, fn) {
    const prev = locks.get(filePath) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    locks.set(filePath, gate);
    await prev;
    try {
        return await fn();
    } finally {
        release();
    }
}

module.exports = { withFileLock };
```

- [ ] **Step 2: 语法校验 + 并发互斥逻辑内联验证**

Run:
```bash
node --check src/writeLock.js
node -e "const {withFileLock}=require('./src/writeLock');let log=[];const t=async(n)=>{await withFileLock('f',async()=>{log.push('start'+n);await new Promise(r=>setTimeout(r,30));log.push('end'+n);});};Promise.all([t(1),t(2)]).then(()=>console.log(JSON.stringify(log)))"
```
Expected:
- `node --check` 无输出（语法 OK）。
- 第 2 条输出 `["start1","end1","start2","end2"]`（任务 1、2 串行，互不交叠）。

- [ ] **Step 3: Commit**

```bash
git add src/writeLock.js
git commit -m "feat: add per-path async file lock for concurrent JSON writes"
```

> 注：本仓库当前无 `.git`（`git status` 会报 not a git repository）。若仍未初始化，提交步骤改为跳过并提示用户；编码仍需完整执行。

---

### Task 2: 创建 `src/deferredCancelManager.js`

**Files:**
- Create: `src/deferredCancelManager.js`

- [ ] **Step 1: 写出文件内容**

```js
/**
 * 后台延迟取消管理器。
 * 用途：号码已存在账号（PHONE_ALREADY_REGISTERED）时，不在主流程里同步轮询取消，
 * 而是登记并从后台在 readyAtMs 之后补做一次 cancel()，避免阻塞整批注册。
 * 后台定时器不 unref，保持进程存活，直到所有取消完成（配合 flush() 退出前排空）。
 */
class DeferredCancelManager {
    constructor() {
        /** @type {Set<unknown>} 正在后台执行取消的 provider（防重复取消） */
        this._inflight = new Set();
        /** @type {Set<Promise<boolean>>} 取消完成承诺（供 flush 等待） */
        this._pending = new Set();
    }

    /**
     * 登记一个待取消号码，立即返回、不阻塞调用方。
     * @param {import('./smsProvider').SMSProvider} provider 持有 activationId 与取消凭据
     * @param {{ readyAtMs: number, phone?: string }} options
     * @returns {Promise<boolean>} 后台取消完成的承诺；取消成功为 true
     */
    schedule(provider, { readyAtMs, phone } = {}) {
        const waitMs = Math.max(0, readyAtMs - Date.now());
        const label = phone || provider.getPhone?.() || provider.activationId || '号码';
        const task = (async () => {
            if (waitMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, waitMs));
            }
            return this._cancel(provider, label);
        })().catch(() => false);
        this._pending.add(task);
        task.finally(() => this._pending.delete(task));
        return task;
    }

    async _cancel(provider, label) {
        if (this._inflight.has(provider)) return false;
        this._inflight.add(provider);
        try {
            console.warn(`[SMS] 后台取消号码 ${label}（已等待到可取消时间）...`);
            await provider.cancel();
            return true;
        } catch (error) {
            console.error(`[SMS] 后台取消号码失败: ${error?.message || error}（号码到期后自动退款）`);
            return false;
        } finally {
            this._inflight.delete(provider);
        }
    }

    /**
     * 等待所有已排队的取消完成（含尚未到 readyAtMs 的，先等到点再取消）。
     * 进程退出前调用，确保退款不遗漏。
     */
    async flush() {
        const all = [...this._pending];
        if (all.length > 0) {
            console.log(`[SMS] 等待 ${all.length} 个后台取消任务排空...`);
            await Promise.all(all);
        }
    }
}

module.exports = { DeferredCancelManager };
```

- [ ] **Step 2: 语法校验 + 后台延迟取消 + 排空逻辑内联验证**

Run:
```bash
node --check src/deferredCancelManager.js
node -e "const {DeferredCancelManager}=require('./src/deferredCancelManager');const d=new DeferredCancelManager();const t0=Date.now();const p={getPhone:()=>'+1',activationId:7,cancel:async()=>{console.log('cancelAt',Date.now()-t0);}};d.schedule(p,{readyAtMs:Date.now()+60,phone:'+1'}).then(()=>d.flush().then(()=>console.log('done',Date.now()-t0)))"
```
Expected:
- `node --check` 无输出。
- 第 2 条依次输出 `cancelAt N`（N 约 ≥ 60）与 `done M`（M ≥ cancelAt，间隔为 flush 等待该任务完成）。证明：不阻塞返回、到点后台取消、flush 排空。

- [ ] **Step 3: Commit**

```bash
git add src/deferredCancelManager.js
git commit -m "feat: add deferred background cancel manager for PHONE_ALREADY_REGISTERED"
```

---

### Task 3: `index.js` 引入模块 + 共享 JSON 写入加锁

**Files:**
- Modify: `index.js`
- Test: `node --check index.js`

- [ ] **Step 1: 添加 require 与常量**

在 [index.js 顶部 require 区](file:///d:/My_Codeproject/gpt-register-clean-main/gpt-register-clean-main/index.js#L2-L11)（`config` 那一行之后）追加：

```js
const { DeferredCancelManager } = require('./src/deferredCancelManager');
const { withFileLock } = require('./src/writeLock');
```

在 [index.js#L35-L36](file:///d:/My_Codeproject/gpt-register-clean-main/gpt-register-clean-main/index.js#L35-L36)（`TARGET_COUNT` 声明后）追加：

```js
const SMS_CANCEL_GRACE_MS = 2 * 60 * 1000; // Grizzly 号码创建后需超过 2 分钟才可取消
const deferredCancelManager = new DeferredCancelManager();
```

- [ ] **Step 2: 把 `saveAccount` 改为 async 并加锁**

替换 [index.js#L896-L914](file:///d:/My_Codeproject/gpt-register-clean-main/gpt-register-clean-main/index.js#L896-L914) 的整个 `saveAccount`：

```js
async function saveAccount(phone, password, name, birthDate, phoneCountry = null, smsOperator = '', extra = {}) {
    await withFileLock(ACCOUNTS_FILE, () => {
        let accounts = [];
        if (fs.existsSync(ACCOUNTS_FILE)) {
            try { accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch (e) {}
        }
        const resolvedCountry = phoneCountry || resolvePhoneCountryForPhone(phone, SELECTED_PHONE_COUNTRY);
        accounts.push({
            phone, password, name, birthDate,
            phoneCountryCode: resolvedCountry?.isoCode || '',
            phoneCountryDialCode: resolvedCountry?.dialCode || '',
            phoneCountryName: resolvedCountry?.name || '',
            heroSmsCountry: resolvedCountry?.heroSmsCountry || null,
            smsOperator: smsOperator || SELECTED_SMS_OPERATOR || '',
            createdAt: new Date().toISOString(),
            status: 'registered',
        });
        fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
        console.log(`[账号] 已保存到 accounts.json (共 ${accounts.length} 个)`);
    });
}
```

- [ ] **Step 3: 更新 `saveAccount` 调用点为 await**

替换 [index.js#L1170](file:///d:/My_Codeproject/gpt-register-clean-main/gpt-register-clean-main/index.js#L1169-L1170) 的调用：

```js
        await saveAccount(smsProvider.getPhone(), userData.password, userData.fullName, userData.birthDate, phoneCountry, SELECTED_SMS_OPERATOR);
```

- [ ] **Step 4: 把 `appendToJsonArrayFile` / `appendFailedToShibai` 改为 async 并加锁**

替换 [index.js#L347-L358](file:///d:/My_Codeproject/gpt-register-clean-main/gpt-register-clean-main/index.js#L347-L358) 的两个函数：

```js
async function appendToJsonArrayFile(filePath, item) {
    let total = 0;
    await withFileLock(filePath, () => {
        const list = readJsonArray(filePath);
        list.push(item);
        fs.writeFileSync(filePath, JSON.stringify(list, null, 2));
        total = list.length;
    });
    return total;
}

async function appendFailedToShibai(entry) {
    const failedEntry = entry && typeof entry === 'object' ? { ...entry } : { raw: entry };
    const total = await appendToJsonArrayFile(SHIBAI_FILE, failedEntry);
    console.log(`[Phase8] appended failed record to shibai.json, total=${total}`);
}
```

- [ ] **Step 5: 更新 `appendFailedToShibai` 调用点为 await**

替换 [index.js#L2115](file:///d:/My_Codeproject/gpt-register-clean-main/gpt-register-clean-main/index.js#L2115)：

```js
            await appendFailedToShibai(entry);
```

- [ ] **Step 6: 语法校验**

Run: `node --check index.js`
Expected: 无输出（Pass）。

- [ ] **Step 7: Commit**

```bash
git add index.js
git commit -m "feat: serialize shared JSON writes under concurrency via withFileLock"
```

---

### Task 4: `runSingleRegistration` 取消逻辑改为后台延迟

**Files:**
- Modify: `index.js`
- Test: `node --check index.js`

- [ ] **Step 1: 替换同步取删除**

把 [index.js#L1926-L1931](file:///d:/My_Codeproject/gpt-register-clean-main/gpt-register-clean-main/index.js#L1926-L1931) 替换为：

```js
        if (error?.code === 'PHONE_ALREADY_REGISTERED' && smsProvider?.activationId) {
            console.warn(`[SMS] 当前号码已存在账号，改由后台在 ${SMS_CANCEL_GRACE_MS / 1000}s 后再取消，不阻塞本轮...`);
            deferredCancelManager.schedule(smsProvider, {
                readyAtMs: Date.now() + SMS_CANCEL_GRACE_MS,
                phone: smsProvider.getPhone?.(),
            }).catch(() => {});
        }
```

> 说明：`readyAtMs = 检测到已注册 + 2 分钟`。号码在本轮开始时创建，因此取消时刻必然晚于"创建后 2 分钟"，规避 Grizzly 的 `EARLY_CANCEL_DENIED`；若已注册更晚才被检测到，取消只会更晚、更安全。原 `await smsProvider.cancel()` 与 try/catch 已移除。

- [ ] **Step 2: 语法校验**

Run: `node --check index.js`
Expected: 无输出（Pass）。

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat: defer PHONE_ALREADY_REGISTERED cancellation to background (no blocking)"
```

---

### Task 5: 新增并发参数并改造 `startBatch` 为并发池

**Files:**
- Modify: `index.js`
- Test: `node --check index.js`

- [ ] **Step 1: 添加 CONCURRENCY 解析（默认 3）**

在 [index.js#L35 `TARGET_COUNT` 声明](file:///d:/My_Codeproject/gpt-register-clean-main/gpt-register-clean-main/index.js#L35) 之后新增一个解析逻辑。在 [index.js#L26 `const args` 附近对应位置](file:///d:/My_Codeproject/gpt-register-clean-main/gpt-register-clean-main/index.js#L26) 追加：

```js
// 并发注册数：--concurrency N 或环境变量 CONCURRENCY，默认 3；至少为 1。
function resolveConcurrency() {
    const argIndex = args.indexOf('--concurrency');
    const raw = argIndex >= 0 && args[argIndex + 1] !== undefined
        ? args[argIndex + 1]
        : (process.env.CONCURRENCY || '3');
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : 3;
}
```

同时在 [index.js#L35 常量区](file:///d:/My_Codeproject/gpt-register-clean-main/gpt-register-clean-main/index.js#L35)（`deferredCancelManager` 之后）追加：

```js
const CONCURRENCY = resolveConcurrency();
```

> `resolveConcurrency` 必须在 `args`（L26）之后声明使用；把它定义在 `args`、`PHASE2_ONLY` 等解析块的同一区域，保证顺序。

- [ ] **Step 2: 新增并发运行辅助函数**

在 `startBatch` 函数定义之前（可在 [index.js#L2186 `checkTokenCount`](file:///d:/My_Codeproject/gpt-register-clean-main/gpt-register-clean-main/index.js#L2186) 附近）新增：

```js
/**
 * 并发注册池：最多 maxWorkers 个 runOne 同时进行。
 * runOne 执行一次注册动作并返回 boolean（true=还需继续，false=达到目标停止）。
 * 停止后仍会等待所有在跑任务完成再 resolve。
 * @param {number} maxWorkers
 * @param {() => Promise<boolean>} runOne
 */
async function runConcurrentRegistration(maxWorkers, runOne) {
    if (maxWorkers < 1) maxWorkers = 1;
    let active = 0;
    let stop = false;
    await new Promise((resolve) => {
        const worker = async () => {
            while (!stop) {
                let go = true;
                try {
                    go = await runOne();
                } catch (error) {
                    console.error('[主程序] worker 异常:', error.message);
                    go = false;
                }
                if (!go) stop = true;
            }
            active--;
            if (active === 0) resolve();
        };
        for (let i = 0; i < maxWorkers; i++) {
            active++;
            worker();
        }
    });
}
```

- [ ] **Step 3: Phase2 分支保持串行，仅在返回前加 flush**

Phase2 分支复用已注册账号、依赖浏览器登录态，并发风险高，因此**保持原串行循环不变**，只在块尾、`return;` 之前加一次 flush，确保该分支下后台取消也被排空。

先在 [index.js#L2289-2291](file:///d:/My_Codeproject/gpt-register-clean-main/gpt-register-clean-main/index.js#L2289-L2291) 的 `console.log(\`\n[完成] Phase2 收尾数量...`)` 块之后、`return;` 之前插入：

```js
        await deferredCancelManager.flush();
```

即把原来：

```js
        console.log(`\n[完成] Phase2 收尾数量 (${completed}) 已达目标 (${target})。`);
        if (BATCH_FAILURES.length > 0) {
            printBatchFailureSummary(BATCH_FAILURES);
        }
        return;
```

改为：

```js
        console.log(`\n[完成] Phase2 收尾数量 (${completed}) 已达目标 (${target})。`);
        if (BATCH_FAILURES.length > 0) {
            printBatchFailureSummary(BATCH_FAILURES);
        }
        await deferredCancelManager.flush();
        return;
```

> 说明：不要改动 Phase2 的 while 循环逻辑本身；并发改造只作用于主注册循环（Step 4）。

- [ ] **Step 4: 改造主循环为并发池**

把 [index.js#L2293-L2321](file:///d:/My_Codeproject/gpt-register-clean-main/gpt-register-clean-main/index.js#L2293-L2321) 的 `while (true) { ... }` + 末尾 print 块整体替换为：

```js
    await runConcurrentRegistration(CONCURRENCY, async () => {
        const currentCount = await checkTokenCount();
        if (currentCount >= TARGET_COUNT) {
            return false;
        }
        console.log(`\n[进度] 新增 Token 数量 ${currentCount} / 目标新增 ${TARGET_COUNT}，还需 ${TARGET_COUNT - currentCount}`);

        try {
            await runSingleRegistration();
        } catch (error) {
            BATCH_FAILURES.push(buildRunContextSummary(error?.runContext || {}, error));
            const shouldRetryImmediately = !!error?.noRetryDelay
                || error?.code === 'SMS_ACTIVATION_CANCELLED'
                || error?.code === 'SMS_CODE_TIMEOUT_CANCELLED'
                || error?.code === 'PHONE_ALREADY_REGISTERED';
            if (!shouldRetryImmediately) {
                console.error('[主程序] 注册失败，10 秒后重试...');
                await new Promise(r => setTimeout(r, 10000));
            }
        }

        const now = await checkTokenCount();
        if (now >= TARGET_COUNT) {
            console.log(`\n[完成] 新增 Token 数量 (${now}) 已达目标 (${TARGET_COUNT})。`);
            return false;
        }
        return true;
    });

    // 完成后排空所有后台取消任务，确保退款不遗漏
    await deferredCancelManager.flush();

    if (BATCH_FAILURES.length > 0) {
        printBatchFailureSummary(BATCH_FAILURES);
    }
```

> 并发下每个 worker 每轮独立 `checkTokenCount`；达到目标后 `stop` 阻止再拉起新任务，但会等待已在跑的注册完成。并发可能较目标多出至多 (CONCURRENCY-1) 个（各 worker 读取到未达目标时同时开跑），属可接受的已知上限。

- [ ] **Step 5: 语法校验**

Run: `node --check index.js`
Expected: 无输出（Pass）。

- [ ] **Step 6: 校验参数解析（不回滚磁盘数据的纯逻辑跑批）**

Run:
```bash
node --check index.js
node -e "const fs=require('fs');const m=fs.readFileSync('index.js','utf8');if(!/resolveConcurrency\(\)/.test(m))process.exit(1);console.log('CONCURRENCY_REF_OK')"
```
Expected:
- `node --check` 无输出。
- 输出 `CONCURRENCY_REF_OK`。

- [ ] **Step 7: Commit**

```bash
git add index.js
git commit -m "feat: run batch registrations concurrently (default 3) and flush deferred cancels on exit"
```

---

### Task 6: 全量校验

**Files:**
- Test: 全仓

- [ ] **Step 1: 语法检查所有改动文件 + 桌面脚本**

Run:
```bash
node --check index.js
node --check src/writeLock.js
node --check src/deferredCancelManager.js
npm run check:desktop
```
Expected: 全部无错误（`check:desktop` 报 `desktop/main.js`、`preload.js`、`renderer/app.js` 均 OK）。

- [ ] **Step 2: 冒烟验证（串行退化）**

Run: `node index.js 1 --concurrency 1`
Expected: `CONCURRENCY` 生效且表现为原串行流程（每步仅 1 个注册），不崩溃、无语法错误报错。

- [ ] **Step 3: 冒烟验证（并发）**

Run: `node index.js 1 --concurrency 2`
Expected: 观察两个并发 worker 交替打印 `[进度]`，无 unhandled rejection。若环境缺少接码/邮箱凭据而在启动校验即退出（`process.exit(1)`），则确认退出前已打印启动校验错误且无 JS 语法错误即可。

- [ ] **Step 4: 验证后台取消不阻塞**

Run: `node index.js 1 --concurrency 1`
退回串行跑，观察日志出现 `[SMS] 当前号码已存在账号，改由后台在 120s 后再取消` 时，主流程是否立即进入下一轮（不再打印逐条 `[SMS:Grizzly] 暂不能取消...` 阻塞日志）；并在约 120s 后看到 `[SMS] 后台取消号码 ...（已等待到可取消时间）` / `激活已取消（退款）`。
Expected: 主流程不因该号码阻塞；后台在到点后完成取消。

- [ ] **Step 5: 记入项目记忆**

把「PHONE_ALREADY_REGISTERED 改后台延迟 2 分钟取消，不阻塞本轮；并发注册默认 3 可配」这则约定追加到 `c:\Users\18430\.trae-cn\memory\projects\<项目>\project_memory.md` 的 Engineering Conventions 一节（保留既有条目；若目录路径不确定，可省略并不阻塞交付）。

---

## 风险与已知上限

- **并发上限**：目标数量可能多出至多 (CONCURRENCY-1) 个注册（worker 读未达目标同时开跑）。可接受。
- **共享文件写入**：`accounts.json`/`shibai.json` 已通过 `withFileLock` 串行化；`OutlookPool` 走其自身实例队列，多实例并发仍可能存在窗口，但非本任务主路径（PHONE_ONLY/非 outlook 模式不依赖）。
- **资源占用**：每 worker 独立浏览器实例，内存/CPU 随 `CONCURRENCY` 上升；可通过 `--concurrency` 调小。
- **背景定时器不 unref**：跑批结束会自动等待后台取消完成；`flush()` 显式排空提供确定性收尾。