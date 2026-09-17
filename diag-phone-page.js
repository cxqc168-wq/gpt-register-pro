// 诊断脚本2：验证补丁后的 navigateToSignup + selectCountry（不提交、不买号）
const { BrowserService } = require('./src/browserService');
const config = require('./src/config');

(async () => {
    let proxy = null;
    if (config.proxyHost && config.proxyPort) {
        proxy = {
            host: config.proxyHost,
            port: config.proxyPort,
            username: config.proxyUsername || '',
            password: config.proxyPassword || '',
        };
    }
    const svc = new BrowserService(proxy, {});
    await svc.launch();
    try {
        await svc.navigateToSignup();
        console.log('[Diag2] navigateToSignup 成功，手机号输入框已就绪');

        // 验证国家选择（瑞典 +46 / SE），不提交表单
        await svc.selectCountry('46', '瑞典', 'SE');
        const selState = await svc.page.evaluate(() => {
            const input = document.querySelector('input#mobile-auth-phone, input[name="phoneNumberInput"], input[type="tel"]');
            const select = document.querySelector('select');
            return {
                inputValue: input ? input.value : '(not found)',
                inputVisible: input ? !!(input.offsetParent || input.getClientRects().length) : false,
                selectedCountry: select ? select.options[select.selectedIndex].text : '(no select)',
            };
        });
        console.log('[Diag2] 手机输入框值:', JSON.stringify(selState));

        // 模拟输入号码但立即停止（不点提交）——只验证输入框可交互
        const input = await svc.page.$('input#mobile-auth-phone, input[name="phoneNumberInput"], input[type="tel"]');
        if (input) {
            await input.click({ clickCount: 3 });
            console.log('[Diag2] 输入框可点击聚焦 OK（不输入、不提交）');
        }
        console.log('[Diag2] 全部验证通过');
    } catch (e) {
        console.log(`[Diag2] 失败: ${e.message}`);
        await svc.screenshot('diag2-fail.png').catch(() => {});
    }
    await svc.browser.close();
    process.exit(0);
})().catch(e => { console.error('[Diag2] 致命错误:', e); process.exit(1); });
