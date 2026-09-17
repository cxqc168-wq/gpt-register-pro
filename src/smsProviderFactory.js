const { SMSProvider } = require('./smsProvider');
const { NexSmsProvider } = require('./nexSmsProvider');
const { GrizzlySmsProvider } = require('./grizzlySmsProvider');

/**
 * 接码服务商注册表。新增服务商 = 1 个 provider 文件 + 1 条注册项 + 前端 1 张凭据卡片。
 * - type：config.smsProvider 取值
 * - label：UI 显示名
 * - Class：客户端实现（公共接口对齐 SMSProvider）
 * - apiKeyField / serviceField：该服务商凭据在 config 中的字段名
 */
const SMS_PROVIDER_REGISTRY = {
    herosms: {
        label: 'HeroSMS',
        Class: SMSProvider,
        apiKeyField: 'heroSmsApiKey',
        serviceField: 'heroSmsService',
    },
    nexsms: {
        label: 'NexSMS',
        Class: NexSmsProvider,
        apiKeyField: 'nexSmsApiKey',
        serviceField: 'nexSmsService',
    },
    grizzly: {
        label: 'Grizzly SMS',
        Class: GrizzlySmsProvider,
        apiKeyField: 'grizzlySmsApiKey',
        serviceField: 'grizzlySmsService',
    },
};

const DEFAULT_SMS_PROVIDER = 'herosms';

/**
 * 服务商标签映射（供桌面端主进程复用）：{herosms: 'HeroSMS', nexsms: 'NexSMS', grizzly: 'Grizzly SMS'}
 */
const SMS_PROVIDER_LABELS = Object.fromEntries(
    Object.entries(SMS_PROVIDER_REGISTRY).map(([type, item]) => [type, item.label])
);

/**
 * 当前激活服务商类型；非法值回落默认 herosms
 */
function getActiveSmsProviderType(config = {}) {
    const type = String(config.smsProvider || '').toLowerCase();
    return SMS_PROVIDER_REGISTRY[type] ? type : DEFAULT_SMS_PROVIDER;
}

/**
 * 按注册表创建当前激活服务商客户端
 */
function createSmsProvider(config, proxy = null) {
    const type = getActiveSmsProviderType(config);
    const entry = SMS_PROVIDER_REGISTRY[type];
    return new entry.Class(config?.[entry.apiKeyField], proxy);
}

/**
 * 当前激活服务商的服务代码（默认 'dr' = OpenAI）
 */
function getActiveSmsService(config = {}) {
    const entry = SMS_PROVIDER_REGISTRY[getActiveSmsProviderType(config)];
    return config[entry.serviceField] || 'dr';
}

/**
 * 当前激活服务商的 API Key
 */
function getActiveSmsApiKey(config = {}) {
    const entry = SMS_PROVIDER_REGISTRY[getActiveSmsProviderType(config)];
    return config[entry.apiKeyField];
}

module.exports = {
    SMS_PROVIDER_REGISTRY,
    SMS_PROVIDER_LABELS,
    DEFAULT_SMS_PROVIDER,
    createSmsProvider,
    getActiveSmsProviderType,
    getActiveSmsService,
    getActiveSmsApiKey,
};
