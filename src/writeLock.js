/**
 * 进程内基于文件路径分组的异步互斥锁。
 * 并发 worker 池下，多个并行注册会对同一个 JSON 文件做"读-改-写"，
 * 必须串行化以避免覆盖丢失。锁按文件绝对路径分组，跨调用共享同一把锁。
 */
const locks = new Map();

/**
 * 在拿到 filePath 的锁后执行 fn，执行完毕释放锁。
 * @template T
 * @param {string} filePath 锁的依据路径（同一路径串行执行）
 * @param {() => T | Promise<T>} fn 临界区逻辑
 * @returns {Promise<T>}
 */
async function withFileLock(filePath, fn) {
    const prev = locks.get(filePath) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    locks.set(filePath, gate);
    await prev;
    try {
        return await fn();
    } finally {
        release();
    }
}

module.exports = { withFileLock };