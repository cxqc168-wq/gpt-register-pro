# NexSMS 接码服务商接入设计

日期：2026-09-15
状态：已确认（默认激活 HeroSMS，保持向后兼容）

## 背景与目标

项目原先仅支持 HeroSMS 作为短信验证码（接码）服务商。本次新增 NexSMS（https://doc.nexsms.net/），
并将桌面端「HeroSMS 数据」模块改造为统一的「接码配置」页面，支持两个服务商随时切换，
同时适配「控制台」模块。

## NexSMS API 摘要（已实测验证）

- 基础地址：`https://api.nexsms.net`，鉴权：query 参数 `apiKey`
- `GET /api/balance` → `{code, data:{userId, username, balance}}`
- `GET /api/countries` → `{code, data:[{id, name(中文)}]}`（180+ 国家）
- `GET /api/services` → `{code, data:[{code, name}]}`（`dr` = OpenAI，与 HeroSMS 相同）
- `GET /api/getCountryByService?serviceCode=&countryId=` → 单国家报价；**不传 countryId 返回全部国家数组**，
  含 `countryName(英文)/minPrice/maxPrice/medianPrice/priceMap{价格:库存}/phoneCode`
- `POST /api/order/purchase?apiKey=` body `{serviceCode, countryId, quantity, price}` → `{data:{quantity, totalAmount, phoneNumbers[]}}`
- `GET /api/sms/messages?phoneNumber=&format=json_latest` → `{data:{text, code, smsTime, expiresTime}}`
- `POST /api/close/activation?apiKey=` body `{phoneNumber}` → 退款（号码创建须超 2 分钟）

关键结论：
1. NexSMS 与 HeroSMS 均使用 sms-activate 国家 ID 体系（16=英格兰/英国，187=美国，4=菲律宾，6=印尼…已逐一核对），
   `phoneCountries[].heroSmsCountry` 与 `heroSmsCountry` 默认值对两家均有效。
2. NexSMS 无 activationId / setStatus 概念，生命周期以手机号为核心：购买 → 轮询短信 → 取消激活。
3. 手机号返回不带 `+` 前缀（如 `254711408024`），统一补 `+` 以兼容浏览器流程的 `getLocalPhoneNumber`。

## 架构

### 后端

1. **`src/nexSmsProvider.js`（新增）**：`NexSmsProvider` 类，公共接口与 `SMSProvider` 对齐：
   - `constructor(apiKey, proxy)`（复用 `smsProvider.js` 的代理构建逻辑，导出共用）
   - `getNumber(service, country, maxRetries, operator)`：先查价（`getCountryByService`），按 `minPrice`
     购买 `quantity=1`；库存不足/价格变动时重试（重新取价）；返回 `{activationId:null, phoneNumber}`
   - `markReady()` / `complete()`：no-op（协议无对应概念）
   - `pollForCode({interval, maxAttempts})`：轮询 `sms/messages`，超时自动 `cancel()` 并抛
     `SMS_CODE_TIMEOUT_CANCELLED`（与 HeroSMS 行为一致）
   - `cancel()`：`close/activation`，失败仅记日志（<2 分钟不可退，不阻塞主流程）
   - `getPhone()`、`phoneNumber` 可写属性（phase2 resume 兼容）
   - `getBalance()`、`getCountries()`、`listCountryPrices(service, countries?)`、`getTopCountriesByService(service)`
   - `getOperators()` / `getOperatorQuoteOptions()`：返回空（NexSMS 无运营商维度，调用方已兼容空列表）

2. **`src/smsProviderFactory.js`（新增）**：`createSmsProvider(config, proxy)` 按 `config.smsProvider`
   返回 `NexSmsProvider`（`nexsms`）或 `SMSProvider`（默认）。

3. **`src/config.js`**：新增 `smsProvider`（默认 `'herosms'`）、`nexSmsApiKey`、`nexSmsService`（默认 `'dr'`）。

4. **`index.js` / `finish-oauth-no-email.js`**：所有 `new SMSProvider(config.heroSmsApiKey, buildSmsProxy())`
   改为 `createSmsProvider(config, buildSmsProxy())`；服务代码按激活平台选择
   （`heroSmsService` / `nexSmsService`）；启动校验按激活平台检查对应 API Key。

5. **`desktop/main.js`**：
   - `safeConfig` 增加新字段
   - `validateConfig`：非邮箱模式校验激活平台的 API Key
   - `getHeroSmsOverview` → `getSmsOverview(config)`：按激活平台返回统一结构
     `{ok, provider, balance, service, countryCount, countries[], refreshedAt}`；
     国家行结构 `{heroSmsCountry, apiName, nameZh?, isoCode?, dialCode, price, count, medianPrice?}`
   - IPC `herosms:overview` → `sms:overview`

6. **`desktop/preload.js`**：`getHeroSmsOverview` → `getSmsOverview`。

### 前端

1. 侧边栏「HeroSMS 数据」→「接码配置」（`view-herosms` → `view-sms`，路由 `sms`）。
2. 接码配置页结构：
   - 面板头 + **服务商切换分段控件**（HeroSMS ⇄ NexSMS，点击即保存 `smsProvider` 并刷新）
   - 配置区：API Key、服务代码、保存、测试连接（按激活平台读写对应字段）
   - 指标区：余额 / 服务 / 国家数量（NexSMS 余额来自 balance 接口）
   - 国家价格表：沿用现有表格与搜索；NexSMS 显示最低价与总库存（priceMap 最大值为累计库存）
3. 「后台配置」页移除 HeroSMS 表单区（配置已并入接码配置页）。
4. 控制台适配：
   - 运行面板标题区新增「接码平台」徽章（如 `HeroSMS` / `NexSMS`），随配置实时更新
   - 国家选择器无需改动（ID 体系一致）
5. UI 沿用现有薄荷绿设计语言；新增分段控件、平台徽章样式。

## 数据与配置

`config.json` 新增：
```json
{
  "smsProvider": "herosms",
  "nexSmsApiKey": "PXFCFQUvGkJlJGkS",
  "nexSmsService": "dr"
}
```
（账户 cxqc168@gmail.com；`config:save` 为合并写入，旧 HeroSMS 字段不受影响。）

## 错误处理

- NexSMS 接口错误统一 `code != 0` → 抛出含 `message` 的中文错误（如「余额不足」「号码创建时间小于2分钟」）
- `getNumber` 重试逻辑与 HeroSMS 对齐（最多 5 次，间隔 5s；无库存类错误重试，鉴权/余额错误直接抛出）
- `cancel()` 失败不阻塞主流程（仅日志）

## 测试计划

1. `node --check` 全部改动文件
2. 只读接口集成测试：余额 / 国家 / 服务 / 价格（`dr`）
3. 低价国家购买 1 个号码验证 `getNumber` → `pollForCode` → `cancel` 全链路（视余额决定）
4. `npm run check:desktop` + visual-qa 截图验证（更新 capture 脚本到新视图）
