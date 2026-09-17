/**
 * Outlook 邮箱接码模块（Node 原生实现，移植自 outlook-mail-manager-main）
 *
 * 职责：
 * - OutlookPool：卡密导入（邮箱----密码----client_id----refresh_token）、账号池消耗制管理
 * - OutlookMailClient：OAuth2 refresh_token 换 access_token + Microsoft Graph 收件箱/垃圾箱拉件
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { ImapFlow } = require('imapflow');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const MICROSOFT_DOMAINS = [
    'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'office365.com', 'outlook.cn',
];
const GOOGLE_DOMAINS = ['gmail.com', 'googlemail.com'];

const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// scope 探测顺序：先试 Graph（API 收件），失败回退 Outlook IMAP scope（XOAUTH2 收件）
const SCOPE_GRAPH = 'https://graph.microsoft.com/Mail.Read offline_access';
const SCOPE_IMAP = 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access';
const IMAP_HOST = 'outlook.office365.com';
const IMAP_PORT = 993;

const ACCESS_TOKEN_TTL_MS = 50 * 60 * 1000; // access_token 缓存 50 分钟
const GRAPH_TIMEOUT_MS = 30000;
const GRAPH_MAX_ATTEMPTS = 3;

function buildProxyUrl(proxy) {
    if (!proxy?.host || !proxy?.port) return '';
    const protocol = proxy.protocol || 'http:';
    const auth = proxy.username || proxy.password
        ? `${encodeURIComponent(proxy.username || '')}:${encodeURIComponent(proxy.password || '')}@`
        : '';
    return `${protocol}//${auth}${proxy.host}:${proxy.port}`;
}

function buildAxiosProxyConfig(proxy) {
    const proxyUrl = buildProxyUrl(proxy);
    if (!proxyUrl) return {};
    const isSocks = String(proxy.protocol || '').startsWith('socks');
    const agent = isSocks ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
    return { proxy: false, httpAgent: agent, httpsAgent: agent };
}

function normalizeEmail(address) {
    const trimmed = String(address || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        throw new Error(`邮箱地址无效: ${address}`);
    }
    return trimmed;
}

function detectProvider(email) {
    const domain = email.split('@').pop();
    if (GOOGLE_DOMAINS.includes(domain)) return 'google';
    return 'microsoft'; // 与原项目一致：未知域名按 microsoft 处理
}

// 真实 Microsoft refresh_token 长度通常在 800 字符以上，低于该下限必然不是真实凭据
const MIN_REFRESH_TOKEN_LENGTH = 100;

// 常见模板/占位符写法（导入时直接拒绝）
const PLACEHOLDER_TOKEN_RE = /^(placeholder|your[_-]?refresh[_-]?token|refresh[_-]?token|xxx+|test|todo|tbd|示例.*|占位.*|待填.*|替换.*|true[_-]?token.*)$/i;

/**
 * 判断 refresh_token 是否为占位符/模板值或明显异常的假凭据
 */
function isPlaceholderRefreshToken(token) {
    const value = String(token || '').trim();
    if (!value) return true;
    if (PLACEHOLDER_TOKEN_RE.test(value)) return true;
    return value.length < MIN_REFRESH_TOKEN_LENGTH;
}

/**
 * 解析卡密文本，格式与 outlook-mail-manager 的 import_accounts 一致：
 * 邮箱----密码----client_id----refresh_token（每行一个，# 注释，空行跳过）
 */
function parseCards(text) {
    const result = { accounts: [], errors: [] };
    const lines = String(text || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const lineNo = i + 1;
        if (!line || line.startsWith('#')) continue;

        const parts = line.split('----');
        if (parts.length < 4) {
            result.errors.push(`第 ${lineNo} 行格式错误（应为 邮箱----密码----client_id----refresh_token）`);
            continue;
        }
        const [email, password, clientId, refreshToken] = parts.slice(0, 4).map(p => p.trim());

        try {
            const normalized = normalizeEmail(email);
            if (detectProvider(normalized) === 'google') {
                result.errors.push(`第 ${lineNo} 行 ${normalized}：暂不支持 Gmail 账号（仅支持 Outlook/Hotmail 等 Microsoft 邮箱）`);
                continue;
            }
            if (!clientId || clientId.length > 256) {
                result.errors.push(`第 ${lineNo} 行 client_id 无效`);
                continue;
            }
            if (!refreshToken || refreshToken.length > 8192) {
                result.errors.push(`第 ${lineNo} 行 refresh_token 无效`);
                continue;
            }
            if (isPlaceholderRefreshToken(refreshToken)) {
                result.errors.push(`第 ${lineNo} 行 ${normalized}：refresh_token 疑似占位符/模板值（长度 ${refreshToken.length}），请填入卡密中的真实 refresh_token（通常 800 字符以上）`);
                continue;
            }
            if (password.length > 2048) {
                result.errors.push(`第 ${lineNo} 行密码字段无效`);
                continue;
            }
            result.accounts.push({
                email: normalized,
                password,
                clientId,
                refreshToken,
                provider: 'microsoft',
            });
        } catch (error) {
            result.errors.push(`第 ${lineNo} 行${error.message}`);
        }
    }
    return result;
}

/**
 * Outlook 账号池（消耗制：available → pending → used；失败回滚；token 失效标 invalid）
 */
class OutlookPool {
    constructor(poolFile = 'outlook-accounts.json') {
        this.poolFile = path.isAbsolute(poolFile)
            ? poolFile
            : path.join(process.cwd(), poolFile);
        this._writeQueue = Promise.resolve();
        this._load();
    }

    _load() {
        try {
            const raw = fs.readFileSync(this.poolFile, 'utf-8');
            const data = JSON.parse(raw);
            this.accounts = Array.isArray(data) ? data : (Array.isArray(data.accounts) ? data.accounts : []);
        } catch {
            this.accounts = [];
        }
    }

    _persist() {
        // 串行化写入，避免并发覆盖
        this._writeQueue = this._writeQueue.then(() => {
            fs.mkdirSync(path.dirname(this.poolFile), { recursive: true });
            fs.writeFileSync(this.poolFile, JSON.stringify({ accounts: this.accounts }, null, 2), 'utf-8');
        }).catch(error => {
            console.error(`[Outlook] 账号池写入失败: ${error.message}`);
        });
        return this._writeQueue;
    }

    importText(text) {
        const parsed = parseCards(text);
        const result = { added: 0, updated: 0, recovered: 0, failed: parsed.errors.length, errors: parsed.errors };
        const now = Date.now();
        for (const account of parsed.accounts) {
            const existing = this.accounts.find(a => a.email === account.email);
            if (existing) {
                // 重复导入只更新凭据，保留原状态与绑定信息
                existing.clientId = account.clientId;
                existing.refreshToken = account.refreshToken;
                existing.password = account.password || existing.password || '';
                // 换上新凭据后，之前因 token 失效标记为 invalid 的账号自动恢复可用
                if (existing.status === 'invalid') {
                    existing.status = 'available';
                    existing.lastError = null;
                    existing.fetchMode = '';
                    result.recovered++;
                }
                existing.updatedAt = now;
                result.updated++;
            } else {
                this.accounts.push({
                    email: account.email,
                    password: account.password || '',
                    clientId: account.clientId,
                    refreshToken: account.refreshToken,
                    provider: 'microsoft',
                    status: 'available',
                    boundPhone: null,
                    lastError: null,
                    importedAt: now,
                    updatedAt: now,
                });
                result.added++;
            }
        }
        if (parsed.accounts.length > 0) this._persist();
        return result;
    }

    stats() {
        const stats = { total: this.accounts.length, available: 0, pending: 0, used: 0, invalid: 0 };
        for (const account of this.accounts) {
            if (stats[account.status] !== undefined) stats[account.status]++;
        }
        return stats;
    }

    // 列表（脱敏：不含 refreshToken / clientId 前缀截断）
    list() {
        return this.accounts.map(a => ({
            email: a.email,
            clientId: a.clientId ? `${a.clientId.slice(0, 8)}...` : '',
            status: a.status,
            boundPhone: a.boundPhone || null,
            lastError: a.lastError || null,
            importedAt: a.importedAt || null,
            updatedAt: a.updatedAt || null,
        }));
    }

    getAccount(email) {
        const normalized = String(email || '').trim().toLowerCase();
        return this.accounts.find(a => a.email === normalized) || null;
    }

    allocate() {
        const now = Date.now();
        const PENDING_STALE_MS = 10 * 60 * 1000; // 进程中断残留的 pending 超过 10 分钟视为可用
        for (const account of this.accounts) {
            if (account.status === 'available') {
                account.status = 'pending';
                account.updatedAt = now;
                this._persist();
                console.log(`[Outlook] 已分配邮箱: ${account.email}`);
                return account;
            }
            if (account.status === 'pending' && now - (account.updatedAt || 0) > PENDING_STALE_MS) {
                account.status = 'available';
                account.updatedAt = now;
                console.log(`[Outlook] 回收超时 pending 邮箱: ${account.email}`);
                return this.allocate();
            }
        }
        return null;
    }

    markUsed(email, phone = null) {
        const account = this.getAccount(email);
        if (!account) return;
        account.status = 'used';
        account.boundPhone = phone || account.boundPhone;
        account.lastError = null;
        account.updatedAt = Date.now();
        this._persist();
        console.log(`[Outlook] 邮箱 ${account.email} 绑定成功${phone ? `（${phone}）` : ''}`);
    }

    markAvailable(email) {
        const account = this.getAccount(email);
        if (!account) return;
        // invalid 为终态（token 失效/邮箱烧毁），只能通过重新导入卡密或手动 reset 恢复；
        // 回滚不得覆盖该状态，否则失效邮箱会回池被反复分配，批量注册陷入死循环
        if (account.status === 'invalid') {
            console.log(`[Outlook] 邮箱 ${account.email} 已标记无效（${account.lastError || 'token 失效'}），跳过回滚`);
            return;
        }
        account.status = 'available';
        account.updatedAt = Date.now();
        this._persist();
        console.log(`[Outlook] 邮箱 ${account.email} 已回滚为可用`);
    }

    markInvalid(email, error = '') {
        const account = this.getAccount(email);
        if (!account) return;
        account.status = 'invalid';
        account.lastError = String(error || 'token 失效').slice(0, 300);
        account.updatedAt = Date.now();
        this._persist();
        console.warn(`[Outlook] 邮箱 ${account.email} 标记无效: ${account.lastError}`);
    }

    reset(email) {
        const account = this.getAccount(email);
        if (!account) return false;
        account.status = 'available';
        account.boundPhone = null;
        account.lastError = null;
        account.updatedAt = Date.now();
        this._persist();
        return true;
    }
}

/**
 * Outlook 邮件客户端：token 刷新（Graph/IMAP scope 自动探测）+ Graph API 或 IMAP XOAUTH2 收件
 */
class OutlookMailClient {
    constructor(proxy = null) {
        this.proxy = proxy;
        this.axios = axios.create(buildAxiosProxyConfig(proxy));
        this.tokenCache = new Map(); // email -> { accessToken, expiresAt, fetchMode }
    }

    async _refreshWithScope(account, scope) {
        const response = await this.axios.post(
            TOKEN_URL,
            new URLSearchParams({
                client_id: account.clientId,
                grant_type: 'refresh_token',
                refresh_token: account.refreshToken,
                scope,
            }),
            { timeout: GRAPH_TIMEOUT_MS, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        return response.data;
    }

    /**
     * 刷新 access_token，自动探测账号可用的 scope：
     * 先 Graph（API 收件），invalid_grant/invalid_scope 时回退 IMAP scope（XOAUTH2 收件）。
     * token 刷新彻底失败时抛出 error.tokenFailure = true 的错误。
     */
    async getAccessToken(account, { onTokenRotated } = {}) {
        const cached = this.tokenCache.get(account.email);
        if (cached && Date.now() < cached.expiresAt) return cached.accessToken;

        const scopes = cached?.fetchMode === 'imap'
            ? [[SCOPE_IMAP, 'imap']]
            : [[SCOPE_GRAPH, 'graph'], [SCOPE_IMAP, 'imap']];

        let lastError = null;
        for (const [scope, mode] of scopes) {
            let data;
            try {
                data = await this._refreshWithScope(account, scope);
            } catch (error) {
                lastError = error;
                const oauthError = error?.response?.data?.error;
                // scope 未授权/不匹配 → 回退尝试下一个 scope
                if (oauthError === 'invalid_grant' || oauthError === 'invalid_scope') {
                    console.log(`[Outlook] ${account.email} scope 不可用（${oauthError}），尝试下一种收件方式`);
                    continue;
                }
                const tokenError = new Error(`token 刷新失败: ${oauthError || error.message}`);
                tokenError.tokenFailure = true;
                throw tokenError;
            }

            const accessToken = data?.access_token;
            if (!accessToken) {
                lastError = new Error('token 响应缺少 access_token');
                continue;
            }

            this.tokenCache.set(account.email, {
                accessToken,
                expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
                fetchMode: mode,
            });
            account.fetchMode = mode;

            // OAuth 轮换出新 refresh_token 时回写存储，避免旧 token 失效
            const rotated = data?.refresh_token;
            if (typeof rotated === 'string' && rotated.trim() && rotated !== account.refreshToken) {
                account.refreshToken = rotated.trim();
                account.updatedAt = Date.now();
                if (typeof onTokenRotated === 'function') {
                    try { await onTokenRotated(account); } catch { /* 持久化失败不阻断取件 */ }
                }
            }
            console.log(`[Outlook] ${account.email} 使用${mode === 'graph' ? ' Graph API' : ' IMAP XOAUTH2'}取件`);
            return accessToken;
        }

        const oauthError = lastError?.response?.data?.error || lastError?.message || '所有 scope 均不可用';
        const hint = oauthError === 'invalid_grant'
            ? '（refresh_token 无效或已失效/被轮换，请重新导入真实卡密）'
            : '';
        const tokenError = new Error(`token 刷新失败: ${oauthError}${hint}`);
        tokenError.tokenFailure = true;
        throw tokenError;
    }

    async _graphGet(url, headers, params, label) {
        let lastError = null;
        for (let attempt = 1; attempt <= GRAPH_MAX_ATTEMPTS; attempt++) {
            try {
                return await this.axios.get(url, { headers, params, timeout: GRAPH_TIMEOUT_MS });
            } catch (error) {
                lastError = error;
                const status = error?.response?.status;
                const retryable = status === 429 || (status >= 500 && status <= 599) || !status;
                if (!retryable || attempt >= GRAPH_MAX_ATTEMPTS) {
                    const detail = error?.response?.data ? ` ${JSON.stringify(error.response.data).slice(0, 200)}` : '';
                    throw new Error(`Graph 请求失败 (${status || error.code || error.message})${detail}${label ? ` [${label}]` : ''}`);
                }
                const waitMs = 1000 * (2 ** (attempt - 1));
                await new Promise(r => setTimeout(r, waitMs));
            }
        }
        throw lastError;
    }

    async _fetchMailsGraph(account, limit, accessToken) {
        const headers = { Authorization: `Bearer ${accessToken}` };
        const params = {
            $top: Math.max(1, Math.min(50, Number(limit) || 5)),
            $orderby: 'receivedDateTime desc',
            $select: 'id,subject,from,receivedDateTime,body',
        };

        const mails = [];
        for (const wellKnown of ['inbox', 'junkemail']) {
            const response = await this._graphGet(
                `${GRAPH_BASE}/me/mailFolders/${wellKnown}/messages`,
                headers, params, wellKnown
            );
            for (const message of (response.data?.value || [])) {
                const sender = message?.from?.emailAddress || {};
                const content = message?.body?.content || '';
                const receivedAt = Date.parse(message?.receivedDateTime || '') || 0;
                mails.push({
                    id: message?.id || '',
                    subject: message?.subject || '',
                    from: `${sender.name || ''} <${sender.address || ''}>`.trim(),
                    content,
                    receivedAt,
                    raw: `${message?.subject || ''}\n\n${content}`,
                });
            }
        }
        return mails;
    }

    async _fetchMailsImap(account, limit, accessToken) {
        const proxyUrl = buildProxyUrl(this.proxy);
        const client = new ImapFlow({
            host: IMAP_HOST,
            port: IMAP_PORT,
            secure: true,
            auth: { user: account.email, accessToken },
            logger: false,
            ...(proxyUrl ? { proxy: proxyUrl } : {}),
        });
        await client.connect();

        const mails = [];
        try {
            for (const mailbox of ['INBOX', 'Junk']) {
                const lock = await client.getMailboxLock(mailbox).catch(() => null);
                if (!lock) continue;
                try {
                    const exists = client.mailbox?.exists || 0;
                    if (exists < 1) continue;
                    const start = Math.max(1, exists - Math.max(1, Number(limit) || 5) + 1);
                    for await (const message of client.fetch(`${start}:${exists}`, { envelope: true, source: true, uid: true })) {
                        const subject = message.envelope?.subject || '';
                        const fromAddr = (message.envelope?.from || [])[0] || {};
                        const source = message.source ? message.source.toString('utf-8') : '';
                        const content = decodeMailBody(source);
                        mails.push({
                            id: String(message.uid || ''),
                            subject,
                            from: `${fromAddr.name || ''} <${fromAddr.address || ''}>`.trim(),
                            content,
                            receivedAt: (message.envelope?.date ? Date.parse(message.envelope.date) : 0) || 0,
                            raw: `${subject}\n\n${content}`,
                        });
                    }
                } finally {
                    lock.release();
                }
            }
        } finally {
            await client.logout().catch(() => client.close());
        }
        return mails;
    }

    /**
     * 拉取账号收件箱+垃圾箱最新邮件，映射为项目统一邮件格式（按时间倒序）
     * { id, subject, from, content, receivedAt, raw }
     */
    async fetchMails(account, limit = 5, { onTokenRotated } = {}) {
        const accessToken = await this.getAccessToken(account, { onTokenRotated });
        const mode = this.tokenCache.get(account.email)?.fetchMode || 'graph';
        let mails;
        if (mode === 'imap') {
            mails = await this._fetchMailsImap(account, limit, accessToken);
        } else {
            mails = await this._fetchMailsGraph(account, limit, accessToken);
        }
        mails.sort((a, b) => b.receivedAt - a.receivedAt);
        return mails.slice(0, Math.max(1, Number(limit) || 5));
    }

    /**
     * 连通性测试：刷新 token + 拉最新邮件
     */
    async testAccount(account, { onTokenRotated } = {}) {
        try {
            const mails = await this.fetchMails(account, 3, { onTokenRotated });
            return { ok: true, mailCount: mails.length, latestSubject: mails[0]?.subject || '', error: '' };
        } catch (error) {
            const message = String(error?.response?.data?.error || error.message || error);
            // tokenFailure=true 表示 token 彻底失效（所有 scope 均不可用）；网络/代理瞬时错误为 false
            return { ok: false, mailCount: 0, latestSubject: '', error: message, tokenFailure: !!error?.tokenFailure };
        }
    }
}

/**
 * 从 header 文本中提取 charset 声明（找不到默认 utf-8）
 */
function detectCharset(text) {
    const match = text.match(/charset\s*=\s*["']?\s*([A-Za-z0-9._-]+)/i);
    return (match ? match[1] : 'utf-8').toLowerCase();
}

/**
 * 按指定编码把字节序列解码为字符串：utf-8 直接解码，其余编码用 iconv-lite（不可用时回退 utf-8）
 */
function decodeBytes(bytes, charset) {
    if (!bytes.length) return '';
    if (charset === 'utf-8' || charset === 'utf8' || charset === 'us-ascii' || charset === 'ascii') {
        return Buffer.from(bytes).toString('utf-8');
    }
    try {
        const iconv = require('iconv-lite');
        return iconv.decode(Buffer.from(bytes), charset);
    } catch {
        return Buffer.from(bytes).toString('utf-8');
    }
}

/**
 * 从原始 RFC822 邮件源码解码正文（处理 base64 / quoted-printable 及 charset），用于验证码提取
 */
function decodeMailBody(source) {
    const headerBodySplit = source.indexOf('\r\n\r\n') !== -1 ? '\r\n\r\n' : '\n\n';
    const idx = source.indexOf(headerBodySplit);
    if (idx === -1) return source;
    const headerText = source.slice(0, idx);
    let body = source.slice(idx + headerBodySplit.length);

    // 去掉 multipart 边界标记行，保留各 part 内容
    if (/boundary=/i.test(headerText)) {
        body = body.replace(/^--[^\r\n]+$/gm, '');
    }

    // 编码声明可能在顶层或 multipart 的 part 头中，统一检测
    const cteText = headerText + '\n' + body.slice(0, 1200);
    const charset = detectCharset(cteText);

    if (/Content-Transfer-Encoding:\s*base64/i.test(cteText) || (/^[A-Za-z0-9+/=\s]+$/.test(body.slice(0, 400)) && body.includes('='))) {
        try {
            const b64 = body.replace(/[^A-Za-z0-9+/=]/g, '');
            const decoded = decodeBytes(Buffer.from(b64, 'base64'), charset);
            if (decoded && /\d/.test(decoded)) body = decoded;
        } catch { /* 保留原文 */ }
    } else if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(cteText)) {
        // QP：先按 =XX 还原为字节序列，再整体按 charset 解码（String.fromCharCode 会按 Latin-1 逐字节转字符，UTF-8 中文必然乱码）
        const bytes = [];
        for (let i = 0; i < body.length; i++) {
            if (body[i] === '=' && i + 2 < body.length && /[0-9A-Fa-f]{2}/.test(body.slice(i + 1, i + 3))) {
                bytes.push(parseInt(body.slice(i + 1, i + 3), 16));
                i += 2;
            } else if (body[i] === '=' && (body[i + 1] === '\r' || body[i + 1] === '\n')) {
                i += body[i + 1] === '\r' && body[i + 2] === '\n' ? 2 : 1; // 软换行
            } else if (body[i] === '\r' || body[i] === '\n') {
                // 硬换行按原样保留（保持 <pre> 显示的换行）
                if (body[i] === '\r' && body[i + 1] === '\n') { bytes.push(0x0a); i++; }
                else bytes.push(0x0a);
            } else {
                bytes.push(body.charCodeAt(i) & 0xff);
            }
        }
        body = decodeBytes(bytes, charset);
    }
    return body;
}

module.exports = { OutlookPool, OutlookMailClient, parseCards, detectProvider, isPlaceholderRefreshToken };
