const path = require('path');
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');

const projectRoot = path.resolve(__dirname, '..');
const outDir = process.argv[2] || path.join(projectRoot, 'desktop-release', 'visual-qa');

async function capture(win, name) {
  await new Promise(resolve => setTimeout(resolve, 700));
  await win.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 300));
  let buffer;
  // RDP + 禁用硬件加速时 capturePage 可能持续返回旧合成帧；CDP 截图由渲染器侧强制出图，优先使用
  try {
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    const shot = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' });
    buffer = Buffer.from(shot.data, 'base64');
  } catch (error) {
    console.warn(`[capture:${name}] CDP 截图失败，回退 capturePage:`, error.message);
    await win.capturePage();
    await win.webContents.invalidate();
    await new Promise(resolve => setTimeout(resolve, 300));
    buffer = (await win.capturePage()).toPNG();
  }
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, `${name}.png`), buffer);
}

// 截图之外输出 DOM 真值：确认服务商切换在 DOM 层已生效（避免像素滞后误判 UI bug）
async function logSmsDomState(win, label) {
  const dom = await win.webContents.executeJavaScript(`(() => ({
    activeBtn: document.querySelector('#smsProviderSwitch button.active')?.dataset.provider || null,
    chip: document.querySelector('#smsProviderChip')?.textContent || null,
    updated: document.querySelector('#smsUpdated')?.textContent || null,
    balance: document.querySelector('#smsBalance')?.textContent || null,
  }))()`);
  console.log(`[dom:${label}]`, JSON.stringify(dom));
}

// 远程桌面/RDP 环境 GPU 合成不可用会导致 capturePage 报 UnknownVizError，这里禁用硬件加速保证可截图
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: true,
    backgroundColor: '#eef7f4',
    webPreferences: {
      preload: path.join(__dirname, 'visual-qa-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  await win.webContents.executeJavaScript(`new Promise(resolve => { const wait = () => window.__desktopBootDone ? resolve() : setTimeout(wait, 50); wait(); })`);
  await capture(win, 'console');
  await win.webContents.executeJavaScript(`window.__setDesktopView('config')`);
  await capture(win, 'config');

  // 接码配置页：默认 HeroSMS → 切换 Grizzly SMS → 切回 HeroSMS
  await win.webContents.executeJavaScript(`window.__setDesktopView('sms'); document.querySelector('#refreshSmsBtn').click()`);
  await new Promise(resolve => setTimeout(resolve, 600));
  await logSmsDomState(win, 'sms-default');
  await capture(win, 'sms');

  await win.webContents.executeJavaScript(`
    window.__visualQaSetData(${JSON.stringify({
      config: {
        smsProvider: 'grizzly',
        heroSmsApiKey: 'cb699ec0216A305785Af93b105dfdeed',
        heroSmsService: 'dr',
        nexSmsApiKey: 'PXFCFQUvGkJlJGkS',
        nexSmsService: 'dr',
        grizzlySmsApiKey: 'b3767a6cc64ce787916c51edd3272212',
        grizzlySmsService: 'dr',
        targetTokenCount: 1,
      },
      issues: [],
    })}, ${JSON.stringify({
      ok: true,
      provider: 'grizzly',
      providerLabel: 'Grizzly SMS',
      balance: 3,
      service: 'dr',
      countryCount: 5,
      countries: [
        { heroSmsCountry: 16, nameZh: '英国', dialCode: '44', price: 0.045, count: 17025 },
        { heroSmsCountry: 3, nameZh: '中国', dialCode: '86', price: 0.013, count: 220 },
        { heroSmsCountry: 4, nameZh: '菲律宾', dialCode: '63', price: 0.09, count: 9015 },
        { heroSmsCountry: 1, nameZh: '乌克兰', dialCode: '380', price: 0.24, count: 9199 },
        { heroSmsCountry: 5, nameZh: '缅甸', dialCode: '95', price: 0.24, count: 4614 },
      ],
      refreshedAt: new Date().toISOString(),
    })});
    document.querySelector('#smsProviderSwitch button[data-provider="grizzly"]').click();
  `);
  await new Promise(resolve => setTimeout(resolve, 600));
  await win.webContents.executeJavaScript(`document.querySelector('#refreshSmsBtn').click()`);
  await new Promise(resolve => setTimeout(resolve, 600));
  await logSmsDomState(win, 'sms-grizzly');
  await capture(win, 'sms-grizzly');

  await win.webContents.executeJavaScript(`
    window.__visualQaSetData(${JSON.stringify({
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
    })}, ${JSON.stringify({
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
    })});
    document.querySelector('#smsProviderSwitch button[data-provider="herosms"]').click();
  `);
  await new Promise(resolve => setTimeout(resolve, 900));
  await logSmsDomState(win, 'sms-switched-back');
  await capture(win, 'sms-switched-back');
  app.quit();
});

