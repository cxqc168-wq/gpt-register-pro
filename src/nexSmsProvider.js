const axios = require('axios');
const { buildAxiosProxyConfig } = require('./smsProvider');

/**
 * NexSMS 接码服务商客户端（https://doc.nexsms.net/）
 * 公共接口与 SMSProvider（HeroSMS）对齐，供注册流程与桌面端混用：
 * - getNumber(service, country, maxRetries, operator)
 * - markReady() / pollForCode({interval, maxAttempts}) / complete() / cancel() / getPhone()
 * - getBalance() / getCountries() / listCountryPrices(service, countries) / getTopCountriesByService(service)
 * - getOperators(country) / getOperatorQuoteOptions(service, country)
 *
 * 与 HeroSMS 的协议差异：
 * - 无 activationId / setStatus 概念，生命周期以手机号为核心（购买 → 轮询短信 → 取消激活）
 * - 服务代码沿用 sms-activate 体系（OpenAI = 'dr'），国家 ID 体系与 HeroSMS 一致
 * - 手机号返回不带 "+" 前缀，这里统一补 "+" 以兼容浏览器流程的 getLocalPhoneNumber
 */
class NexSmsProvider {
    constructor(apiKey, proxy = null) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.nexsms.net';
        this.providerName = 'nexsms';
        this.activationId = null;
        this.phoneNumber = null;
        this.orderedAt = null;
        this.orderedPrice = null;
        this.proxy = proxy;
        this.axios = axios.create(buildAxiosProxyConfig(proxy));
        if (proxy?.host && proxy?.port) {
            console.log(`[SMS:NexSMS] 接口使用代理: ${proxy.host}:${proxy.port}`);
        }
    }

    /**
     * GET 请求，返回 NexSMS 统一响应体 {code, message, data}
     */
    async request(path, params = {}) {
        const response = await this.axios.get(`${this.baseUrl}${path}`, {
            params: { apiKey: this.apiKey, ...params },
            timeout: 30000,
        });
        return response.data;
    }

    /**
     * POST 请求（apiKey 走 query 参数，业务参数走 JSON body）
     */
    async post(path, body = {}) {
        const response = await this.axios.post(
            `${this.baseUrl}${path}`,
            body,
            {
                params: { apiKey: this.apiKey },
                timeout: 30000,
                headers: { 'Content-Type': 'application/json' },
            }
        );
        return response.data;
    }

    /**
     * NexSMS 错误统一为 {code != 0, message}，转换为中文异常
     */
    assertOk(payload, fallbackMessage = 'NexSMS 接口返回异常') {
        if (!payload || typeof payload !== 'object') {
            throw new Error(`${fallbackMessage}: ${String(payload).slice(0, 160)}`);
        }
        if (Number(payload.code) !== 0) {
            throw new Error(`NexSMS 接口错误(${payload.code}): ${payload.message || fallbackMessage}`);
        }
        return payload;
    }

    /**
     * 轮询 / 取消时使用的号码（去掉 + 前缀的纯数字）
     */
    apiPhoneNumber() {
        return String(this.phoneNumber || '').replace(/^\+/, '').trim();
    }

    isAuthOrBalanceError(message) {
        const text = String(message || '');
        return /api\s*key|密钥|令牌|余额不足|balance/i.test(text);
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 账户余额
     * @returns {Promise<{userId: number, username: string, balance: number}>}
     */
    async getBalance() {
        const payload = this.assertOk(await this.request('/api/balance'), '获取余额失败');
        const data = payload.data || {};
        const balance = Number.parseFloat(String(data.balance ?? ''));
        return {
            userId: data.userId,
            username: data.username || '',
            balance: Number.isFinite(balance) ? balance : null,
        };
    }

    /**
     * 地区列表（中文名称）
     * @returns {Promise<Array<{heroSmsCountry: number, apiName: string}>>}
     */
    async getCountries() {
        const payload = this.assertOk(await this.request('/api/countries'), '获取地区列表失败');
        const list = Array.isArray(payload.data) ? payload.data : [];
        return list
            .map(item => ({
                heroSmsCountry: Number(item.id),
                apiName: String(item.name || '').trim(),
                nameZh: String(item.name || '').trim(),
            }))
            .filter(item => Number.isFinite(item.heroSmsCountry));
    }

    /**
     * 价格列表。不传 countryId 时 NexSMS 返回全部国家报价（一次请求）。
     * 行结构与其他 provider 的国家价格行对齐：
     * {heroSmsCountry, apiName, nameZh, dialCode, price, medianPrice, maxPrice, count}
     */
    async listCountryPrices(service = 'dr', countries = []) {
        const payload = this.assertOk(
            await this.request('/api/getCountryByService', { serviceCode: service }),
            '获取价格列表失败'
        );

        const countryNameZh = new Map();
        try {
            for (const country of await this.getCountries()) {
                countryNameZh.set(Number(country.heroSmsCountry), country.nameZh || country.apiName);
            }
        } catch (error) {
            console.log(`[SMS:NexSMS] 地区名称获取失败（不影响价格展示）: ${error.message}`);
        }

        const allowIds = Array.isArray(countries) && countries.length > 0
            ? new Set(countries.map(c => Number(c.heroSmsCountry)).filter(Number.isFinite))
            : null;

        const rows = [];
        const raw = Array.isArray(payload.data) ? payload.data : [payload.data].filter(Boolean);
        for (const item of raw) {
            const countryId = Number(item.countryId);
            if (!Number.isFinite(countryId)) continue;
            if (allowIds && !allowIds.has(countryId)) continue;

            const priceMapValues = Object.values(item.priceMap || {})
                .map(v => Number(v))
                .filter(Number.isFinite);
            const totalStock = priceMapValues.length ? Math.max(...priceMapValues) : null;
            const dialCode = String(item.phoneCode || '').replace(/^\+/, '').trim();

            rows.push({
                heroSmsCountry: countryId,
                nexSmsCountry: countryId,
                apiName: String(item.countryName || '').trim(),
                nameZh: countryNameZh.get(countryId) || String(item.countryName || '').trim(),
                dialCode,
                price: Number.isFinite(Number(item.minPrice)) ? Number(item.minPrice) : null,
                medianPrice: Number.isFinite(Number(item.medianPrice)) ? Number(item.medianPrice) : null,
                maxPrice: Number.isFinite(Number(item.maxPrice)) ? Number(item.maxPrice) : null,
                count: totalStock,
                serviceCode: item.serviceCode || service,
                serviceName: item.serviceName || '',
            });
        }

        return rows.sort((a, b) => {
            const priceA = a.price ?? Number.POSITIVE_INFINITY;
            const priceB = b.price ?? Number.POSITIVE_INFINITY;
            if (priceA !== priceB) return priceA - priceB;
            return (b.count || 0) - (a.count || 0);
        });
    }

    /**
     * Top 国家列表（与 SMSProvider 接口对齐，供概览兜底）
     */
    async getTopCountriesByService(service = 'dr') {
        return this.listCountryPrices(service);
    }

    /**
     * NexSMS 无运营商维度，返回空列表（调用方已兼容）
     */
    async getOperators() {
        return [];
    }

    async getOperatorQuoteOptions() {
        return [];
    }

    /**
     * 查询单个国家在指定服务下的报价
     */
    async getCountryQuote(service, countryId) {
        const payload = this.assertOk(
            await this.request('/api/getCountryByService', { serviceCode: service, countryId }),
            '获取国家报价失败'
        );
        const item = payload.data;
        if (!item || typeof item !== 'object') return null;
        return {
            minPrice: Number(item.minPrice),
            maxPrice: Number(item.maxPrice),
            medianPrice: Number.isFinite(Number(item.medianPrice)) ? Number(item.medianPrice) : null,
            priceMap: item.priceMap || {},
            phoneCode: String(item.phoneCode || '').replace(/^\+/, ''),
            countryName: item.countryName || '',
        };
    }

    /**
     * 购买手机号（对齐 SMSProvider.getNumber）
     * 策略：按最低价（minPrice）购买 1 个；无库存/价格变动时重新取价重试。
     * @returns {Promise<{activationId: null, phoneNumber: string}>}
     */
    async getNumber(service = 'dr', country = 16, maxRetries = 5, _operator = '') {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            let quote;
            try {
                quote = await this.getCountryQuote(service, country);
            } catch (error) {
                const message = String(error?.message || '');
                // 鉴权/余额/参数类业务错误重试无意义，直接抛出；网络类错误重试
                if (this.isAuthOrBalanceError(message) || /接口错误/.test(message)) throw error;
                console.log(`[SMS:NexSMS] 报价获取失败: ${message}，${attempt < maxRetries ? '5秒后重试' : '已达最大重试次数'} (${attempt}/${maxRetries})`);
                if (attempt < maxRetries) {
                    await this.sleep(5000);
                    continue;
                }
                throw error;
            }

            if (!quote || !Number.isFinite(Number(quote.minPrice))) {
                throw new Error(`NexSMS 未返回国家 ${country} 的报价（服务 ${service}）`);
            }

            try {
                const order = this.assertOk(
                    await this.post('/api/order/purchase', {
                        serviceCode: service,
                        countryId: Number(country),
                        quantity: 1,
                        price: Number(quote.minPrice),
                    }),
                    '购买号码失败'
                );
                const phones = Array.isArray(order.data?.phoneNumbers) ? order.data.phoneNumbers : [];
                const phone = String(phones[0] || '').trim();
                if (!phone) {
                    throw new Error('NexSMS 下单成功但未返回手机号');
                }

                this.phoneNumber = phone.startsWith('+') ? phone : `+${phone}`;
                this.orderedAt = Date.now();
                this.orderedPrice = Number(quote.minPrice);

                console.log(
                    `[SMS:NexSMS] 获取号码: ${this.phoneNumber} (国家: ${quote.countryName || country}, ` +
                    `费用: $${order.data.totalAmount ?? quote.minPrice}, 库存价: $${quote.minPrice})`
                );
                return { activationId: null, phoneNumber: this.phoneNumber };
            } catch (error) {
                const message = String(error?.message || '');
                if (this.isAuthOrBalanceError(message)) {
                    throw new Error(`NexSMS 购买失败: ${message}`);
                }
                console.log(`[SMS:NexSMS] 购买失败: ${message}，${attempt < maxRetries ? '5秒后重试（重新取价）' : '已达最大重试次数'} (${attempt}/${maxRetries})`);
                if (attempt < maxRetries) {
                    await this.sleep(5000);
                    continue;
                }
                throw error;
            }
        }
        throw new Error('NexSMS 获取号码失败（重试耗尽）');
    }

    /**
     * 标记准备接收短信。NexSMS 协议无此概念，保持 no-op 以对齐调用方。
     */
    async markReady() {
        console.log('[SMS:NexSMS] 已购买号码，等待短信（协议无需标记就绪）');
    }

    /**
     * 查询最新短信
     * @returns {Promise<{received: boolean, code?: string, text?: string, expiresTime?: string}>}
     */
    async getStatus() {
        const phone = this.apiPhoneNumber();
        if (!phone) return { received: false };

        const payload = this.assertOk(
            await this.request('/api/sms/messages', { phoneNumber: phone, format: 'json_latest' }),
            '查询短信失败'
        );
        const data = payload.data;
        if (!data || typeof data !== 'object') return { received: false };

        const code = String(data.code || '').trim();
        if (code) {
            return { received: true, code, text: data.text || '', expiresTime: data.expiresTime || '' };
        }
        return { received: false };
    }

    /**
     * 轮询等待短信验证码（与 SMSProvider 行为一致，超时取消激活）
     */
    async pollForCode(options = {}) {
        const { interval = 5000, maxAttempts = 60 } = options;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            console.log(`[SMS:NexSMS] 等待短信验证码... (${attempt}/${maxAttempts})`);

            try {
                const result = await this.getStatus();
                if (result.received) {
                    console.log(`[SMS:NexSMS] 收到验证码: ${result.code}`);
                    return result.code;
                }
            } catch (error) {
                console.error(`[SMS:NexSMS] 查询短信出错: ${error.message}`);
            }

            await this.sleep(interval);
        }

        console.error(`[SMS:NexSMS] 超过 ${(maxAttempts * interval) / 1000} 秒未收到验证码，尝试取消激活...`);
        await this.cancel();
        const timeoutError = new Error(`短信验证码超时（等待 ${(maxAttempts * interval) / 1000} 秒），已尝试取消激活`);
        timeoutError.code = 'SMS_CODE_TIMEOUT_CANCELLED';
        timeoutError.noRetryDelay = true;
        throw timeoutError;
    }

    /**
     * 完成激活。NexSMS 协议无确认激活概念（号码到期自动结算），保持 no-op。
     */
    async complete() {
        console.log('[SMS:NexSMS] 激活完成（号码到期自动结算）');
    }

    /**
     * 取消激活（退款）。约束：号码创建超 2 分钟且未退款；失败不阻塞主流程。
     */
    async cancel() {
        try {
            const phone = this.apiPhoneNumber();
            if (!phone) return;
            const payload = this.assertOk(
                await this.post('/api/close/activation', { phoneNumber: phone }),
                '取消激活失败'
            );
            console.log(`[SMS:NexSMS] 激活已取消（退款: ${payload.data === true ? '成功' : payload.data}）`);
        } catch (error) {
            console.error(`[SMS:NexSMS] 取消失败: ${error.message}（号码将在到期后自动处理）`);
        }
    }

    /**
     * 获取格式化的手机号（带 + 前缀）
     */
    getPhone() {
        return this.phoneNumber;
    }
}

module.exports = { NexSmsProvider };
