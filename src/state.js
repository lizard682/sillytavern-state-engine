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
        // 全局进度：记录「哪些条目已经出现过」（合集id::条目id），
        // 供「只出现一次」和「前置条件」使用，跨合集共享。
        progress: [],
        // 每层一份快照：删楼 / 重生成 / 切分支时按楼层回退。
        frames: {},
        ledger: [],
    };
}

/**
 * 给当前楼层拍一张快照。
 * 只记会随抽签变化的字段，别把整份状态抄一遍。
 */
export function captureFrame(state) {
    if (!state.frames || typeof state.frames !== 'object') {
        state.frames = {};
    }
    const turn = Number(state.turn) || 0;
    const decks = {};
    for (const [id, ds] of Object.entries(state.decks || {})) {
        decks[id] = {
            current: Array.isArray(ds?.current) ? [...ds.current] : [],
            used: ds?.used === true,
            hold: ds?.hold ? { ...ds.hold } : null,
            holdStart: Number.isFinite(Number(ds?.holdStart)) ? Number(ds.holdStart) : -1,
            holdStartDay: Number.isFinite(Number(ds?.holdStartDay)) ? Number(ds.holdStartDay) : -1,
            itemTurns: { ...(ds?.itemTurns || {}) },
            gameDay: Number.isFinite(Number(ds?.gameDay)) ? Number(ds.gameDay) : null,
        };
    }
    state.frames[turn] = {
        decks,
        progress: Array.isArray(state.progress) ? [...state.progress] : [],
        markerFloor: Number.isFinite(Number(state.markerFloor)) ? Number(state.markerFloor) : -1,
    };
    // 只保留最近 200 层，别让快照无限长。
    const keys = Object.keys(state.frames).map(Number).sort((a, b) => a - b);
    if (keys.length > 200) {
        for (const key of keys.slice(0, keys.length - 200)) {
            delete state.frames[key];
        }
    }
}

/**
 * 回退到某一层：找不晚于 targetTurn 的最近快照，把 current / 进度 / 标记楼层复原。
 * 返回是否真的恢复过。
 */
export function restoreFrame(state, targetTurn) {
    const frames = state.frames || {};
    const keys = Object.keys(frames)
        .map(Number)
        .filter((key) => key <= targetTurn)
        .sort((a, b) => a - b);
    if (keys.length === 0) {
        return false;
    }
    const frame = frames[keys[keys.length - 1]];
    for (const [id, snap] of Object.entries(frame.decks || {})) {
        const ds = deckState(state, id);
        ds.current = Array.isArray(snap.current) ? [...snap.current] : [];
        ds.used = snap.used === true;
        // 持续时长是「抽中那一条」自己的设置，回退时必须一起复原，
        // 否则会掉到合集默认值上，看起来就像条目的独立判定被合集覆盖了。
        ds.hold = snap.hold ? { ...snap.hold } : null;
        ds.holdStart = Number.isFinite(Number(snap.holdStart)) ? Number(snap.holdStart) : -1;
        ds.holdStartDay = Number.isFinite(Number(snap.holdStartDay)) ? Number(snap.holdStartDay) : -1;
        ds.itemTurns = { ...(snap.itemTurns || {}) };
        ds.gameDay = Number.isFinite(Number(snap.gameDay)) ? Number(snap.gameDay) : null;
    }
    state.progress = Array.isArray(frame.progress) ? [...frame.progress] : [];
    state.markerFloor = Number.isFinite(Number(frame.markerFloor)) ? Number(frame.markerFloor) : -1;
    // 比目标楼层更晚的快照不再有意义。
    for (const key of Object.keys(frames)) {
        if (Number(key) > targetTurn) {
            delete frames[key];
        }
    }
    return true;
}

/** 前置条件引用的键。 */
export function itemRef(deckId, itemId) {
    return `${deckId}::${itemId}`;
}

/** 取已完成条目的集合（顺带把 progress 修成数组）。 */
export function doneSet(state) {
    if (!Array.isArray(state.progress)) {
        state.progress = [];
    }
    return new Set(state.progress);
}

/** 抽中后把条目写进进度（去重）。 */
export function recordProgress(state, deckId, items) {
    if (!Array.isArray(state.progress)) {
        state.progress = [];
    }
    for (const item of items || []) {
        const ref = itemRef(deckId, item.id);
        if (!state.progress.includes(ref)) {
            state.progress.push(ref);
        }
    }
}

/** 清空进度：所有「只出现一次」和前置条件回到初始状态。 */
export function clearProgress(state) {
    state.progress = [];
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
    ds.itemTurns ||= {};
    ds.nonce = Number(ds.nonce) || 0;
    if (!Number.isFinite(Number(ds.holdStart))) {
        ds.holdStart = -1;
        ds.holdStartDay = -1;
        ds.hold = null;
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
        // 先按楼层快照复原（删楼 / 切分支 / 重生成都会走到这里），
        // 再把比当前楼层更晚的时间戳清掉，让自动触发能重新满足。
        restoreFrame(state, next);
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
    const { force = false, cause = 'manual', ephemeral = false } = options;
    const ds = deckState(state, deck.id);
    const turn = state.turn;

    // 配套抽取：只借用这个合集的候选池和随机流，不写 current / 进度 / 账本。
    if (ephemeral) {
        const pool = availableItems(state, deck);
        if (pool.length === 0) {
            return { changed: false, items: [], ids: [], cause: 'compose-empty', fallback: true };
        }
        const pick = Math.min(Math.max(1, Number(deck.pick) || 1), pool.length);
        ds.composeNonce = (Number(ds.composeNonce) || 0) + 1;
        const rng = createRng(hashSeed(`${state.seed}:${deck.id}:compose:${turn}:${ds.composeNonce}`));
        const picked = pickWithRng(pool, pick, rng);
        return { changed: true, items: picked, ids: picked.map((item) => item.id), cause: 'compose', fallback: false };
    }

    // 同一楼层只决定一次；重生成、swipe 都沿用上一轮结论。
    if (!force && Number(ds.lastDecisionTurn) === turn && hasCurrent(state, deck)) {
        return { changed: false, items: currentItems(state, deck), ids: ds.current.slice(), cause: 'cached', fallback: false };
    }

    const cooldown = Math.max(0, Number(deck.cooldown) || 0);
    const done = doneSet(state);
    // 候选池：排除冷却中、权重为 0、已经「只出现一次」用过、以及前置条件没满足的条目。
    const pool = availableItems(state, deck);

    if (pool.length === 0) {
        // 全部都在冷却里、都被关掉、或前置条件没满足：这一轮不抽，宁可留空也不硬塞重复内容。
        // 同时清掉旧值，否则旧条目会一直留在注入里，和「这一轮没有」自相矛盾。
        ds.current = [];
        ds.lastDecisionTurn = turn;
        ds.lastTurn = turn;
        pushLedger(state, {
            deck: deck.id,
            deckName: deck.name,
            cause,
            picked: [],
            note: '没有可抽的条目（冷却 / 只出现一次已用过 / 前置条件未满足）',
        });
        return { changed: true, items: [], ids: [], cause: 'exhausted', fallback: true };
    }

    const pick = Math.min(Math.max(1, Number(deck.pick) || 1), pool.length);
    const rng = rngFor(state, deck.id, 0);
    const picked = pickWithRng(pool, pick, rng);
    const ids = picked.map((item) => item.id);

    ds.current = ids;
    ds.recent.push(...ids);
    for (const item of picked) {
        ds.itemTurns[item.id] = turn;
    }
    const keep = Math.max(cooldown, 8);
    if (ds.recent.length > keep) {
        ds.recent = ds.recent.slice(-keep);
    }
    // 记录进度：供「只出现一次」和别的条目的前置条件使用。
    recordProgress(state, deck.id, picked);
    // 动态权重：降权累计 / 增权归零。
    applyFatigueOnHit(state, deck, picked);
    ds.lastTurn = turn;
    ds.lastDecisionTurn = turn;
    ds.holdStart = turn;
    // 持续时长优先看「抽中这一条」自己的设置，没设就跟随合集。
    const itemHold = picked.find((entry) => entry && entry.hold)?.hold;
    const effectiveHold = itemHold || deck.hold || null;
    ds.hold = effectiveHold ? { ...effectiveHold } : null;
    ds.holdTurns = Math.max(1, Number(effectiveHold?.turns) || 1);
    ds.holdDays = Math.max(1, Number(effectiveHold?.days) || 1);
    // 记下抽中时的「游戏内天数」，按天冷却的合集从这一天开始算。
    if (Number.isFinite(Number(state.gameDay))) {
        ds.gameDay = Number(state.gameDay);
        ds.holdStartDay = Number(state.gameDay);
    }

    pushLedger(state, {
        deck: deck.id,
        deckName: deck.name,
        cause,
        picked: picked.map((item) => `${item.name}(${item.id})`),
        note: '',
    });

    return { changed: true, items: picked, ids, cause, fallback: false };
}

/**
 * 组合：抽中本合集的条目后，按 deck.compose 里列出的来源各抽一次，
 * 把结果填进条目文本里的 {合集名} / {合集id} 占位符，存进 ds.rendered。
 * 只影响「这一轮注入的文本」，不改来源合集的 current 与进度。
 */
export function applyCompose(state, decks, deck, result) {
    const ds = deckState(state, deck.id);
    const sources = Array.isArray(deck.compose) ? deck.compose : [];
    if (sources.length === 0 || !result || !Array.isArray(result.items) || result.items.length === 0) {
        ds.rendered = {};
        return {};
    }
    const values = {};
    for (const id of sources) {
        const source = (decks || []).find((item) => item && item.id === id);
        if (!source) {
            continue;
        }
        const drawn = drawDeck(state, source, { force: true, ephemeral: true, cause: 'compose' });
        const text = (drawn.items || []).map((item) => item.text).join('、');
        if (!text) {
            continue;
        }
        values[source.name] = text;
        values[source.id] = text;
    }
    const rendered = {};
    for (const item of result.items) {
        let text = item.text || '';
        for (const [key, value] of Object.entries(values)) {
            text = text.split(`{${key}}`).join(value);
        }
        rendered[item.id] = text;
    }
    ds.rendered = rendered;
    return rendered;
}

/** 手动重抽：nonce+1，让随机流换一条。 */
/**
 * 初始值：合集里勾了「作为初始值」的条目，在新聊天第一次打开时直接生效，
 * 不需要先抽。只跑一次（ds.initialized 记住），清空或新开聊天才会重来。
 */
export function applyInitial(state, deck) {
    const ds = deckState(state, deck.id);
    if (ds.initialized === true) {
        return { applied: [] };
    }
    if (Array.isArray(ds.current) && ds.current.length > 0) {
        ds.initialized = true;
        return { applied: [] };
    }
    const initials = (deck.items || []).filter((item) => item.initial === true);
    if (initials.length === 0) {
        return { applied: [] };
    }
    ds.current = initials.map((item) => item.id);
    ds.initialized = true;
    ds.holdStart = Number(state.turn) || 0;
    ds.used = false;
    // 初始值也算「出现过」，否则后面 requires 指向它的条目会永远等不到。
    recordProgress(state, deck.id, initials);
    pushLedger(state, { deck: deck.id, deckName: deck.name, picked: ds.current.slice(), cause: 'init', note: '初始值' });
    return { applied: ds.current.slice(), items: initials };
}

export function bumpNonce(state, deckId) {    const ds = deckState(state, deckId);
    ds.nonce = (Number(ds.nonce) || 0) + 1;
    return ds.nonce;
}

/**
 * 这个合集此刻能抽的条目。
 * 排除：冷却中的、权重为 0 的、「只出现一次」已用过的、前置条件没满足的、排除条件被触发的。
 */
/**
 * 条目的「当前有效权重」：基础权重 × 动态倍率。
 * 动态权重（fatigue）有两种：
 *   decay：被抽中一次就往下掉，掉到下限以下进冷却，冷却结束回到 100%。
 *   boost：一直没被抽中，每隔 N 轮往上加一点，直到被抽中才回到 100%。
 * 冷却中返回 0（等于这一轮不进池）。
 */
export function effectiveWeight(state, deck, item, ds = deckState(state, deck.id), turn = Number(state.turn) || 0) {
    const base = Math.max(0, Number(item.weight) || 0);
    if (base <= 0) {
        return 0;
    }
    const cfg = item.fatigue;
    if (!cfg || typeof cfg !== 'object' || cfg.mode === 'off') {
        return base;
    }
    if (!ds.fatigue || typeof ds.fatigue !== 'object') {
        ds.fatigue = {};
    }
    let f = ds.fatigue[item.id];
    if (!f || typeof f !== 'object') {
        f = { mult: 1, lastHit: -1, cooledUntil: -1 };
        ds.fatigue[item.id] = f;
    }
    const until = Number(f.cooledUntil);
    if (Number.isFinite(until) && until >= 0) {
        if (turn < until) {
            return 0; // 冷却中
        }
        f.cooledUntil = -1;
        f.mult = 1; // 冷却结束，恢复满权重
    }
    if (cfg.mode === 'boost') {
        const every = Math.max(1, Number(cfg.everyTurns) || 1);
        const last = Number(f.lastHit);
        if (last >= 0) {
            const steps = Math.floor((turn - last) / every);
            if (steps > 0) {
                const amount = Number(cfg.amount) || 10;
                // 用绝对值算，反复读取也不会重复叠加。
                const mult = cfg.ratio
                    ? (1 + amount / 100) ** steps
                    : 1 + (steps * amount) / 100;
                const cap = Math.max(1, (Number(cfg.maxPercent) || 300) / 100);
                f.mult = Math.min(cap, mult);
            }
        }
    }
    return base * Math.max(0, Number(f.mult) || 1);
}

/**
 * 抽中之后更新动态权重：decay 往下掉、可能进冷却；boost 被抽中就回到 100%。
 * 只处理这次真正抽中的条目。
 */
export function applyFatigueOnHit(state, deck, picked) {
    const ds = deckState(state, deck.id);
    if (!ds.fatigue || typeof ds.fatigue !== 'object') {
        ds.fatigue = {};
    }
    const turn = Number(state.turn) || 0;
    for (const hit of picked || []) {
        const source = (deck.items || []).find((item) => item.id === hit.id);
        const cfg = source?.fatigue;
        if (!cfg || typeof cfg !== 'object' || cfg.mode === 'off') {
            delete ds.fatigue[hit.id];
            continue;
        }
        let f = ds.fatigue[hit.id];
        if (!f || typeof f !== 'object') {
            f = { mult: 1, lastHit: -1, cooledUntil: -1 };
            ds.fatigue[hit.id] = f;
        }
        const every = Math.max(1, Number(cfg.everyTurns) || 1);
        const last = Number(f.lastHit);
        if (cfg.mode === 'decay') {
            // 第一次抽中也算一次「用了」，往下掉一档；隔太久没抽中则先回到满权重再掉。
            if (last < 0 || turn - last <= every) {
                const amount = Math.max(0, Number(cfg.amount) || 10);
                const mult = Number(f.mult) || 1;
                f.mult = cfg.ratio
                    ? Math.max(0, Math.round(mult * (1 - amount / 100) * 10000) / 10000)
                    : Math.max(0, Math.round((mult - amount / 100) * 10000) / 10000);
            } else {
                f.mult = 1;
            }
            const base = Math.max(0, Number(hit.weight) || 0);
            const floor = Math.max(0, Number(cfg.floorPercent) || 1) / 100;
            if (base * (Number(f.mult) || 0) <= floor) {
                f.cooledUntil = turn + Math.max(1, Number(cfg.recoverTurns) || 1);
            }
        } else {
            f.mult = 1;
        }
        f.lastHit = turn;
    }
}

export function availableItems(state, deck) {
    if (!deck || !Array.isArray(deck.items) || deck.items.length === 0) {
        return [];
    }
    const ds = deckState(state, deck.id);
    const cooldown = Math.max(0, Number(deck.cooldown) || 0);
    // 按游戏内天数冷却：整池一起等，直到 MVU 的日期走过 N 天。
    if (deck.timeUnit === 'day' && cooldown > 0) {
        const now = Number.isFinite(Number(state.gameDay)) ? Number(state.gameDay) : null;
        const last = Number.isFinite(Number(ds.gameDay)) ? Number(ds.gameDay) : null;
        if (now !== null && last !== null && now - last < cooldown) {
            return [];
        }
    }
    const excluded = new Set(cooldown > 0 ? ds.recent.slice(-cooldown) : []);
    const done = doneSet(state);
    const turn = Number(state.turn) || 0;
    const itemTurns = ds.itemTurns && typeof ds.itemTurns === 'object' ? ds.itemTurns : {};
    const kept = deck.items.filter((item) => {
        // 条目自己的启用开关：关掉的不参与抽签。
        if (item.enabled === false) {
            return false;
        }
        if (excluded.has(item.id)) {
            return false;
        }
        // 条目自己的冷却：覆盖合集设置。按「上次抽中那一轮」往后数，没抽过的不受影响。
        const ownCooldown = Number(item.cooldown);
        if (Number.isFinite(ownCooldown) && ownCooldown > 0) {
            const last = Number(itemTurns[item.id]);
            if (Number.isFinite(last) && last >= 0 && turn - last < ownCooldown) {
                return false;
            }
        }
        if ((Number(item.weight) || 0) <= 0) {
            return false;
        }
        if (item.once && done.has(itemRef(deck.id, item.id))) {
            return false;
        }
        if (Array.isArray(item.requires) && item.requires.some((ref) => !done.has(ref))) {
            return false;
        }
        // 排除条件：列表里任何一条已经出现过，这张条目就不再进池（互斥 / 分支的另一条路）。
        if (Array.isArray(item.excludes) && item.excludes.some((ref) => done.has(ref))) {
            return false;
        }
        // 「排除本合集的其它条目」：同合集里任何别的条目出现过，这张就不再进池，
        // 省得每张都手写一长串排除条件。
        if (item.excludeSiblings === true) {
            const hasSibling = deck.items.some((other) => other !== item && other.id !== item.id && done.has(itemRef(deck.id, other.id)));
            if (hasSibling) {
                return false;
            }
        }
        return true;
    });
    // 动态权重：把有效权重写进副本，抽签按它算；冷却中的（0）直接不进池。
    const pool = [];
    for (const item of kept) {
        const eff = effectiveWeight(state, deck, item, ds, turn);
        if (eff > 0) {
            pool.push(eff === (Number(item.weight) || 0) ? item : { ...item, weight: eff });
        }
    }
    return pool;
}

/** 某个合集的直接子合集（启用的）。 */
export function childDecks(decks, deckId) {
    return (decks || []).filter((item) => item && item.parent === deckId && item.enabled !== false);
}

/**
 * 这个合集是不是「抽无可抽」：
 * 自己一条能抽的都没有，而且所有能参与的子合集也都抽无可抽。
 * 权重为 0 的子合集不算「能参与」。
 */
export function deckExhausted(state, decks, deckId, seen = new Set()) {
    if (!deckId || seen.has(deckId)) {
        return false; // 成环时不要判成耗尽，交给上层防环
    }
    const deck = (decks || []).find((item) => item && item.id === deckId);
    if (!deck) {
        return true;
    }
    seen.add(deckId);
    if (availableItems(state, deck).length > 0) {
        return false;
    }
    const kids = childDecks(decks, deckId).filter((child) => (Number(child.entryWeight) || 0) > 0);
    if (kids.length === 0) {
        return true;
    }
    return kids.every((child) => deckExhausted(state, decks, child.id, seen));
}

/**
 * 现在有没有「不可打断」的合集在管事。
 * 有的话，自动抽取只认它；它自己抽无可抽了就自动让位。
 */
export function activeLockDeck(state, decks) {
    const locked = (decks || []).filter((deck) => deck && deck.lock === true && deck.enabled !== false);
    for (const deck of locked) {
        if (!deckExhausted(state, decks, deck.id)) {
            return deck;
        }
    }
    return null;
}

/**
 * 合集树抽签：条目和子合集放在同一把秤上比权重。
 *
 * - 自己的可用条目算一份总权重；直接子合集各按 entryWeight 算一份。
 * - 先掷一次骰子决定「这一抽走条目还是走某个子合集」，再按各自规则抽具体的东西。
 * - 子合集抽无可抽（自己空、下面的也都空）就不参与竞争。
 * - 最多 maxDepth 层，visited 防环。
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
        ignoreHold = false,
    } = options;
    const deck = (decks || []).find((item) => item && item.id === deckId);
    if (!deck || visited.has(deckId) || depth > maxDepth) {
        return { ok: false, nested: false, deck: deck || null, parentDeck: null, result: null, reason: 'invalid' };
    }
    // 当前内容还在持续期里，就不抽下一轮（手动重抽/立即判断会传 ignoreHold 绕过）。
    if (!ignoreHold && holdActive(state, deck)) {
        return { ok: false, nested: false, deck, parentDeck: null, result: null, reason: 'holding' };
    }
    const nextVisited = new Set(visited);
    nextVisited.add(deckId);

    const items = availableItems(state, deck);
    const itemWeight = items.reduce((sum, item) => sum + Math.max(0, Number(item.weight) || 0), 0);

    const kids = depth < maxDepth
        ? childDecks(decks, deckId).filter((child) => {
            if (visited.has(child.id)) {
                return false;
            }
            if ((Number(child.entryWeight) || 0) <= 0) {
                return false;
            }
            return !deckExhausted(state, decks, child.id, new Set([deckId]));
        })
        : [];
    const kidWeight = kids.reduce((sum, child) => sum + Math.max(0, Number(child.entryWeight) || 0), 0);
    const total = itemWeight + kidWeight;

    if (total <= 0) {
        // 条目和子合集都没得抽：走一次 drawDeck 的空池分支，把旧值和账本收拾干净。
        const result = drawDeck(state, deck, { force, cause });
        return { ok: false, nested: false, deck, parentDeck: null, result, reason: 'exhausted' };
    }

    const rng = rngFor(state, deckId, 7);
    const roll = rng.next() * total;

    if (roll < itemWeight || kids.length === 0) {
        const result = drawDeck(state, deck, { force, cause });
        applyCompose(state, decks, deck, result);
        return { ok: true, nested: false, deck, parentDeck: null, result };
    }

    let acc = itemWeight;
    let picked = kids[kids.length - 1];
    for (const child of kids) {
        acc += Math.max(0, Number(child.entryWeight) || 0);
        if (roll < acc) {
            picked = child;
            break;
        }
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
    const hold = ds.hold || deck.hold || {};
    if (hold.mode === 'days') {
        // 按游戏内天数：抽中那天算第 1 天，过满 days 天就清空。没有日期就不计时。
        const startDay = Number(ds.holdStartDay);
        const nowDay = Number(state.gameDay);
        const days = Math.max(1, Number(hold.days) || 1);
        if (!Number.isFinite(startDay) || startDay < 0) {
            // 抽中那一刻还没拿到日期（比如日期来自 MVU、抽签在刷新之前），
            // 就把「今天」记成起点，从下一轮开始正常算，不要永远不过期。
            if (Number.isFinite(nowDay)) {
                ds.holdStartDay = nowDay;
            }
            return false;
        }
        if (!Number.isFinite(nowDay)) {
            return false;
        }
        if (nowDay - startDay < days) {
            return false;
        }
        const dropped = ds.current.slice();
        ds.current = [];
        ds.holdStart = -1;
        ds.holdStartDay = -1;
        ds.hold = null;
        pushLedger(state, {
            deck: deck.id,
            deckName: deck.name,
            cause: 'expire',
            picked: [],
            note: `持续 ${days} 天到期：${dropped.join('、')}`,
        });
        return true;
    }
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
    ds.holdStartDay = -1;
    ds.hold = null;
    pushLedger(state, {
        deck: deck.id,
        deckName: deck.name,
        cause: 'expire',
        picked: [],
        note: `持续 ${turns} 轮到期：${dropped.join('、')}`,
    });
    return true;
}

/**
 * 当前抽中的内容是不是还在「持续」里（按轮数/按天数，且还没到期）。
 * 还在持续时，自动抽取要跳过这个合集；手动重抽、立即判断不受限制。
 * forever / ai 不阻塞，否则自动抽取会永远卡住。
 */
export function holdActive(state, deck) {
    const ds = deckState(state, deck.id);
    if (!Array.isArray(ds.current) || ds.current.length === 0) {
        return false;
    }
    const hold = ds.hold || null;
    if (!hold) {
        return false;
    }
    if (hold.mode === 'turns') {
        const start = Number(ds.holdStart);
        const turns = Math.max(1, Number(hold.turns) || 1);
        if (!Number.isFinite(start) || start < 0) {
            return false;
        }
        return Number(state.turn) - start < turns;
    }
    if (hold.mode === 'days') {
        const start = Number(ds.holdStartDay);
        const days = Math.max(1, Number(hold.days) || 1);
        if (!Number.isFinite(start) || start < 0) {
            return false;
        }
        const nowDay = Number(state.gameDay);
        if (!Number.isFinite(nowDay)) {
            return false;
        }
        return nowDay - start < days;
    }
    if (hold.mode === 'ai') {
        // 由 AI 判断结束：模型没写结束标记之前，这段内容就一直演下去，不换新的。
        return true;
    }
    return false;
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
    ds.holdStartDay = -1;
    ds.hold = null;
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

/**
 * 手动撤销这一抽：把当前合集抽中的内容清空，让它回到「还没抽」的状态。
 *
 * 只动「当前选中」这一个状态：current / holdStart / used。
 * 不动「已出现」记录（progress）——一次性、前置、排除引用的都是「这条出现过没有」，
 * 清除之后这些记录仍然有效；冷却记录（recent）也保留。
 */
export function clearCurrent(state, deck) {
    if (!deck?.id) {
        return { removed: [] };
    }
    const ds = deckState(state, deck.id);
    const removed = Array.isArray(ds.current) ? ds.current.slice() : [];
    ds.current = [];
    ds.holdStart = -1;
    ds.holdStartDay = -1;
    ds.hold = null;
    ds.used = false;
    if (removed.length > 0) {
        pushLedger(state, {
            deck: deck.id,
            deckName: deck.name,
            cause: 'cleared',
            picked: removed,
            note: '手动清除（不动「已出现」记录与冷却）',
        });
    }
    return { removed };
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

// ---------------------------------------------------------------------------
// 游戏内时间：从 MVU 变量里读「年月日」，换算成天数
// ---------------------------------------------------------------------------

const GAME_DATE_RE = /(\d{1,5})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/;

/** 「天元482年7月15日」→ 天数索引；认不出返回 null。 */
export function parseGameDay(text) {
    const m = String(text || '').match(GAME_DATE_RE);
    if (!m) {
        return null;
    }
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (!year || month < 1 || month > 12 || day < 1 || day > 31) {
        return null;
    }
    return year * 360 + (month - 1) * 30 + (day - 1);
}

/** 在一个变量对象里找日期字段（键名优先，其次全量找），最多下钻 4 层。 */
export function gameDayFromVariables(vars, depth = 0) {
    if (vars == null || depth > 4) {
        return null;
    }
    if (typeof vars === 'string') {
        return parseGameDay(vars);
    }
    if (typeof vars !== 'object') {
        return null;
    }
    if (Array.isArray(vars)) {
        for (const value of vars.slice(0, 20)) {
            const found = gameDayFromVariables(value, depth + 1);
            if (found !== null) {
                return found;
            }
        }
        return null;
    }
    const keys = Object.keys(vars).slice(0, 80);
    for (const key of keys) {
        if (/日期|时间|date|time|day/i.test(key)) {
            const found = gameDayFromVariables(vars[key], depth + 1);
            if (found !== null) {
                return found;
            }
        }
    }
    for (const key of keys) {
        const found = gameDayFromVariables(vars[key], depth + 1);
        if (found !== null) {
            return found;
        }
    }
    return null;
}

/**
 * 当前游戏内天数：先看聊天变量，再看最近几条消息附带的变量。
 * 没有 MVU 或没有日期字段时返回 null（按天冷却的合集就退回按楼层算）。
 */
export function currentGameDay(ctx) {
    const sources = [ctx?.chatMetadata?.variables];
    const chat = Array.isArray(ctx?.chat) ? ctx.chat.slice(-6) : [];
    for (const message of chat) {
        sources.push(message?.variables);
    }
    for (const source of sources) {
        const found = gameDayFromVariables(source);
        if (found !== null) {
            return found;
        }
    }
    return null;
}
