/**
 * selectCountry 修复验证脚本（只读，不购买号码、不提交）
 * 验证：进入 chatgpt.com 注册弹窗后 selectCountry('27','南非','ZA') 能把国家真正切到南非 (+27)。
 * 用法: node scripts/test-country-select.js
 */
const config = require('../src/config');
const { BrowserService } = require('../src/browserService');

const SLEEP = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
    const proxy = (config.proxyHost && config.proxyPort)
        ? { host: config.proxyHost, port: config.proxyPort, username: config.proxyUsername || '', password: config.proxyPassword || '' }
        : null;

    const svc = new BrowserService(proxy, {
        useChrome: config.useChrome,
        chromePath: config.chromePath,
        userDataDir: config.browserUserDataDir,
        incognito: config.browserIncognito,
        clearChatGptSession: config.browserClearChatGptSession,
    });

    try {
        await svc.launch();
        console.log('\n[test] 导航到注册弹窗...');
        await svc.navigateToSignup();

        console.log('[test] 调用 selectCountry(27, 南非, ZA) ...');
        await svc.selectCountry('27', '南非', 'ZA');
        await SLEEP(1200);

        const state = await svc.page.evaluate(() => {
            const select = document.querySelector('select#mobile-auth-phone-country');
            const input = document.querySelector('input#mobile-auth-phone');
            if (!select) return { ok: false, reason: '未找到 select#mobile-auth-phone-country' };
            const opt = select.options[select.selectedIndex];
            return {
                ok: String(opt.value).toUpperCase() === 'ZA',
                selectedValue: opt.value,
                selectedText: opt.text.trim(),
                phoneInputPlaceholder: input ? input.placeholder : null,
            };
        });

        console.log('[test] 国家 select 状态:', JSON.stringify(state));

        if (!state.ok) {
            await svc.screenshot('inspect-country-fix-failed.png').catch(() => {});
            throw new Error(`修复验证失败: 选中值=${state.selectedValue} (期望 ZA)`);
        }

        // 本地号码剥离 + 输入框填充（不点击提交）
        const localNumber = svc.getLocalPhoneNumber('+27641457575', { dialCode: '27' });
        console.log(`[test] getLocalPhoneNumber(+27641457575, +27) = ${localNumber}`);
        const input = await svc.page.$('input#mobile-auth-phone');
        await input.click({ clickCount: 3 });
        await input.type(localNumber, { delay: 30 });
        await SLEEP(600);
        const typed = await svc.page.evaluate(() => document.querySelector('input#mobile-auth-phone').value);
        console.log('[test] 输入框实际值:', JSON.stringify(typed));
        await svc.screenshot('inspect-country-fix-ok.png').catch(() => {});

        const finalCheck = await svc.page.evaluate(() => {
            const select = document.querySelector('select#mobile-auth-phone-country');
            return { selectedValue: select.options[select.selectedIndex].value, selectedText: select.options[select.selectedIndex].text.trim() };
        });
        console.log('[test] 最终国家:', JSON.stringify(finalCheck));
        console.log('\n[test] 验证通过 ✅（国家=南非 +27，本地号码=641457575，输入框已填充）');
    } finally {
        await SLEEP(1000);
        await svc.close().catch(() => {});
    }
}

main().catch(e => { console.error('\n[test] 失败:', e.message); process.exit(1); });
