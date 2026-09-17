const { contextBridge } = require('electron');

let summary = {
  projectRoot: 'D:/Codex/projects/gpt_register-workcopy',
  configPath: 'D:/Codex/projects/gpt_register-workcopy/config.json',
  config: {
    smsProvider: 'herosms',
    heroSmsApiKey: 'cb699ec0216A305785Af93b105dfdeed',
    heroSmsService: 'dr',
    nexSmsApiKey: 'PXFCFQUvGkJlJGkS',
    nexSmsService: 'dr',
    grizzlySmsApiKey: 'b3767a6cc64ce787916c51edd3272212',
    grizzlySmsService: 'dr',
    targetTokenCount: 1,
  },
  issues: [],
  counts: { accounts: 3, usernames: 2, tokens: 1 },
  isRunning: false,
  logs: [],
};
let smsOverview = {
  ok: true,
  provider: 'herosms',
  providerLabel: 'HeroSMS',
  balance: 1.96,
  service: 'dr',
  countryCount: 5,
  countries: [
    { heroSmsCountry: 4, nameZh: '菲律宾', dialCode: '63', price: 0.0622, count: 651098 },
    { heroSmsCountry: 6, nameZh: '印度尼西亚', dialCode: '62', price: 0.1207, count: 591828 },
    { heroSmsCountry: 41, nameZh: '喀麦隆', dialCode: '237', price: 0.1388, count: 3670 },
    { heroSmsCountry: 73, nameZh: '巴西', dialCode: '55', price: 0.1409, count: 951175 },
    { heroSmsCountry: 117, nameZh: '葡萄牙', dialCode: '351', price: 0.1451, count: 1821 },
  ],
  refreshedAt: new Date().toISOString(),
};
const logListeners = new Set();
const stateListeners = new Set();

contextBridge.exposeInMainWorld('desktopApi', {
  getSummary: async () => summary,
  saveConfig: async (config) => {
    summary = { ...summary, config: { ...summary.config, ...config }, issues: [] };
    return { ok: true, config: summary.config, issues: [] };
  },
  openProjectFolder: async () => ({ ok: true }),
  getSmsOverview: async () => smsOverview,
  resetStats: async () => ({ ok: true, counts: summary.counts }),
  openTokenDir: async () => ({ ok: true }),
  getTokenStatus: async () => ({ ok: true, rows: [], counts: {}, total: 0, refreshedAt: new Date().toISOString() }),
  testMail: async () => ({ ok: true, address: 'desktop@example.com', inboxReachable: true, count: 0 }),
  startRun: async () => ({ ok: true, pid: 12345 }),
  stopRun: async () => ({ ok: true }),
  onRuntimeLog: (callback) => {
    logListeners.add(callback);
    return () => logListeners.delete(callback);
  },
  onRuntimeState: (callback) => {
    stateListeners.add(callback);
    return () => stateListeners.delete(callback);
  },
});

contextBridge.exposeInMainWorld('__visualQaSetData', (nextSummary, nextSmsOverview) => {
  summary = nextSummary;
  smsOverview = nextSmsOverview;
});

