const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { createSmsProvider, getActiveSmsProviderType, getActiveSmsService, getActiveSmsApiKey, SMS_PROVIDER_LABELS } = require('../src/smsProviderFactory');
const { MailProvider } = require('../src/mailProvider');
const { normalizePhoneCountries, DEFAULT_PHONE_COUNTRIES } = require('../src/phoneCountryCatalog');
const { OutlookPool, OutlookMailClient, isPlaceholderRefreshToken } = require('../src/outlookProvider');
const { checkLicense, activateLicense, collectMachineId, STATUS, EXPECTED_CODE } = require('../src/licenseGuard');

// Windows 控制台默认代码页为 GBK(936)，而 Electron 主进程的 console 输出是 UTF-8 字节，
// 终端会按 GBK 解码，导致中文日志乱码。这里把控制台切换到 UTF-8 代码页，保证日志正常显示。
if (process.platform === 'win32') {
  try {
    require('child_process').execSync('chcp 65001', { stdio: 'ignore' });
  } catch (error) {
    // 无控制台（如后台/打包启动）时忽略，不影响运行
  }
}

const projectRoot = path.resolve(__dirname, '..');
const configPath = path.join(projectRoot, 'config.json');
const statsBaselinePath = path.join(projectRoot, 'desktop-stats-baseline.json');
const tokenStatusPath = path.join(projectRoot, 'token-status.json');
let mainWindow = null;
let activeRun = null;
let runStartedAt = null;
let lastLogLines = [];

const HERO_SMS_COUNTRY_META = {
  4: { isoCode: 'PH', dialCode: '63', name: '菲律宾' },
  6: { isoCode: 'ID', dialCode: '62', name: '印度尼西亚' },
  16: { isoCode: 'GB', dialCode: '44', name: '英国' },
  31: { isoCode: 'ZA', dialCode: '27', name: '南非' },
  33: { isoCode: 'CO', dialCode: '57', name: '哥伦比亚' },
  39: { isoCode: 'AR', dialCode: '54', name: '阿根廷' },
  50: { isoCode: 'AT', dialCode: '43', name: '奥地利' },
  73: { isoCode: 'BR', dialCode: '55', name: '巴西' },
  117: { isoCode: 'PT', dialCode: '351', name: '葡萄牙' },
  151: { isoCode: 'CL', dialCode: '56', name: '智利' },
  187: { isoCode: 'US', dialCode: '1', name: '美国' },
};

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function safeConfig(config = {}) {
  const provider = String(config.smsProvider || '').toLowerCase();
  const smsProvider = ['nexsms', 'grizzly'].includes(provider) ? provider : 'herosms';
  return {
    smsProvider,
    heroSmsApiKey: config.heroSmsApiKey || '',
    heroSmsService: config.heroSmsService || 'dr',
    heroSmsCountry: Number(config.heroSmsCountry) || 16,
    heroSmsPromptCountrySelection: config.heroSmsPromptCountrySelection !== false,
    heroSmsCountryTopN: Number(config.heroSmsCountryTopN) || 10,
    nexSmsApiKey: config.nexSmsApiKey || '',
    nexSmsService: config.nexSmsService || 'dr',
    grizzlySmsApiKey: config.grizzlySmsApiKey || '',
    grizzlySmsService: config.grizzlySmsService || 'dr',
    phoneCountryCode: String(config.phoneCountryCode || 'GB').toUpperCase(),
    phoneCountries: Array.isArray(config.phoneCountries) ? config.phoneCountries : DEFAULT_PHONE_COUNTRIES,
    mailProvider: config.mailProvider || 'cloudflare-worker',
    mailBaseUrl: config.mailBaseUrl || '',
    mailAdminToken: config.mailAdminToken || '',
    mailAdminPassword: config.mailAdminPassword || '',
    mailSitePassword: config.mailSitePassword || '',
    mailAdminEmail: config.mailAdminEmail || '',
    mailDomain: config.mailDomain || '',
    mailDomains: Array.isArray(config.mailDomains) ? config.mailDomains : [],
    outlookPoolFile: config.outlookPoolFile || 'outlook-accounts.json',
    outlookUseProxy: config.outlookUseProxy !== false,
    proxyHost: config.proxyHost || '',
    proxyPort: Number(config.proxyPort) || 0,
    proxyUsername: config.proxyUsername || '',
    proxyPassword: config.proxyPassword || '',
    useChrome: config.useChrome !== false,
    chromePath: config.chromePath || '',
    browserUserDataDir: config.browserUserDataDir || 'browser-profile',
    browserIncognito: config.browserIncognito === true,
    browserClearChatGptSession: config.browserClearChatGptSession === true,
    targetTokenCount: Math.max(1, Math.min(100, Math.floor(Number(config.targetTokenCount) || 1))),
    tokenOutputDir: config.tokenOutputDir || 'tokens',
    tokenOutputDirs: Array.isArray(config.tokenOutputDirs) ? config.tokenOutputDirs : ['tokens'],
  };
}

function getTokenDir(config) {
  return path.resolve(projectRoot, config.tokenOutputDir || 'tokens');
}

function getTokenDirs(config) {
  const dirs = Array.isArray(config.tokenOutputDirs) && config.tokenOutputDirs.length
    ? config.tokenOutputDirs
    : [config.tokenOutputDir || 'tokens'];
  return [...new Set(dirs.map(dir => path.resolve(projectRoot, dir || 'tokens')))];
}

function listTokenFiles(config) {
  const seen = new Set();
  const files = [];
  for (const dir of getTokenDirs(config)) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!/^codex-.*-free\.json$/.test(file)) continue;
      const fullPath = path.join(dir, file);
      if (seen.has(fullPath)) continue;
      seen.add(fullPath);
      files.push(fullPath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function countTokenFiles(config) {
  return listTokenFiles(config).length;
}

function getRawCounts(config) {
  const accounts = readJson(path.join(projectRoot, 'accounts.json'), []);
  const usernames = readJson(path.join(projectRoot, 'username.json'), []);
  return {
    accounts: Array.isArray(accounts) ? accounts.length : 0,
    usernames: Array.isArray(usernames) ? usernames.length : 0,
    tokens: countTokenFiles(config),
  };
}

function getStatsBaseline() {
  const baseline = readJson(statsBaselinePath, {});
  return {
    usernames: Math.max(0, Math.floor(Number(baseline.usernames) || 0)),
    tokens: Math.max(0, Math.floor(Number(baseline.tokens) || 0)),
  };
}

function getDisplayCounts(config) {
  const raw = getRawCounts(config);
  const baseline = getStatsBaseline();
  return {
    accounts: raw.accounts,
    usernames: Math.max(0, raw.usernames - baseline.usernames),
    tokens: Math.max(0, raw.tokens - baseline.tokens),
    raw,
    baseline,
  };
}

function emit(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function appendLog(source, text) {
  const normalized = String(text || '').replace(/\r/g, '').split('\n').filter(Boolean);
  for (const line of normalized) {
    const item = { at: new Date().toISOString(), source, line };
    lastLogLines.push(item);
    if (lastLogLines.length > 800) lastLogLines.shift();
    emit('runtime:log', item);
  }
}

function getNodeCommand() {
  return process.env.GPT_REGISTER_NODE || 'node';
}

function summarizeError(error) {
  const status = error?.response?.status;
  const body = error?.response?.data;
  let detail = '';
  if (body) {
    detail = typeof body === 'string' ? body : JSON.stringify(body);
    if (detail.length > 600) detail = `${detail.slice(0, 600)}...`;
  }
  return { ok: false, status, code: error?.code || '', message: error?.message || String(error), detail };
}

function parseJwtPayload(token) {
  try {
    const [, payload] = String(token || '').split('.');
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_error) {
    return null;
  }
}

function tokenEmailFromFile(filePath, token = {}) {
  const jwtPayload = parseJwtPayload(token.access_token);
  const profile = jwtPayload?.['https://api.openai.com/profile'];
  const fromJwt = profile?.email || jwtPayload?.email;
  if (fromJwt) return fromJwt;
  if (token.email) return token.email;
  const file = path.basename(filePath);
  const match = file.match(/^codex-(.*)-free\.json$/);
  return match ? match[1] : file;
}

function tokenExpiryMs(token = {}) {
  const explicit = token.expires_at || token.expiresAt || token.expired_time || token.expiredTime || token.expired || token.expires;
  if (explicit) {
    const parsed = typeof explicit === 'number'
      ? (explicit < 10_000_000_000 ? explicit * 1000 : explicit)
      : Date.parse(explicit);
    if (Number.isFinite(parsed)) return parsed;
  }
  const jwtPayload = parseJwtPayload(token.access_token);
  if (Number.isFinite(Number(jwtPayload?.exp))) return Number(jwtPayload.exp) * 1000;
  return 0;
}

function classifyTokenFile(filePath) {
  try {
    const token = readJson(filePath, null);
    if (!token || typeof token !== 'object') {
      return { email: path.basename(filePath), status: '未知', error: 'token 文件不是有效 JSON' };
    }
    const email = tokenEmailFromFile(filePath, token);
    const expiresAtMs = tokenExpiryMs(token);
    if (!token.access_token) {
      return { email, status: '未知', error: '缺少 access_token' };
    }
    if (!expiresAtMs) {
      return { email, status: '未知', error: '无法解析过期时间' };
    }
    if (expiresAtMs <= Date.now()) {
      return {
        email,
        status: token.refresh_token ? '已过期' : '刷新失败',
        error: token.refresh_token ? 'access_token 已过期，等待刷新验证' : 'access_token 已过期且缺少 refresh_token',
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    }
    return { email, status: '可用', error: '', expiresAt: new Date(expiresAtMs).toISOString() };
  } catch (error) {
    return { email: path.basename(filePath), status: '未知', error: error.message || String(error) };
  }
}

async function requestWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function refreshExpiredToken(filePath, row) {
  const token = readJson(filePath, null);
  if (!token?.refresh_token) return row;
  const clientId = token.client_id || token.clientId || 'app_EMoamEEZ73f0CkXAXp7hrann';
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
  });
  try {
    const response = await requestWithTimeout('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ...row, status: '刷新失败', error: `刷新接口返回 ${response.status}${text ? `：${text.slice(0, 160)}` : ''}` };
    }
    const refreshed = await response.json();
    if (!refreshed.access_token) {
      return { ...row, status: '刷新失败', error: '刷新成功响应缺少 access_token' };
    }
    const next = {
      ...token,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token || token.refresh_token,
      id_token: refreshed.id_token || token.id_token,
      expires_in: refreshed.expires_in || token.expires_in,
      updated_at: new Date().toISOString(),
    };
    writeJson(filePath, next);
    const checked = classifyTokenFile(filePath);
    return { ...checked, file: path.basename(filePath), filePath, checkedAt: new Date().toISOString(), error: checked.error || '' };
  } catch (error) {
    const code = error?.name === 'AbortError' ? 'TIMEOUT' : error?.code;
    return { ...row, status: '接口不可用', error: code ? `${code}: ${error.message}` : error.message || String(error) };
  }
}

async function getTokenStatusOverview(config) {
  const files = listTokenFiles(config);
  const rows = [];
  for (const filePath of files) {
    const classified = classifyTokenFile(filePath);
    let row = {
      ...classified,
      file: path.basename(filePath),
      filePath,
      checkedAt: new Date().toISOString(),
      error: classified.error || '',
    };
    if (classified.status === '已过期') {
      row = await refreshExpiredToken(filePath, row);
    }
    rows.push(row);
  }
  const counts = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});
  const result = { ok: true, rows, counts, total: rows.length, refreshedAt: new Date().toISOString() };
  writeJson(tokenStatusPath, result);
  return result;
}

function getOutlookPoolPath(config) {
  return path.resolve(projectRoot, config.outlookPoolFile || 'outlook-accounts.json');
}

function getOutlookPool(config) {
  return new OutlookPool(getOutlookPoolPath(config));
}

function getOutlookProxy(config) {
  if (config.outlookUseProxy === false) return null;
  return config.proxyHost ? {
    host: config.proxyHost,
    port: Number(config.proxyPort) || 0,
    username: config.proxyUsername || '',
    password: config.proxyPassword || '',
  } : null;
}

function collectOutlookPoolIssues(config) {
  try {
    const pool = getOutlookPool(config);
    const stats = pool.stats();
    if (stats.total === 0) return ['Outlook 账号池为空，请先在「Outlook 邮箱池」导入卡密'];
    if (stats.available === 0) return ['Outlook 账号池无可用邮箱（已全部使用或失效）'];
    return [];
  } catch {
    return ['Outlook 账号池文件读取失败'];
  }
}

function validateConfig(config, mode = 'full') {
  const issues = [];
  const isEmailMode = mode === 'email';
  const isPhoneOnlyMode = mode === 'phone';
  const mailProvider = String(config.mailProvider || '').toLowerCase();
  if (!isEmailMode && !getActiveSmsApiKey(config)) {
    issues.push(`${(SMS_PROVIDER_LABELS[getActiveSmsProviderType(config)] || '接码')} API Key 为空`);
  }
  if (isEmailMode) {
    // 纯邮箱注册：强依赖 Outlook 池，不依赖 HeroSMS/邮箱接口
    if (mailProvider !== 'outlook') {
      issues.push('纯邮箱注册需要邮箱服务为 outlook（真实邮箱池），请在设置页切换');
    } else {
      issues.push(...collectOutlookPoolIssues(config));
    }
  } else if (isPhoneOnlyMode) {
    // 仅手机号模式：注册后直接用手机号拿 Token，不绑定邮箱，故不检查邮箱池/接口/域名
  } else if (mailProvider === 'outlook') {
    // Outlook 模式：不依赖接口地址/域名，只检查账号池
    issues.push(...collectOutlookPoolIssues(config));
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

async function getSmsOverview(config) {
  const providerType = getActiveSmsProviderType(config);
  const providerLabel = SMS_PROVIDER_LABELS[providerType] || providerType;
  const apiKey = getActiveSmsApiKey(config);
  if (!apiKey) return { ok: false, message: `${providerLabel} API Key 为空` };
  const provider = createSmsProvider(config, config.proxyHost ? {
    host: config.proxyHost,
    port: config.proxyPort,
    username: config.proxyUsername,
    password: config.proxyPassword,
  } : null);
  const service = getActiveSmsService(config);
  const normalizedCountries = normalizePhoneCountries(Array.isArray(config.phoneCountries) && config.phoneCountries.length ? config.phoneCountries : DEFAULT_PHONE_COUNTRIES);

  // 余额：各服务商统一实现 getBalance()，返回 {balance, userId, username}
  let balance = null;
  let balanceRaw = '';
  let userId = null;
  let username = '';
  try {
    const account = await provider.getBalance();
    balance = account.balance;
    balanceRaw = account.balance === null ? '' : String(account.balance);
    userId = account.userId ?? null;
    username = account.username || '';
  } catch (error) {
    balanceRaw = '';
  }

  let priced = [];
  try {
    const apiCountries = await provider.getCountries();
    const byId = new Map(normalizedCountries.filter(c => c.heroSmsCountry).map(c => [Number(c.heroSmsCountry), c]));
    const usable = apiCountries.length
      ? apiCountries.map(c => {
        const heroId = Number(c.heroSmsCountry);
        const local = byId.get(heroId) || HERO_SMS_COUNTRY_META[heroId];
        return local ? { ...c, ...local, apiName: c.name || c.country || c.countryName || c.apiName || '' } : c;
      })
      : normalizedCountries;
    priced = await provider.listCountryPrices(service, usable.filter(c => c.heroSmsCountry));
  } catch (error) {
    priced = await provider.getTopCountriesByService(service).catch(() => []);
  }
  return {
    ok: true,
    provider: providerType,
    providerLabel,
    balance,
    balanceRaw,
    userId,
    username,
    service,
    countryCount: priced.length,
    countries: priced.slice(0, 160),
    refreshedAt: new Date().toISOString(),
  };
}

async function testMail(config) {
  const mailProvider = String(config.mailProvider || '').toLowerCase();
  if (mailProvider === 'outlook') {
    // Outlook 模式：取一个可用账号做连通性测试（刷 token + 拉最近邮件，不消耗账号）
    const pool = getOutlookPool(config);
    const account = pool.accounts.find(a => a.status === 'available') || pool.accounts[0];
    if (!account) return { ok: false, message: 'Outlook 账号池为空，请先导入卡密' };
    const client = new OutlookMailClient(getOutlookProxy(config));
    const result = await client.testAccount(account, {
      onTokenRotated: async (rotated) => {
        const stored = pool.getAccount(rotated.email);
        if (stored) {
          stored.refreshToken = rotated.refreshToken;
          stored.updatedAt = Date.now();
          pool._persist();
        }
      },
    });
    if (!result.ok) {
      // 仅 token 彻底失效（所有 scope 均不可用）才把账号标记为 invalid；
      // 代理未启动/网络瞬时错误（如 ECONNREFUSED 127.0.0.1:7890）不烧号，保留原状态以便下次重试
      if (result.tokenFailure) {
        pool.markInvalid(account.email, result.error);
      }
      return { ok: false, message: `${account.email} 测试失败: ${result.error}` };
    }
    // 测试成功说明账号实际可用：若此前被瞬时错误误标为 invalid，恢复为可用
    if (account.status !== 'available') {
      pool.reset(account.email);
    }
    return {
      ok: true,
      address: account.email,
      inboxReachable: true,
      count: result.mailCount,
      message: `${account.email} 连通正常，最近邮件 ${result.mailCount} 封${result.latestSubject ? `（最新: ${result.latestSubject}）` : ''}`,
    };
  }
  const domain = String(config.mailDomain || (config.mailDomains || [])[0] || '').replace(/^@/, '');
  if (!config.mailBaseUrl || !domain) return { ok: false, message: '邮箱接口地址或域名为空' };
  const proxy = config.proxyHost ? {
    host: config.proxyHost,
    port: Number(config.proxyPort) || 0,
    username: config.proxyUsername || '',
    password: config.proxyPassword || '',
  } : null;
  const mail = new MailProvider({
    baseUrl: config.mailBaseUrl,
    provider: config.mailProvider,
    adminToken: config.mailAdminToken,
    adminPassword: config.mailAdminPassword || config.mailAdminToken,
    sitePassword: config.mailSitePassword,
    adminEmail: config.mailAdminEmail,
    domain,
    proxy,
  });
  const created = await mail.createAddress(`desktop${Date.now()}`);
  const mails = await mail.getMailsByAddress(created.address, 1, 0).catch(() => []);
  return { ok: true, address: created.address, inboxReachable: Array.isArray(mails), count: mails.length };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 700,
    title: 'GPT注册桌面控制台',
    backgroundColor: '#eef7f4',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // 外部链接（target="_blank"）用系统默认浏览器打开，而非 Electron 内置窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (activeRun) {
    appendLog('system', '桌面窗口关闭，正在停止当前任务');
    activeRun.kill('SIGTERM');
  }
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('license:status', async () => {
  const result = checkLicense();
  return {
    ...result,
    valid: result.status === STATUS.OK,
    machineId: collectMachineId(),
    expectedCode: EXPECTED_CODE,
  };
});

ipcMain.handle('license:activate', async (_event, incoming = {}) => {
  const code = String(incoming.code || '').trim();
  const result = await activateLicense(code);
  return {
    ...result,
    valid: result.status === STATUS.OK,
    machineId: collectMachineId(),
  };
});

ipcMain.handle('app:summary', async () => {
  const config = safeConfig(readJson(configPath, {}));
  return { projectRoot, configPath, config, issues: validateConfig(config), counts: getDisplayCounts(config), isRunning: !!activeRun, logs: lastLogLines };
});

ipcMain.handle('stats:reset', async () => {
  const config = safeConfig(readJson(configPath, {}));
  const raw = getRawCounts(config);
  const baseline = {
    usernames: raw.usernames,
    tokens: raw.tokens,
    resetAt: new Date().toISOString(),
  };
  writeJson(statsBaselinePath, baseline);
  appendLog('system', `统计已归零：邮箱记录 ${raw.usernames}，Token ${raw.tokens}。文件未删除。`);
  return { ok: true, counts: getDisplayCounts(config) };
});

ipcMain.handle('config:save', async (_event, incoming) => {
  const current = readJson(configPath, {});
  const next = safeConfig({ ...current, ...incoming });
  writeJson(configPath, next);
  return { ok: true, config: next, issues: validateConfig(next) };
});

ipcMain.handle('config:open-folder', async () => {
  await shell.openPath(projectRoot);
  return { ok: true };
});

ipcMain.handle('token:open-dir', async () => {
  const config = safeConfig(readJson(configPath, {}));
  const dir = getTokenDir(config);
  fs.mkdirSync(dir, { recursive: true });
  await shell.openPath(dir);
  return { ok: true, dir };
});

ipcMain.handle('token:status', async () => {
  try {
    const config = safeConfig(readJson(configPath, {}));
    return await getTokenStatusOverview(config);
  } catch (error) {
    return summarizeError(error);
  }
});

ipcMain.handle('sms:overview', async () => {
  try {
    const config = safeConfig(readJson(configPath, {}));
    return await getSmsOverview(config);
  } catch (error) {
    return summarizeError(error);
  }
});

ipcMain.handle('mail:test', async () => {
  try {
    const config = safeConfig(readJson(configPath, {}));
    return await testMail(config);
  } catch (error) {
    return summarizeError(error);
  }
});

// ===== Outlook 邮箱池 =====

ipcMain.handle('outlook:import', async (_event, incoming = {}) => {
  try {
    const config = safeConfig(readJson(configPath, {}));
    let text = String(incoming.text || '');
    // 支持直接传文件路径（UI 选择 txt 文件）
    const filePath = String(incoming.filePath || '');
    if (!text && filePath) {
      if (!fs.existsSync(filePath)) return { ok: false, message: `文件不存在: ${filePath}` };
      text = fs.readFileSync(filePath, 'utf8');
    }
    if (!text.trim()) return { ok: false, message: '卡密内容为空' };
    const pool = getOutlookPool(config);
    const result = pool.importText(text);
    const stats = pool.stats();
    const recoveredPart = result.recovered ? `，恢复无效账号 ${result.recovered}` : '';
    return {
      ok: result.failed === 0,
      message: `导入完成：新增 ${result.added}，更新 ${result.updated}${recoveredPart}，失败 ${result.failed}`,
      added: result.added,
      updated: result.updated,
      failed: result.failed,
      errors: result.errors.slice(0, 20),
      stats,
      accounts: pool.list(),
    };
  } catch (error) {
    return summarizeError(error);
  }
});

ipcMain.handle('outlook:accounts', async () => {
  try {
    const config = safeConfig(readJson(configPath, {}));
    const pool = getOutlookPool(config);
    return { ok: true, accounts: pool.list(), stats: pool.stats() };
  } catch (error) {
    return summarizeError(error);
  }
});

ipcMain.handle('outlook:reset', async (_event, incoming = {}) => {
  try {
    const config = safeConfig(readJson(configPath, {}));
    const email = String(incoming.email || '').trim();
    if (!email) return { ok: false, message: '邮箱地址为空' };
    const pool = getOutlookPool(config);
    if (!pool.reset(email)) return { ok: false, message: `账号不存在: ${email}` };
    appendLog('system', `[Outlook] 已重置账号状态: ${email}`);
    return { ok: true, accounts: pool.list(), stats: pool.stats() };
  } catch (error) {
    return summarizeError(error);
  }
});

ipcMain.handle('outlook:test', async (_event, incoming = {}) => {
  try {
    const config = safeConfig(readJson(configPath, {}));
    const email = String(incoming.email || '').trim();
    const pool = getOutlookPool(config);
    const account = pool.getAccount(email);
    if (!account) return { ok: false, message: `账号不存在: ${email}` };
    // 占位符/模板 token 直接快速失败，避免无意义的 OAuth 调用与含糊报错
    if (isPlaceholderRefreshToken(account.refreshToken)) {
      const warn = `refresh_token 为占位符/模板值（长度 ${String(account.refreshToken || '').trim().length}），不是真实凭据。请先重新导入完整卡密（邮箱----密码----client_id----真实refresh_token），再进行测试`;
      pool.markInvalid(account.email, warn);
      return { ok: false, message: `测试失败: ${warn}`, accounts: pool.list(), stats: pool.stats() };
    }
    const client = new OutlookMailClient(getOutlookProxy(config));
    const result = await client.testAccount(account, {
      onTokenRotated: async (rotated) => {
        const stored = pool.getAccount(rotated.email);
        if (stored) {
          stored.refreshToken = rotated.refreshToken;
          stored.updatedAt = Date.now();
          pool._persist();
        }
      },
    });
    if (!result.ok) {
      // 仅 token 彻底失效才标记 invalid；代理未启动/网络瞬时错误不烧号
      if (result.tokenFailure) {
        pool.markInvalid(account.email, result.error);
      }
      return { ok: false, message: `测试失败: ${result.error}`, accounts: pool.list(), stats: pool.stats() };
    }
    // 测试成功恢复账号可用（此前可能被瞬时错误误标为 invalid）
    if (account.status !== 'available') {
      pool.reset(account.email);
    }
    return {
      ok: true,
      message: `连通正常，最近邮件 ${result.mailCount} 封${result.latestSubject ? `（最新: ${result.latestSubject}）` : ''}`,
      accounts: pool.list(),
      stats: pool.stats(),
    };
  } catch (error) {
    return summarizeError(error);
  }
});

// 查看邮箱全部邮件（收件箱+垃圾箱，按时间倒序）
ipcMain.handle('outlook:mails', async (_event, incoming = {}) => {
  try {
    const config = safeConfig(readJson(configPath, {}));
    const email = String(incoming.email || '').trim();
    const limit = Math.max(1, Math.min(50, Number(incoming.limit) || 50));
    const pool = getOutlookPool(config);
    const account = pool.getAccount(email);
    if (!account) return { ok: false, message: `账号不存在: ${email}` };
    if (isPlaceholderRefreshToken(account.refreshToken)) {
      return { ok: false, message: `refresh_token 为占位符/模板值（长度 ${String(account.refreshToken || '').trim().length}），无法拉取邮件，请先重新导入真实卡密` };
    }
    const client = new OutlookMailClient(getOutlookProxy(config));
    const mails = await client.fetchMails(account, limit, {
      onTokenRotated: async (rotated) => {
        const stored = pool.getAccount(rotated.email);
        if (stored) {
          stored.refreshToken = rotated.refreshToken;
          stored.updatedAt = Date.now();
          pool._persist();
        }
      },
    });
    return { ok: true, mails, stats: pool.stats() };
  } catch (error) {
    return summarizeError(error);
  }
});

// 完整卡密详情（含密码凭据，仅本地展示）
ipcMain.handle('outlook:detail', async (_event, incoming = {}) => {
  try {
    const config = safeConfig(readJson(configPath, {}));
    const email = String(incoming.email || '').trim().toLowerCase();
    const pool = getOutlookPool(config);
    const account = pool.getAccount(email);
    if (!account) return { ok: false, message: `账号不存在: ${email}` };
    return {
      ok: true,
      detail: {
        email: account.email,
        password: account.password || '',
        clientId: account.clientId || '',
        refreshToken: account.refreshToken || '',
        tokenSuspicious: isPlaceholderRefreshToken(account.refreshToken),
        status: account.status || '',
        fetchMode: account.fetchMode || '',
        boundPhone: account.boundPhone || null,
        lastError: account.lastError || null,
        importedAt: account.importedAt || null,
        updatedAt: account.updatedAt || null,
      },
    };
  } catch (error) {
    return summarizeError(error);
  }
});

// 账号信息列表（合并 username/accounts/Outlook 池/Token 文件）
ipcMain.handle('accounts:list', async () => {
  try {
    const config = safeConfig(readJson(configPath, {}));
    const usernames = readJson(path.join(projectRoot, 'username.json'), []);
    const accounts = readJson(path.join(projectRoot, 'accounts.json'), []);
    const usernameList = Array.isArray(usernames) ? usernames : [usernames];
    const accountList = Array.isArray(accounts) ? accounts : [];
    const pool = getOutlookPool(config);
    const tokenFiles = listTokenFiles(config);
    const tokenEmails = new Set(tokenFiles.map(f => {
      const base = path.basename(f).replace(/^codex-/, '').replace(/-free\.json$/, '');
      return base.toLowerCase();
    }));

    const usedPhones = new Set();
    const rows = [];

    // username.json 为主表（含邮箱与验证码）
    for (const record of usernameList) {
      const phone = String(record?.phone || '').trim();
      if (phone) usedPhones.add(phone);
      const acc = accountList.find(a => String(a?.phone || '').trim() === phone) || {};
      const email = String(record?.email || '').trim();
      const isOutlook = !!(email && pool.getAccount(email));
      // 仅手机号模式没有邮箱，token 文件以手机号命名：无邮箱时回退按手机号匹配 token
      const tokenLookupKey = (email || phone).trim().toLowerCase();
      rows.push({
        phone,
        name: record?.name || acc?.name || '',
        email,
        status: record?.status || acc?.status || '',
        createdAt: record?.createdAt || acc?.createdAt || '',
        smsCode: record?.smsCode || acc?.smsCode || '',
        emailCode: record?.emailCode || acc?.emailCode || '',
        isOutlook,
        hasToken: !!(tokenLookupKey && tokenEmails.has(tokenLookupKey)),
      });
    }

    // accounts.json 中未进入 username 的记录（尚未绑定邮箱）
    for (const acc of accountList) {
      const phone = String(acc?.phone || '').trim();
      if (!phone || usedPhones.has(phone)) continue;
      usedPhones.add(phone);
      rows.push({
        phone,
        name: acc?.name || '',
        email: '',
        status: acc?.status || 'registered',
        createdAt: acc?.createdAt || '',
        smsCode: acc?.smsCode || '',
        emailCode: acc?.emailCode || '',
        isOutlook: false,
        // 仅手机号模式：token 文件以手机号命名
        hasToken: tokenEmails.has(phone.toLowerCase()),
      });
    }

    rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const stats = {
      total: rows.length,
      bound: rows.filter(r => r.email).length,
      outlookBound: rows.filter(r => r.isOutlook).length,
      tokenCount: rows.filter(r => r.hasToken).length,
    };
    return { ok: true, accounts: rows, stats };
  } catch (error) {
    return summarizeError(error);
  }
});

ipcMain.handle('outlook:pick-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择卡密文件',
    filters: [{ name: '文本文件', extensions: ['txt', 'text', 'csv'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  return { ok: true, filePath: result.filePaths[0] };
});

ipcMain.handle('runtime:start', async (_event, options = {}) => {
  const lic = checkLicense();
  if (lic.status !== STATUS.OK) {
    return { ok: false, message: `未激活授权：${lic.message || '请先激活软件'}` };
  }
  if (activeRun) return { ok: false, message: '已有任务正在运行，请先停止或等待完成' };
  const config = safeConfig(readJson(configPath, {}));
  const mode = String(options.mode || 'full');
  const issues = validateConfig(config, mode);
  if (issues.length) return { ok: false, message: issues.join('；') };

  fs.mkdirSync(getTokenDir(config), { recursive: true });

  const args = ['index.js'];
  if (mode === 'phase2') args.push('--phase2');
  if (mode === 'phase3') args.push('--phase3');
  if (mode === 'phase8') args.push('--phase8');
  if (mode === 'email') args.push('--email');
  if (mode === 'phone') args.push('--phone-only');
  if (mode !== 'email' && options.stopAfterPhase2 && mode !== 'phone') args.push('--stop-after-phase2');
  if (mode !== 'email' && options.country) args.push(`--country=${String(options.country).toUpperCase()}`);
  const concurrency = Number(options.concurrency || config.concurrency);
  if (concurrency && concurrency >= 1) args.push(`--concurrency=${concurrency}`);
  const targetCount = Math.max(1, Math.min(100, Math.floor(Number(options.targetCount || config.targetTokenCount) || 1)));
  args.push(String(targetCount));

  lastLogLines = [];
  runStartedAt = Date.now();
  activeRun = spawn(getNodeCommand(), args, { cwd: projectRoot, env: { ...process.env, FORCE_COLOR: '0' }, windowsHide: false });
  const pid = activeRun.pid;
  appendLog('system', `任务已启动，PID=${pid}`);
  activeRun.stdout.on('data', data => appendLog('stdout', data.toString('utf8')));
  activeRun.stderr.on('data', data => appendLog('stderr', data.toString('utf8')));
  activeRun.on('error', error => {
    appendLog('system', `启动失败: ${error.message}`);
    emit('runtime:state', { isRunning: false, exitCode: null, message: error.message });
    activeRun = null;
  });
  activeRun.on('close', code => {
    const durationMs = runStartedAt ? Date.now() - runStartedAt : 0;
    appendLog('system', `任务结束，退出码=${code}，耗时=${Math.round(durationMs / 1000)}s`);
    activeRun = null;
    runStartedAt = null;
    emit('runtime:state', { isRunning: false, exitCode: code, durationMs });
  });
  emit('runtime:state', { isRunning: true, pid });
  return { ok: true, pid };
});

ipcMain.handle('runtime:stop', async () => {
  if (!activeRun) return { ok: true, message: '没有正在运行的任务' };
  const pid = activeRun.pid;
  appendLog('system', `用户请求停止任务，PID=${pid}`);
  activeRun.kill('SIGTERM');
  appendLog('system', `已发送停止信号，PID=${pid}`);
  return { ok: true };
});



