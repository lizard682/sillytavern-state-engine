/**
 * 离线自测：node tools/selftest.mjs
 * 只测纯逻辑（包校验 / 抽签 / 冷却 / 随机流），不碰浏览器。
 */

import assert from 'node:assert/strict';
import { validatePack, serializePack, normalizeKeywords, DEFAULT_TRIGGER } from '../src/pack.js';
import { createState, drawDeck, drawDeckTree, deckState, clearDeckHistory, pickWithRng, syncTurn, expireIfDue, endHold } from '../src/state.js';
import { createRng, hashSeed } from '../src/rng.js';

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
    assert.equal(result.pack.schema, 4);
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
    assert.equal(result.pack.schema, 4);
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
    assert.equal(out.schema, 4);
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

section('持续时长');
test('hold 默认是永久，旧数据会被补齐', () => {
    const deck = makeDeck();
    assert.deepEqual(deck.hold, { mode: 'forever', turns: 3 });
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
