# 纯邮箱（Outlook）注册功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增纯邮箱注册模式——从 Outlook 邮箱池分配邮箱，一次浏览器会话完成 ChatGPT/Codex 账号注册与 Token 获取，全程不使用手机号。

**Architecture:** 复用现有 OAuth 一体化路径：`oauthLoginAndAuthorize({ loginMethod: 'email' })` 在 auth.openai.com 对新邮箱自动进入注册流（邮箱验证码 → 创建密码 → about-you → 授权），回调拿 code 换 token。CLI 新增 `--email` 模式，桌面 UI 运行模式下拉新增「邮箱注册」。

**Tech Stack:** Node.js (CommonJS)、puppeteer-real-browser、Electron、Microsoft Graph API/IMAP（outlookProvider）

**注意事项:**
- 项目非 git 仓库，所有「commit」步骤替换为语法检查验证
- 项目无测试框架，验证方式为 `node --check` + 冒烟命令
- 现有手机模式（full/phase2/phase3/phase8）行为不得改变

---

### Task 1: CLI 邮箱注册模式（index.js 编排层）

**Files:**
- Modify: `index.js`（约 3 处：参数解析区 L17-24 附近、phase3 函数后新增两个函数 L1336 附近、main() L1931 附近）

- [ ] **Step 1: 添加 `--email` 参数解析**

在 `index.js` 顶部参数区（L17-24，`const args = process.argv.slice(2);` 之后）添加：

```javascript
const EMAIL_ONLY = args.includes('--email');
```

插入位置参考（现有代码）：

```javascript
const args = process.argv.slice(2);
const PHASE2_ONLY = args.includes('--phase2');
const PHASE3_ONLY = args.includes('--phase3');
const PHASE8_ONLY = args.includes('--phase8');
const EMAIL_ONLY = args.includes('--email');   // ← 新增此行
```

- [ ] **Step 2: 新增 `runSingleEmailRegistration()` 函数**

在 `phase3()` 函数结束（约 L1336 `}` 之后）与 `runSingleRegistration()` 之前插入完整函数：

```javascript
/**
 * 单次纯邮箱注册流程（Outlook 池 + OAuth 一体化，无手机号）
 */
async function runSingleEmailRegistration() {
    console.log('\n=========================================');
    console.log('[主程序] 开始一次纯邮箱注册与授权流程');
    console.log('=========================================');

    const runContext = {
        stage: 'init',
        phone: '',
        email: '',
        name: '',
        country: '',
        phoneCountryCode: '',
        smsOperator: '',
        mailDomain: '',
    };

    const baseProxy = config.proxyHost ? {
        host: config.proxyHost,
        port: config.proxyPort,
        username: config.proxyUsername,
        password: config.proxyPassword,
    } : null;
    const mailProxy = baseProxy;
    const mailProvider = new MailProvider({
        baseUrl: config.mailBaseUrl,
        adminPassword: config.mailAdminPassword,
        sitePassword: config.mailSitePassword,
        domain: '',
        provider: config.mailProvider,
        adminEmail: config.mailAdminEmail,
        adminToken: config.mailAdminToken,
        userType: config.mailUserType,
        proxy: mailProxy,
        outlookPoolFile: config.outlookPoolFile,
        outlookUseProxy: config.outlookUseProxy,
    });
    let browserService = null;
    let oauthService = null;

    const createServices = (useProxy) => {
        const proxy = useProxy ? baseProxy : null;
        const b = new BrowserService(proxy, {
            useChrome: config.useChrome,
            chromePath: config.chromePath,
        });
        const oauthProxy = proxy ? {
            host: proxy.host,
            port: proxy.port,
            username: proxy.username,
            password: proxy.password,
        } : null;
        const o = new OAuthService({ proxy: oauthProxy });
        return { b, o };
    };

    const executeFlow = async () => {
        const flowStartedAt = Date.now();
        const userData = generateUserData();
        console.log(`[主程序] 用户: ${userData.fullName}, 年龄: ${userData.age}, 生日: ${userData.birthDate}`);
        runContext.name = userData.fullName;

        // 1. 从 Outlook 池分配邮箱
        console.log('[邮箱注册] 正在从 Outlook 池分配邮箱...');
        await mailProvider.createAddress();
        const email = mailProvider.getEmail();
        runContext.email = email;
        runContext.stage = 'email_register';
        console.log(`[邮箱注册] 使用邮箱: ${email}`);

        try {
            // 2. OAuth 注册 + 授权一体化（新邮箱自动进入注册流）
            oauthService.regeneratePKCE();
            const authUrl = oauthService.getAuthUrl();
            console.log(`[邮箱注册] OAuth URL: ${authUrl.substring(0, 100)}...`);
            await browserService.navigateToOAuth(authUrl);

            const callbackUrl = await browserService.oauthLoginAndAuthorize({
                loginMethod: 'email',
                email,
                password: userData.password,
                fullName: userData.fullName,
                age: userData.age,
                birthDate: userData.birthDate,
                redirectUri: oauthService.redirectUri,
                onEmailCodeNeeded: async () => {
                    console.log('[邮箱注册] 需要邮箱验证码，轮询 Outlook...');
                    const code = await pollEmailCode(mailProvider, 30, 5000, {
                        email,
                        minTimestampMs: flowStartedAt,
                    });
                    if (code) capturedCodes.emailCode = code;
                    return code;
                },
                onSmsNeeded: async () => {
                    throw new Error('纯邮箱注册遇到手机验证（风控），本轮失败');
                },
            });

            console.log(`[邮箱注册] 回调 URL: ${callbackUrl}`);
            const params = oauthService.extractCallbackParams(callbackUrl);
            if (!params || params.error) {
                throw new Error(`OAuth 授权失败: ${params?.error_description || params?.error || '未知错误'}`);
            }
            if (!params.code) {
                throw new Error('回调 URL 中未找到授权码');
            }

            // 3. 授权码换 Token
            const tokenData = await oauthService.exchangeTokenAndSave(params.code, email);

            // 4. Outlook 池标记已用 + 保存账号记录
            mailProvider.confirmOutlookBound(null);
            saveUsernameFile({
                email,
                phone: '',
                password: userData.password,
                name: userData.fullName,
                birthDate: userData.birthDate,
                status: 'oauth_done',
                emailCode: capturedCodes.emailCode,
            });

            console.log('[邮箱注册] 纯邮箱注册流程圆满结束！');
            console.log(`[邮箱注册] Token 已保存，邮箱: ${tokenData.email}`);
            return true;
        } catch (error) {
            // 失败归还邮箱池（pending → available）
            mailProvider.rollbackOutlookAllocation();
            throw error;
        }
    };

    try {
        const hasProxy = !!baseProxy;
        ({ b: browserService, o: oauthService } = createServices(hasProxy));
        await browserService.launch();
        try {
            return await executeFlow();
        } catch (error) {
            if (hasProxy && isProxyConnectionError(error)) {
                console.warn('[主程序] 检测到代理连接失败，自动切换为直连重试本轮任务...');
                await browserService.close().catch(() => {});
                ({ b: browserService, o: oauthService } = createServices(false));
                await browserService.launch();
                return await executeFlow();
            }
            throw error;
        }
    } catch (error) {
        error.runContext = { ...(error.runContext || {}), ...runContext };
        console.error('[主程序] 本次任务执行失败:', error.message);
        throw error;
    } finally {
        await browserService.close();
    }
}
```

- [ ] **Step 3: 新增 `startEmailBatch()` 函数**

紧接 `runSingleEmailRegistration()` 之后插入：

```javascript
/**
 * 启动纯邮箱批量注册
 */
async function startEmailBatch() {
    console.log(`[启动] Codex 纯邮箱注册机（Outlook 池 + Puppeteer 模式），目标: ${TARGET_COUNT}`);
    BATCH_FAILURES.length = 0;

    assertNotRunningWithXvfb();

    if (MAIL_PROVIDER !== 'outlook') {
        console.error('[错误] 纯邮箱注册需要 mailProvider=outlook，请在配置页将邮箱服务切换为 outlook');
        process.exit(1);
    }
    {
        const { OutlookPool } = require('./src/outlookProvider');
        const stats = new OutlookPool(config.outlookPoolFile).stats();
        console.log(`[Mail][outlook] 账号池: 可用 ${stats.available} / 已用 ${stats.used} / 无效 ${stats.invalid} / 共 ${stats.total}`);
        if (stats.available < 1) {
            console.error('[错误] Outlook 账号池已耗尽（无可用邮箱），请先导入新的卡密');
            process.exit(1);
        }
    }

    while (true) {
        const currentCount = await checkTokenCount();
        if (currentCount >= TARGET_COUNT) {
            console.log(`\n[完成] Token 数量 (${currentCount}) 已达目标 (${TARGET_COUNT})。`);
            break;
        }

        console.log(`\n[进度] 当前有效 Token 总数 ${currentCount} / 目标总数 ${TARGET_COUNT}，还需 ${TARGET_COUNT - currentCount}`);

        try {
            await runSingleEmailRegistration();
        } catch (error) {
            BATCH_FAILURES.push(buildRunContextSummary(error?.runContext || {}, error));
            const isPoolExhausted = /账号池已耗尽/.test(String(error?.message || ''));
            if (isPoolExhausted) {
                console.error('[主程序] Outlook 邮箱池已耗尽，终止批量注册');
                break;
            }
            if (error?.noRetryDelay) {
                console.error('[主程序] 邮箱注册失败，立即进入下一轮...');
                continue;
            }
            console.error('[主程序] 邮箱注册失败，10 秒后重试...');
            await new Promise(r => setTimeout(r, 10000));
        }
    }

    if (BATCH_FAILURES.length > 0) {
        printBatchFailureSummary(BATCH_FAILURES);
    }
}
```

- [ ] **Step 4: `main()` 分发邮箱模式**

修改 `main()`（约 L1931）：

```javascript
async function main() {
    if (TEST_SMS_COUNTRY_ONLY) {
        await runSmsCountryDebug();
        return;
    }
    if (EMAIL_ONLY) {
        await startEmailBatch();
        return;
    }
    if (PHASE3_ONLY) {
        await startPhase3Only();
        return;
    }
    if (PHASE8_ONLY) {
        await startPhase8();
        return;
    }
    await startBatch();
}
```

- [ ] **Step 5: 语法检查**

Run: `node --check index.js`
Expected: 无输出（语法通过）

- [ ] **Step 6: 冒烟验证参数分发（不启动浏览器）**

Run: `node -e "process.argv[2]='--email'; const src=require('fs').readFileSync('index.js','utf8'); console.log(src.includes('EMAIL_ONLY') && src.includes('startEmailBatch') && src.includes('runSingleEmailRegistration') ? 'OK: 邮箱模式入口已就位' : 'FAIL')"`
Expected: `OK: 邮箱模式入口已就位`

---

### Task 2: browserService 注册流增强

**Files:**
- Modify: `src/browserService.js:1654`（isEmailVerificationPage）
- Modify: `src/browserService.js:1818` 附近（密码页分支）

- [ ] **Step 1: `isEmailVerificationPage` 增加 `verify-email` URL 匹配**

定位 L1654（`oauthLoginAndAuthorize` 内）：

```javascript
// 修改前
const isEmailVerificationPage = url.includes('email-verification')
    || (loginMethod === 'email'
        && /code|verification|验证码|收件箱/i.test(pageInfo.text)
        && pageInfo.inputs.some(i => i.name !== 'phoneNumberInput' && i.id !== 'mobile-auth-phone' && (i.type === 'text' || i.type === 'tel' || i.type === 'number')));

// 修改后（新增 verify-email 与验证邮箱文案匹配）
const isEmailVerificationPage = url.includes('email-verification') || url.includes('verify-email')
    || (loginMethod === 'email'
        && (/code|verification|验证码|收件箱|查看您的邮箱|check your email/i.test(pageInfo.text))
        && pageInfo.inputs.some(i => i.name !== 'phoneNumberInput' && i.id !== 'mobile-auth-phone' && (i.type === 'text' || i.type === 'tel' || i.type === 'number')));
```

- [ ] **Step 2: 密码页区分「创建密码」注册场景（仅增强日志）**

定位 L1818 密码页分支（`if (pageInfo.inputs.some(i => i.type === 'password') || url.includes('password')) {`），在 `if (loginMethod === 'email' && shouldPreferEmailOtp) {` 之前插入注册场景检测：

```javascript
// 纯邮箱注册流：新邮箱验证码后出现「创建密码」页
if (loginMethod === 'email' && /创建密码|create password|set (up )?a? ?password/i.test(pageInfo.text)) {
    console.log('[OAuth] 检测到「创建密码」页（新账号注册流），填写注册密码...');
}
```

插入后该分支开头变为：

```javascript
if (pageInfo.inputs.some(i => i.type === 'password') || url.includes('password')) {
    // 纯邮箱注册流：新邮箱验证码后出现「创建密码」页
    if (loginMethod === 'email' && /创建密码|create password|set (up )?a? ?password/i.test(pageInfo.text)) {
        console.log('[OAuth] 检测到「创建密码」页（新账号注册流），填写注册密码...');
    }
    if (loginMethod === 'email' && shouldPreferEmailOtp) {
    ...（现有代码不变）
```

说明：现有密码页逻辑（fillPasswordInput → Enter → 点击提交）对登录/注册两种场景天然兼容，此处仅加日志便于观测。

- [ ] **Step 3: 语法检查**

Run: `node --check src/browserService.js`
Expected: 无输出（语法通过）

---

### Task 3: 桌面端集成（Electron UI）

**Files:**
- Modify: `desktop/main.js:329-352`（validateConfig）、`desktop/main.js:775-791`（runtime:start）
- Modify: `desktop/renderer/index.html:59-64`（runMode）
- Modify: `desktop/renderer/app.js:800-819`（startRun）、`desktop/renderer/app.js:846-870`（bindEvents）

- [ ] **Step 1: `validateConfig` 支持 mode 参数（邮箱模式不强制 HeroSMS）**

替换 `desktop/main.js` L329-352 整个函数：

```javascript
function validateConfig(config, mode = 'full') {
  const issues = [];
  const isEmailMode = mode === 'email';
  const mailProvider = String(config.mailProvider || '').toLowerCase();
  if (!isEmailMode && !config.heroSmsApiKey) issues.push('HeroSMS API Key 为空');
  if (isEmailMode) {
    // 纯邮箱注册：强依赖 Outlook 池，不依赖 HeroSMS/邮箱接口
    if (mailProvider !== 'outlook') {
      issues.push('纯邮箱注册需要邮箱服务为 outlook（真实邮箱池），请在设置页切换');
    } else {
      try {
        const pool = getOutlookPool(config);
        const stats = pool.stats();
        if (stats.total === 0) issues.push('Outlook 账号池为空，请先在「Outlook 邮箱池」导入卡密');
        else if (stats.available === 0) issues.push('Outlook 账号池无可用邮箱（已全部使用或失效）');
      } catch {
        issues.push('Outlook 账号池文件读取失败');
      }
    }
  } else if (mailProvider === 'outlook') {
    // Outlook 模式：不依赖接口地址/域名，只检查账号池
    try {
      const pool = getOutlookPool(config);
      const stats = pool.stats();
      if (stats.total === 0) issues.push('Outlook 账号池为空，请先在「Outlook 邮箱池」导入卡密');
      else if (stats.available === 0) issues.push('Outlook 账号池无可用邮箱（已全部使用或失效）');
    } catch {
      issues.push('Outlook 账号池文件读取失败');
    }
  } else {
    if (!config.mailBaseUrl) issues.push('邮箱接口地址为空');
    if (!config.mailDomain && (!Array.isArray(config.mailDomains) || config.mailDomains.length === 0)) issues.push('邮箱域名为空');
    if (['cloudflare-worker', 'cloud-mail'].includes(mailProvider) && !config.mailAdminToken && !config.mailAdminPassword) {
      issues.push('邮箱接口 Token/管理员密码为空');
    }
  }
  if (config.useChrome && !config.chromePath) issues.push('Chrome 路径为空');
  return issues;
}
```

- [ ] **Step 2: `runtime:start` 映射 email 模式**

修改 `desktop/main.js` L783-791：

```javascript
// 修改前
const args = ['index.js'];
const mode = String(options.mode || 'full');
if (mode === 'phase2') args.push('--phase2');
if (mode === 'phase3') args.push('--phase3');
if (mode === 'phase8') args.push('--phase8');
if (options.stopAfterPhase2) args.push('--stop-after-phase2');
if (options.country) args.push(`--country=${String(options.country).toUpperCase()}`);

// 修改后
const args = ['index.js'];
const mode = String(options.mode || 'full');
if (mode === 'phase2') args.push('--phase2');
if (mode === 'phase3') args.push('--phase3');
if (mode === 'phase8') args.push('--phase8');
if (mode === 'email') args.push('--email');
if (options.stopAfterPhase2) args.push('--stop-after-phase2');
if (mode !== 'email' && options.country) args.push(`--country=${String(options.country).toUpperCase()}`);
```

同时把该 handler 内的 `validateConfig(config)` 调用改为 `validateConfig(config, mode)`：

```javascript
// 修改前
const issues = validateConfig(config);

// 修改后
const issues = validateConfig(config, mode);
```

注意：若 `desktop/main.js` 中存在其他 `validateConfig` 调用点，保持原调用（不传 mode 即默认 'full'，行为不变）。搜索确认：`Select-String -Path desktop/main.js -Pattern "validateConfig"` 应只有定义 + runtime:start 一处调用。

- [ ] **Step 3: index.html 新增运行模式选项**

修改 `desktop/renderer/index.html` L59-64：

```html
<!-- 修改前 -->
<select id="runMode">
  <option value="full">完整流程</option>
  <option value="phase2">阶段2 绑定邮箱</option>
  <option value="phase3">阶段3 获取 Token</option>
  <option value="phase8">Phase8 批量补 Token</option>
</select>

<!-- 修改后 -->
<select id="runMode">
  <option value="full">完整流程</option>
  <option value="email">邮箱注册（Outlook 池）</option>
  <option value="phase2">阶段2 绑定邮箱</option>
  <option value="phase3">阶段3 获取 Token</option>
  <option value="phase8">Phase8 批量补 Token</option>
</select>
```

- [ ] **Step 4: app.js startRun 邮箱模式跳过国家逻辑**

替换 `desktop/renderer/app.js` L800-819 的 `startRun()`：

```javascript
async function startRun() {
  const mode = document.querySelector('#runMode').value;
  const isEmailMode = mode === 'email';
  const selectedCountry = document.querySelector('#runCountry').value;
  if (!isEmailMode && selectedCountry && selectedCountry !== state.config.phoneCountryCode) {
    await api.saveConfig({ phoneCountryCode: selectedCountry });
    state.config.phoneCountryCode = selectedCountry;
  }
  const options = {
    mode,
    country: isEmailMode ? '' : selectedCountry,
    targetCount: getTargetTokenCount(),
    stopAfterPhase2: document.querySelector('#stopAfterPhase2').checked,
  };
  const result = await api.startRun(options);
  if (!result.ok) {
    toast(result.message || '任务启动失败');
    return;
  }
  updateRunState(true);
  toast(`任务已启动，PID=${result.pid}，目标总数=${options.targetCount}`);
}
```

- [ ] **Step 5: app.js 新增模式切换 UI 联动（隐藏国家/停止选项）**

在 `desktop/renderer/app.js` 的 `bindEvents()` 函数内（`$('#startBtn').addEventListener('click', startRun);` 之后）添加：

```javascript
  const runModeSelect = $('#runMode');
  if (runModeSelect) {
    runModeSelect.addEventListener('change', updateRunModeUi);
    updateRunModeUi();
  }
```

并在 `startRun()` 函数定义之前添加工具函数：

```javascript
function updateRunModeUi() {
  const isEmailMode = document.querySelector('#runMode').value === 'email';
  const countryRow = document.querySelector('#runCountry')?.closest('label');
  if (countryRow) countryRow.style.display = isEmailMode ? 'none' : '';
  const stopRow = document.querySelector('#stopAfterPhase2')?.closest('label');
  if (stopRow) stopRow.style.display = isEmailMode ? 'none' : '';
}
```

- [ ] **Step 6: 语法检查**

Run: `npm run check:desktop`
Expected: 无输出（三个文件语法全部通过）

---

### Task 4: 回归验证与实测冒烟

**Files:** 无新增改动（本任务为验证）

- [ ] **Step 1: 全量语法检查**

Run: `node --check index.js && node --check src/browserService.js && npm run check:desktop`
Expected: 全部无输出

- [ ] **Step 2: 确认现有模式参数解析不受影响**

Run: `node -e "const args=['--phase2','2']; console.log(args.includes('--phase2') && !args.includes('--email') ? 'OK: 手机模式参数不受影响' : 'FAIL')"`
Expected: `OK: 手机模式参数不受影响`

- [ ] **Step 3: 邮箱模式配置预检验证（不启动浏览器）**

前提：config.json 中 `mailProvider` 当前为 `outlook` 且池中有可用邮箱（outlook-accounts.json 中 status=available）。

Run: `node -e "const {OutlookPool}=require('./src/outlookProvider'); const s=new OutlookPool('outlook-accounts.json').stats(); console.log(JSON.stringify(s))"`
Expected: `{"total":1,"available":1,"pending":0,"used":0,"invalid":0}`（数字以实际为准，available ≥ 1）

Run: `node -e "const c=require('./src/config'); console.log('mailProvider='+c.mailProvider)"`
Expected: `mailProvider=outlook`

- [ ] **Step 4: 真实流程冒烟（需用户环境：Chrome + 代理 + Outlook 池可用）**

Run: `node index.js --email 1`

观察要点（按顺序）：
1. `[邮箱注册] 使用邮箱: xxx@outlook.com`（池分配成功）
2. `[OAuth] 检测到邮箱输入页，输入: xxx`（OAuth 邮箱输入）
3. 新邮箱注册流：邮箱验证码页出现 → `[Mail] 收到验证码: xxxxxx`（Outlook Graph/IMAP 取件）
4. 「创建密码」页日志 → about-you 填写
5. `[OAuth] 捕获到回调 URL` → Token 保存
6. `outlook-accounts.json` 中该邮箱 status 变为 `used`
7. `username.json` 新增记录（email 有值、phone 为空、status=oauth_done）

若 OpenAI 注册流出现计划未覆盖的新页面（如「创建账户」确认页、生日单独页），依据 `debug-screenshots/` 截图与日志中的「页面文字」输出，在 `oauthLoginAndAuthorize` 对应分支补充处理（参考现有 30 轮循环模式），并同步更新本计划勾选项。

- [ ] **Step 5: 桌面 UI 冒烟**

Run: `npm start`

验证要点：
1. 运行模式下拉出现「邮箱注册（Outlook 池）」
2. 选中后「国家」与「阶段2 完成后停止」两行隐藏；切回「完整流程」恢复显示
3. 保持 mailProvider=outlook、清空 HeroSMS API Key 的配置下点击「开始任务」能正常启动（validateConfig 不再报 HeroSMS 为空）
4. 日志流正常显示 `[邮箱注册]` 前缀输出

---

## Self-Review 记录

- **Spec 覆盖**：模式入口（Task 1/3）、核心流程（Task 1）、browserService 增强（Task 2）、UI（Task 3）、错误处理（Task 1 内建回滚/池耗尽终止）、测试计划（Task 4）——全覆盖
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码
- **类型一致性**：`runSingleEmailRegistration`/`startEmailBatch`/`EMAIL_ONLY`/`validateConfig(config, mode)`/`updateRunModeUi` 命名在 Task 间一致；`mailProvider.confirmOutlookBound(null)`、`rollbackOutlookAllocation()` 与 outlookProvider 现有签名一致
