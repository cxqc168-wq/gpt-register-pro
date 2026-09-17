/**
 * 批量为三个出错账号完成 OAuth：
 * +639050668187, +639559509484, +639559513120
 * 从 Outlook 池分配新邮箱，用手机号+密码登录，绑定邮箱，授权拿 token。
 */
const fs = require('fs');
const { BrowserService } = require('./src/browserService');
const { OAuthService } = require('./src/oauthService');
const { MailProvider } = require('./src/mailProvider');
const { OutlookPool, OutlookMailClient } = require('./src/outlookProvider');
const config = require('./src/config');

if (process.platform === 'win32') {
  try { require('child_process').execSync('chcp 65001', { stdio: 'ignore' }); } catch (e) {}
}

const SLEEP = (ms) => new Promise(r => setTimeout(r, ms));

const TARGET_ACCOUNTS = [
  { phone: '+639050668187', password: '5ZU1bC4yC5ReIoFnA1!', name: 'Tina Young', birthDate: '1988-02-07', phoneCountryCode: 'PH', phoneCountryDialCode: '63', phoneCountryName: '菲律宾', heroSmsCountry: 4 },
  { phone: '+639559509484', password: 'm6mA9NeP!ZNNG4RYA1!', name: 'Andoain Burris', birthDate: '1988-06-01', phoneCountryCode: 'PH', phoneCountryDialCode: '63', phoneCountryName: '菲律宾', heroSmsCountry: 4 },
  { phone: '+639559513120', password: '#2hCAz3E8C$xCWoGA1!', name: 'Techno Krukovska', birthDate: '1997-02-21', phoneCountryCode: 'PH', phoneCountryDialCode: '63', phoneCountryName: '菲律宾', heroSmsCountry: 4 },
];

const proxy = config.proxyHost ? {
  host: config.proxyHost, port: config.proxyPort,
  username: config.proxyUsername, password: config.proxyPassword,
} : null;

// ===== 验证码提取工具 =====
function mailToRawText(mail = {}) {
  return [mail.raw, mail.text, mail.content, mail.subject, mail.message]
    .filter(v => typeof v === 'string' && v.trim()).join('\n\n');
}
function mailTimestampMs(mail = {}) {
  const c = [mail.receivedAt, mail.createdAt, mail.createTime, mail.created_time, mail.received_time, mail.date, mail.time, mail.timestamp, mail.created];
  for (const v of c) {
    if (v == null || v === '') continue;
    if (typeof v === 'number') { const ms = v < 1e12 ? v * 1000 : v; if (Number.isFinite(ms)) return ms; }
    const p = Date.parse(String(v)); if (Number.isFinite(p)) return p;
  }
  return 0;
}
function extractMailBody(raw = '') {
  if (!raw) return '';
  if (/<html[\s>]|<body[\s>]/i.test(raw)) return raw;
  const hm = raw.match(/Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:--[^\r\n]+--|$)/i);
  if (hm) return hm[1];
  const parts = raw.split(/\r?\n\r?\n/);
  return parts.length > 1 ? parts.slice(Math.max(1, parts.length - 3)).join('\n') : raw;
}
function extractVerificationCodeFromBody(body = '', raw = '') {
  if (!body) return null;
  const noisy = (code, idx) => {
    const prev = body[idx-1]||'', next = body[idx+6]||'';
    const ctx = body.slice(Math.max(0,idx-100), Math.min(body.length,idx+140)).toLowerCase();
    if (/\d/.test(prev)||/\d/.test(next)) return true;
    if (prev === '#') return true;
    if (ctx.includes('http')||ctx.includes('href=')||ctx.includes('sendgrid')) return true;
    if (ctx.includes('color:')||ctx.includes('font-')||ctx.includes('css')) return true;
    if (/[a-z]/i.test(prev)||/[a-z]/i.test(next)) return true;
    return false;
  };
  for (const pat of [
    /(?:code|验证码|verification(?:\s+code)?|verify|one[-\s]*time\s+code|temporary\s+code)[^\d]{0,120}(\d{6})/i,
    /-->\s*(\d{6})\s*<!--/i, />\s*(\d{6})\s*</,
  ]) {
    const m = body.match(pat);
    if (m) { const idx = body.indexOf(m[1], m.index||0); if (!noisy(m[1], Math.max(0,idx))) return m[1]; }
  }
  const cands = [];
  for (const m of body.matchAll(/\d{6}/g)) { if (!noisy(m[0], m.index||0)) cands.push(m[0]); }
  if (cands.length) return cands[0];
  const all = body.match(/\b(\d{6})\b/g) || [];
  return all.length ? all[0] : null;
}
async function pollEmailCode(mailProvider, minTs, maxAttempts = 30, interval = 5000) {
  for (let i = 1; i <= maxAttempts; i++) {
    console.log(`[Mail] 轮询邮箱验证码... (${i}/${maxAttempts})`);
    try {
      const mails = await mailProvider.getMails(5, 0);
      if (mails.length) {
        const usable = mails.filter(m => { const ts = mailTimestampMs(m); return !minTs || !ts || ts >= minTs; });
        const latest = usable[0];
        if (!latest) { console.log('[Mail] 只有旧邮件，等待新验证码...'); await SLEEP(interval); continue; }
        const raw = mailToRawText(latest);
        const body = extractMailBody(raw);
        const code = extractVerificationCodeFromBody(body, raw);
        if (code) { console.log(`[Mail] 收到验证码: ${code}`); return code; }
        console.log(`[Mail] 邮件已到但未提取到验证码: ${body.substring(0,150)}`);
      }
    } catch (e) {
      if (e?.tokenFailure) throw e;
      console.error(`[Mail] 查询出错: ${e.message}`);
    }
    await SLEEP(interval);
  }
  throw new Error('邮箱验证码超时');
}

// ===== 处理单个账号 =====
async function processAccount(acc, browserService, oauthService, mailProvider, outlookPool) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`[*] 处理账号: ${acc.phone} (${acc.name})`);
  console.log(`${'='.repeat(50)}`);

  // 从池中分配邮箱
  const account = outlookPool.allocate();
  if (!account) throw new Error('Outlook 池已耗尽');
  const email = account.email;
  console.log(`[*] 分配邮箱: ${email}`);

  // 让 mailProvider 使用这个邮箱
  mailProvider.useExistingAddressSession({ address: email });

  // 清除 OpenAI 登录态
  console.log('[*] 清除 OpenAI 登录态...');
  await browserService.clearChatGptSession();
  await SLEEP(2000);

  // 监听回调
  const redirectBase = new URL(oauthService.redirectUri);
  let capturedCallbackUrl = null;
  const requestHandler = (req) => {
    const reqUrl = req.url();
    try {
      const u = new URL(reqUrl);
      if (u.hostname === redirectBase.hostname && u.port === redirectBase.port
          && u.pathname === redirectBase.pathname
          && (u.searchParams.has('code') || u.searchParams.has('error'))) {
        capturedCallbackUrl = reqUrl;
        console.log(`[OAuth] 捕获回调: ${reqUrl.substring(0,80)}...`);
      }
    } catch (e) {}
  };
  browserService.page.on('request', requestHandler);

  // 导航到 OAuth
  oauthService.regeneratePKCE();
  await browserService.navigateToOAuth(oauthService.getAuthUrl());
  await SLEEP(5000);

  const phoneCountry = { isoCode: acc.phoneCountryCode, dialCode: acc.phoneCountryDialCode, name: acc.phoneCountryName };
  let smsRequested = false;
  let emailBoundDone = false;
  let phaseStartedAt = Date.now();
  let lastHandledUrl = '';
  let smsProvider = null; // 这些账号没有保留 activationId，不尝试 SMS

  for (let round = 0; round < 50; round++) {
    await SLEEP(3000);
    if (capturedCallbackUrl) break;

    let url, pageInfo;
    try {
      pageInfo = await browserService.page.evaluate(() => ({
        text: (document.body?.innerText||'').substring(0,800),
        btns: Array.from(document.querySelectorAll('button')).map(b=>b.innerText.trim()).filter(t=>t),
        inputs: Array.from(document.querySelectorAll('input:not([type="hidden"])')).map(i=>({type:i.type,name:i.name})),
        url: location.href,
      }));
      url = pageInfo.url;
    } catch (e) { lastHandledUrl=''; continue; }

    // 检查回调 URL
    try {
      const cur = new URL(url);
      if (cur.hostname===redirectBase.hostname && cur.port===redirectBase.port && cur.pathname===redirectBase.pathname
          && (cur.searchParams.has('code')||cur.searchParams.has('error'))) {
        capturedCallbackUrl = url; break;
      }
    } catch (e) {}

    if (url === lastHandledUrl) continue;
    console.log(`[OAuth] R${round}: ${url.substring(0,75)}`);
    console.log(`[OAuth]   btns: ${pageInfo.btns.slice(0,8).join(', ')}`);
    console.log(`[OAuth]   text: ${pageInfo.text.substring(0,100).replace(/\n/g,' | ')}`);

    // 第三方登录防御
    if (/accounts\.google\.com|appleid\.apple\.com|login\.live\.com|login\.microsoftonline\.com|github\.com/i.test(url)) {
      throw new Error('走错路径: ' + url.substring(0,100));
    }

    // 错误页重试
    if ((pageInfo.text.includes('出错了')||pageInfo.text.includes('went wrong')) && !url.includes('error=')) {
      if (pageInfo.btns.some(b=>b.includes('重试')||b.includes('Retry'))) {
        try { await browserService.clickButtonByText('重试',5000); } catch(e) { try { await browserService.clickButtonByText('Retry',3000); } catch(e2){} }
        await SLEEP(5000); await browserService.waitForCloudflare(30000); await SLEEP(3000);
        lastHandledUrl=''; continue;
      }
    }

    // 1. 手机登录按钮
    const phoneTexts = ['使用电话号码继续','继续使用手机登录','手机登录','Continue with phone number','Continue with phone'];
    if (pageInfo.btns.some(b=>phoneTexts.some(t=>b.includes(t)))) {
      await browserService.clickButtonByText(phoneTexts);
      await SLEEP(3000); lastHandledUrl=url; continue;
    }

    // choose-an-account
    if (url.includes('/choose-an-account') || pageInfo.text.toLowerCase().includes('choose an account')) {
      await browserService.chooseExistingOAuthAccount({ phone: acc.phone, fullName: acc.name, tag: '[OAuth]' });
      lastHandledUrl=''; continue;
    }

    // 2. 手机号输入页
    if (pageInfo.inputs.some(i=>i.name==='phoneNumberInput'||i.type==='tel')) {
      try { await browserService.selectCountry(phoneCountry.dialCode, phoneCountry.name, phoneCountry.isoCode); } catch(e){}
      const input = await browserService.page.$('input[name="phoneNumberInput"]') || await browserService.page.$('input[type="tel"]');
      if (input) {
        const cc = await browserService.page.evaluate(() => {
          for (const b of document.querySelectorAll('button,select')) { const m=(b.textContent||'').match(/\+(\d+)/); if(m) return m[1]; }
          return '';
        });
        await input.click({clickCount:3});
        if (cc === phoneCountry.dialCode) {
          const local = browserService.getLocalPhoneNumber(acc.phone, phoneCountry);
          await input.type(local, {delay:50});
        } else {
          await input.type(acc.phone.replace(/^\+/,''), {delay:50});
        }
      }
      await SLEEP(500);
      await browserService.clickRealSubmitButton(['继续','Continue','使用电话号码继续']);
      await SLEEP(3000); await browserService.waitForCloudflare(30000); await SLEEP(5000);
      lastHandledUrl=url; continue;
    }

    // 3. 密码页
    if (url.includes('auth.openai.com') && (pageInfo.inputs.some(i=>i.type==='password')||url.includes('password'))) {
      await browserService.fillPasswordInput('input[type="password"]', acc.password, 'oauth.password', '[OAuth]');
      await SLEEP(500);
      await browserService.page.keyboard.press('Enter').catch(()=>{});
      await SLEEP(1000);
      const pos = await browserService.page.evaluate(() => {
        for (const b of document.querySelectorAll('button[type="submit"],button')) {
          const t=(b.innerText||'').trim();
          if (!['继续','Continue','Next','Verify','Submit'].some(p=>t===p||t.includes(p))) continue;
          if (b.disabled) continue;
          const r=b.getBoundingClientRect(); if(r.width<=0||r.height<=0) continue;
          return {x:r.x+r.width/2,y:r.y+r.height/2,text:t};
        }
        return null;
      });
      if (pos) { console.log(`[OAuth] 点击: ${pos.text}`); await browserService.page.mouse.click(pos.x,pos.y); }
      await SLEEP(5000); await browserService.waitForCloudflare(30000); await SLEEP(3000);
      await browserService.detectCredentialError('[OAuth]');
      lastHandledUrl=url; continue;
    }

    // 3.5 about-you
    if (url.includes('about-you')||url.includes('about_you')) {
      const age = new Date().getFullYear() - parseInt(acc.birthDate);
      await browserService.fillAboutYouAndSubmit(acc.name, age, acc.birthDate, '[OAuth]');
      await SLEEP(3000); lastHandledUrl=url; continue;
    }

    // 3.6 add-email
    if (url.includes('add-email')||url.includes('add_email')) {
      console.log(`[OAuth] add-email 页面，输入: ${email}`);
      const ei = await browserService.page.$('input[type="email"]') || await browserService.page.$('input[name="email"]') || await browserService.page.$('input[type="text"]');
      if (ei) { await ei.click({clickCount:3}); await browserService.page.keyboard.type(email,{delay:30}); }
      await SLEEP(500);
      await browserService.clickRealSubmitButton(['继续','Continue','下一步','Next','添加','Add']);
      await SLEEP(5000); await browserService.waitForCloudflare(30000); await SLEEP(3000);
      phaseStartedAt = Date.now();
      lastHandledUrl=url; continue;
    }

    // 4a. email-verification
    if (url.includes('email-verification')||url.includes('verify-email')) {
      console.log('[OAuth] 邮箱验证页面，轮询验证码...');
      const code = await pollEmailCode(mailProvider, phaseStartedAt, 30, 5000);
      if (code) {
        await browserService.enterSmsCode(code);
        emailBoundDone = true;
        await SLEEP(5000); await browserService.waitForCloudflare(30000); await SLEEP(3000);
        lastHandledUrl=url; continue;
      }
    }

    // 4b. SMS 验证码页 —— 这些账号没有 activationId，报告并等待手动
    if (url.includes('contact-verification')) {
      console.log('[OAuth] 需要 SMS 验证码（无 activationId），等待 60 秒看是否自动跳转...');
      await SLEEP(60000);
      lastHandledUrl=url; continue;
    }

    // 5. consent 授权页
    if (emailBoundDone && (url.includes('/consent') ||
        (pageInfo.btns.some(b=>['Allow','授权','允许','同意','Continue','继续'].some(t=>b.includes(t))) &&
         !pageInfo.inputs.some(i=>i.type!=='hidden')))) {
      console.log('[OAuth] 授权页，点击授权...');
      const clicked = await browserService.page.evaluate(() => {
        const skip = ['Google','Apple','Microsoft','邮件','邮箱','手机','email','phone','取消','Cancel','Back','返回'];
        for (const b of document.querySelectorAll('button')) {
          const t=b.innerText.trim(); if(!t||t.length>12||skip.some(w=>t.includes(w))) continue;
          if (['Allow','授权','允许','同意','Continue','继续','Yes'].some(x=>t.includes(x))) {
            ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(ty=>b.dispatchEvent(new MouseEvent(ty,{bubbles:true,cancelable:true,view:window})));
            return t;
          }
        }
        return null;
      });
      if (clicked) { console.log(`[OAuth] 点击了「${clicked}」`); await SLEEP(5000); lastHandledUrl=url; continue; }
    }

    if (round % 5 === 4) await browserService.screenshot(`batch-oauth-${round}.png`).catch(()=>{});
  }

  browserService.page.off('request', requestHandler);

  if (!capturedCallbackUrl) {
    await browserService.screenshot('batch-timeout.png').catch(()=>{});
    throw new Error('超时未捕获回调');
  }

  const params = oauthService.extractCallbackParams(capturedCallbackUrl);
  if (!params || params.error) throw new Error(`授权失败: ${params?.error_description||params?.error}`);
  if (!params.code) throw new Error('无授权码');

  console.log(`[OAuth] 授权码: ${params.code.substring(0,15)}...`);
  const tokenData = await oauthService.exchangeTokenAndSave(params.code, acc.phone);

  // 解析 account_id（pid 字段）
  try {
    const payload = JSON.parse(Buffer.from(tokenData.access_token.split('.')[1],'base64').toString('utf8'));
    const auth = payload['https://api.openai.com/auth'] || {};
    tokenData.account_id = auth.pid || auth.chatgpt_account_id || '';
    const tpath = `tokens/codex-${acc.phone.replace(/[\\/:*?"<>|]/g,'_')}-free.json`;
    fs.writeFileSync(tpath, JSON.stringify(tokenData, null, 2));
    console.log(`[Token] account_id: ${tokenData.account_id}`);
  } catch(e) { console.error('解析 account_id 失败:', e.message); }

  // 标记邮箱已绑定
  mailProvider.confirmOutlookBound(acc.phone);

  // 更新 accounts.json
  const regs = JSON.parse(fs.readFileSync('accounts.json','utf8'));
  const r = regs.find(x=>x.phone===acc.phone);
  if (r) { r.status='oauth_done'; r.email=email; }
  fs.writeFileSync('accounts.json', JSON.stringify(regs, null, 2));

  console.log(`[完成] ${acc.phone} -> ${email} -> token saved`);
  return tokenData;
}

async function main() {
  const outlookPool = new OutlookPool(config.outlookPoolFile);
  const mailProvider = new MailProvider({
    baseUrl: config.mailBaseUrl, adminPassword: config.mailAdminPassword,
    sitePassword: config.mailSitePassword, domain: '', provider: config.mailProvider,
    adminEmail: config.mailAdminEmail, adminToken: config.mailAdminToken,
    userType: config.mailUserType, proxy, outlookPoolFile: config.outlookPoolFile,
    outlookUseProxy: config.outlookUseProxy,
  });

  const browserService = new BrowserService(proxy, {
    useChrome: config.useChrome, chromePath: config.chromePath,
    clearChatGptSession: true, incognito: false,
  });
  await browserService.launch();

  const oauthService = new OAuthService({
    proxy: proxy ? {host:proxy.host,port:proxy.port,username:proxy.username,password:proxy.password} : null,
  });

  const results = [];
  for (const acc of TARGET_ACCOUNTS) {
    try {
      const token = await processAccount(acc, browserService, oauthService, mailProvider, outlookPool);
      results.push({ phone: acc.phone, success: true, email: mailProvider.getEmail() });
    } catch (e) {
      console.error(`[失败] ${acc.phone}: ${e.message}`);
      results.push({ phone: acc.phone, success: false, error: e.message });
      // 失败时回滚邮箱分配
      try { mailProvider.rollbackOutlookAllocation(); } catch(e2){}
    }
    // 账号间间隔
    await SLEEP(5000);
  }

  console.log('\n' + '='.repeat(50));
  console.log('[批量结果]');
  results.forEach(r => console.log(`  ${r.phone}: ${r.success ? '成功 -> ' + r.email : '失败 -> ' + r.error}`));
  console.log('='.repeat(50));

  await browserService.close();
}

main().catch(e => { console.error('[Fatal]', e.message); process.exit(1); });
