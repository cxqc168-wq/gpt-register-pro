const api = window.desktopApi;
const state = {
  config: {},
  issues: [],
  counts: {},
  isRunning: false,
  logs: [],
  smsRows: [],
  tokenStatusRows: [],
  tokenStatusTimer: null,
  tokenStatusPending: false,
  refreshTimer: null,
  refreshPending: false,
  smsPending: false,
};

// 服务商注册表：与后端 SMS_PROVIDER_REGISTRY 保持一致；新增服务商在此加一条即可
const SMS_PROVIDER_LABELS = { herosms: 'HeroSMS', nexsms: 'NexSMS', grizzly: 'Grizzly SMS' };

function activeSmsProvider() {
  const provider = String(state.config.smsProvider || '').toLowerCase();
  return SMS_PROVIDER_LABELS[provider] ? provider : 'herosms';
}

const COUNTRY_ZH = {
  GB: '英国', US: '美国', CA: '加拿大', AU: '澳大利亚', NZ: '新西兰', IE: '爱尔兰',
  DE: '德国', FR: '法国', ES: '西班牙', IT: '意大利', NL: '荷兰', BE: '比利时',
  AT: '奥地利', CH: '瑞士', SE: '瑞典', NO: '挪威', DK: '丹麦', FI: '芬兰',
  PL: '波兰', PT: '葡萄牙', CZ: '捷克', GR: '希腊', RO: '罗马尼亚', HU: '匈牙利',
  TR: '土耳其', IL: '以色列', AE: '阿联酋', SA: '沙特阿拉伯', SG: '新加坡',
  MY: '马来西亚', TH: '泰国', VN: '越南', PH: '菲律宾', ID: '印度尼西亚',
  IN: '印度', JP: '日本', KR: '韩国', HK: '中国香港', TW: '中国台湾',
  BR: '巴西', MX: '墨西哥', AR: '阿根廷', CL: '智利', CO: '哥伦比亚',
  PE: '秘鲁', ZA: '南非', EG: '埃及', NG: '尼日利亚', CN: '中国', RU: '俄罗斯',
  UA: '乌克兰', KZ: '哈萨克斯坦', PK: '巴基斯坦', BD: '孟加拉国'
};
const COUNTRY_EN_ZH = {
  'afghanistan': '阿富汗', 'albania': '阿尔巴尼亚', 'algeria': '阿尔及利亚', 'angola': '安哥拉',
  'argentina': '阿根廷', 'armenia': '亚美尼亚', 'australia': '澳大利亚', 'austria': '奥地利',
  'azerbaijan': '阿塞拜疆', 'bahrain': '巴林', 'bangladesh': '孟加拉国', 'belarus': '白俄罗斯',
  'belgium': '比利时', 'bolivia': '玻利维亚', 'bosnia and herzegovina': '波黑', 'brazil': '巴西',
  'bulgaria': '保加利亚', 'cambodia': '柬埔寨', 'cameroon': '喀麦隆', 'canada': '加拿大',
  'chile': '智利', 'china': '中国', 'colombia': '哥伦比亚', 'costa rica': '哥斯达黎加',
  'croatia': '克罗地亚', 'cyprus': '塞浦路斯', 'czech republic': '捷克', 'czechia': '捷克',
  'denmark': '丹麦', 'dominican republic': '多米尼加共和国', 'ecuador': '厄瓜多尔', 'egypt': '埃及',
  'estonia': '爱沙尼亚', 'ethiopia': '埃塞俄比亚', 'finland': '芬兰', 'france': '法国',
  'georgia': '格鲁吉亚', 'germany': '德国', 'ghana': '加纳', 'greece': '希腊',
  'guatemala': '危地马拉', 'hong kong': '中国香港', 'hungary': '匈牙利', 'india': '印度',
  'indonesia': '印度尼西亚', 'ireland': '爱尔兰', 'israel': '以色列', 'italy': '意大利',
  'japan': '日本', 'jordan': '约旦', 'kazakhstan': '哈萨克斯坦', 'kenya': '肯尼亚',
  'kuwait': '科威特', 'kyrgyzstan': '吉尔吉斯斯坦', 'laos': '老挝', 'latvia': '拉脱维亚',
  'lebanon': '黎巴嫩', 'lithuania': '立陶宛', 'luxembourg': '卢森堡', 'macau': '中国澳门',
  'malaysia': '马来西亚', 'mexico': '墨西哥', 'moldova': '摩尔多瓦', 'mongolia': '蒙古',
  'morocco': '摩洛哥', 'mozambique': '莫桑比克', 'myanmar': '缅甸', 'nepal': '尼泊尔',
  'netherlands': '荷兰', 'new zealand': '新西兰', 'nigeria': '尼日利亚', 'norway': '挪威',
  'oman': '阿曼', 'pakistan': '巴基斯坦', 'panama': '巴拿马', 'paraguay': '巴拉圭',
  'peru': '秘鲁', 'philippines': '菲律宾', 'poland': '波兰', 'portugal': '葡萄牙',
  'qatar': '卡塔尔', 'romania': '罗马尼亚', 'russia': '俄罗斯', 'russian federation': '俄罗斯',
  'saudi arabia': '沙特阿拉伯', 'senegal': '塞内加尔', 'serbia': '塞尔维亚', 'singapore': '新加坡',
  'slovakia': '斯洛伐克', 'slovenia': '斯洛文尼亚', 'south africa': '南非', 'south korea': '韩国',
  'spain': '西班牙', 'sri lanka': '斯里兰卡', 'sweden': '瑞典', 'switzerland': '瑞士',
  'taiwan': '中国台湾', 'tajikistan': '塔吉克斯坦', 'tanzania': '坦桑尼亚', 'thailand': '泰国',
  'tunisia': '突尼斯', 'turkey': '土耳其', 'turkmenistan': '土库曼斯坦', 'uganda': '乌干达',
  'ukraine': '乌克兰', 'united arab emirates': '阿联酋', 'uae': '阿联酋',
  'united kingdom': '英国', 'uk': '英国', 'great britain': '英国', 'britain': '英国',
  'united states': '美国', 'united states of america': '美国', 'usa': '美国', 'america': '美国',
  'uruguay': '乌拉圭', 'uzbekistan': '乌兹别克斯坦', 'venezuela': '委内瑞拉', 'vietnam': '越南',
  'zambia': '赞比亚', 'zimbabwe': '津巴布韦'
};

const HERO_ID_ZH = {
  4: '菲律宾', 6: '印度尼西亚', 16: '英国', 33: '哥伦比亚', 39: '阿根廷', 73: '巴西',
  117: '葡萄牙', 151: '智利', 187: '美国'
};
// 中文名 → ISO 反查（NexSMS 的地区接口只返回中文名，用它补全 ISO 列）
const COUNTRY_ZH_TO_ISO = {};
for (const [iso, zh] of Object.entries(COUNTRY_ZH)) {
  if (!COUNTRY_ZH_TO_ISO[zh]) COUNTRY_ZH_TO_ISO[zh] = iso;
}
const HERO_ID_META = {
  4: { isoCode: 'PH', dialCode: '63' },
  6: { isoCode: 'ID', dialCode: '62' },
  16: { isoCode: 'GB', dialCode: '44' },
  31: { isoCode: 'ZA', dialCode: '27' },
  33: { isoCode: 'CO', dialCode: '57' },
  39: { isoCode: 'AR', dialCode: '54' },
  50: { isoCode: 'AT', dialCode: '43' },
  73: { isoCode: 'BR', dialCode: '55' },
  117: { isoCode: 'PT', dialCode: '351' },
  151: { isoCode: 'CL', dialCode: '56' },
  187: { isoCode: 'US', dialCode: '1' },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function normalizeIso(value) {
  return String(value || '').trim().toUpperCase();
}

function countryIso(row = {}) {
  const heroId = Number(row.heroSmsCountry);
  return normalizeIso(row.isoCode || row.code || row.countryCode || row.iso || row.phoneCountryCode || HERO_ID_META[heroId]?.isoCode)
    || COUNTRY_ZH_TO_ISO[row.nameZh || row.apiName || '']
    || '';
}

function countryDial(row = {}) {
  const heroId = Number(row.heroSmsCountry);
  return String(row.dialCode || row.phoneCode || row.prefix || HERO_ID_META[heroId]?.dialCode || '').replace(/^\+/, '').trim();
}

function normalizeCountryKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function countryName(row = {}) {
  const iso = countryIso(row);
  const englishKey = normalizeCountryKey(row.apiName || row.name || row.country || row.countryName);
  const heroId = Number(row.heroSmsCountry);
  return COUNTRY_ZH[iso]
    || COUNTRY_EN_ZH[englishKey]
    || HERO_ID_ZH[heroId]
    || row.nameZh
    || row.zhName
    || row.chineseName
    || row.nameCn
    || row.name
    || row.apiName
    || iso
    || '-';
}

function countryOptionLabel(country = {}) {
  const iso = countryIso(country);
  const name = countryName(country);
  const parts = [name];
  if (iso) parts.push(iso);
  if (country.dialCode) parts.push(`+${country.dialCode}`);
  if (country.heroSmsCountry !== undefined && country.heroSmsCountry !== null && country.heroSmsCountry !== '') parts.push(`ID ${country.heroSmsCountry}`);
  return parts.join(' · ');
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 3200);
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function setView(view) {
  $$('.nav-item').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
  $$('.view').forEach(section => section.classList.toggle('active', section.id === `view-${view}`));
  const titles = {
    console: ['Console', '控制台'],
    config: ['Settings', '后台配置'],
    sms: ['SMS Config', '接码配置'],
    outlook: ['Outlook Pool', 'Outlook 邮箱池'],
    accounts: ['Accounts', '账号信息'],
    'token-status': ['Token Status', 'Token 状态'],
  };
  $('#viewEyebrow').textContent = titles[view][0];
  $('#viewTitle').textContent = titles[view][1];
  if (view === 'token-status') refreshTokenStatus().catch(error => console.warn(error));
  if (view === 'sms') refreshSmsOverview({ silent: true }).catch(error => console.warn(error));
  if (view === 'outlook') refreshOutlookAccounts({ silent: true }).catch(error => console.warn(error));
  if (view === 'accounts') refreshAccounts({ silent: true }).catch(error => console.warn(error));
}

function updateRunState(running) {
  state.isRunning = running;
  $('#runDot').classList.toggle('running', running);
  $('#runStateText').textContent = running ? '运行中' : '未运行';
  $('#statusPill').textContent = running ? '运行中' : '空闲';
  $('#statusPill').classList.toggle('running', running);
  $('#startBtn').disabled = running;
  $('#stopBtn').disabled = !running;
  scheduleLiveRefresh(running);
}

function updateSummaryUi(summary) {
  state.config = summary.config || {};
  state.issues = summary.issues || [];
  state.counts = summary.counts || {};
  $('#accountCount').textContent = state.counts.accounts ?? 0;
  $('#usernameCount').textContent = state.counts.usernames ?? 0;
  $('#tokenCount').textContent = state.counts.tokens ?? 0;
  $('#issueText').textContent = state.issues.length ? state.issues.join('；') : '配置可运行';
  updateRunState(!!summary.isRunning);
  const targetInput = document.querySelector('#targetTokenCount');
  if (targetInput && !summary.isRunning) targetInput.value = Math.max(1, Math.min(100, Math.floor(Number(state.config.targetTokenCount) || 1)));
  renderCountryOptions(state.config);
  fillConfigForm(state.config);
  fillSmsCards(state.config);
  updateSmsProviderUi();
  state.logs = summary.logs || [];
  renderLogs();
}

function renderCountryOptions(config = {}) {
  const select = $('#runCountry');
  if (!select) return;
  const currentValue = normalizeIso(select.value);
  const configured = Array.isArray(config.phoneCountries) ? config.phoneCountries : [];
  const fallback = [
    { isoCode: 'PH', dialCode: '63', heroSmsCountry: 4 },
    { isoCode: 'GB', dialCode: '44', heroSmsCountry: 16 },
    { isoCode: 'BR', dialCode: '55', heroSmsCountry: 73 },
    { isoCode: 'ID', dialCode: '62', heroSmsCountry: 6 },
    { isoCode: 'CO', dialCode: '57', heroSmsCountry: 33 },
    { isoCode: 'CL', dialCode: '56', heroSmsCountry: 151 },
    { isoCode: 'AR', dialCode: '54', heroSmsCountry: 39 },
    { isoCode: 'PT', dialCode: '351', heroSmsCountry: 117 },
    { isoCode: 'ZA', dialCode: '27', heroSmsCountry: 31 },
    { isoCode: 'AT', dialCode: '43', heroSmsCountry: 50 },
    { isoCode: 'US', dialCode: '1', heroSmsCountry: 187 },
  ];
  const countries = configured.length ? configured : fallback;
  const seen = new Set();
  const options = countries
    .map(country => ({ ...country, isoCode: countryIso(country) }))
    .filter(country => country.isoCode && !seen.has(country.isoCode) && seen.add(country.isoCode));
  const selected = currentValue || normalizeIso(config.phoneCountryCode) || options[0]?.isoCode || 'GB';
  select.innerHTML = options.map(country => {
    const value = escapeHtml(country.isoCode);
    const label = escapeHtml(countryOptionLabel(country));
    return `<option value="${value}">${label}</option>`;
  }).join('');
  if (!options.some(country => country.isoCode === selected)) {
    select.insertAdjacentHTML('afterbegin', `<option value="${escapeHtml(selected)}">${escapeHtml(COUNTRY_ZH[selected] || selected)} · ${escapeHtml(selected)}</option>`);
  }
  select.value = selected;
}

function fillConfigForm(config) {
  const form = $('#configForm');
  for (const [key, value] of Object.entries(config)) {
    const input = form.elements[key];
    if (!input) continue;
    if (input.type === 'checkbox') {
      input.checked = !!value;
    } else {
      input.value = value ?? '';
    }
  }
}

function collectConfigForm() {
  const form = $('#configForm');
  const data = {};
  for (const element of [...form.elements]) {
    if (!element.name) continue;
    if (element.type === 'checkbox') data[element.name] = element.checked;
    else if (element.type === 'number') data[element.name] = Number(element.value) || 0;
    else data[element.name] = element.value.trim();
  }
  if (data.mailDomain) data.mailDomains = [data.mailDomain];
  return data;
}

// ===== 接码配置：服务商切换与凭据卡片 =====

function fillSmsCards(config = {}) {
  for (const form of $$('.sms-config-card')) {
    // 正在编辑时不回填，避免运行中自动刷新打断输入
    if (form.contains(document.activeElement)) continue;
    for (const [key, value] of Object.entries(config)) {
      const input = form.elements[key];
      if (!input || input.type === 'submit') continue;
      input.value = value ?? '';
    }
  }
}

function updateSmsProviderUi() {
  const active = activeSmsProvider();
  const label = SMS_PROVIDER_LABELS[active] || active;
  $$('#smsProviderSwitch button').forEach(btn => btn.classList.toggle('active', btn.dataset.provider === active));
  $$('.sms-config-card').forEach(card => {
    const isActive = card.dataset.provider === active;
    card.classList.toggle('active', isActive);
    const chip = card.querySelector('[data-card-chip]');
    if (chip) chip.textContent = isActive ? '使用中' : '未激活';
  });
  ['#smsProviderChip', '#configProviderChip'].forEach(selector => {
    const chip = $(selector);
    if (!chip) return;
    chip.textContent = label;
    chip.dataset.provider = active;
  });
}

async function switchSmsProvider(provider) {
  const next = SMS_PROVIDER_LABELS[provider] ? provider : 'herosms';
  if (activeSmsProvider() === next) return;
  const switchEl = $('#smsProviderSwitch');
  if (switchEl) switchEl.classList.add('busy');
  try {
    const result = await api.saveConfig({ smsProvider: next });
    if (!result.ok) {
      toast(result.message || '服务商切换失败');
      return;
    }
    state.config = result.config || { ...state.config, smsProvider: next };
    state.issues = result.issues || [];
    $('#issueText').textContent = state.issues.length ? state.issues.join('；') : '配置可运行';
    updateSmsProviderUi();
    toast(`接码服务商已切换为 ${SMS_PROVIDER_LABELS[next]}`);
    await refreshSmsOverview();
  } finally {
    if (switchEl) switchEl.classList.remove('busy');
  }
}

async function saveSmsCard(provider) {
  const form = $$('.sms-config-card').find(card => card.dataset.provider === provider);
  if (!form) return;
  const data = {};
  for (const element of [...form.elements]) {
    if (!element.name || element.type === 'submit') continue;
    data[element.name] = element.value.trim();
  }
  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  try {
    const result = await api.saveConfig(data);
    if (result.ok) {
      state.config = result.config || { ...state.config, ...data };
      state.issues = result.issues || [];
      $('#issueText').textContent = state.issues.length ? state.issues.join('；') : '配置可运行';
      toast(`${SMS_PROVIDER_LABELS[provider] || '接码'} 配置已保存`);
    } else {
      toast(result.message || '保存失败');
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function appendLog(item) {
  state.logs.push(item);
  if (state.logs.length > 800) state.logs.shift();
  renderLogs(true);
  if (/Token (成功保存|已保存)|token saved/i.test(item?.line || '')) {
    refreshSummary().catch(error => console.warn(error));
  }
}

function renderLogs(stickToBottom = false) {
  const box = $('#logBox');
  box.textContent = state.logs.map(item => `[${formatTime(item.at)}] ${item.source}: ${item.line}`).join('\n');
  if (stickToBottom) box.scrollTop = box.scrollHeight;
}

function renderSmsRows() {
  const query = $('#countryFilter').value.trim().toLowerCase();
  const rows = state.smsRows.filter(row => {
    const zhName = countryName(row);
    const haystack = [countryIso(row), zhName, row.name, row.apiName, row.heroSmsCountry, row.nexSmsCountry, countryDial(row)].join(' ').toLowerCase();
    return !query || haystack.includes(query);
  });
  const tbody = $('#countryTable');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6">暂无数据</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(row => {
    const price = Number.isFinite(Number(row.price)) ? `$${Number(row.price).toFixed(3)}` : '-';
    const count = Number.isFinite(Number(row.count)) ? Number(row.count) : '-';
    const dial = countryDial(row);
    const countryId = row.heroSmsCountry ?? row.nexSmsCountry ?? '-';
    return `<tr><td>${escapeHtml(countryIso(row) || '-')}</td><td>${escapeHtml(countryName(row))}</td><td>${dial ? `+${escapeHtml(dial)}` : '-'}</td><td>${escapeHtml(countryId)}</td><td>${price}</td><td>${count}</td></tr>`;
  }).join('');
}

function statusClass(status) {
  if (status === '可用') return 'ok';
  if (status === '未知') return 'unknown';
  return 'bad';
}

function renderTokenStatusRows() {
  const tbody = $('#tokenStatusTable');
  if (!tbody) return;
  const rows = state.tokenStatusRows || [];
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4">暂无 Token 文件</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(row => {
    const status = row.status || '未知';
    const updated = row.checkedAt ? new Date(row.checkedAt).toLocaleString('zh-CN') : '-';
    return `<tr><td>${escapeHtml(row.email || '-')}</td><td><span class="token-badge ${statusClass(status)}">${escapeHtml(status)}</span></td><td>${escapeHtml(updated)}</td><td>${escapeHtml(row.error || '-')}</td></tr>`;
  }).join('');
}

function updateTokenStatusUi(result) {
  state.tokenStatusRows = result.rows || [];
  const counts = result.counts || {};
  const abnormal = (counts['已过期'] || 0) + (counts['刷新失败'] || 0) + (counts['接口不可用'] || 0);
  $('#tokenStatusTotal').textContent = result.total ?? state.tokenStatusRows.length;
  $('#tokenStatusOk').textContent = counts['可用'] || 0;
  $('#tokenStatusBad').textContent = abnormal;
  $('#tokenStatusUnknown').textContent = counts['未知'] || 0;
  $('#tokenStatusUpdated').textContent = result.refreshedAt
    ? `最后检测 ${new Date(result.refreshedAt).toLocaleString('zh-CN')}，每 10 秒自动刷新`
    : '每 10 秒自动刷新一次';
  renderTokenStatusRows();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

async function refreshSummary() {
  if (state.refreshPending) return;
  state.refreshPending = true;
  try {
    const summary = await api.getSummary();
    updateSummaryUi(summary);
  } finally {
    state.refreshPending = false;
  }
}

function scheduleLiveRefresh(running) {
  if (!running) {
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = null;
    return;
  }
  if (state.refreshTimer) return;
  state.refreshTimer = setInterval(() => {
    refreshSummary().catch(error => console.warn(error));
  }, 3000);
}

async function refreshSmsOverview({ silent = false } = {}) {
  if (state.smsPending) return;
  state.smsPending = true;
  const btn = $('#refreshSmsBtn');
  if (btn) btn.disabled = true;
  try {
    const result = await api.getSmsOverview();
    if (!result.ok) {
      if (!silent) toast(result.message || result.detail || '接码数据获取失败');
      return;
    }
    state.smsRows = result.countries || [];
    $('#smsProviderName').textContent = result.providerLabel || SMS_PROVIDER_LABELS[activeSmsProvider()] || '-';
    $('#smsBalance').textContent = result.balance === null || result.balance === undefined
      ? (result.balanceRaw || '-')
      : `$${Number(result.balance).toFixed(2)}`;
    $('#smsService').textContent = result.service || '-';
    $('#smsCountryCount').textContent = result.countryCount ?? state.smsRows.length;
    const accountPart = result.username ? `账户 ${result.username} · ` : '';
    $('#smsUpdated').textContent = `${accountPart}当前服务商 ${result.providerLabel || '-'} · 最后刷新 ${new Date(result.refreshedAt).toLocaleString('zh-CN')}`;
    renderSmsRows();
    if (!silent) toast(`${result.providerLabel || '接码'} 数据已刷新`);
  } finally {
    state.smsPending = false;
    if (btn) btn.disabled = false;
  }
}

async function refreshTokenStatus({ silent = false } = {}) {
  if (state.tokenStatusPending) return;
  state.tokenStatusPending = true;
  const btn = $('#refreshTokenStatusBtn');
  if (btn) btn.disabled = true;
  try {
    const result = await api.getTokenStatus();
    if (!result.ok) {
      if (!silent) toast(result.message || result.detail || 'Token 状态检测失败');
      return;
    }
    updateTokenStatusUi(result);
    if (!silent) toast('Token 状态已刷新');
  } finally {
    state.tokenStatusPending = false;
    if (btn) btn.disabled = false;
  }
}

async function testMail() {
  $('#testMailBtn').disabled = true;
  try {
    const result = await api.testMail();
    if (result.ok) toast(`邮箱接口正常：${result.address}${result.message ? `，${result.message}` : ''}`);
    else toast(result.message || result.detail || '邮箱接口测试失败');
  } finally {
    $('#testMailBtn').disabled = false;
  }
}

// ===== Outlook 邮箱池 =====

const OUTLOOK_STATUS_LABEL = {
  available: '可用',
  pending: '分配中',
  used: '已使用',
  invalid: '无效',
};

function outlookStatusBadge(status) {
  const label = OUTLOOK_STATUS_LABEL[status] || status || '-';
  const cls = status === 'available' ? 'ok' : (status === 'invalid' ? 'bad' : 'unknown');
  return `<span class="token-badge ${cls}">${escapeHtml(label)}</span>`;
}

function updateOutlookUi(result) {
  const accounts = result.accounts || [];
  const stats = result.stats || {};
  $('#outlookAvailable').textContent = stats.available ?? 0;
  $('#outlookUsed').textContent = stats.used ?? 0;
  $('#outlookInvalid').textContent = stats.invalid ?? 0;
  $('#outlookTotal').textContent = stats.total ?? accounts.length;
  const tbody = $('#outlookTable');
  if (!accounts.length) {
    tbody.innerHTML = '<tr><td colspan="5">暂无数据，请先导入卡密</td></tr>';
    return;
  }
  tbody.innerHTML = accounts.map(account => {
    const importedAt = account.importedAt ? new Date(account.importedAt).toLocaleString('zh-CN') : '-';
    const lastError = account.lastError ? escapeHtml(String(account.lastError).slice(0, 80)) : '-';
    return `<tr>
      <td>${escapeHtml(account.email)}</td>
      <td>${outlookStatusBadge(account.status)}</td>
      <td class="outlook-error-cell">${lastError}</td>
      <td>${escapeHtml(importedAt)}</td>
      <td>
        <button class="ghost-button small outlook-action" data-action="detail" data-email="${escapeHtml(account.email)}">详情</button>
        <button class="ghost-button small outlook-action" data-action="test" data-email="${escapeHtml(account.email)}">测试</button>
        <button class="ghost-button small outlook-action" data-action="reset" data-email="${escapeHtml(account.email)}">重置</button>
        <button class="ghost-button small outlook-action" data-action="mails" data-email="${escapeHtml(account.email)}">邮件</button>
      </td>
    </tr>`;
  }).join('');
}

async function refreshOutlookAccounts({ silent = false } = {}) {
  const result = await api.getOutlookAccounts();
  if (!result.ok) {
    if (!silent) toast(result.message || result.detail || 'Outlook 账号列表获取失败');
    return;
  }
  updateOutlookUi(result);
  if (!silent) toast('Outlook 账号列表已刷新');
}

// ===== 导入卡密模态框 =====

function openOutlookImportModal() {
  $('#outlookImportModal').hidden = false;
  $('#outlookImportText').focus();
}

function closeOutlookImportModal() {
  $('#outlookImportModal').hidden = true;
}

function updateImportLineCount() {
  const text = $('#outlookImportText').value;
  const lines = text.split(/\r?\n/).filter(line => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith('#') && trimmed.includes('----');
  });
  const counter = $('#outlookLineCount');
  if (counter) counter.innerHTML = `已识别 <strong>${lines.length}</strong> 条卡密`;
  return lines.length;
}

async function importOutlookCards() {
  const text = $('#outlookImportText').value;
  if (!text.trim()) {
    toast('请先粘贴卡密内容或选择 txt 文件');
    return;
  }
  const btn = $('#outlookImportBtn');
  btn.disabled = true;
  const resultLine = $('#outlookImportResult');
  const errorsList = $('#outlookImportErrors');
  try {
    const result = await api.importOutlook({ text });
    resultLine.style.display = 'block';
    resultLine.textContent = result.message || '导入完成';
    resultLine.classList.toggle('bad', !result.ok);
    if (Array.isArray(result.errors) && result.errors.length) {
      errorsList.style.display = 'block';
      errorsList.innerHTML = result.errors.map(err => `<li>${escapeHtml(err)}</li>`).join('');
    } else {
      errorsList.style.display = 'none';
      errorsList.innerHTML = '';
    }
    if (result.accounts) updateOutlookUi(result);
    else await refreshOutlookAccounts({ silent: true });
    toast(result.message || '导入完成');
    if (result.ok) {
      $('#outlookImportText').value = '';
      updateImportLineCount();
      setTimeout(closeOutlookImportModal, 1200);
    }
  } catch (error) {
    toast(error.message || '导入失败');
  } finally {
    btn.disabled = false;
  }
}

async function importOutlookFromFile() {
  const picked = await api.pickOutlookFile();
  if (!picked.ok) return;
  try {
    const result = await api.importOutlook({ filePath: picked.filePath });
    const resultLine = $('#outlookImportResult');
    const errorsList = $('#outlookImportErrors');
    resultLine.style.display = 'block';
    resultLine.textContent = `${picked.filePath} → ${result.message || '导入完成'}`;
    resultLine.classList.toggle('bad', !result.ok);
    if (Array.isArray(result.errors) && result.errors.length) {
      errorsList.style.display = 'block';
      errorsList.innerHTML = result.errors.map(err => `<li>${escapeHtml(err)}</li>`).join('');
    } else {
      errorsList.style.display = 'none';
      errorsList.innerHTML = '';
    }
    if (result.accounts) updateOutlookUi(result);
    toast(result.message || '导入完成');
    if (result.ok) setTimeout(closeOutlookImportModal, 1200);
  } catch (error) {
    toast(error.message || '文件导入失败');
  }
}

async function handleOutlookAction(action, email) {
  // 详情/邮件走独立模态框，不进按钮禁用流程
  if (action === 'detail') {
    await openOutlookDetailModal(email);
    return;
  }
  if (action === 'mails') {
    await openOutlookMailsModal(email);
    return;
  }
  const buttons = $$('.outlook-action');
  buttons.forEach(btn => { btn.disabled = true; });
  try {
    const result = action === 'test'
      ? await api.testOutlookAccount(email)
      : await api.resetOutlookAccount(email);
    toast(`${email}: ${result.message || (result.ok ? '操作成功' : '操作失败')}`);
    if (result.accounts) updateOutlookUi(result);
    else await refreshOutlookAccounts({ silent: true });
  } catch (error) {
    toast(error.message || '操作失败');
  } finally {
    buttons.forEach(btn => { btn.disabled = false; });
  }
}

// ===== Outlook 邮箱详情模态框（邮箱池 / 账号信息共用） =====

let currentOutlookDetail = null;

function formatMs(ms) {
  return ms ? new Date(ms).toLocaleString('zh-CN') : '-';
}

function detailRow(label, value, { mono = false, wrap = false } = {}) {
  const cls = [mono ? 'mono' : '', wrap ? 'wrap' : ''].filter(Boolean).join(' ');
  return `<div class="detail-row"><span>${label}</span><code class="${cls}">${escapeHtml(String(value ?? '-'))}</code></div>`;
}

async function openOutlookDetailModal(email) {
  const modal = $('#outlookDetailModal');
  const grid = $('#outlookDetailGrid');
  grid.innerHTML = '<p class="soft-note">加载中...</p>';
  modal.hidden = false;
  try {
    const result = await api.getOutlookDetail(email);
    if (!result.ok) {
      grid.innerHTML = `<p class="soft-note">${escapeHtml(result.message || '获取详情失败')}</p>`;
      return;
    }
    const d = result.detail;
    currentOutlookDetail = d;
    $('#outlookDetailTitle').textContent = `邮箱详情 - ${d.email}`;
    const tokenLength = String(d.refreshToken || '').trim().length;
    grid.innerHTML = [
      detailRow('邮箱地址', d.email, { mono: true }),
      detailRow('密码', d.password || '（空）', { mono: true }),
      detailRow('client_id', d.clientId, { mono: true, wrap: true }),
      detailRow('refresh_token', d.refreshToken || '（空）', { mono: true, wrap: true }),
      d.tokenSuspicious
        ? `<div class="detail-warn">refresh_token 疑似占位符/模板值（长度 ${tokenLength}），并非真实凭据，因此刷新失败（invalid_grant）且账号被标记为无效。请重新导入包含真实 refresh_token 的完整卡密，导入成功后该账号会自动恢复为可用。</div>`
        : '',
      detailRow('状态', OUTLOOK_STATUS_LABEL[d.status] || d.status || '-'),
      detailRow('取件方式', d.fetchMode === 'imap' ? 'IMAP XOAUTH2' : (d.fetchMode === 'graph' ? 'Graph API' : '未检测')),
      detailRow('绑定号码', d.boundPhone || '未绑定'),
      detailRow('导入时间', formatMs(d.importedAt)),
      detailRow('更新时间', formatMs(d.updatedAt)),
      d.lastError ? detailRow('最近错误', d.lastError, { wrap: true }) : '',
    ].filter(Boolean).join('');
  } catch (error) {
    grid.innerHTML = `<p class="soft-note">${escapeHtml(error.message || '获取详情失败')}</p>`;
  }
}

function closeOutlookDetailModal() {
  const modal = $('#outlookDetailModal');
  modal.hidden = true;
  currentOutlookDetail = null;
}

// ===== Outlook 邮件查看模态框（左右分栏：列表 + 详情） =====

let currentMailList = [];
let currentMailIndex = -1;

// HTML 邮件用 sandbox iframe 安全渲染（无脚本执行），纯文本走转义显示
function renderMailContent(content) {
  const text = String(content || '').trim();
  if (!text) return '<div class="mail-empty-body">（无正文）</div>';
  if (/^\s*<(html|div|p|table|body|!doctype)/i.test(text) || (text.includes('</') && text.includes('<'))) {
    const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:0;padding:12px;font:13px/1.6 "Segoe UI","Microsoft YaHei UI",sans-serif;color:#172321;word-break:break-word;} img{max-width:100%;height:auto;} a{color:#1f7b68;}</style></head><body>${text}</body></html>`;
    return `<iframe class="mail-body-frame" sandbox="" srcdoc="${escapeHtml(doc)}"></iframe>`;
  }
  return `<pre class="mail-body-text">${escapeHtml(text)}</pre>`;
}

function renderMailDetail(mail) {
  const wrap = $('#mailDetailPanel');
  if (!mail) {
    wrap.innerHTML = '<div class="mail-detail-empty">从左侧选择一封邮件查看详情</div>';
    return;
  }
  wrap.innerHTML = `
    <div class="mail-detail-head">
      <h4 class="mail-detail-subject">${escapeHtml(mail.subject || '（无主题）')}</h4>
      <div class="mail-detail-meta">
        <span class="mail-from" title="${escapeHtml(mail.from)}">${escapeHtml(mail.from || '未知发件人')}</span>
        <span class="mail-time">${escapeHtml(formatMs(mail.receivedAt))}</span>
      </div>
    </div>
    <div class="mail-detail-body">${renderMailContent(mail.content)}</div>`;
}

function selectMail(index) {
  currentMailIndex = index;
  $$('#mailListPanel .mail-item').forEach((item, i) => item.classList.toggle('active', i === index));
  renderMailDetail(currentMailList[index]);
}

function renderMailList(mails) {
  const listPanel = $('#mailListPanel');
  currentMailList = mails || [];
  currentMailIndex = -1;
  if (!currentMailList.length) {
    listPanel.innerHTML = '<div class="mail-detail-empty">收件箱与垃圾箱均无邮件</div>';
    renderMailDetail(null);
    return;
  }
  listPanel.innerHTML = currentMailList.map((mail, i) => `
    <button class="mail-item" data-index="${i}">
      <span class="mail-item-subject">${escapeHtml(mail.subject || '（无主题）')}</span>
      <span class="mail-item-from" title="${escapeHtml(mail.from)}">${escapeHtml(mail.from || '未知发件人')}</span>
      <span class="mail-item-time">${escapeHtml(formatMs(mail.receivedAt))}</span>
    </button>`).join('');
  selectMail(0);
}

async function openOutlookMailsModal(email) {
  const modal = $('#outlookMailsModal');
  $('#outlookMailsTitle').textContent = `邮件 - ${email}`;
  $('#mailListPanel').innerHTML = '<div class="mail-detail-empty">邮件拉取中...</div>';
  $('#mailDetailPanel').innerHTML = '<div class="mail-detail-empty">从左侧选择一封邮件查看详情</div>';
  modal.hidden = false;
  try {
    const result = await api.getOutlookMails(email, 50);
    if (!result.ok) {
      $('#mailListPanel').innerHTML = `<div class="mail-detail-error">${escapeHtml(result.message || '邮件拉取失败')}</div>`;
      return;
    }
    renderMailList(result.mails);
  } catch (error) {
    $('#mailListPanel').innerHTML = `<div class="mail-detail-error">${escapeHtml(error.message || '邮件拉取失败')}</div>`;
  }
}

function closeOutlookMailsModal() {
  $('#outlookMailsModal').hidden = true;
  currentMailList = [];
  currentMailIndex = -1;
}

// 作者信息模态框
function openAuthorModal() {
  $('#authorModal').hidden = false;
}
function closeAuthorModal() {
  $('#authorModal').hidden = true;
}

async function copyOutlookCard() {
  if (!currentOutlookDetail) return;
  const d = currentOutlookDetail;
  const card = [d.email, d.password || '', d.clientId, d.refreshToken].join('----');
  try {
    await navigator.clipboard.writeText(card);
    toast('完整卡密已复制到剪贴板');
  } catch {
    toast('复制失败，请手动选择复制');
  }
}

// ===== 账号信息 =====

const ACCOUNT_STATUS_LABEL = {
  registered: '已注册',
  email_bound: '已绑邮箱',
  oauth_done: 'OAuth 完成',
  oauth_phase2_failed: '绑定失败',
  oauth_phase3_failed: 'Token 失败',
};

function accountStatusBadge(status) {
  const label = ACCOUNT_STATUS_LABEL[status] || status || '-';
  const cls = ['oauth_done', 'email_bound'].includes(status) ? 'ok' : (String(status).includes('failed') ? 'bad' : 'unknown');
  return `<span class="token-badge ${cls}">${escapeHtml(label)}</span>`;
}

function codeBadge(code) {
  if (!code) return '<span class="soft-note">-</span>';
  return `<code class="code-chip">${escapeHtml(code)}</code>`;
}

function updateAccountsUi(result) {
  const accounts = result.accounts || [];
  const stats = result.stats || {};
  $('#accountsTotal').textContent = stats.total ?? accounts.length;
  $('#accountsBound').textContent = stats.bound ?? 0;
  $('#accountsOutlook').textContent = stats.outlookBound ?? 0;
  $('#accountsToken').textContent = stats.tokenCount ?? 0;
  const tbody = $('#accountsTable');
  if (!accounts.length) {
    tbody.innerHTML = '<tr><td colspan="9">暂无数据，运行注册流程后自动生成</td></tr>';
    return;
  }
  tbody.innerHTML = accounts.map(account => {
    const createdAt = account.createdAt ? new Date(account.createdAt).toLocaleString('zh-CN') : '-';
    const emailCell = account.email
      ? (account.isOutlook
        ? `<span class="token-badge ok">Outlook</span> ${escapeHtml(account.email)}`
        : escapeHtml(account.email))
      : '<span class="soft-note">未绑定</span>';
    const tokenCell = account.hasToken
      ? '<span class="token-badge ok">已获取</span>'
      : '<span class="soft-note">-</span>';
    const actionCell = account.isOutlook
      ? `<button class="ghost-button small account-card-btn" data-email="${escapeHtml(account.email)}">查看卡密</button>`
      : '<span class="soft-note">-</span>';
    return `<tr>
      <td class="cell-phone">${escapeHtml(account.phone || '-')}</td>
      <td class="cell-email">${emailCell}</td>
      <td class="cell-name">${escapeHtml(account.name || '-')}</td>
      <td>${codeBadge(account.smsCode)}</td>
      <td>${codeBadge(account.emailCode)}</td>
      <td>${accountStatusBadge(account.status)}</td>
      <td class="cell-time">${escapeHtml(createdAt)}</td>
      <td>${tokenCell}</td>
      <td>${actionCell}</td>
    </tr>`;
  }).join('');
}

async function refreshAccounts({ silent = false } = {}) {
  const result = await api.getAccounts();
  if (!result.ok) {
    if (!silent) toast(result.message || result.detail || '账号列表获取失败');
    return;
  }
  updateAccountsUi(result);
  if (!silent) toast('账号列表已刷新');
}

function updateMailProviderHint() {
  const select = $('#mailProviderSelect');
  if (!select) return;
  const isOutlook = select.value === 'outlook';
  const hint = $('#outlookModeHint');
  if (hint) hint.style.display = isOutlook ? 'block' : 'none';
  const form = $('#configForm');
  for (const name of ['mailBaseUrl', 'mailAdminToken', 'mailDomain']) {
    const input = form.elements[name];
    if (input) input.disabled = isOutlook;
  }
}

function getTargetTokenCount() {
  const input = document.querySelector('#targetTokenCount');
  const raw = Number(input?.value || 1);
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.min(100, Math.floor(raw)));
}

function updateRunModeUi() {
  const mode = document.querySelector('#runMode').value;
  const isEmailMode = mode === 'email';
  const isPhoneOnly = mode === 'phone';
  const countryRow = document.querySelector('#runCountry')?.closest('label');
  if (countryRow) countryRow.style.display = isEmailMode ? 'none' : '';
  const stopRow = document.querySelector('#stopAfterPhase2')?.closest('label');
  // 纯邮箱模式与仅手机号模式都不存在「阶段2 绑定邮箱后停止」，隐藏该开关
  if (stopRow) stopRow.style.display = (isEmailMode || isPhoneOnly) ? 'none' : '';
}

async function startRun() {
  const mode = document.querySelector('#runMode').value;
  const isEmailMode = mode === 'email';
  const isPhoneOnly = mode === 'phone';
  const selectedCountry = document.querySelector('#runCountry').value;
  if (!isEmailMode && selectedCountry && selectedCountry !== state.config.phoneCountryCode) {
    await api.saveConfig({ phoneCountryCode: selectedCountry });
    state.config.phoneCountryCode = selectedCountry;
  }
  const options = {
    mode,
    country: isEmailMode ? '' : selectedCountry,
    targetCount: getTargetTokenCount(),
    // 仅手机号模式没有阶段2，强制不传「阶段2后停止」
    stopAfterPhase2: isPhoneOnly ? false : document.querySelector('#stopAfterPhase2').checked,
  };
  const result = await api.startRun(options);
  if (!result.ok) {
    toast(result.message || '任务启动失败');
    return;
  }
  updateRunState(true);
  toast(`任务已启动，PID=${result.pid}，目标新增=${options.targetCount}`);
}
async function stopRun() {
  const result = await api.stopRun();
  toast(result.message || '已请求停止任务');
}

async function openTokenDir() {
  const result = await api.openTokenDir();
  if (result.ok) toast('Token 目录已打开');
  else toast(result.message || 'Token 目录打开失败');
}

async function resetStats() {
  const confirmed = window.confirm('将邮箱记录和 Token 显示数量归零，不会删除任何 token 文件。继续吗？');
  if (!confirmed) return;
  const result = await api.resetStats();
  if (result.ok) {
    state.counts = result.counts || {};
    $('#usernameCount').textContent = state.counts.usernames ?? 0;
    $('#tokenCount').textContent = state.counts.tokens ?? 0;
    toast('统计数字已归零，文件未删除');
    await refreshSummary();
  } else {
    toast(result.message || '统计归零失败');
  }
}

function bindEvents() {
  $$('.nav-item').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));
  $('#refreshBtn').addEventListener('click', refreshSummary);
  $('#openFolderBtn').addEventListener('click', () => api.openProjectFolder());
  $('#startBtn').addEventListener('click', startRun);
  const runModeSelect = $('#runMode');
  if (runModeSelect) {
    runModeSelect.addEventListener('change', updateRunModeUi);
    updateRunModeUi();
  }
  $('#stopBtn').addEventListener('click', stopRun);
  const tokenDirBtn = $('#openTokenDirBtn');
  if (tokenDirBtn) tokenDirBtn.addEventListener('click', openTokenDir);
  const resetStatsBtn = $('#resetStatsBtn');
  if (resetStatsBtn) resetStatsBtn.addEventListener('click', resetStats);
  $('#clearLogBtn').addEventListener('click', () => { state.logs = []; renderLogs(); });
  $('#refreshSmsBtn').addEventListener('click', () => refreshSmsOverview());
  $('#refreshTokenStatusBtn').addEventListener('click', () => refreshTokenStatus());
  $('#testMailBtn').addEventListener('click', testMail);
  $('#countryFilter').addEventListener('input', renderSmsRows);
  $('#smsProviderSwitch').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-provider]');
    if (!btn) return;
    switchSmsProvider(btn.dataset.provider).catch(error => console.warn(error));
  });
  $$('.sms-config-card').forEach(card => {
    card.addEventListener('submit', (event) => {
      event.preventDefault();
      saveSmsCard(card.dataset.provider).catch(error => console.warn(error));
    });
  });
  const gotoSmsConfigBtn = $('#gotoSmsConfigBtn');
  if (gotoSmsConfigBtn) gotoSmsConfigBtn.addEventListener('click', () => setView('sms'));
  // Outlook 邮箱池
  $('#refreshOutlookBtn').addEventListener('click', () => refreshOutlookAccounts());
  $('#openOutlookImportBtn').addEventListener('click', openOutlookImportModal);
  $('#outlookImportBtn').addEventListener('click', importOutlookCards);
  $('#outlookImportFileBtn').addEventListener('click', importOutlookFromFile);
  $('#outlookImportCloseBtn').addEventListener('click', closeOutlookImportModal);
  $('#outlookImportModal').addEventListener('click', (event) => {
    if (event.target === $('#outlookImportModal')) closeOutlookImportModal();
  });
  $('#outlookImportText').addEventListener('input', updateImportLineCount);
  $('#outlookClearInputBtn').addEventListener('click', () => {
    $('#outlookImportText').value = '';
    updateImportLineCount();
    $('#outlookImportResult').style.display = 'none';
    $('#outlookImportResult').classList.remove('bad');
    $('#outlookImportErrors').style.display = 'none';
    $('#outlookImportErrors').innerHTML = '';
  });
  $('#outlookTable').addEventListener('click', (event) => {
    const button = event.target.closest('.outlook-action');
    if (!button || button.disabled) return;
    handleOutlookAction(button.dataset.action, button.dataset.email).catch(error => console.warn(error));
  });
  // 账号信息
  $('#refreshAccountsBtn').addEventListener('click', () => refreshAccounts());
  $('#accountsTable').addEventListener('click', (event) => {
    const button = event.target.closest('.account-card-btn');
    if (!button || button.disabled) return;
    openOutlookDetailModal(button.dataset.email).catch(error => console.warn(error));
  });
  // 邮箱详情模态框
  $('#outlookDetailCloseBtn').addEventListener('click', closeOutlookDetailModal);
  $('#outlookDetailCopyBtn').addEventListener('click', () => copyOutlookCard());
  $('#outlookDetailModal').addEventListener('click', (event) => {
    if (event.target === $('#outlookDetailModal')) closeOutlookDetailModal();
  });
  // 邮件查看模态框
  $('#outlookMailsCloseBtn').addEventListener('click', closeOutlookMailsModal);
  $('#outlookMailsModal').addEventListener('click', (event) => {
    if (event.target === $('#outlookMailsModal')) closeOutlookMailsModal();
  });
  $('#mailListPanel').addEventListener('click', (event) => {
    const item = event.target.closest('.mail-item');
    if (!item) return;
    selectMail(Number(item.dataset.index));
  });
  // 作者信息模态框
  $('#authorBtn').addEventListener('click', openAuthorModal);
  $('#authorCloseBtn').addEventListener('click', closeAuthorModal);
  $('#authorModal').addEventListener('click', (event) => {
    if (event.target === $('#authorModal')) closeAuthorModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('#outlookMailsModal').hidden) closeOutlookMailsModal();
    else if (!$('#outlookDetailModal').hidden) closeOutlookDetailModal();
    else if (!$('#outlookImportModal').hidden) closeOutlookImportModal();
    else if (!$('#authorModal').hidden) closeAuthorModal();
  });
  const mailProviderSelect = $('#mailProviderSelect');
  if (mailProviderSelect) mailProviderSelect.addEventListener('change', updateMailProviderHint);
  $('#configForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#configResult').textContent = '保存中';
    const result = await api.saveConfig(collectConfigForm());
    if (result.ok) {
      state.config = result.config;
      state.issues = result.issues || [];
      $('#issueText').textContent = state.issues.length ? state.issues.join('；') : '配置可运行';
      const targetInput = document.querySelector('#targetTokenCount');
      if (targetInput) targetInput.value = Math.max(1, Math.min(100, Math.floor(Number(state.config.targetTokenCount) || 1)));
      renderCountryOptions(state.config);
      $('#configResult').textContent = '已保存';
      toast('配置已保存');
    } else {
      $('#configResult').textContent = '保存失败';
      toast(result.message || '保存失败');
    }
  });
  api.onRuntimeLog(appendLog);
  api.onRuntimeState((payload) => {
    updateRunState(!!payload.isRunning);
    if (!payload.isRunning) refreshSummary();
  });
}

window.__setDesktopView = setView;

async function boot() {
  bindEvents();
  await refreshSummary();
  const initialView = ['console', 'config', 'sms', 'outlook', 'accounts', 'token-status'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'console';
  setView(initialView);
  await refreshTokenStatus({ silent: true });
  state.tokenStatusTimer = setInterval(() => {
    refreshTokenStatus({ silent: true }).catch(error => console.warn(error));
  }, 10000);
  window.__desktopBootDone = true;
}

boot().catch(error => toast(error.message || String(error)));







