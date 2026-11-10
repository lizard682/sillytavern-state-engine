/**
 * 可复现随机数。
 *
 * 设计目标：同一个 seed + 同样的调用顺序 => 永远得到同样的结果。
 * 这样"这局为什么抽到病娇"可以事后完全还原，也能让你把一局的随机结果分享给别人。
 *
 * 注意：这不是密码学安全的随机，插件里也不需要——我们要的是"公平且可复现"。
 */

/** 把任意字符串/数字揉成一个 32 位种子（FNV-1a）。 */
export function hashSeed(input) {
    const text = String(input ?? '');
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/** 从浏览器真随机源取一个种子。只在开局或玩家手动重抽时调用。 */
export function freshSeed() {
    const buf = new Uint32Array(1);
    if (globalThis.crypto?.getRandomValues) {
        globalThis.crypto.getRandomValues(buf);
        return buf[0] >>> 0;
    }
    return (Math.random() * 0x100000000) >>> 0;
}

/**
 * 建一个随机数发生器。
 * @param {number|string} seed 种子；同一个种子永远产生同一串数
 */
export function createRng(seed) {
    let state = (Number(seed) >>> 0) || 0x9e3779b9;

    const next = () => {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state / 4294967296;
    };

    const rng = {
        next,

        /** 0..n-1 等概率 */
        int(n) {
            if (!Number.isFinite(n) || n <= 0) return 0;
            return Math.floor(next() * n);
        },

        /** 以 p 的概率返回 true */
        chance(p) {
            return next() < Math.min(1, Math.max(0, Number(p) || 0));
        },

        /**
         * 加权抽一个，返回 { item, index }；池子为空返回 null。
         * 权重缺失按 1 算，负数当 0。
         */
        weighted(items) {
            if (!Array.isArray(items) || items.length === 0) return null;
            let total = 0;
            for (const it of items) {
                total += Math.max(0, Number(it?.weight ?? 1));
            }
            if (!(total > 0)) {
                return { item: items[0], index: 0 };
            }
            let r = next() * total;
            for (let i = 0; i < items.length; i++) {
                r -= Math.max(0, Number(items[i]?.weight ?? 1));
                if (r <= 0) return { item: items[i], index: i };
            }
            return { item: items[items.length - 1], index: items.length - 1 };
        },

        /** 洗牌（Fisher-Yates），返回新数组 */
        shuffle(list) {
            const out = [...(list || [])];
            for (let i = out.length - 1; i > 0; i--) {
                const j = Math.floor(next() * (i + 1));
                [out[i], out[j]] = [out[j], out[i]];
            }
            return out;
        },
    };

    return rng;
}
