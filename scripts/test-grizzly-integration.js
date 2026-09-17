/**
 * Grizzly SMS 集成测试（临时脚本，测完删除）
 * 用法：node scripts/test-grizzly-integration.js [--purchase]
 */
const config = require('../src/config');
const { createSmsProvider, getActiveSmsProviderType } = require('../src/smsProviderFactory');

async function main() {
    const testConfig = { ...config, smsProvider: 'grizzly' };
    console.log(`[0] 工厂解析: type=${getActiveSmsProviderType(testConfig)} (期望 grizzly)`);
    if (getActiveSmsProviderType(testConfig) !== 'grizzly') throw new Error('工厂类型解析失败');

    const provider = createSmsProvider(testConfig);
    if (!(provider.constructor.name === 'GrizzlySmsProvider')) throw new Error(`工厂返回了 ${provider.constructor.name}`);

    // 1. 余额
    const account = await provider.getBalance();
    console.log(`[1] 余额: $${account.balance}`);

    // 2. 地区列表（chn 中文名）
    const countries = await provider.getCountries();
    const uk = countries.find(c => c.heroSmsCountry === 16);
    console.log(`[2] 地区: ${countries.length} 个；英国(16)=${JSON.stringify(uk)}`);

    // 3. Top 国家（价格矩阵推导）
    const top = await provider.getTopCountriesByService('dr');
    console.log(`[3] Top 国家: ${top.length} 个；前5: ${top.slice(0, 5).map(r => `${r.nameZh || r.apiName}($${r.price},x${r.count})`).join(', ')}`);

    // 4. 国家价格列表（对齐桌面端概览调用）
    const priced = await provider.listCountryPrices('dr', countries.slice(0, 5).map(c => ({ heroSmsCountry: c.heroSmsCountry })));
    console.log(`[4] listCountryPrices: ${priced.length} 行；${priced.map(r => `id${r.heroSmsCountry}=$${r.price}(x${r.count})`).join(', ')}`);

    if (!process.argv.includes('--purchase')) {
        console.log('=== 只读测试通过（未购买）===');
        return;
    }

    // 5. 购买（英国，最便宜时 $0.045）
    const ukQuote = top.find(r => r.heroSmsCountry === 16) || priced.find(r => r.heroSmsCountry === 16);
    const order = await provider.getNumber('dr', 16, 2);
    console.log(`[5] 购买成功: ${order.phoneNumber} (activationId=${order.activationId})`);

    // 6. 轮询一次（预期无短信）
    await provider.markReady();
    const status = await provider.getStatus();
    console.log(`[6] markReady + getStatus: received=${status.received}${status.received ? ` code=${status.code}` : '（暂无短信，符合预期）'}`);

    // 7. 取消退款（sms-activate 协议允许直接 setStatus 8）
    await provider.cancel();
    const after = await provider.getBalance();
    console.log(`[7] 取消后余额: $${after.balance}（购买前 $${account.balance}）`);
    console.log('=== 全流程测试完成 ===');
}

main().catch(error => {
    console.error('测试失败:', error.message);
    process.exit(1);
});
