# Grizzly SMS 接码服务商接入设计

日期：2026-09-15
状态：已确认（用户批准实施方案 A：注册表驱动架构）

## 背景

项目已有 HeroSMS / NexSMS 双接码服务商（工厂模式切换）。本次新增 Grizzly SMS（https://grizzlysms.com/cn/docs），并预置后续继续新增其他接码平台的扩展能力。

- 账户：cxqc168@gmail.com
- API KEY：b3767a6cc64ce787916c51edd3272212
- 余额（实测）：$3.00
- 默认激活服务商：HeroSMS（用户指定；三家随时可在「接码配置」页切换）

## API 实测结论

Grizzly SMS 与 sms-activate 协议完全兼容，与 HeroSMS 同协议、不同域名：

- Base URL：`https://api.grizzlysms.com/stubs/handler_api.php`
- `getBalance` → `ACCESS_BALANCE:3.0000`（文本）
- `getPrices&service=dr&country=16` → `{"16":{"dr":{"count":17025,"cost":0.045,"retry":0}}}`（现有 HeroSMS 价格矩阵解析器直接支持）
- `getPricesV2` → 价格梯度 `{16:{dr:{price:count}}}`
- `getCountries` → `{id:{id,eng,rus,chn,...}}`（含中文 chn 字段）
- `getNumber` → `ACCESS_NUMBER:activationId:phone`（文本；文档另列有 v2）
- `setStatus`（1=ready/6=complete/8=cancel）、`getStatus/getStatusV2` 与 HeroSMS 语义一致
- 错误码：BAD_KEY / NO_BALANCE / NO_NUMBERS / BAD_ACTION / SERVICE_UNAVAILABLE_REGION
- 国家 ID 体系与 HeroSMS 一致（16=英国），phoneCountries 配置可直接复用

## 架构：注册表驱动（方案 A）

将 `smsProviderFactory.js` 从 if/else 分支改造为注册表：

```js
const SMS_PROVIDER_REGISTRY = {
    herosms: { label: 'HeroSMS', Class: SMSProvider, apiKeyField: 'heroSmsApiKey', serviceField: 'heroSmsService' },
    nexsms:  { label: 'NexSMS',  Class: NexSmsProvider, apiKeyField: 'nexSmsApiKey', serviceField: 'nexSmsService' },
    grizzly: { label: 'Grizzly SMS', Class: GrizzlySmsProvider, apiKeyField: 'grizzlySmsApiKey', serviceField: 'grizzlySmsService' },
};
```

- `createSmsProvider` / `getActiveSmsProviderType` / `getActiveSmsApiKey` / `getActiveSmsService` 全部注册表驱动
- 导出 `SMS_PROVIDER_LABELS` 供桌面主进程复用
- 新增平台 = 1 个 provider 文件 + 1 条注册表项 + 1 张 UI 卡片 + 1 个徽章配色

## GrizzlySmsProvider（继承 SMSProvider）

仅覆写协议差异点，其余（setStatus/getStatusV2/pollForCode/complete/cancel/价格解析/重试逻辑）全部继承：

- `baseUrl = 'https://api.grizzlysms.com/stubs/handler_api.php'`
- `getBalance()`：解析 `ACCESS_BALANCE:balance` 文本，返回 `{balance, userId: null, username: ''}`
- `getCountries()`：优先 `chn` 中文名（apiName/nameZh）
- `getNumber()`：先试 `getNumberV2`（JSON，同 HeroSMS）；若返回文本（如 BAD_ACTION / ACCESS_NUMBER）则回退解析 `getNumber` 的 `ACCESS_NUMBER:id:phone` 文本；NO_BALANCE/BAD_KEY/NO_NUMBERS 语义与 HeroSMS 相同
- 基类 `SMSProvider` 补 `getBalance()`（解析 ACCESS_BALANCE 文本），使控制台概览余额获取对三家统一

## 配置

- `config.json` / `config.example.json`：`smsProvider` 默认 `herosms`；新增 `grizzlySmsApiKey` / `grizzlySmsService`（默认 'dr'）
- `src/config.js`：新增字段与合法值校验（herosms | nexsms | grizzly）
- `desktop/main.js` `safeConfig`：同步新增字段；`SMS_PROVIDER_LABELS` 改从工厂导入；`getSmsOverview` 余额统一走 `provider.getBalance()`；`validateConfig` 泛化（已按工厂函数驱动）

## 前端（接码配置页 + 控制台）

- 分段切换控件：HeroSMS / NexSMS / Grizzly SMS 三按钮
- 凭据卡片：三张（HeroSMS API Key、NexSMS API Token、Grizzly SMS API Key），grid 自适应
- 徽章配色：HeroSMS 绿 / NexSMS 紫 / Grizzly 琥珀棕（灰熊）
- 泛化逻辑：切换、卡片激活态、控制台/配置页徽章均按 `data-provider` 属性驱动，前端 JS 不再硬编码服务商分支
- 控制台 `#smsProviderChip` 与配置页 `#configProviderChip` 三态配色

## 测试计划

1. 语法检查（node --check 全部改动文件）
2. 只读接口集成测试（已通过：余额/价格/国家列表）
3. 真实购买全流程测试（用户已确认）：英国号 $0.045 → getStatus → setStatus 8 取消退款 → 余额复核
4. UI 截图验证（控制台/配置页/接码配置页）
