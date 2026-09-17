/**
 * 并发浏览器启动验证（不购买号码、不提交表单）
 * 模拟 3 个并发 worker：各自使用独立 profile（browser-profile-w0/1/2），
 * 验证都能成功启动、连接 CDP、导航到 chatgpt.com，不再出现 about:blank / ECONNREFUSED。
 * 用法: node scripts/test-concurrent-launch.js
 */
const config = require('../src/config');
const { BrowserService } = require('../src/browserService');

const SLEEP = (ms) => new Promise(r => setTimeout(r, ms));
const CONCURRENCY = 3;

async function worker(workerIndex) {
    const proxy = (config.proxyHost && config.proxyPort)
        ? { host: config.proxyHost, port: config.proxyPort, username: config.proxyUsername || '', password: config.proxyPassword || '' }
        : null;
    const userDataDir = `${config.browserUserDataDir || 'browser-profile'}-w${workerIndex}`;
    const svc = new BrowserService(proxy, {
        useChrome: config.useChrome,
        chromePath: config.chromePath,
        userDataDir,
        incognito: config.browserIncognito,
        clearChatGptSession: config.browserClearChatGptSession,
    });
    const tag = `[w${workerIndex}]`;
    try {
        console.log(`${tag} launch (profile=${userDataDir}) ...`);
        await svc.launch();
        console.log(`${tag} 浏览器已启动`);
        console.log(`${tag} 导航到 chatgpt.com ...`);
        await svc.safeGoto('https://chatgpt.com', { timeout: 45000 });
        await SLEEP(4000);
        const state = await svc.page.evaluate(() => ({
            url: location.href,
            title: document.title,
            hasSignup: /免费注册|Sign up/.test(document.body?.innerText || ''),
        })).catch(e => ({ url: 'ERROR: ' + e.message, title: '', hasSignup: false }));
        console.log(`${tag} 结果: url=${state.url} | title=${state.title} | 有注册按钮=${state.hasSignup}`);
        if (!state.url || state.url === 'about:blank' || /^chrome-error/.test(state.url)) {
            throw new Error(`worker${workerIndex} 页面未正常加载: ${state.url}`);
        }
        return true;
    } finally {
        await svc.close().catch(() => {});
        console.log(`${tag} 已关闭`);
    }
}

async function main() {
    const results = await Promise.allSettled(
        Array.from({ length: CONCURRENCY }, (_, i) => worker(i))
    );
    const ok = results.filter(r => r.status === 'fulfilled').length;
    console.log(`\n[结果] ${ok}/${CONCURRENCY} 个并发 worker 启动+导航成功`);
    for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'rejected') {
            console.error(`[结果] worker${i} 失败: ${results[i].reason?.message || results[i].reason}`);
        }
    }
    if (ok !== CONCURRENCY) process.exit(1);
    console.log('[结果] 验证通过 ✅（3 个 worker 均成功，无 about:blank / ECONNREFUSED）');
}

main().catch(e => { console.error('脚本失败:', e); process.exit(1); });
