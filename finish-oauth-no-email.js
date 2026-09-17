/**
 * 为 +447443756960 完成 OAuth 授权。
 * 用手机号 + 密码登录，用 thayerjacqueline0210@outlook.com 完成邮箱绑定，
 * 然后到 consent 页点授权，拿 code 换 token。
 */
const path = require('path');
const fs = require('fs');
const { BrowserService } = require('./src/browserService');
const { OAuthService } = require('./src/oauthService');
const { createSmsProvider } = require('./src/smsProviderFactory');
const { MailProvider } = require('./src/mailProvider');
const config = require('./src/config');

if (process.platform === 'win32') {
  try { require('child_process').execSync('chcp 65001', { stdio: 'ignore' }); } catch (e) {}
}

const SLEEP = (ms) => new Promise(r => setTimeout(r, ms));

// ===== 账号信息 =====
const ACCOUNT = {
  phone: '+447443756960',
  password: 'dQ7QsNDwpXvsnCFhA1!',
  name: 'Eno Texas',
  birthDate: '1989-06-14',
  phoneCountryCode: 'GB',
  phoneCountryDialCode: '44',
  phoneCountryName: '英国',
  heroSmsCountry: 16,
  // 该账号的号码购买自 HeroSMS，恢复流程固定使用原服务商轮询短信
  smsProvider: 'herosms',
};
const SMS_ACTIVATION_ID = 854451613;
const TARGET_EMAIL = 'thayerjacqueline0210@outlook.com';

// ===== 代理 =====
const proxy = config.proxyHost ? {
  host: config.proxyHost,
  port: config.proxyPort,
  username: config.proxyUsername,
  password: config.proxyPassword,
} : null;

// ===== 验证码提取工具（复制自 index.js）=====
function mailToRawText(mail = {}) {
  const parts = [
    mail.raw, mail.text, mail.content, mail.subject, mail.message,
  ].filter(v => typeof v === 'string' && v.trim().length > 0);
  return parts.join('\n\n');
}
function mailTimestampMs(mail = {}) {
  const candidates = [mail.receivedAt, mail.createdAt, mail.createTime, mail.created_time, mail.received_time, mail.date, mail.time, mail.timestamp, mail.created];
  for (const value of candidates) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'number') {
      const ms = value < 1000000000000 ? value * 1000 : value;
      if (Number.isFinite(ms)) return ms;
    }
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
function extractMailBody(raw = '') {
  if (!raw || typeof raw !== 'string') return '';
  if (/<html[\s>]|<body[\s>]/i.test(raw)) return raw;
  const htmlMatch = raw.match(/Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:--[^\r\n]+--|$)/i);
  if (htmlMatch) return htmlMatch[1];
  const parts = raw.split(/\r?\n\r?\n/);
  if (parts.length > 1) return parts.slice(Math.max(1, parts.length - 3)).join('\n');
  return raw;
}
function extractVerificationCodeFromBody(body = '', raw = '') {
  if (!body) return null;
  const isNoisySixDigitCandidate = (code, idx) => {
    const prev = body[idx - 1] || '';
    const next = body[idx + 6] || '';
    const ctx = body.slice(Math.max(0, idx - 100), Math.min(body.length, idx + 140)).toLowerCase();
    if (/\d/.test(prev) || /\d/.test(next)) return true;
    if (prev === '#') return true;
    if (ctx.includes('http') || ctx.includes('href=') || ctx.includes('sendgrid')) return true;
    if (ctx.includes('color:') || ctx.includes('font-') || ctx.includes('css')) return true;
    if (/[a-z]/i.test(prev) || /[a-z]/i.test(next)) return true;
    return false;
  };
  const strongPatterns = [
    /(?:code|验证码|verification(?:\s+code)?|verify|one[-\s]*time\s+code|temporary\s+code)[^\d]{0,120}(\d{6})/i,
    /-->\s*(\d{6})\s*<!--/i,
    />\s*(\d{6})\s*</,
  ];
  for (const pattern of strongPatterns) {
    const match = body.match(pattern);
    if (match) {
      const idx = typeof match.index === 'number' ? body.indexOf(match[1], match.index) : body.indexOf(match[1]);
      if (!isNoisySixDigitCandidate(match[1], Math.max(0, idx))) return match[1];
    }
  }
  const candidates = [];
  for (const m of body.matchAll(/\d{6}/g)) {
    const idx = m.index || 0;
    if (isNoisySixDigitCandidate(m[0], idx)) continue;
    candidates.push(m[0]);
  }
  if (candidates.length > 0) return candidates[0];
  const allSixDigits = body.match(/\b(\d{6})\b/g) || [];
  return allSixDigits.length > 0 ? allSixDigits[0] : null;
}

async function pollEmailCode(mailProvider, minTimestampMs, maxAttempts = 30, interval = 5000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`[Mail] 轮询邮箱验证码... (${attempt}/${maxAttempts})`);
    try {
      const mails = await mailProvider.getMails(5, 0);
      if (mails.length > 0) {
        const usableMails = mails.filter(mail => {
          const ts = mailTimestampMs(mail);
          return !minTimestampMs || !ts || ts >= minTimestampMs;
        });
        const latest = usableMails[0];
        if (!latest) {
          console.log('[Mail] 已收到旧邮件，但还没有当前阶段的新验证码邮件');
          await SLEEP(interval);
          continue;
        }
        const raw = mailToRawText(latest);
        const body = extractMailBody(raw);
        const code = extractVerificationCodeFromBody(body, raw);
        if (code) {
          console.log(`[Mail] 收到验证码: ${code}`);
          return code;
        }
        console.log(`[Mail] 邮件已收到但未提取到验证码，正文前200字: ${body.substring(0, 200)}`);
      }
    } catch (error) {
      if (error?.tokenFailure) {
        throw new Error(`Outlook token 刷新失败: ${error.message}`);
      }
      console.error(`[Mail] 查询出错: ${error.message}`);
    }
    await SLEEP(interval);
  }
  throw new Error(`邮箱验证码超时（等待 ${(maxAttempts * interval) / 1000} 秒）`);
}

async function main() {
  console.log('[*] 启动邮件服务...');
  const mailProvider = new MailProvider({
    baseUrl: config.mailBaseUrl,
    adminPassword: config.mailAdminPassword,
    sitePassword: config.mailSitePassword,
    domain: '',
    provider: config.mailProvider,
    adminEmail: config.mailAdminEmail,
    adminToken: config.mailAdminToken,
    userType: config.mailUserType,
    proxy: proxy,
    outlookPoolFile: config.outlookPoolFile,
    outlookUseProxy: config.outlookUseProxy,
  });

  // 直接指定使用 thayerjacqueline0210@outlook.com
  console.log(`[*] 指定邮箱: ${TARGET_EMAIL}`);
  mailProvider.useExistingAddressSession({ address: TARGET_EMAIL });

  console.log('[*] 启动浏览器...');
  const browserService = new BrowserService(proxy, {
    useChrome: config.useChrome,
    chromePath: config.chromePath,
    clearChatGptSession: false,
    incognito: false,
  });
  await browserService.launch();

  const oauthService = new OAuthService({
    proxy: proxy ? { host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password } : null,
  });

  const smsProvider = createSmsProvider({ ...config, smsProvider: ACCOUNT.smsProvider }, proxy);
  smsProvider.activationId = SMS_ACTIVATION_ID;
  smsProvider.phoneNumber = ACCOUNT.phone;

  // 监听回调
  const redirectBase = new URL(oauthService.redirectUri);
  let capturedCallbackUrl = null;
  browserService.page.on('request', (req) => {
    const reqUrl = req.url();
    try {
      const u = new URL(reqUrl);
      if (u.hostname === redirectBase.hostname && u.port === redirectBase.port
          && u.pathname === redirectBase.pathname
          && (u.searchParams.has('code') || u.searchParams.has('error'))) {
        capturedCallbackUrl = reqUrl;
        console.log(`[OAuth] 捕获到回调 URL: ${reqUrl.substring(0, 100)}...`);
      }
    } catch (e) {}
  });

  // 导航到 OAuth
  oauthService.regeneratePKCE();
  const authUrl = oauthService.getAuthUrl();
  console.log(`[*] 导航到 OAuth URL...`);
  await browserService.navigateToOAuth(authUrl);
  await SLEEP(5000);

  const phoneCountry = {
    isoCode: ACCOUNT.phoneCountryCode,
    dialCode: ACCOUNT.phoneCountryDialCode,
    name: ACCOUNT.phoneCountryName,
  };

  let smsRequested = false;
  let emailBoundDone = false;
  let phaseStartedAt = Date.now();
  let lastHandledUrl = '';

  for (let round = 0; round < 45; round++) {
    await SLEEP(3000);

    if (capturedCallbackUrl) {
      console.log('[OAuth] 检测到 localhost 回调！');
      break;
    }

    let url, pageInfo;
    try {
      pageInfo = await browserService.page.evaluate(() => ({
        text: (document.body?.innerText || '').substring(0, 800),
        btns: Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim()).filter(t => t),
        inputs: Array.from(document.querySelectorAll('input:not([type="hidden"])')).map(i => ({
          type: i.type, name: i.name, placeholder: i.placeholder,
        })),
        url: location.href,
      }));
      url = pageInfo.url;
    } catch (e) {
      console.log(`[OAuth] Round ${round}: 页面上下文变化...`);
      lastHandledUrl = '';
      continue;
    }

    try {
      const current = new URL(url);
      if (current.hostname === redirectBase.hostname && current.port === redirectBase.port
          && current.pathname === redirectBase.pathname
          && (current.searchParams.has('code') || current.searchParams.has('error'))) {
        console.log('[OAuth] 检测到 localhost 回调（URL 匹配）！');
        capturedCallbackUrl = url;
        break;
      }
    } catch (e) {}

    if (url === lastHandledUrl) {
      console.log(`[OAuth] Round ${round}: 页面未变化...`);
      continue;
    }

    console.log(`[OAuth] Round ${round}: ${url.substring(0, 80)}`);
    console.log(`[OAuth]   按钮: ${pageInfo.btns.slice(0, 10).join(', ')}`);
    console.log(`[OAuth]   文本: ${pageInfo.text.substring(0, 120).replace(/\n/g, ' | ')}`);

    if (/accounts\.google\.com|appleid\.apple\.com|login\.live\.com|login\.microsoftonline\.com|github\.com|facebook\.com/i.test(url)) {
      throw new Error(`OAuth 走错路径: ${url.substring(0, 100)}`);
    }

    // 错误页面
    if ((pageInfo.text.includes('出错了') || pageInfo.text.includes('went wrong')) && !url.includes('error=')) {
      const hasRetry = pageInfo.btns.some(b => b.includes('重试') || b.includes('Retry') || b.includes('Try again'));
      if (hasRetry) {
        console.log('[OAuth] 点击重试...');
        try { await browserService.clickButtonByText('重试', 5000); } catch (e) {
          try { await browserService.clickButtonByText('Retry', 3000); } catch (e2) {}
        }
        await SLEEP(5000);
        await browserService.waitForCloudflare(30000);
        await SLEEP(3000);
        lastHandledUrl = '';
        continue;
      }
    }

    // ===== 1. 登录方式选择页 =====
    const phoneLoginTexts = ['使用电话号码继续', '继续使用手机登录', '手机登录', 'Continue with phone number', 'Continue with phone'];
    const hasPhoneLogin = pageInfo.btns.some(b => phoneLoginTexts.some(text => b.includes(text)));
    if (hasPhoneLogin) {
      console.log('[OAuth] 点击「继续使用手机登录」...');
      await browserService.clickButtonByText(phoneLoginTexts);
      await SLEEP(3000);
      lastHandledUrl = url;
      continue;
    }

    // ===== choose-an-account =====
    const isChooseAccountPage = url.includes('/choose-an-account')
      || pageInfo.text.includes('选择帐户') || pageInfo.text.includes('选择账户')
      || pageInfo.text.toLowerCase().includes('choose an account');
    if (isChooseAccountPage) {
      console.log('[OAuth] 检测到 choose-an-account 页面...');
      await browserService.chooseExistingOAuthAccount({
        phone: ACCOUNT.phone, fullName: ACCOUNT.name, tag: '[OAuth]',
      });
      lastHandledUrl = '';
      continue;
    }

    // ===== 2. 手机号输入页 =====
    const hasPhoneForm = pageInfo.inputs.some(i => i.name === 'phoneNumberInput' || i.type === 'tel');
    if (hasPhoneForm) {
      console.log('[OAuth] 检测到手机号输入页...');
      try { await browserService.selectCountry(phoneCountry.dialCode, phoneCountry.name, phoneCountry.isoCode); } catch (e) {}
      const input = await browserService.page.$('input[name="phoneNumberInput"]')
        || await browserService.page.$('input[type="tel"]');
      if (input) {
        const currentCountry = await browserService.page.evaluate(() => {
          for (const b of document.querySelectorAll('button, select')) {
            const t = b.textContent || b.innerText || '';
            const match = t.match(/\+(\d+)/);
            if (match) return match[1];
          }
          return '';
        });
        await input.click({ clickCount: 3 });
        if (currentCountry === phoneCountry.dialCode) {
          const localNumber = browserService.getLocalPhoneNumber(ACCOUNT.phone, phoneCountry);
          await input.type(localNumber, { delay: 50 });
        } else {
          await input.type(ACCOUNT.phone.replace(/^\+/, ''), { delay: 50 });
        }
      }
      await SLEEP(500);
      await browserService.clickRealSubmitButton(['继续', 'Continue', '使用电话号码继续']);
      await SLEEP(3000);
      await browserService.waitForCloudflare(30000);
      await SLEEP(5000);
      lastHandledUrl = url;
      continue;
    }

    // ===== 3. 密码页 =====
    if (url.includes('auth.openai.com') && (pageInfo.inputs.some(i => i.type === 'password') || url.includes('password'))) {
      console.log('[OAuth] 检测到密码页，输入密码...');
      await browserService.fillPasswordInput('input[type="password"]', ACCOUNT.password, 'oauth.password', '[OAuth]');
      await SLEEP(500);
      await browserService.page.keyboard.press('Enter').catch(() => {});
      await SLEEP(1000);
      const submitBtnPos = await browserService.page.evaluate(() => {
        const preferredTexts = ['继续', 'Continue', 'Next', 'Verify', 'Submit'];
        for (const b of document.querySelectorAll('button[type="submit"], button')) {
          const text = (b.innerText || '').trim();
          if (!preferredTexts.some(t => text === t || text.includes(t))) continue;
          if (b.disabled) continue;
          const rect = b.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text };
        }
        return null;
      });
      if (submitBtnPos) {
        console.log(`[OAuth] 点击: ${submitBtnPos.text}`);
        await browserService.page.mouse.click(submitBtnPos.x, submitBtnPos.y);
      }
      await SLEEP(5000);
      await browserService.waitForCloudflare(30000);
      await SLEEP(3000);
      await browserService.detectCredentialError('[OAuth]');
      lastHandledUrl = url;
      continue;
    }

    // ===== 3.5 about-you =====
    if (url.includes('about-you') || url.includes('about_you')) {
      console.log('[OAuth] 检测到 about-you 页面...');
      const age = new Date().getFullYear() - parseInt(ACCOUNT.birthDate);
      await browserService.fillAboutYouAndSubmit(ACCOUNT.name, age, ACCOUNT.birthDate, '[OAuth]');
      await SLEEP(3000);
      lastHandledUrl = url;
      continue;
    }

    // ===== 3.6 add-email 页面：输入指定邮箱 =====
    if (url.includes('add-email') || url.includes('add_email')) {
      console.log(`[OAuth] 检测到 add-email 页面，输入邮箱: ${TARGET_EMAIL}`);
      const emailInput = await browserService.page.$('input[type="email"]')
        || await browserService.page.$('input[name="email"]')
        || await browserService.page.$('input[type="text"]');
      if (emailInput) {
        await emailInput.click({ clickCount: 3 });
        await browserService.page.keyboard.type(TARGET_EMAIL, { delay: 30 });
      }
      await SLEEP(500);
      await browserService.clickRealSubmitButton(['继续', 'Continue', '下一步', 'Next', '添加', 'Add']);
      await SLEEP(5000);
      await browserService.waitForCloudflare(30000);
      await SLEEP(3000);
      phaseStartedAt = Date.now(); // 记录时间用于过滤旧邮件
      lastHandledUrl = url;
      continue;
    }

    // ===== 4a. email-verification 页面：轮询验证码 =====
    const isEmailVerificationPage = url.includes('email-verification') || url.includes('verify-email');
    if (isEmailVerificationPage) {
      console.log('[OAuth] 检测到邮箱验证码页面，开始轮询邮箱...');
      const code = await pollEmailCode(mailProvider, phaseStartedAt, 30, 5000);
      if (code) {
        await browserService.enterSmsCode(code);
        await browserService.screenshot('after-email-code-new.png');
        emailBoundDone = true;
        await SLEEP(5000);
        await browserService.waitForCloudflare(30000);
        await SLEEP(3000);
        lastHandledUrl = url;
        continue;
      }
    }

    // ===== 4b. SMS 验证码页面 =====
    if (url.includes('contact-verification')) {
      console.log('[OAuth] 需要 SMS 验证码...');
      if (!smsRequested) {
        smsRequested = true;
        const code = await smsProvider.pollForCode({ interval: 10000, maxAttempts: 12 });
        if (code) {
          await browserService.enterSmsCode(code);
          await SLEEP(5000);
          await browserService.waitForCloudflare(30000);
          await SLEEP(3000);
          lastHandledUrl = url;
          continue;
        }
      }
    }

    // ===== 5. 授权确认页 (consent) =====
    const isConsentPage = url.includes('/consent')
      || (pageInfo.btns.some(b => ['Allow', '授权', '允许', '同意', 'Continue', '继续'].some(t => b.includes(t)))
          && !pageInfo.inputs.some(i => i.type !== 'hidden'));
    if (isConsentPage && emailBoundDone) {
      console.log('[OAuth] 检测到授权页，点击授权...');
      const safeClick = await browserService.page.evaluate(() => {
        const skipWords = ['Google', 'Apple', 'Microsoft', '邮件', '邮箱', '手机', 'email', 'phone', '取消', 'Cancel', 'Back', '返回'];
        for (const b of document.querySelectorAll('button')) {
          const text = b.innerText.trim();
          if (!text) continue;
          if (text.length <= 12 && !skipWords.some(w => text.includes(w))) {
            if (['Allow', '授权', '允许', '同意', 'Continue', '继续', 'Yes'].some(t => text.includes(t))) {
              ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
                b.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
              });
              return text;
            }
          }
        }
        return null;
      });
      if (safeClick) {
        console.log(`[OAuth] 点击了「${safeClick}」`);
        await SLEEP(5000);
        lastHandledUrl = url;
        continue;
      }
    }

    if (round % 5 === 4) {
      await browserService.screenshot(`oauth-flow-round${round}.png`).catch(() => {});
    }
  }

  if (!capturedCallbackUrl) {
    await browserService.screenshot('oauth-timeout-final.png').catch(() => {});
    throw new Error('OAuth 超时：未捕获到回调 URL');
  }

  const params = oauthService.extractCallbackParams(capturedCallbackUrl);
  if (!params || params.error) {
    throw new Error(`OAuth 授权失败: ${params?.error_description || params?.error || '未知错误'}`);
  }
  if (!params.code) throw new Error('回调 URL 中未找到授权码');

  console.log(`[OAuth] 成功获取授权码: ${params.code.substring(0, 15)}...`);

  const tokenData = await oauthService.exchangeTokenAndSave(params.code, ACCOUNT.phone);
  console.log('\n=========================================');
  console.log('[完成] Token 获取成功！');
  console.log(`[完成] account_id: ${tokenData.account_id}`);
  console.log(`[完成] expired: ${tokenData.expired}`);
  console.log(`[完成] email(保存名): ${ACCOUNT.phone}`);
  console.log('=========================================');

  // 标记 Outlook 邮箱已绑定
  mailProvider.confirmOutlookBound(ACCOUNT.phone);

  await browserService.close();
}

main().catch(async (err) => {
  console.error('[错误]', err.message);
  await SLEEP(2000);
  process.exit(1);
});
