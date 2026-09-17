# 纯邮箱（Outlook）注册功能设计

日期：2026-09-05
状态：已批准

## 背景与目标

当前项目注册 ChatGPT/Codex 账号必须依赖手机号（HeroSMS 接码）。实际上 OpenAI 账号体系支持纯邮箱注册：用一个 Outlook 邮箱接收注册验证码即可完成账号创建，无需手机号。

目标：新增「纯邮箱注册」模式，从 Outlook 邮箱池分配邮箱，一次浏览器会话完成 注册 → 授权 → 获取 Codex token。

产出（用户已确认）：注册 + Token 一步到位。

## 核心决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 实现路径 | OAuth 一体化（方案 A） | auth.openai.com 与 chatgpt.com 共用 auth0 账号体系；OAuth 页输入新邮箱自动进入注册流；`oauthLoginAndAuthorize` 已有完整 email 分支；一次会话完成注册+token |
| 邮箱来源 | 仅 Outlook 池 | 临时邮箱域名（.lol/.top）大概率被 OpenAI 风控；`mailProvider !== 'outlook'` 时直接报错提示 |
| SMS 处理 | 遇手机验证即失败回滚 | OpenAI 对可疑邮箱可能触发手机验证，此时归还邮箱、换下一个重试，绝不调用 HeroSMS |
| 账号存储 | 仅写 username.json | email 主键、phone 留空；phase8 批量补 token 兼容 |
| 配置 | 零新增配置项 | Outlook 池文件、代理、OAuth 配置全部复用 |

## 流程设计

### runSingleEmailRegistration()

```
预检：MAIL_PROVIDER === 'outlook' 且池中 available ≥ 1
  ↓
generateUserData()                    // 现有函数：姓名/密码/生日
  ↓
mailProvider.createAddress()          // Outlook 池分配邮箱（available → pending）
  ↓
BrowserService.launch() + OAuthService // 代理失败自动直连重试（复用现有）
  ↓
oauthService.regeneratePKCE()
navigateToOAuth(authUrl)
  ↓
oauthLoginAndAuthorize({
    loginMethod: 'email',
    email, password, fullName, age, birthDate,
    redirectUri,
    onEmailCodeNeeded: () => pollEmailCode(mailProvider, 30, 5000, { minTimestampMs: flowStartedAt }),
    onSmsNeeded: () => { throw new Error('纯邮箱注册遇到手机验证，视为风控失败') },
})
  ↓ 新邮箱在 OAuth 页自动进入注册流：
    邮箱输入 → 邮箱验证码 → 创建密码 → about-you → 授权确认
  ↓
回调 URL 提取 code → oauthService.exchangeTokenAndSave(code, email)
  ↓
mailProvider.confirmOutlookBound(null)   // 池标记 used（boundPhone=null）
saveUsernameFile({ email, phone: '', status: 'oauth_done', emailCode })
  ↓
失败路径：mailProvider.rollbackOutlookAllocation()（pending → available 归还池）
```

### 批量循环 startEmailBatch()

- 沿用 token 计数停止逻辑：`checkTokenCount() >= TARGET_COUNT` 则停止
- 单轮失败：10 秒退避重试（沿用 BATCH_FAILURES 记录）
- 邮箱池耗尽：立即终止批量，提示导入新卡密

## 文件改动

### index.js

- 新增 `--email` CLI 参数（`EMAIL_ONLY`）
- 新增 `runSingleEmailRegistration()`：编排上述流程
- 新增 `startEmailBatch()`：批量循环 + 配置校验（不要求 heroSmsApiKey/mailBaseUrl/mailDomain，仅要求 outlook 池）
- `main()` 分发：`EMAIL_ONLY → startEmailBatch()`
- 复用：`pollEmailCode`、`generateUserData`、`saveUsernameFile`、`checkTokenCount`、代理回退逻辑

### src/browserService.js

`oauthLoginAndAuthorize` 注册流增强（小改）：

- 密码页兼容「创建密码 / Create password」（注册场景）：现有逻辑统一填密码并提交，天然兼容；增加文案日志区分
- `isEmailVerificationPage` 确认覆盖注册时的邮箱验证页（URL `email-verification` 或文本匹配）
- 实测中如遇新页面（如「创建账户」确认页），按现有 30 轮循环模式补充分支

### desktop/main.js

- `runtime:start`：`mode === 'email'` → `args.push('--email')`
- `validateConfig`：邮箱注册模式启动时不强制 HeroSMS API Key（仍校验 Outlook 池非空）

### desktop/renderer/index.html + app.js

- `runMode` 下拉新增 `<option value="email">邮箱注册（Outlook 池）</option>`
- `startRun()`：邮箱模式跳过国家选择保存逻辑
- 其余 UI（日志流、状态、统计）完全复用

## 错误处理

| 场景 | 处理 |
|---|---|
| 邮箱池耗尽 | 批量立即终止，提示导入卡密 |
| 邮箱验证码超时 | `pollEmailCode` 30 次 × 5s 后抛错 → 回滚邮箱 → 换下一个重试 |
| 验证码错误 | 现有逻辑：清空输入 + 重发按钮 |
| 遇手机验证（风控） | 抛错 → 回滚邮箱 → 下一轮 |
| Outlook token 失效 | 现有 `markInvalid` + `onTokenRotated` 回写机制 |
| OAuth 错误页 | 现有「重试」按钮点击逻辑 |

## 测试计划

1. 单元验证：`--email` 参数解析、池预检逻辑
2. 手动全流程：`node index.js --email 1` 实测 OAuth 注册页面流，按需补充 browserService 分支
3. 桌面 UI：模式选择、启动、日志流、validateConfig 放宽 HeroSMS
4. 回归：现有手机模式（full/phase2/phase3/phase8）不受影响
