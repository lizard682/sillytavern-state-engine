/**
 * 离线自测：node tools/selftest.mjs
 * 只测纯逻辑（包校验 / 抽签 / 冷却 / 随机流），不碰浏览器。
 */

import assert from 'node:assert/strict';
import { validatePack, serializePack, normalizeKeywords, DEFAULT_TRIGGER, PACK_SCHEMA } from '../src/pack.js';
import { createState, drawDeck, drawDeckTree, deckState, clearDeckHistory, pickWithRng, syncTurn, expireIfDue, endHold, activeLockDeck, deckExhausted, availableItems, applyCompose, applyInitial, holdActive, effectiveWeight, applyFatigueOnHit, captureFrame, parseGameDay, gameDayFromVariables } from '../src/state.js';
import { createRng, hashSeed } from '../src/rng.js';
import { buildDirectorPrompt } from '../src/inject.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failed += 1;
        console.log(`  FAIL ${name} — ${error.message}`);
    }
}

function section(name) {
    console.log(`\n[${name}]`);
}

function makeDeck(overrides = {}) {
    const base = {
        schema: 3,
        id: 'outfit',
        name: '衣柜',
        items: [
            { id: 'a', name: 'A', text: 'a', weight: 1 },
            { id: 'b', name: 'B', text: 'b', weight: 1 },
            { id: 'c', name: 'C', text: 'c', weight: 1 },
        ],
        cooldown: 2,
        pick: 1,
    };
    const merged = { ...base, ...overrides };
    const result = validatePack(merged);
    if (!result.ok) {
        throw new Error('测试夹具不合法：' + result.errors.join('；'));
    }
    return result.pack;
}

// ---------------------------------------------------------------------------

section('包校验');
test('schema 3 的合集可以通过并升级到当前版本', () => {
    const result = validatePack({
        schema: 3,
        id: 'ok',
        name: 'OK',
        items: [{ id: 'x', name: 'X', text: 'x' }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.pack.schema, 5);
    assert.equal(result.pack.items[0].weight, 1);
});

test('旧 schema 2 会自动升级', () => {
    const result = validatePack({
        schema: 2,
        id: 'old',
        name: '旧',
        type: 'outfit',
        owner: 'character',
        items: [{ id: 'x', name: 'X', text: 'x', weight: 2 }],
        auto: true,
        autoEvery: 5,
    });
    assert.equal(result.ok, true);
    assert.equal(result.pack.schema, 5);
    assert.equal(result.pack.trigger.auto, true);
    assert.equal(result.pack.trigger.autoEvery, 5);
    assert.equal(result.pack.items[0].weight, 2);
});

test('缺 id 会报错', () => {
    const result = validatePack({ schema: 3, items: [{ name: 'X' }] });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('缺少 id')));
});

test('空 items 允许（纯容器合集靠子合集抽签）', () => {
    const result = validatePack({ schema: 4, id: 'x', items: [] });
    assert.equal(result.ok, true);
});

test('items 不是数组会报错', () => {
    const result = validatePack({ schema: 4, id: 'x', items: 'nope' });
    assert.equal(result.ok, false);
});

test('重复条目 id 会报错', () => {
    const result = validatePack({
        schema: 3,
        id: 'x',
        items: [{ id: 'same', name: 'A' }, { id: 'same', name: 'B' }],
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('重复')));
});

test('关键词支持逗号/顿号/换行分隔并去重', () => {
    assert.deepEqual(normalizeKeywords('换衣服，外套\n换衣服'), ['换衣服', '外套']);
});

test('默认触发：手动开、关键词关', () => {
    const deck = makeDeck();
    assert.equal(deck.trigger.manual, true);
    assert.equal(deck.trigger.keyword, false);
    assert.equal(deck.trigger.ai, false);
});

test('序列化输出当前 schema 且保留绑定/注入设置', () => {
    const deck = makeDeck({
        binding: { type: 'character', name: '沈微澜' },
        inject: { position: 'prompt', depth: 0, role: 'user' },
        keywords: ['换衣服'],
    });
    const out = serializePack(deck);
    assert.equal(out.schema, 5);
    assert.equal(out.binding.name, '沈微澜');
    assert.equal(out.inject.position, 'prompt');
    assert.equal(out.inject.role, 'user');
    assert.deepEqual(out.keywords, ['换衣服']);
});

// ---------------------------------------------------------------------------

section('权重抽样');
test('weight 0 的条目永不出现', () => {
    const deck = makeDeck({
        items: [
            { id: 'a', name: 'A', text: 'a', weight: 0 },
            { id: 'b', name: 'B', text: 'b', weight: 1 },
        ],
        cooldown: 0,
    });
    const state = createState('seed-x');
    for (let i = 0; i < 120; i += 1) {
        syncTurn(state, i + 1);
        state.decks[deck.id] = undefined;
        const result = drawDeck(state, deck, { force: true, cause: 'test' });
        assert.deepEqual(result.ids, ['b']);
    }
});

test('权重 1:3 时稀有项大约占 25%', () => {
    const deck = makeDeck({
        items: [
            { id: 'common', name: '常见', text: 'c', weight: 3 },
            { id: 'rare', name: '稀有', text: 'r', weight: 1 },
        ],
        cooldown: 0,
    });
    const state = createState('weight-seed');
    let rare = 0;
    const rounds = 1000;
    for (let i = 0; i < rounds; i += 1) {
        syncTurn(state, i + 1);
        const result = drawDeck(state, deck, { force: true, cause: 'test' });
        if (result.ids[0] === 'rare') rare += 1;
    }
    const ratio = rare / rounds;
    assert.ok(ratio > 0.18 && ratio < 0.32, `稀有项比例 ${ratio}`);
});

test('全部 weight 为 0 时返回空', () => {
    const rng = createRng(hashSeed('x'));
    assert.deepEqual(pickWithRng([{ weight: 0 }, { weight: 0 }], 1, rng), []);
});

// ---------------------------------------------------------------------------

section('冷却与同楼');
test('冷却内的条目不会被抽到', () => {
    const deck = makeDeck({
        items: [
            { id: 'a', name: 'A', text: 'a', weight: 1 },
            { id: 'b', name: 'B', text: 'b', weight: 1 },
        ],
        cooldown: 1,
    });
    const state = createState('cool');
    syncTurn(state, 1);
    const first = drawDeck(state, deck, { force: true, cause: 'test' });
    syncTurn(state, 2);
    const second = drawDeck(state, deck, { force: true, cause: 'test' });
    assert.notEqual(first.ids[0], second.ids[0]);
});

test('同一楼层再抽返回 cached', () => {
    const deck = makeDeck();
    const state = createState('cache');
    syncTurn(state, 5);
    const first = drawDeck(state, deck, { force: true, cause: 'test' });
    const second = drawDeck(state, deck, { cause: 'test' });
    assert.equal(second.cause, 'cached');
    assert.deepEqual(second.ids, first.ids);
});

test('重抽会换一个值（nonce 推进）', () => {
    const deck = makeDeck();
    const state = createState('reroll');
    syncTurn(state, 5);
    const ds = deckState(state, deck.id);
    ds.nonce += 1;
    const first = drawDeck(state, deck, { force: true, cause: 'test' });
    ds.nonce += 1;
    const second = drawDeck(state, deck, { force: true, cause: 'reroll' });
    assert.notEqual(first.ids[0], second.ids[0]);
});

test('清空记录后可以重新抽到冷却中的条目', () => {
    const deck = makeDeck({
        items: [
            { id: 'a', name: 'A', text: 'a', weight: 1 },
            { id: 'b', name: 'B', text: 'b', weight: 1 },
        ],
        cooldown: 1,
    });
    const state = createState('clear');
    syncTurn(state, 1);
    drawDeck(state, deck, { force: true, cause: 'test' });
    clearDeckHistory(state, deck.id);
    syncTurn(state, 2);
    const again = drawDeck(state, deck, { force: true, cause: 'test' });
    assert.equal(again.ids.length, 1);
    assert.equal(again.cause, 'test');
});

// ---------------------------------------------------------------------------

section('随机流');
test('同 seed 同楼层结果一致', () => {
    const deck = makeDeck();
    const a = createState('same');
    const b = createState('same');
    syncTurn(a, 7);
    syncTurn(b, 7);
    const ra = drawDeck(a, deck, { force: true, cause: 'test' });
    const rb = drawDeck(b, deck, { force: true, cause: 'test' });
    assert.deepEqual(ra.ids, rb.ids);
});

test('不同 seed 大概率不同', () => {
    const deck = makeDeck({
        items: Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, name: `I${i}`, text: `i${i}`, weight: 1 })),
        cooldown: 0,
    });
    const seen = new Set();
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
        const state = createState(seed);
        syncTurn(state, 3);
        seen.add(drawDeck(state, deck, { force: true, cause: 'test' }).ids[0]);
    }
    assert.ok(seen.size >= 4, `只见到 ${seen.size} 种结果`);
});

// ---------------------------------------------------------------------------

section('触发设置');
test('关键词触发开关会写进 trigger', () => {
    const deck = makeDeck({ trigger: { keyword: true, ai: true } });
    assert.equal(deck.trigger.keyword, true);
    assert.equal(deck.trigger.ai, true);
});

test('扫描设置默认最近 4 条、用户+AI', () => {
    const deck = makeDeck();
    assert.equal(deck.scan.depth, 4);
    assert.equal(deck.scan.source, 'both');
    assert.deepEqual(deck.scan.fields, []);
});

test('扫描来源只接受白名单字段', () => {
    const deck = makeDeck({ scan: { depth: 2, source: 'ai', fields: ['description', 'lorebook', 'bogus', '__proto__'] } });
    assert.deepEqual(deck.scan.fields, ['description', 'lorebook']);
});

test('递归默认只允许被叫醒、不允许继续扩散', () => {
    const deck = makeDeck();
    assert.deepEqual(deck.recursion, { canBeRecursed: true, canRecurse: false, delay: false });
});

test('递归字段会序列化并被旧数据补齐', () => {
    const deck = makeDeck({ recursion: { canBeRecursed: false, canRecurse: true, delay: true } });
    const wire = serializePack(deck);
    assert.deepEqual(wire.recursion, { canBeRecursed: false, canRecurse: true, delay: true });
    const again = validatePack(wire);
    assert.equal(again.ok, true);
    assert.deepEqual(again.pack.recursion, { canBeRecursed: false, canRecurse: true, delay: true });
});

test('DEFAULT_TRIGGER 不被测试污染', () => {
    assert.equal(DEFAULT_TRIGGER.keyword, false);
});

// ---------------------------------------------------------------------------

section('被谁唤起');
test('summon 默认：没人能唤起，也不限制自己出场', () => {
    const deck = makeDeck();
    assert.deepEqual(deck.summon, { by: [], only: false });
});

test('summon.by 只保留合法 id，去重', () => {
    const deck = makeDeck({ summon: { by: ['a', 'a', 'b', '__proto__', 'bad id!', 42], only: true } });
    assert.deepEqual(deck.summon, { by: ['a', 'b'], only: true });
});

test('summon 会序列化并能再导入', () => {
    const deck = makeDeck({ summon: { by: ['parent-deck'], only: true } });
    const wire = serializePack(deck);
    assert.deepEqual(wire.summon, { by: ['parent-deck'], only: true });
    const again = validatePack(wire);
    assert.equal(again.ok, true);
    assert.deepEqual(again.pack.summon, { by: ['parent-deck'], only: true });
});

test('旧包没有 summon 时补默认值', () => {
    const deck = makeDeck();
    delete deck.summon;
    const wire = serializePack(deck);
    assert.deepEqual(wire.summon, { by: [], only: false });
});

// ---------------------------------------------------------------------------

section('持续时长');
test('hold 默认是永久，旧数据会被补齐', () => {
    const deck = makeDeck();
    assert.deepEqual(deck.hold, { mode: 'forever', turns: 3, days: 1 });
});

test('按轮数：抽中当轮保留，下一轮才到期', () => {
    const state = createState('hold-seed', 10);
    state.turn = 10;
    const deck = makeDeck({ hold: { mode: 'turns', turns: 1 }, cooldown: 0 });
    drawDeck(state, deck, { force: true });
    assert.equal(deckState(state, 'outfit').current.length, 1);
    assert.equal(expireIfDue(state, deck), false);
    state.turn = 11;
    assert.equal(expireIfDue(state, deck), true);
    assert.equal(deckState(state, 'outfit').current.length, 0);
});

test('按轮数：3 轮才到期', () => {
    const state = createState('hold-seed-3', 5);
    state.turn = 5;
    const deck = makeDeck({ hold: { mode: 'turns', turns: 3 }, cooldown: 0 });
    drawDeck(state, deck, { force: true });
    state.turn = 6;
    assert.equal(expireIfDue(state, deck), false);
    state.turn = 7;
    assert.equal(expireIfDue(state, deck), false);
    state.turn = 8;
    assert.equal(expireIfDue(state, deck), true);
});

test('永久模式不会自动到期', () => {
    const state = createState('hold-forever', 1);
    state.turn = 1;
    const deck = makeDeck({ hold: { mode: 'forever' }, cooldown: 0 });
    drawDeck(state, deck, { force: true });
    state.turn = 99;
    assert.equal(expireIfDue(state, deck), false);
});

test('AI 结束时清空当前值', () => {
    const state = createState('hold-ai', 1);
    state.turn = 1;
    const deck = makeDeck({ hold: { mode: 'ai' }, cooldown: 0 });
    drawDeck(state, deck, { force: true });
    assert.equal(deckState(state, 'outfit').current.length, 1);
    assert.equal(endHold(state, deck), true);
    assert.equal(deckState(state, 'outfit').current.length, 0);
    assert.equal(endHold(state, deck), false);
});

// ---------------------------------------------------------------------------

section('合集嵌套');
test('schema 4：容器合集允许空条目', () => {
    const result = validatePack({ schema: 4, id: 'box', name: '大合集', items: [] });
    assert.equal(result.ok, true);
    assert.equal(result.pack.items.length, 0);
});

test('嵌套字段默认值', () => {
    const deck = makeDeck();
    assert.equal(deck.parent, '');
    assert.equal(deck.onlyFromParent, false);
    assert.equal(deck.entryWeight, 1);
});

test('大合集抽签会落到子合集的条目', () => {
    const state = createState('nest-seed', 3);
    state.turn = 3;
    const parent = makeDeck({ id: 'body', name: '身体', items: [], cooldown: 0 });
    const child = makeDeck({
        id: 'cervix',
        name: '宫口',
        parent: 'body',
        cooldown: 0,
        items: [
            { id: 'x', name: 'X', text: 'x' },
            { id: 'y', name: 'Y', text: 'y' },
        ],
    });
    const tree = drawDeckTree(state, [parent, child], 'body', { force: true });
    assert.equal(tree.ok, true);
    assert.equal(tree.nested, true);
    assert.equal(tree.deck.id, 'cervix');
    assert.equal(deckState(state, 'cervix').current.length, 1);
});

test('entryWeight=0 的子合集不会被抽中', () => {
    const state = createState('nest-zero', 1);
    state.turn = 1;
    const parent = makeDeck({ id: 'p', items: [], cooldown: 0 });
    const off = makeDeck({ id: 'off', parent: 'p', entryWeight: 0, cooldown: 0 });
    const tree = drawDeckTree(state, [parent, off], 'p', { force: true });
    assert.equal(tree.ok, false);
});

test('成环时不会死循环', () => {
    const state = createState('nest-cycle', 1);
    const a = makeDeck({ id: 'a', parent: 'b', items: [], cooldown: 0 });
    const b = makeDeck({ id: 'b', parent: 'a', items: [], cooldown: 0 });
    const tree = drawDeckTree(state, [a, b], 'a', { force: true });
    assert.equal(tree.ok, true);
});

// ---------------------------------------------------------------------------
// 条目与子合集在同一把秤上竞争

section('条目与子合集竞争');

test('父条目不会被有子合集这件事永久挡住', () => {
    let itemHits = 0;
    let childHits = 0;
    for (let i = 0; i < 60; i += 1) {
        const state = createState(`mix-${i}`, 1);
        state.turn = 1;
        const parent = makeDeck({ id: 'mix', name: '父', cooldown: 0, items: [{ id: 'own', name: '自己的条目', text: 'x', weight: 1 }] });
        const child = makeDeck({ id: 'kid', name: '子', parent: 'mix', entryWeight: 9, cooldown: 0, items: [{ id: 'c1', name: '子条目', text: 'y' }] });
        const tree = drawDeckTree(state, [parent, child], 'mix', { force: true });
        if (tree.nested) {
            childHits += 1;
        } else {
            itemHits += 1;
        }
    }
    assert.ok(itemHits > 0, `父条目一次都没抽到（item=${itemHits}, child=${childHits}）`);
    assert.ok(childHits > itemHits, `权重 9 的子合集没有占多数（item=${itemHits}, child=${childHits}）`);
});

test('多个子合集按各自入口权重分配', () => {
    let a = 0;
    let b = 0;
    for (let i = 0; i < 60; i += 1) {
        const state = createState(`multi-${i}`, 1);
        state.turn = 1;
        const parent = makeDeck({ id: 'p', items: [], cooldown: 0 });
        const ka = makeDeck({ id: 'a', parent: 'p', entryWeight: 1, cooldown: 0 });
        const kb = makeDeck({ id: 'b', parent: 'p', entryWeight: 3, cooldown: 0 });
        drawDeckTree(state, [parent, ka, kb], 'p', { force: true });
        if (deckState(state, 'a').current.length > 0) {
            a += 1;
        }
        if (deckState(state, 'b').current.length > 0) {
            b += 1;
        }
    }
    assert.ok(a > 0 && b > 0, `两个子合集都要能抽到（a=${a}, b=${b}）`);
    assert.ok(b > a, `权重高的应该更多（a=${a}, b=${b}）`);
});

test('子合集抽无可抽时不参与竞争', () => {
    const state = createState('kid-empty', 1);
    const parent = makeDeck({ id: 'p', items: [{ id: 'own', name: '自己的', text: 'x' }], cooldown: 0 });
    const kid = makeDeck({ id: 'k', parent: 'p', entryWeight: 5, cooldown: 0, items: [{ id: 'used', name: '用过', text: 'y', once: true }] });
    state.progress = ['k::used'];
    for (let i = 1; i <= 10; i += 1) {
        state.turn = i;
        const tree = drawDeckTree(state, [parent, kid], 'p', { force: true });
        assert.equal(tree.nested, false);
    }
});

test('抽无可抽的合集会被判定为耗尽', () => {
    const state = createState('exhausted-seed', 1);
    const deck = makeDeck({ id: 'only', cooldown: 0, items: [{ id: 'a', name: 'A', text: 'x', once: true }] });
    assert.equal(deckExhausted(state, [deck], 'only'), false);
    state.progress = ['only::a'];
    assert.equal(deckExhausted(state, [deck], 'only'), true);
});

// ---------------------------------------------------------------------------

section('不可打断');

test('锁定的合集会占住自动抽取', () => {
    const state = createState('lock-seed', 1);
    const lock = makeDeck({ id: 'lock', name: '主线', lock: true, cooldown: 0 });
    const other = makeDeck({ id: 'other', name: '支线', cooldown: 0 });
    const active = activeLockDeck(state, [lock, other]);
    assert.equal(active?.id, 'lock');
});

test('锁定合集抽无可抽后自动让位', () => {
    const state = createState('lock-done', 1);
    const lock = makeDeck({ id: 'lock', name: '主线', lock: true, cooldown: 0, items: [{ id: 'a', name: 'A', text: 'x', once: true }] });
    const other = makeDeck({ id: 'other', name: '支线', cooldown: 0 });
    state.progress = ['lock::a'];
    assert.equal(activeLockDeck(state, [lock, other]), null);
});

test('普通合集不会挡住别的合集', () => {
    const state = createState('no-lock', 1);
    const a = makeDeck({ id: 'a', cooldown: 0 });
    const b = makeDeck({ id: 'b', cooldown: 0 });
    assert.equal(activeLockDeck(state, [a, b]), null);
});

// ---------------------------------------------------------------------------
// 一次性条目 + 前置条件（剧情线）

section('一次性与前置条件');

test('once 的条目抽中后不再进候选池', () => {
    const state = createState('once-seed', 1);
    state.turn = 1;
    const deck = makeDeck({
        id: 'line',
        cooldown: 0,
        items: [
            { id: 'one', name: '第一幕', text: '1', once: true },
            { id: 'two', name: '第二幕', text: '2' },
        ],
    });
    const first = drawDeck(state, deck, { force: true });
    assert.equal(first.ids.length, 1);
    // 冷却为 0，但 once 用过之后不该再被抽到
    for (let i = 0; i < 20; i += 1) {
        const again = drawDeck(state, deck, { force: true, reroll: true });
        assert.notEqual(again.ids[0], 'one');
    }
});

test('前置条件未满足时不会抽到', () => {
    const state = createState('req-seed', 1);
    state.turn = 1;
    const deck = makeDeck({
        id: 'branch',
        cooldown: 0,
        items: [
            { id: 'gate', name: '门', text: 'g' },
            { id: 'after', name: '门后', text: 'a', requires: ['branch::gate'] },
        ],
    });
    // 门还没出现：候选池里只有门，第一次一定抽到门
    const first = drawDeck(state, deck, { force: true });
    assert.equal(first.ids[0], 'gate');
    // 门出现后，门后才解锁
    let sawAfter = false;
    for (let i = 0; i < 40; i += 1) {
        deckState(state, 'branch').nonce += 1;
        const again = drawDeck(state, deck, { force: true, reroll: true });
        if (again.ids[0] === 'after') {
            sawAfter = true;
            break;
        }
    }
    assert.equal(sawAfter, true);
});

test('前置条件可以跨合集，进度随抽中记录', () => {
    const state = createState('req-cross', 1);
    state.turn = 1;
    const door = makeDeck({ id: 'door', cooldown: 0, items: [{ id: 'open', name: '开门', text: 'o' }] });
    const inside = makeDeck({
        id: 'inside',
        cooldown: 0,
        items: [{ id: 'room', name: '里屋', text: 'r', requires: ['door::open'] }],
    });
    const before = drawDeck(state, inside, { force: true });
    assert.equal(before.ids.length, 0);

    const opened = drawDeck(state, door, { force: true });
    assert.equal(opened.ids[0], 'open');

    const after = drawDeck(state, inside, { force: true });
    assert.equal(after.items[0].id, 'room');
});

test('排除条件：被排除的条目出现过之后，这条不再进池', () => {
    const deck = makeDeck({
        id: 'fork',
        cooldown: 0,
        items: [
            { id: 'left', name: '走左边', text: 'l' },
            { id: 'right', name: '走右边', text: 'r', excludes: ['fork::left'] },
        ],
    });
    // 左边还没出现：右边仍然可抽（换几个种子总能抽到一次，避免单次随机运气）。
    let sawRight = false;
    for (let i = 0; i < 40 && !sawRight; i += 1) {
        const fresh = createState(`exclude-probe-${i}`, 1);
        const draw = drawDeck(fresh, deck, { force: true });
        if (draw.ids[0] === 'right') {
            sawRight = true;
        }
    }
    assert.equal(sawRight, true);

    // 把左边记进进度后，右边必须彻底消失。
    const state = createState('exclude-seed', 1);
    state.progress = ['fork::left'];
    for (let i = 0; i < 40; i += 1) {
        deckState(state, 'fork').nonce = i;
        const draw = drawDeck(state, deck, { force: true });
        assert.notEqual(draw.ids[0], 'right');
    }
});

// ---------------------------------------------------------------------------

// [排除本合集其它条目] 勾了 excludeSiblings 的条目，同合集里别的条目出现过就不再进池
test('排除本合集的其它条目（不必逐条手写排除）', () => {
    const deck = {
        id: 'sib',
        name: '同层互斥',
        items: [
            { id: 'a', name: 'A', text: 'A', weight: 1, once: false, requires: [], excludes: [], excludeSiblings: true },
            { id: 'b', name: 'B', text: 'B', weight: 1, once: false, requires: [], excludes: [], excludeSiblings: true },
            { id: 'c', name: 'C', text: 'C', weight: 1, once: false, requires: [], excludes: [], excludeSiblings: true },
        ],
        pick: 1,
        cooldown: 0,
    };
    const state = createState('sib-seed', 1);
    assert.deepEqual(availableItems(state, deck).map((item) => item.id), ['a', 'b', 'c']);

    // A 出现过之后，B / C 永久退出，只剩 A 自己
    state.progress = ['sib::a'];
    assert.deepEqual(availableItems(state, deck).map((item) => item.id), ['a']);
});

// [兼容] 老清单没有 excludeSiblings 字段时，默认不启用
test('excludeSiblings 默认关闭（旧清单不受影响）', () => {
    const pack = validatePack({
        schema: PACK_SCHEMA,
        id: 'sib2',
        name: '旧清单',
        items: [{ id: 'x', name: 'X', text: 'X' }],
    });
    assert.equal(pack.ok, true);
    assert.equal(pack.pack.items[0].excludeSiblings, false);
});

// [组合] 抽中条目后，从来源合集顺带抽一次，填进 {合集名} 占位符
test('组合：条目里的占位符会被来源合集抽到的内容替换', () => {
    const outfit = {
        id: 'compose-outfit',
        name: '连衣裙',
        items: [{ id: 'dress', name: '连衣裙', text: '{颜色}的连衣裙', weight: 1 }],
        pick: 1,
        cooldown: 0,
        compose: ['compose-color'],
    };
    const color = {
        id: 'compose-color',
        name: '颜色',
        items: [{ id: 'white', name: '白色', text: '白色', weight: 1 }],
        pick: 1,
        cooldown: 0,
    };
    const decks = [outfit, color];
    const state = createState('compose-seed', 1);
    const result = drawDeck(state, outfit, { force: true });
    const rendered = applyCompose(state, decks, outfit, result);
    assert.equal(rendered.dress, '白色的连衣裙');
    assert.equal(deckState(state, 'compose-outfit').rendered.dress, '白色的连衣裙');
    // 来源合集自己的 current 不被配套抽取写入
    assert.deepEqual(deckState(state, 'compose-color').current, []);
});

// [组合] 同一轮抽两件，每次都会重新抽来源，结果可以不同
test('组合：同一轮多次抽取会各自配套，互不覆盖', () => {
    const outfit = {
        id: 'compose-2',
        name: '穿搭',
        items: [
            { id: 'coat', name: '外套', text: '{颜色}的外套', weight: 1 },
            { id: 'pants', name: '长裤', text: '{颜色}的长裤', weight: 1 },
        ],
        pick: 1,
        cooldown: 0,
        compose: ['compose-color-2'],
    };
    const color = {
        id: 'compose-color-2',
        name: '颜色',
        items: [
            { id: 'red', name: '红色', text: '红色', weight: 1 },
            { id: 'blue', name: '蓝色', text: '蓝色', weight: 1 },
        ],
        pick: 1,
        cooldown: 0,
    };
    const decks = [outfit, color];
    const seen = new Set();
    for (let i = 0; i < 12; i += 1) {
        const state = createState('compose-multi-' + i, 1);
        const result = drawDeck(state, outfit, { force: true });
        applyCompose(state, decks, outfit, result);
        const text = deckState(state, 'compose-2').rendered[result.ids[0]];
        if (text) {
            seen.add(text);
        }
    }
    assert.ok(seen.has('红色的外套') || seen.has('蓝色的外套'));
    assert.ok(seen.has('红色的长裤') || seen.has('蓝色的长裤'));
});

// [条目冷却] 单条自己设定的冷却优先于合集设置
test('条目冷却：刚抽中的那条在冷却轮数内不再出现', () => {
    const deck = {
        id: 'item-cd',
        name: '冷却测试',
        cooldown: 0,
        pick: 1,
        items: [
            { id: 'a', name: 'A', text: 'A', weight: 1, cooldown: 2 },
            { id: 'b', name: 'B', text: 'B', weight: 1, cooldown: null },
        ],
    };
    const state = createState('item-cd-seed', 1);
    // 不靠抽签决定谁先出现，直接标记 A 在第 1 轮被抽过。
    deckState(state, 'item-cd').itemTurns = { a: 1 };
    const cooled = availableItems(state, deck).map((item) => item.id);
    assert.deepEqual(cooled, ['b'], 'A 在冷却里，池子只剩 B');
    // 到第 3 轮（1 + 2）A 又回到池子里
    state.turn = 3;
    const later = availableItems(state, deck).map((item) => item.id);
    assert.ok(later.includes('a'), '冷却结束后 A 应该回到池子');
});

test('条目冷却：留空时不额外限制，跟合集设置走', () => {
    const deck = {
        id: 'item-cd-2',
        name: '跟随合集',
        cooldown: 0,
        pick: 1,
        items: [
            { id: 'x', name: 'X', text: 'X', weight: 1, cooldown: null },
            { id: 'y', name: 'Y', text: 'Y', weight: 1, cooldown: null },
        ],
    };
    const state = createState('item-cd-2-seed', 1);
    const seen = new Set();
    for (let i = 0; i < 10; i += 1) {
        const result = drawDeck(state, deck, { force: true });
        seen.add(result.ids[0]);
    }
    assert.ok(seen.has('x') || seen.has('y'));
    assert.equal(deckState(state, 'item-cd-2').itemTurns.x !== undefined || deckState(state, 'item-cd-2').itemTurns.y !== undefined, true);
});


section('初始值');
test('勾了初始值的条目会在新聊天里直接生效', () => {
    const deck = {
        id: 'init-a',
        name: '初始柜',
        cooldown: 0,
        pick: 1,
        items: [
            { id: 'a', name: 'A', text: 'A', weight: 1, initial: true },
            { id: 'b', name: 'B', text: 'B', weight: 1, initial: false },
        ],
    };
    const state = createState('init-seed', 1);
    const { applied } = applyInitial(state, deck);
    assert.deepEqual(applied, ['a']);
    assert.deepEqual(deckState(state, 'init-a').current, ['a']);
    assert.equal(state.ledger[state.ledger.length - 1].cause, 'init');
});

test('初始值只应用一次，清空后也不会自己回来', () => {
    const deck = {
        id: 'init-b',
        name: '初始柜二',
        cooldown: 0,
        pick: 1,
        items: [{ id: 'a', name: 'A', text: 'A', weight: 1, initial: true }],
    };
    const state = createState('init-seed-2', 1);
    applyInitial(state, deck);
    deckState(state, 'init-b').current = [];
    const again = applyInitial(state, deck);
    assert.deepEqual(again.applied, []);
    assert.deepEqual(deckState(state, 'init-b').current, []);
});

test('没有初始值的合集保持空', () => {
    const deck = {
        id: 'init-c',
        name: '没有初始',
        cooldown: 0,
        pick: 1,
        items: [{ id: 'a', name: 'A', text: 'A', weight: 1 }],
    };
    const state = createState('init-seed-3', 1);
    const { applied } = applyInitial(state, deck);
    assert.deepEqual(applied, []);
    assert.deepEqual(deckState(state, 'init-c').current, []);
});


section('AI 判定提示');
test('会告诉模型每份清单现在停在哪、后面还有哪些', () => {
    const decks = [
        { id: 'plot', name: '剧情线', enabled: true, trigger: { ai: true } },
        { id: 'bro', name: '师兄线', parent: 'plot', enabled: true, trigger: { ai: false } },
    ];
    const items = {
        plot: [{ id: 'p1', name: '第一章 代婚' }],
        bro: [
            { id: 'b1', name: '第一章 代婚' },
            { id: 'b2', name: '第二章 洞房' },
            { id: 'b3', name: '第三章 三日' },
        ],
    };
    const text = buildDirectorPrompt(decks, '{{decks}}', items, {
        currentByDeck: { bro: ['b1'] },
        done: new Set(['bro::b1']),
    });
    assert.ok(text.includes('师兄线'), 'should list the sub deck');
    assert.ok(text.includes('当前：第一章 代婚'), 'should show current item');
    assert.ok(text.includes('第二章 洞房'), 'should show the next chapter');
    assert.ok(text.includes('要推进它就申请抽「剧情线」'), 'should say which deck to draw');
});

test('没有开启 AI 判定的合集不会出现在提示里', () => {
    const decks = [{ id: 'x', name: '安静', enabled: true, trigger: { ai: false } }];
    const text = buildDirectorPrompt(decks, '{{decks}}', { x: [{ id: 'a', name: 'A' }] }, {});
    assert.equal(text, '');
});


test('已经出现过、或前置没满足的条目，不会混进「现在可以抽」', () => {
    const deck = {
        id: 'dir-deck',
        name: '剧情线',
        enabled: true,
        trigger: { ai: true },
        cooldown: 0,
        pick: 1,
        items: [
            { id: 'a', name: '第一条 代婚', weight: 1, once: true, requires: [], excludes: [], cooldown: null },
            { id: 'b', name: '第二条 洞房', weight: 1, once: true, requires: ['dir-deck::a'], excludes: [], cooldown: null },
            { id: 'c', name: '第三条 三日', weight: 1, once: true, requires: ['dir-deck::b'], excludes: [], cooldown: null },
        ],
    };
    const state = createState('dir-seed', 5);
    state.progress = ['dir-deck::a'];
    state.decks['dir-deck'] = { current: ['a'], recent: ['a'], nonce: 0, lastTurn: 5, lastDecisionTurn: 5, itemTurns: { a: 5 } };
    const text = buildDirectorPrompt([deck], '{{decks}}', { 'dir-deck': deck.items }, {
        currentByDeck: { 'dir-deck': ['a'] },
        done: new Set(state.progress),
        state,
    });
    assert.ok(text.includes('当前：第一条 代婚'), 'should show current');
    assert.ok(text.includes('第二条 洞房'), 'b is available once a appeared');
    assert.ok(!text.includes('现在可以抽：第一条'), 'already appeared item must not be listed as drawable');
    assert.ok(text.includes('还没解锁：第三条 三日'), 'c should be marked locked');
});


test('初始值也会算作「出现过」，后面 requires 它的条目能解锁', () => {
    const deck = {
        id: 'init-chain',
        name: '章节线',
        cooldown: 0,
        pick: 1,
        items: [
            { id: 'p1', name: '第一章', weight: 1, initial: true, once: true, requires: [], excludes: [], cooldown: null },
            { id: 'p2', name: '第二章', weight: 1, once: true, requires: ['init-chain::p1'], excludes: [], cooldown: null },
        ],
    };
    const state = createState('init-chain-seed', 1);
    applyInitial(state, deck);
    assert.ok(state.progress.includes('init-chain::p1'), 'initial item should be recorded in progress');
    const pool = availableItems(state, { ...deck, cooldown: 0 })
        .map((item) => item.id);
    assert.ok(pool.includes('p2'), 'p2 should be unlocked after p1 initial');
});


section('楼层回退');
test('删楼后当前值跟着回到那一层', () => {
    const deck = {
        id: 'rb',
        name: '回退测试',
        cooldown: 0,
        pick: 1,
        items: [
            { id: 'a', name: 'A', text: 'A', weight: 1 },
            { id: 'b', name: 'B', text: 'B', weight: 1 },
        ],
    };
    const state = createState('rb-seed', 5);
    const ds = deckState(state, 'rb');
    ds.current = ['a'];
    captureFrame(state);
    syncTurn(state, 7);
    drawDeck(state, deck, { force: true });
    captureFrame(state);
    assert.ok(deckState(state, 'rb').current.length === 1);
    syncTurn(state, 5);
    assert.deepEqual(deckState(state, 'rb').current, ['a']);
});

test('回退后进度也一起回退，一次性条目可以重新抽到', () => {
    const deck = {
        id: 'rb2',
        name: '回退进度',
        cooldown: 0,
        pick: 1,
        items: [{ id: 'x', name: 'X', text: 'X', weight: 1 }],
    };
    const state = createState('rb-seed-2', 3);
    captureFrame(state);
    syncTurn(state, 6);
    const r = drawDeck(state, deck, { force: true });
    captureFrame(state);
    assert.equal(state.progress.length, 1);
    syncTurn(state, 3);
    assert.deepEqual(state.progress, []);
    assert.ok(r.changed);
});


section('按游戏内天数冷却');
test('能解析「年月日」，认不出就返回 null', () => {
    assert.equal(parseGameDay('天元482年7月15日'), 482 * 360 + 6 * 30 + 14);
    assert.equal(parseGameDay('没有日期'), null);
    assert.equal(gameDayFromVariables({ stat_data: { 世界变量: { 当前日期: '天元482年7月15日' } } }), 482 * 360 + 6 * 30 + 14);
});

test('按天冷却：没到天数就抽不到，到了就能抽', () => {
    const deck = {
        id: 'day-deck',
        name: '按天',
        cooldown: 3,
        timeUnit: 'day',
        pick: 1,
        items: [{ id: 'a', name: 'A', text: 'A', weight: 1 }],
    };
    const state = createState('day-seed', 1);
    const ds = deckState(state, 'day-deck');
    state.gameDay = 100;
    ds.gameDay = 98;
    assert.deepEqual(availableItems(state, deck), []);
    ds.gameDay = 90;
    assert.equal(availableItems(state, deck).length, 1);
});


test('按天持续：到天数就清空', () => {
    const state = createState('hold-days-seed', 10);
    state.turn = 10;
    state.gameDay = 5;
    const deck = makeDeck({ hold: { mode: 'days', days: 2 }, cooldown: 0 });
    drawDeck(state, deck, { force: true });
    assert.equal(expireIfDue(state, deck), false);
    state.gameDay = 7;
    assert.equal(expireIfDue(state, deck), true);
    assert.deepEqual(deckState(state, deck.id).current, []);
});


test('条目自己的持续时长优先于合集设置', () => {
    const state = createState('item-hold-seed', 10);
    state.turn = 10;
    state.gameDay = 1;
    const deck = makeDeck({
        cooldown: 0,
        hold: { mode: 'turns', turns: 5 },
        items: [
            { id: 'a', name: 'A', text: 'A', weight: 1, hold: { mode: 'turns', turns: 1 } },
        ],
    });
    drawDeck(state, deck, { force: true });
    assert.equal(deckState(state, deck.id).hold.mode, 'turns');
    assert.equal(deckState(state, deck.id).hold.turns, 1);
    state.turn = 11;
    assert.equal(expireIfDue(state, deck), true);
});


section('动态权重');
function fatigueDeck(extra = {}) {
    return {
        id: 'fat-1',
        name: '权重柜',
        cooldown: 0,
        pick: 1,
        items: [
            { id: 'a', name: 'A', text: 'A', weight: 1, fatigue: { mode: 'decay', everyTurns: 3, amount: 10, ratio: false, floorPercent: 1, recoverTurns: 5, maxPercent: 300 } },
            { id: 'b', name: 'B', text: 'B', weight: 1, fatigue: { mode: 'boost', everyTurns: 2, amount: 20, ratio: false, floorPercent: 1, recoverTurns: 5, maxPercent: 300 } },
        ],
        ...extra,
    };
}

test('降权：连续抽中会累计往下掉', () => {
    const deck = fatigueDeck();
    const state = createState('fat-seed', 1);
    const ds = deckState(state, 'fat-1');
    ds.fatigue = {};
    const item = deck.items[0];
    state.turn = 1;
    applyFatigueOnHit(state, deck, [item]);
    assert.equal(Math.round(effectiveWeight(state, deck, item, ds, 2) * 100), 90);
    state.turn = 2;
    applyFatigueOnHit(state, deck, [item]);
    assert.equal(Math.round(effectiveWeight(state, deck, item, ds, 3) * 100), 80);
});

test('降权：掉到下限以下进冷却，冷却结束回到 100%', () => {
    const deck = fatigueDeck();
    const state = createState('fat-seed-2', 1);
    const ds = deckState(state, 'fat-1');
    ds.fatigue = {};
    const item = deck.items[0];
    ds.fatigue[item.id] = { mult: 0.005, lastHit: 1, cooledUntil: -1 };
    state.turn = 2;
    applyFatigueOnHit(state, deck, [item]);
    assert.ok(Number(ds.fatigue[item.id].cooledUntil) > 2);
    assert.equal(effectiveWeight(state, deck, item, ds, 3), 0);
    assert.equal(effectiveWeight(state, deck, item, ds, 99), 1);
});

test('增权：隔几轮没抽中就往上加，抽中后回到 100%', () => {
    const deck = fatigueDeck();
    const state = createState('fat-seed-3', 1);
    const ds = deckState(state, 'fat-1');
    ds.fatigue = {};
    const item = deck.items[1];
    state.turn = 1;
    applyFatigueOnHit(state, deck, [item]);
    assert.equal(Math.round(effectiveWeight(state, deck, item, ds, 3) * 100), 120);
    assert.equal(Math.round(effectiveWeight(state, deck, item, ds, 5) * 100), 140);
    state.turn = 6;
    applyFatigueOnHit(state, deck, [item]);
    assert.equal(Math.round(effectiveWeight(state, deck, item, ds, 7) * 100), 100);
});

test('动态权重会乘到实际抽签权重上', () => {
    const deck = fatigueDeck();
    const state = createState('fat-seed-4', 1);
    const ds = deckState(state, 'fat-1');
    ds.fatigue = {};
    state.turn = 5;
    ds.fatigue.a = { mult: 0.1, lastHit: 1, cooledUntil: -1 };
    const pool = availableItems(state, deck);
    const a = pool.find((item) => item.id === 'a');
    assert.equal(Math.round(a.weight * 100), 10);
});


section('持续期内不再抽下一次');
test('内容还在持续里时，自动抽取会被挡住', () => {
    const deck = {
        id: 'hold-a',
        name: '持续柜',
        cooldown: 0,
        pick: 1,
        items: [{ id: 'a', name: 'A', text: 'A', weight: 1, hold: { mode: 'turns', turns: 3 } }],
    };
    const state = createState('hold-seed', 10);
    const first = drawDeckTree(state, [deck], 'hold-a', { force: true });
    assert.equal(first.ok, true);
    assert.equal(holdActive(state, deck), true);
    state.turn = 11;
    const blocked = drawDeckTree(state, [deck], 'hold-a', {});
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'holding');
    const forced = drawDeckTree(state, [deck], 'hold-a', { ignoreHold: true, force: true });
    assert.equal(forced.ok, true);
});

test('持续结束（按轮数到期）之后可以再抽', () => {
    const deck = {
        id: 'hold-b',
        name: '持续柜二',
        cooldown: 0,
        pick: 1,
        items: [{ id: 'a', name: 'A', text: 'A', weight: 1, hold: { mode: 'turns', turns: 1 } }],
    };
    const state = createState('hold-seed-2', 20);
    drawDeckTree(state, [deck], 'hold-b', { force: true });
    assert.equal(holdActive(state, deck), true);
    state.turn = 21;
    expireIfDue(state, deck);
    assert.equal(holdActive(state, deck), false);
    const again = drawDeckTree(state, [deck], 'hold-b', {});
    assert.equal(again.ok, true);
});


section('AI 结束模式：没写结束就保持原样');
test('由 AI 结束的条目，没收到结束标记时不会被换掉', () => {
    const deck = {
        id: 'aihold-a',
        name: 'AI 持有柜',
        cooldown: 0,
        pick: 1,
        items: [{ id: 'a', name: 'A', text: 'A', weight: 1, hold: { mode: 'ai' } }],
    };
    const state = createState('aihold-seed', 30);
    const first = drawDeckTree(state, [deck], 'aihold-a', { force: true });
    assert.equal(first.ok, true);
    assert.equal(holdActive(state, deck), true);
    state.turn = 31;
    const blocked = drawDeckTree(state, [deck], 'aihold-a', {});
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'holding');
    // 收到结束标记后清空，就可以再抽
    endHold(state, deck, 'ai-end');
    assert.equal(holdActive(state, deck), false);
    const again = drawDeckTree(state, [deck], 'aihold-a', {});
    assert.equal(again.ok, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
