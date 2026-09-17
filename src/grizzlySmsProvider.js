const { SMSProvider } = require('./smsProvider');

/**
 * Grizzly SMS 接码服务商客户端（https://grizzlysms.com/cn/docs）
 * 协议与 sms-activate 兼容（同 HeroSMS），因此继承 SMSProvider，
 * 仅覆写差异点：baseUrl、余额解析无需覆写（同为 ACCESS_BALANCE 文本）、
 * getCountries 优先中文名（chn 字段）、getNumber 兼容 V2 JSON 与 V1 文本两种响应、
 * pollForCode 默认等待 3 分钟、cancel 轮询重试确保号码取消成功后再继续。
 *
 * 公共接口与 SMSProvider / NexSmsProvider 对齐，供注册流程与桌面端混用。
 */
class GrizzlySmsProvider extends SMSProvider {
    constructor(apiKey, proxy = null) {
        super(apiKey, proxy);
        this.baseUrl = 'https://api.grizzlysms.com/stubs/handler_api.php';
        this.providerName = 'grizzly';
        // 首选 V2 JSON（同 HeroSMS）；若平台不支持则自动降级为 V1 文本协议
        this.numberAction = 'getNumberV2';
        // 验证码默认等待 3 分钟（调用方传入更短等待时提升到 3 分钟，更长则尊重调用方）
        this.defaultCodeWaitMs = 3 * 60 * 1000;
        // 取消被拒（如 409 EARLY_CANCEL_DENIED）时的轮询间隔与最长重试窗口
        this.cancelRetryIntervalMs = 15 * 1000;
        this.cancelRetryWindowMs = 5 * 60 * 1000;
    }

    /**
     * 记录并返回购买的号码
     */
    applyNumber(activationId, phone, cost) {
        this.activationId = activationId;
        this.phoneNumber = String(phone || '').trim();
        if (!this.phoneNumber.startsWith('+')) {
            this.phoneNumber = `+${this.phoneNumber}`;
        }
        const costText = cost === undefined || cost === null ? '' : `, 费用: $${cost}`;
        console.log(`[SMS:Grizzly] 获取号码: ${this.phoneNumber} (activation: ${this.activationId}${costText})`);
        return { activationId: this.activationId, phoneNumber: this.phoneNumber };
    }

    /**
     * 购买手机号（对齐 SMSProvider.getNumber）
     * V2 返回 JSON {activationId, phoneNumber, activationCost}；
     * V1 返回文本 ACCESS_NUMBER:id:phone。
     * @returns {Promise<{activationId: string|number, phoneNumber: string}>}
     */
    async getNumber(service = 'dr', country = 16, maxRetries = 5, operator = '') {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            let data;
            try {
                const params = { service, country };
                if (operator) params.operator = operator;
                data = await this.request(this.numberAction, params);
            } catch (httpErr) {
                // sms-activate 兼容平台可能用 HTTP 404 + JSON {"title":"NO_NUMBERS"} 表示无号
                // （协议原生为 HTTP 200 纯文本，这里兼容两种形态）
                const status = Number(httpErr?.response?.status || 0);
                const payload = httpErr?.response?.data;
                const isNoNumbers = status === 404 && (
                    payload?.title === 'NO_NUMBERS'
                    || payload === 'NO_NUMBERS'
                    || (typeof payload === 'string' && payload.includes('NO_NUMBERS'))
                );
                if (isNoNumbers) {
                    console.log(
                        `[SMS:Grizzly] 暂无可用号码${operator ? `（运营商 ${operator} 无库存）` : ''}，` +
                        `${attempt < maxRetries ? '3秒后重试...' : '已达最大重试次数'} (${attempt}/${maxRetries})`
                    );
                    if (attempt < maxRetries) {
                        await new Promise(r => setTimeout(r, 3000));
                        continue;
                    }
                    throw new Error('当前无可用号码（重试耗尽）');
                }
                console.log(
                    `[SMS:Grizzly] API 请求失败: ${httpErr.message}，` +
                    `${attempt < maxRetries ? '5秒后重试...' : '已达最大重试次数'} (${attempt}/${maxRetries})`
                );
                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, 5000));
                    continue;
                }
                throw new Error(`Grizzly SMS API 不可用: ${httpErr.message}`);
            }


            if (data && typeof data === 'object' && data.activationId) {
                return this.applyNumber(data.activationId, data.phoneNumber, data.activationCost);
            }

            const text = String(data || '').trim();
            if (text.startsWith('ACCESS_NUMBER:')) {
                const [, activationId, phone] = text.split(':');
                return this.applyNumber(activationId, phone);
            }
            if (text === 'NO_BALANCE') throw new Error('Grizzly SMS 余额不足');
            if (text === 'BAD_KEY') throw new Error('Grizzly SMS API Key 无效');
            if (text === 'NO_NUMBERS') {
                console.log(
                    `[SMS:Grizzly] 暂无可用号码，` +
                    `${attempt < maxRetries ? '3秒后重试...' : '已达最大重试次数'} (${attempt}/${maxRetries})`
                );
                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, 3000));
                    continue;
                }
                throw new Error('当前无可用号码（重试耗尽）');
            }

            // 其余文本错误：若 V2 不被支持则降级为 V1，否则直接抛出
            if (this.numberAction === 'getNumberV2') {
                console.log(`[SMS:Grizzly] getNumberV2 不可用（${text}），改用 getNumber`);
                this.numberAction = 'getNumber';
                continue;
            }
            throw new Error(`获取号码失败: ${text}`);
        }
        throw new Error('Grizzly SMS 获取号码失败（重试耗尽）');
    }

    /**
     * 轮询等待短信验证码（Grizzly 默认等待 3 分钟）。
     * 调用方传入的等待时长（interval × maxAttempts）不足 3 分钟时提升到 3 分钟，
     * 更长则尊重调用方设置。超时后走本类 cancel()：确保号码被正常取消后再抛超时错误。
     */
    async pollForCode(options = {}) {
        const interval = options.interval || 5000;
        const minAttempts = Math.ceil(this.defaultCodeWaitMs / interval);
        const callerAttempts = options.maxAttempts ?? 60;
        return super.pollForCode({
            ...options,
            interval,
            maxAttempts: Math.max(callerAttempts, minAttempts),
        });
    }

    /**
     * 取消激活（退款）。确保号码被正常取消服务后再继续：
     * - 校验 setStatus 8 响应：ACCESS_CANCEL / JSON 对象视为成功，
     *   其余错误文本（如 EARLY_CANCEL_DENIED）视为本次取消失败；
     * - 取消失败（如 409 刚购买的号码暂不能取消）时轮询重试，
     *   直到取消成功或超过最长重试窗口（默认 5 分钟）；
     * - 窗口耗尽仍失败则记录日志返回（号码到期后自动退款），不阻塞主流程。
     * @returns {Promise<boolean>} 是否取消成功
     */
    async cancel() {
        const deadline = Date.now() + this.cancelRetryWindowMs;
        let lastError = null;
        while (true) {
            try {
                const data = await this.setStatusWithRetry(8, '取消激活');
                const text = String(data ?? '').trim();
                if (text && text !== 'ACCESS_CANCEL' && typeof data !== 'object') {
                    throw new Error(text);
                }
                console.log('[SMS:Grizzly] 激活已取消（退款）');
                return true;
            } catch (error) {
                lastError = error;
                const waitMs = Math.min(this.cancelRetryIntervalMs, deadline - Date.now());
                if (waitMs <= 0) break;
                console.error(`[SMS:Grizzly] 暂不能取消: ${error.message}，${Math.round(waitMs / 1000)}s 后重试...`);
                await new Promise(resolve => setTimeout(resolve, waitMs));
            }
        }
        console.error(`[SMS:Grizzly] 取消失败: ${lastError?.message || '未知错误'}（号码将在到期后自动退款）`);
        return false;
    }

    /**
     * 价格矩阵：Grizzly 仅支持 getPrices（getPricesVerification 返回 BAD_ACTION），
     * 直接请求全量矩阵 {countryId: {service: {count, cost, retry}}}
     */
    async getPriceMatrix(service = 'dr') {
        const data = await this.request('getPrices', { service });
        if (typeof data === 'string') {
            try {
                return JSON.parse(data);
            } catch (error) {
                throw new Error(`Grizzly 价格接口返回了非 JSON: ${String(data).slice(0, 120)}`);
            }
        }
        return data;
    }

    /**
     * Top 国家列表。Grizzly 无专用接口（getTopCountriesByServiceRank / getTopCountriesByService
     * 均返回 BAD_ACTION），从全量价格矩阵推导，返回结构与 SMSProvider 对齐。
     */
    async getTopCountriesByService(service = 'dr') {
        const matrix = await this.getPriceMatrix(service);
        const countryMeta = new Map((await this.getCountries()).map(c => [c.heroSmsCountry, c]));

        const rows = [];
        for (const key of Object.keys(matrix)) {
            const countryId = this.parseInteger(key);
            if (!Number.isFinite(countryId)) continue;
            const parsed = this.extractCountryPrice(matrix, countryId, service);
            if (!parsed || parsed.price === null) continue;
            const meta = countryMeta.get(countryId) || {};
            rows.push({
                heroSmsCountry: countryId,
                price: parsed.price,
                count: parsed.count,
                apiName: meta.apiName || '',
                nameZh: meta.nameZh || '',
            });
        }
        return rows.sort((a, b) => {
            if (a.price !== b.price) return a.price - b.price;
            return (b.count || 0) - (a.count || 0);
        });
    }

    /**
     * 地区列表。Grizzly 返回 {id: {id, eng, rus, chn, ...}}，chn 为中文名。
     * @returns {Promise<Array<{heroSmsCountry: number, apiName: string, nameZh: string}>>}
     */
    async getCountries() {
        let data = await this.request('getCountries');
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            } catch (error) {
                return [];
            }
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) return [];

        const list = [];
        for (const [key, value] of Object.entries(data)) {
            const countryId = this.parseInteger(value?.id ?? key);
            if (!Number.isFinite(countryId)) continue;
            const nameZh = String(value?.chn || '').trim();
            const apiName = String(value?.eng || nameZh || '').trim();
            list.push({ heroSmsCountry: countryId, apiName, nameZh });
        }
        return list;
    }
}

module.exports = { GrizzlySmsProvider };
