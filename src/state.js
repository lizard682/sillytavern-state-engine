/**
 * 抽取引擎：合集状态、冷却、随机流、抽签。
 *
 * 设计原则：
 * - 每个合集有独立的随机流（由 seed + deckId + turn + nonce 派生），
 *   同一楼层重生成结果不变，手动重抽只在 nonce 上 +1。
 * - 抽过的条目进入 recent（冷却），冷却期内不会再被抽到。
 * - 状态整体存在 chat_metadata 里，跟着聊天走。
 */

import { createRng, freshSeed, hashSeed } from './rng.js';
import { pushLedger } from './ledger.js';

export const STATE_SCHEMA = 2;

/** 创建一个空状态。 */
export function createState(seed, startTurn = 0) {
    return {
        schema: STATE_SCHEMA,
        seed: seed || freshSeed(),
        turn: Number.isFinite(Number(startTurn)) ? Number(startTurn) : 0,
        decks: {},
        ledger: [],
    };
}

/** 不能当对象键用：写进去会碰到 Object.prototype。 */
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** 取（并按需创建）某个合集的运行时状态。 */
export function deckState(state, deckId) {
    if (!state.decks || typeof state.decks !== 'object') {
        state.decks = {};
    }
    const key = String(deckId);
    // 保留键不进对象：返回一次性状态，绝不写原型链。
    if (RESERVED_KEYS.has(key)) {
        return { current: [], recent: [], nonce: 0, lastTurn: -1, lastDecisionTurn: -1 };
    }
    const existing = Object.prototype.hasOwnProperty.call(state.decks, key) ? state.decks[key] : null;
    if (!existing || typeof existing !== 'object') {
        state.decks[key] = {
            current: [],
            recent: [],
            nonce: 0,
            lastTurn: -1,
            lastDecisionTurn: -1,
        };
    }
    const ds = state.decks[key];
    ds.current ||= [];
    ds.recent ||= [];
    ds.nonce = Number(ds.nonce) || 0;
    if (!Number.isFinite(Number(ds.holdStart))) {
        ds.holdStart = -1;
    }
    return ds;
}

/**
 * 把当前楼层同步进状态。
 * 前进时照常推进；回退时（切分支、删楼、回滚）也要跟回去，
 * 否则 lastTurn/markerFloor 会卡在父分支的楼层上，自动触发永远不满足。
 */
export function syncTurn(state, floor) {
    const prev = Number.isFinite(Number(state.turn)) ? Number(state.turn) : 0;
    const next = Number.isFinite(Number(floor)) ? Number(floor) : prev;
    if (next === prev) {
        return;
    }
    state.turn = next;
    if (next < prev) {
        for (const ds of Object.values(state.decks || {})) {
            if (Number(ds?.lastTurn) > next) {
                ds.lastTurn = -1;
            }
            if (Number(ds?.lastDecisionTurn) > next) {
                ds.lastDecisionTurn = -1;
            }
        }
        if (Number(state.markerFloor) > next) {
            state.markerFloor = -1;
        }
    }
}

/** 每个合集独立的随机流。salt 用来在同一个合集内区分不同用途。 */
export function rngFor(state, deckId, salt = 0) {
    const ds = state.decks?.[deckId];
    const nonce = Number(ds?.nonce) || 0;
    return createRng(hashSeed(`${state.seed}:${deckId}:${state.turn}:${nonce}:${salt}`));
}

/**
 * 从数组里按权重随机取 count 个不重复的元素。
 * weight 是相对权重（默认 1）；weight <= 0 的条目视为“永不出现”。
 * 如果池子里所有条目权重都是 0，返回空数组。
 */
export function pickWithRng(pool, count, rng) {
    const bag = pool.filter((item) => (Number(item.weight) || 0) > 0);
    const out = [];
    const wanted = Math.max(0, Math.min(count, bag.length));
    while (out.length < wanted) {
        const total = bag.reduce((sum, item) => sum + (Number(item.weight) || 0), 0);
        let point = rng.next() * total;
        let index = bag.length - 1;
        for (let i = 0; i < bag.length; i += 1) {
            point -= Number(bag[i].weight) || 0;
            if (point < 0) {
                index = i;
                break;
            }
        }
        out.push(bag.splice(index, 1)[0]);
    }
    return out;
}

/** 当前值是否已经抽过（用于“同楼不重抽”和初始化判断）。 */
export function hasCurrent(state, deck) {
    const ds = deckState(state, deck.id);
    return Array.isArray(ds.current) && ds.current.length > 0;
}

/** 取当前值对应的条目。 */
export function currentItems(state, deck) {
    const ds = deckState(state, deck.id);
    const byId = new Map(deck.items.map((item) => [item.id, item]));
    return ds.current.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * 抽一个合集。
 * options: { force, cause }
 * 返回 { changed, items, ids, cause, fallback }
 */
export function drawDeck(state, deck, options = {}) {
    const { force = false, cause = 'manual' } = options;
    const ds = deckState(state, deck.id);
    const turn = state.turn;

    // 同一楼层只决定一次；重生成、swipe 都沿用上一轮结论。
    if (!force && Number(ds.lastDecisionTurn) === turn && hasCurrent(state, deck)) {
        return { changed: false, items: currentItems(state, deck), ids: ds.current.slice(), cause: 'cached', fallback: false };
    }

    const cooldown = Math.max(0, Number(deck.cooldown) || 0);
    const excluded = new Set(cooldown > 0 ? ds.recent.slice(-cooldown) : []);
    // weight 为 0 的条目视为禁用，不进入候选池。
    const pool = deck.items.filter((item) => !excluded.has(item.id) && (Number(item.weight) || 0) > 0);

    if (pool.length === 0) {
        // 全部都在冷却里（或全被关掉）：这一轮不抽，宁可留空也不硬塞重复内容。
        // 同时清掉旧值，否则旧条目会一直留在注入里，和「这一轮没有」自相矛盾。
        ds.current = [];
        ds.lastDecisionTurn = turn;
        ds.lastTurn = turn;
        pushLedger(state, { deck: deck.id, deckName: deck.name, cause, picked: [], note: '候选都在冷却中或都被关闭' });
        return { changed: true, items: [], ids: [], cause: 'exhausted', fallback: true };
    }

    const pick = Math.min(Math.max(1, Number(deck.pick) || 1), pool.length);
    const rng = rngFor(state, deck.id, 0);
    const picked = pickWithRng(pool, pick, rng);
    const ids = picked.map((item) => item.id);

    ds.current = ids;
    ds.recent.push(...ids);
    const keep = Math.max(cooldown, 8);
    if (ds.recent.length > keep) {
        ds.recent = ds.recent.slice(-keep);
    }
    ds.lastTurn = turn;
    ds.lastDecisionTurn = turn;
    ds.holdStart = turn;
    ds.holdTurns = Math.max(1, Number(deck.hold?.turns) || 1);

    pushLedger(state, {
        deck: deck.id,
        deckName: deck.name,
        cause,
        picked: picked.map((item) => `${item.name}(${item.id})`),
        note: '',
    });

    return { changed: true, items: picked, ids, cause, fallback: false };
}

/** 手动重抽：nonce+1，让随机流换一条。 */
export function bumpNonce(state, deckId) {
    const ds = deckState(state, deckId);
    ds.nonce = (Number(ds.nonce) || 0) + 1;
    return ds.nonce;
}

/**
 * 合集树抽签：先抽「子合集」，再抽子合集的条目。
 *
 * - decks 里 parent === 当前合集 id 的，就是它的子合集。
 * - 子合集按下级自己的 entryWeight 加权抽一个，然后对子合集继续抽。
 * - 子合集抽中后，它自己的 current / hold / 注入照常生效；上层合集只负责「挑一组」。
 * - 最多 maxDepth 层，visited 防环（A 的 parent 是 B、B 的 parent 是 A 时不会死循环）。
 *
 * 返回：
 *   { ok, nested, deck, parentDeck, result } —— nested=true 表示这一抽是「抽中了子合集」，
 *   deck 是最终抽到条目的那个合集，result 是 drawDeck 的返回值。
 */
export function drawDeckTree(state, decks, deckId, options = {}) {
    const {
        force = false,
        cause = 'manual',
        maxDepth = 3,
        depth = 0,
        visited = new Set(),
    } = options;
    const deck = (decks || []).find((item) => item && item.id === deckId);
    if (!deck || visited.has(deckId) || depth > maxDepth) {
        return { ok: false, nested: false, deck: deck || null, parentDeck: null, result: null, reason: 'invalid' };
    }
    const nextVisited = new Set(visited);
    nextVisited.add(deckId);

    const children = (decks || []).filter((item) => item && item.parent === deckId && item.enabled !== false);
    if (children.length > 0 && depth < maxDepth) {
        const rng = rngFor(state, deckId, 7);
        const pool = children.map((child) => ({ ...child, weight: Number(child.entryWeight) || 0 }));
        const picked = pickWithRng(pool, 1, rng)[0];
        if (!picked) {
            pushLedger(state, {
                deck: deck.id,
                deckName: deck.name,
                cause,
                picked: [],
                note: '子合集的权重都是 0，没有可抽的',
            });
            return { ok: false, nested: false, deck, parentDeck: null, result: null, reason: 'empty' };
        }
        // 上层只记一笔「抽中了哪个子合集」，真正的条目账本由子合集自己写。
        pushLedger(state, {
            deck: deck.id,
            deckName: deck.name,
            cause: cause === 'manual' ? 'nested' : cause,
            picked: [`→ ${picked.name}`],
            note: '',
        });
        const childResult = drawDeckTree(state, decks, picked.id, {
            force: true,
            cause: cause === 'manual' ? 'nested' : cause,
            maxDepth,
            depth: depth + 1,
            visited: nextVisited,
        });
        return { ok: true, nested: true, deck: picked, parentDeck: deck, result: childResult };
    }

    const result = drawDeck(state, deck, { force, cause });
    return { ok: true, nested: false, deck, parentDeck: null, result };
}

/**
 * 到期检查：抽中的内容该不该在这一轮被丢掉。
 * mode='turns' 时，抽中那一轮算第 1 轮，过了 turns 轮就清空。
 * mode='forever' / 'ai' 不按轮数过期（'ai' 等模型发结束标记）。
 */
export function expireIfDue(state, deck) {
    const ds = deckState(state, deck.id);
    if (!Array.isArray(ds.current) || ds.current.length === 0) {
        return false;
    }
    const hold = deck.hold || {};
    if (hold.mode !== 'turns') {
        return false;
    }
    const start = Number(ds.holdStart);
    if (!Number.isFinite(start) || start < 0) {
        return false;
    }
    const turns = Math.max(1, Number(hold.turns) || 1);
    if (Number(state.turn) - start < turns) {
        return false;
    }
    const dropped = ds.current.slice();
    ds.current = [];
    ds.holdStart = -1;
    pushLedger(state, {
        deck: deck.id,
        deckName: deck.name,
        cause: 'expire',
        picked: [],
        note: `持续 ${turns} 轮到期：${dropped.join('、')}`,
    });
    return true;
}

/** 模型主动结束（mode='ai' 时用 <!--SE-END:合集id--> 触发）。 */
export function endHold(state, deck, cause = 'ai-end') {
    const ds = deckState(state, deck.id);
    if (!Array.isArray(ds.current) || ds.current.length === 0) {
        return false;
    }
    const dropped = ds.current.slice();
    ds.current = [];
    ds.holdStart = -1;
    pushLedger(state, {
        deck: deck.id,
        deckName: deck.name,
        cause,
        picked: [],
        note: `结束当前内容：${dropped.join('、')}`,
    });
    return true;
}

/** 清掉一个合集的冷却记录（保留当前值）。 */
export function clearDeckHistory(state, deckId) {
    const ds = deckState(state, deckId);
    ds.recent = [];
    ds.lastDecisionTurn = -1;
}

/** 导入新合集时，把它的状态也重置一份。 */
export function resetDeckState(state, deckId) {
    const key = String(deckId);
    if (RESERVED_KEYS.has(key)) {
        return;
    }
    if (!state.decks || typeof state.decks !== 'object') {
        state.decks = {};
    }
    state.decks[key] = {
        current: [],
        recent: [],
        nonce: 0,
        lastTurn: -1,
        lastDecisionTurn: -1,
    };
}
