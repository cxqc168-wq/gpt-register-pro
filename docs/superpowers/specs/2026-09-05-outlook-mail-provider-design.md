# Outlook 邮箱接码集成设计

日期：2026-09-05
状态：已获用户批准

## 背景

gpt-register-clean-main 原用 Cloudflare 临时邮箱接收 OpenAI 验证码，但 OpenAI 邮件系统拒向廉价 TLD（.top/.lol）投递验证邮件（已实测确认：Worker 零收信事件，QQ 测试邮件正常到达）。改用用户导入的 Outlook 真实邮箱接码。

参考项目 outlook-mail-manager-main（Python Flask）提供卡密格式与 Graph 取件链路，本设计将其核心能力移植为 Node 原生实现。

## 决策记录

- 集成方式：Node 原生重写（不依赖 Python 子进程）

- 账号池：消耗制（一个 Outlook 邮箱绑定一个 OpenAI 账号后标记 used）

- 旧 provider：保留并存，mailProvider 下拉新增 outlook

## 核心组件：src/outlookProvider.js

### 卡密格式（与 outlook-mail-manager 一致）

```
邮箱----密码----client_id----refresh_token
```

- 每行一个账号；`#` 开头为注释；空行跳过

- Microsoft 账号（outlook/hotmail/live/msn/office365/outlook.cn 域名）密码字段留空，走 Graph 取件

- 长度校验：client\_id ≤ 256，refresh\_token ≤ 8192，password ≤ 2048

- 重复导入同邮箱只更新凭据，保留原状态

### 账号池存储（outlook-accounts.json）

字段：email、clientId、refreshToken、status（available/pending/used/invalid）、boundPhone、lastError、importedAt、updatedAt

状态机：

- available → pending（分配）→ used（绑定成功）

- pending → available（绑定失败/超时回滚）

- available/pending → invalid（invalid\_grant 或刷新失败）

### Token 刷新

POST `https://login.microsoftonline.com/common/oauth2/v2.0/token`
grant\_type=refresh\_token，scope=`https://graph.microsoft.com/Mail.Read offline_access`，无需 client\_secret。
access\_token 内存缓存 50 分钟；响应中的新 refresh\_token 回写存储。

### Graph 收件

GET `https://graph.microsoft.com/v1.0/me/mailFolders/{inbox|junkemail}/messages`
$top=5, $orderby=receivedDateTime desc, $select=id,subject,from,receivedDateTime,body
映射为统一邮件格式 {subject, content, raw, from, receivedAt}，兼容现有 pollEmailCode 的提取逻辑（mailTimestampMs/mailToRawText/extractMailBody）。
429/5xx 指数退避重试 2 次。

### 代理

复用现有 proxyHost/proxyPort 配置 + https-proxy-agent，配置项 outlookUseProxy 控制开关（默认 true）。

## 接入点

| 文件                          | 改动                                                                             |
| --------------------------- | ------------------------------------------------------------------------------ |
| src/mailProvider.js         | provider 枚举加 outlook；createAddress → 池分配；getMails/getMailsByAddress → Graph 拉件 |
| index.js                    | mailProvider 构造传代理；outlook 模式注册前预检池非空                                          |
| src/config.js               | 新增 outlookPoolFile（默认 outlook-accounts.json）、outlookUseProxy（默认 true）          |
| desktop/main.js             | IPC: outlook:import / outlook:accounts / outlook:reset / outlook:test          |
| desktop/renderer/index.html | Provider 下拉加 outlook；新视图「Outlook 邮箱池」                                          |
| desktop/renderer/app.js     | 导入/列表/重置/测试交互；表单填充与收集适配                                                        |

## UI

- 后台配置-邮箱接口：mailProvider 下拉加 outlook；选中 outlook 时接口地址/Token/域名字段禁用

- 侧边栏新视图 view-outlook（排在 HeroSMS 数据后）：

  - 统计条：可用/已用/无效/总数

  - 卡密导入卡：textarea + 文件选择 + 导入按钮（返回 added/updated/failed 明细）

  - 账号表格：邮箱/状态/绑定号码/最近错误/导入时间/操作（测试、重置）

- 沿用 surface-panel 与现有主题（--accent: #2f9d83）

## 错误处理

- 池空/无可用账号：注册前预检报错，不消耗 SMS 费用

- invalid\_grant：账号标 invalid，自动尝试下一个

- Graph 429/5xx：退避重试

- 绑定失败/超时：pending 回滚 available

## 测试

- 卡密解析单元测试：正常行、空密码、Gmail 混入、坏行、注释、重复导入更新

- 手动集成：导入真实卡密 → 测试按钮 → phase2 完整收码

