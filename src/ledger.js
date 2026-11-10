/**
 * 记录（Ledger）：把每一次切换写下来，方便事后复查"到底有没有生效"。
 *
 * 玩家不需要被通知，但后台必须留下证据：
 *   第几轮、哪一层、从什么变成什么、为什么变（过期/随机命中/手动/初始化）、
 *   当时候选池多大、种子是什么。
 */

export const LEDGER_LIMIT = 300;

/**
 * 追加一条记录，超出上限自动丢掉最老的。
 * @param {object} state 引擎状态（会就地修改 state.ledger）
 * @param {object} entry
 */
export function pushLedger(state, entry) {
    if (!state || typeof state !== 'object') return;
    if (!Array.isArray(state.ledger)) state.ledger = [];
    state.ledger.push({
        turn: Number(state.turn) || 0,
        at: Date.now(),
        ...entry,
    });
    const overflow = state.ledger.length - LEDGER_LIMIT;
    if (overflow > 0) state.ledger.splice(0, overflow);
}

/** 取最近 n 条，新的在后。 */
export function recentLedger(state, n = 20) {
    const list = Array.isArray(state?.ledger) ? state.ledger : [];
    return list.slice(Math.max(0, list.length - n));
}

/** 导出成一段可读文本，便于贴给别人看或存成文件。 */
export function formatLedger(state, n = 50) {
    return recentLedger(state, n)
        .map(row => {
            const name = row.deckName || row.deck || row.layer || '?';
            const picked = Array.isArray(row.picked) ? row.picked.join('、') : '';
            const note = row.note ? `：${row.note}` : '';
            return `#${row.turn} [${name}] ${picked || '空'} (${row.cause}${note})`;
        })
        .join('\n');
}
