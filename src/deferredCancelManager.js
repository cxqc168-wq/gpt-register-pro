/**
 * 后台延迟取消管理器。
 * 用途：号码已存在账号（PHONE_ALREADY_REGISTERED）时，不在主流程里同步轮询取消，
 * 而是登记并从后台在 readyAtMs 之后补做一次 cancel()，避免阻塞整批注册。
 * 后台定时器不 unref，保持进程存活，直到所有取消完成（配合 flush() 退出前排空）。
 */
class DeferredCancelManager {
    constructor() {
        /** @type {Set<unknown>} 正在后台执行取消的 provider（防重复取消） */
        this._inflight = new Set();
        /** @type {Set<Promise<boolean>>} 取消完成承诺（供 flush 等待） */
        this._pending = new Set();
    }

    /**
     * 登记一个待取消号码，立即返回、不阻塞调用方。
     * @param {import('./smsProvider').SMSProvider} provider 持有 activationId 与取消凭据
     * @param {{ readyAtMs: number, phone?: string }} options
     * @returns {Promise<boolean>} 后台取消完成的承诺；取消成功为 true
     */
    schedule(provider, { readyAtMs, phone } = {}) {
        const waitMs = Math.max(0, readyAtMs - Date.now());
        const label = phone || provider.getPhone?.() || provider.activationId || '号码';
        const task = (async () => {
            if (waitMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, waitMs));
            }
            return this._cancel(provider, label);
        })().catch(() => false);
        this._pending.add(task);
        task.finally(() => this._pending.delete(task));
        return task;
    }

    async _cancel(provider, label) {
        if (this._inflight.has(provider)) return false;
        this._inflight.add(provider);
        try {
            console.warn(`[SMS] 后台取消号码 ${label}（已等待到可取消时间）...`);
            await provider.cancel();
            return true;
        } catch (error) {
            console.error(`[SMS] 后台取消号码失败: ${error?.message || error}（号码到期后自动退款）`);
            return false;
        } finally {
            this._inflight.delete(provider);
        }
    }

    /**
     * 等待所有已排队的取消完成（含尚未到 readyAtMs 的，先等到点再取消）。
     * 进程退出前调用，确保退款不遗漏。
     */
    async flush() {
        const all = [...this._pending];
        if (all.length > 0) {
            console.log(`[SMS] 等待 ${all.length} 个后台取消任务排空...`);
            await Promise.all(all);
        }
    }
}

module.exports = { DeferredCancelManager };