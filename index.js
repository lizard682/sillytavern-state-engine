/**
 * 状态引擎（State Engine）
 *
 * 一个「清单抽签」框架：创作者在面板里建合集、写条目，插件负责挑一个、
 * 记住挑过什么、并在生成前把条目内容直接注入上下文。插件本身不含内容。
 */

import {
    DEFAULT_AI_TEMPLATE,
    DIRECTOR_KEY,
    PROMPT_POSITION,
    PROMPT_ROLE,
    buildDirectorPrompt,
    clearInjections,
    injectDeck,
    promptKey,
} from './src/inject.js';
import {
    DEFAULT_BINDING,
    DEFAULT_HOLD,
    DEFAULT_INJECT,
    DEFAULT_RECURSION,
    DEFAULT_SCAN,
    DEFAULT_TRIGGER,
    SCAN_FIELDS,
    normalizeKeywords,
    serializePack,
    validatePack,
} from './src/pack.js';
import {
    clearDeckHistory,
    createState,
    currentItems,
    deckState,
    drawDeck,
    endHold,
    expireIfDue,
    hasCurrent,
    resetDeckState,
    syncTurn,
} from './src/state.js';
import { formatLedger } from './src/ledger.js';
import { freshSeed } from './src/rng.js';

const SETTINGS_KEY = 'stateEngine';
const STORE_KEY = 'stateEngine';

const SCAN_LABELS = {
    description: '角色描述',
    personality: '角色性格',
    scenario: '情景',
    persona: '用户设定',
    notes: '角色备注',
    lorebook: '世界书',
};
const TRIGGER_RE = /<!--\s*SE:([a-zA-Z0-9_-]{1,64})\s*-->/g;
const END_RE = /<!--\s*SE-END:([a-zA-Z0-9_-]{1,64})\s*-->/g;
const PANEL_ID = 'state-engine-panel';
const BUTTON_ID = 'state-engine-button';

let context;
let settings = { enabled: true, aiTemplate: DEFAULT_AI_TEMPLATE, aiDepth: 4 };
let selectedDeckId = null;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function liveContext() {
    return globalThis.SillyTavern?.getContext?.() || context;
}

function toast(kind, message) {
    try {
        const fn = globalThis.toastr?.[kind];
        if (typeof fn === 'function') {
            fn(message);
        } else {
            console.log('[state-engine]', message);
        }
    } catch {
        /* toastr 不可用就算了 */
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function saveSettings() {
    const ctx = liveContext();
    if (!ctx?.extensionSettings) {
        return;
    }
    ctx.extensionSettings[SETTINGS_KEY] = settings;
    ctx.saveSettingsDebounced?.();
}

// ---------------------------------------------------------------------------
// 存储：合集内容 + 运行时状态都跟着聊天走
// ---------------------------------------------------------------------------

/** 把任意旧版合集补成当前形状（不动内容）。 */
function normalizeDeckShape(deck) {
    if (!deck || typeof deck !== 'object') {
        return deck;
    }
    if (!deck.binding) {
        deck.binding = { ...DEFAULT_BINDING };
    }
    if (!deck.trigger) {
        deck.trigger = { ...DEFAULT_TRIGGER };
    }
    if (!Array.isArray(deck.keywords)) {
        deck.keywords = [];
    }
    if (!deck.scan) {
        deck.scan = { ...DEFAULT_SCAN };
    } else if (!Array.isArray(deck.scan.fields)) {
        deck.scan.fields = [];
    }
    if (!deck.recursion) {
        deck.recursion = { ...DEFAULT_RECURSION };
    }
    if (!deck.hold) {
        deck.hold = { ...DEFAULT_HOLD };
    } else {
        if (!['turns', 'forever', 'ai'].includes(deck.hold.mode)) {
            deck.hold.mode = DEFAULT_HOLD.mode;
        }
        const turns = Number(deck.hold.turns);
        deck.hold.turns = Number.isFinite(turns) ? Math.max(1, Math.floor(turns)) : DEFAULT_HOLD.turns;
    }
    if (!deck.inject) {
        deck.inject = { ...DEFAULT_INJECT };
    }
    if (typeof deck.enabled !== 'boolean') {
        deck.enabled = true;
    }
    if (!Array.isArray(deck.items)) {
        deck.items = [];
    }
    deck.items.forEach((item) => {
        if (item && typeof item === 'object') {
            // JSON 里 Infinity 会被写成 null，读回来要当默认权重，不能让条目静默消失。
            const weight = Number(item.weight);
            item.weight = Number.isFinite(weight) ? Math.max(0, weight) : 1;
            delete item.situation;
        }
    });
    // 旧字段：类型/归属/字数预算/道具概率，已经不再使用。
    for (const key of ['type', 'owner', 'budget', 'useChance', 'auto', 'autoEvery', 'marker']) {
        delete deck[key];
    }
    return deck;
}

/** 旧聊天里可能缺字段（seed/turn/ledger/markerFloor），读的时候补齐，避免 NaN 静默失效。 */
function ensureStateShape(state, ctx) {
    if (!state || typeof state !== 'object') {
        return createState(undefined, ctx?.chat?.length ?? 0);
    }
    if (!state.seed) {
        state.seed = freshSeed();
    }
    if (!Array.isArray(state.ledger)) {
        state.ledger = [];
    }
    if (!state.decks || typeof state.decks !== 'object') {
        state.decks = {};
    }
    if (!Number.isFinite(Number(state.turn))) {
        state.turn = Number.isFinite(Number(ctx?.chat?.length)) ? Number(ctx.chat.length) : 0;
    }
    if (!Number.isFinite(Number(state.markerFloor))) {
        state.markerFloor = -1;
    }
    return state;
}

function getStore({ create = false } = {}) {
    const ctx = liveContext();
    const md = ctx?.chatMetadata;
    if (!md) {
        return null;
    }
    const current = md[STORE_KEY];
    const valid = current && Array.isArray(current.decks) && current.state && typeof current.state === 'object';
    if (valid) {
        current.decks.forEach(normalizeDeckShape);
        ensureStateShape(current.state, ctx);
        return current;
    }
    if (!create && !ctx?.chatId) {
        return null;
    }
    md[STORE_KEY] = {
        schema: 2,
        decks: [],
        state: createState(undefined, ctx.chat?.length ?? 0),
    };
    return md[STORE_KEY];
}

/**
 * 默认用 debounce（高频字段编辑不必每次都写盘）；
 * 抽签/导入/删除这类一次性动作传 immediate，避免刚点完就切聊天导致丢状态。
 */
function saveStore({ immediate = false } = {}) {
    const ctx = liveContext();
    if (immediate) {
        ctx?.saveMetadata?.();
    } else {
        ctx?.saveMetadataDebounced?.();
    }
}

function getDecks() {
    return getStore()?.decks || [];
}

function deckById(id) {
    return getDecks().find((deck) => deck.id === id) || null;
}

// ---------------------------------------------------------------------------
// MVU 检测：从角色卡世界书的 [InitVar] 条目里找角色名
// ---------------------------------------------------------------------------

const MVU_SKIP_KEYS = /^(世界|世界变量|全局变量|公共变量|系统变量|世界观|世界设定|环境|时间|地点|系统|用户|user|用户身份|user身份|USER身份|当前玩家|剧情|变量|stat_data|game|world|meta|config)$/i;

/** 有些卡把变量包一层（stat_data / 变量数据），角色名在它下面一层。 */
const MVU_WRAPPER_KEYS = /^(stat_data|变量数据|变量表|数据|角色变量|世界书变量|变量)$/i;

/** MVU 里常见但显然不是角色名的顶层键（关系表、日记、背包之类）。 */
const MVU_NON_CHARACTER = /^(人际关系|人物关系|关系|关系网|联系人|日记|日记条目|日志|笔记|记忆|变量列表|物品|道具|背包|装备|任务|事件|地图|剧情|设置|规则|说明|提示|选项|状态|属性|技能|技能列表|金钱|时间线|档案|好感|数值|npc|npc列表|敌人|怪物|全局|全局时间|日期|当前日期|时间|地点|当前地点|天气|筹码|风气|消息|传闻|势力|势力版图|近期事件|暗流|排行榜|系统|系统日志|世界|世界变量|天机|天命之子|主角|玩家|旁白|风格|癖好|玩法|设定|开局|初始化)$/i;

/** 尽力从一段 JSON 文本里取出顶层键（容忍尾逗号、注释、单引号）。 */
function topLevelKeys(text) {
    const source = String(text || '');
    try {
        const parsed = JSON.parse(source);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return Object.keys(parsed);
        }
    } catch {
        // 解析不了就用深度扫描兜底（只认第一层的键，避免把 信任度/日期 这类嵌套字段当成角色名）。
    }

    const out = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < source.length; i += 1) {
        const ch = source[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
                if (depth === 1 && start >= 0) {
                    let j = i + 1;
                    while (j < source.length && /\s/.test(source[j])) {
                        j += 1;
                    }
                    if (source[j] === ':') {
                        const key = source.slice(start + 1, i);
                        if (key && !out.includes(key)) {
                            out.push(key);
                        }
                    }
                }
                start = -1;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            start = i;
        } else if (ch === '{' || ch === '[') {
            depth += 1;
        } else if (ch === '}' || ch === ']') {
            depth -= 1;
        }
    }
    return out;
}

/** 从一个对象的第一层里挑出像角色名的键（值必须是对象）。 */
function characterKeysFromObject(root) {
    const out = [];
    if (!root || typeof root !== 'object' || Array.isArray(root)) {
        return out;
    }
    for (const key of Object.keys(root)) {
        const value = root[key];
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            continue;
        }
        if (MVU_SKIP_KEYS.test(key) || MVU_NON_CHARACTER.test(key) || key.length > 4) {
            continue;
        }
        out.push(key);
    }
    return out;
}

/** 从一份 MVU 变量对象里取角色名：有的卡顶层就是角色，有的包在 stat_data 里。 */
function mvuNamesFromVariables(vars) {
    if (Array.isArray(vars)) {
        for (const item of vars) {
            const names = mvuNamesFromVariables(item);
            if (names.length) {
                return names;
            }
        }
        return [];
    }
    if (!vars || typeof vars !== 'object') {
        return [];
    }
    if (vars.stat_data && typeof vars.stat_data === 'object') {
        return characterKeysFromObject(vars.stat_data);
    }
    return characterKeysFromObject(vars);
}

/** 有些卡的 [InitVar] 写的是 YAML（不是 JSON），按缩进只取顶层/包裹层下一层的键。 */
function yamlNames(text) {
    const lines = String(text || '').split(/\r?\n/);
    const entries = [];
    for (const line of lines) {
        const match = /^(\s*)([^\s#-][^:]{0,40}):(?:\s|$)/.exec(line);
        if (match) {
            entries.push({ indent: match[1].length, key: match[2].trim() });
        }
    }
    if (!entries.length) {
        return [];
    }
    const rootIndent = Math.min(...entries.map((entry) => entry.indent));
    const isName = (key) => !MVU_SKIP_KEYS.test(key) && !MVU_NON_CHARACTER.test(key) && key.length <= 4;
    const hasChildren = (index) => {
        const indent = entries[index].indent;
        for (let i = index + 1; i < entries.length; i += 1) {
            if (entries[i].indent <= indent) {
                return false;
            }
            return true;
        }
        return false;
    };
    const objectRoots = entries
        .map((entry, index) => ({ entry, index }))
        .filter((item) => item.entry.indent === rootIndent && hasChildren(item.index));
    const wrapper = objectRoots.find((item) => MVU_WRAPPER_KEYS.test(item.entry.key));
    if (wrapper) {
        const deeper = entries
            .map((entry, index) => ({ entry, index }))
            .filter((item) => item.entry.indent > rootIndent);
        if (deeper.length) {
            const childIndent = Math.min(...deeper.map((item) => item.entry.indent));
            return deeper
                .filter((item) => item.entry.indent === childIndent && hasChildren(item.index) && isName(item.entry.key))
                .map((item) => item.entry.key);
        }
        return [];
    }
    return objectRoots.filter((item) => isName(item.entry.key)).map((item) => item.entry.key);
}

/** 返回当前角色卡里登记过 MVU 的角色名列表。 */
export function detectMvuNames(ctx = liveContext()) {
    const names = new Set();

    // 1) 优先读当前聊天的实际变量（比世界书模板更准）。
    try {
        const chatVars = ctx?.chatMetadata?.variables;
        for (const name of mvuNamesFromVariables(chatVars)) {
            names.add(name);
        }
        const chat = ctx?.chat || [];
        for (let i = chat.length - 1; i >= 0 && i >= chat.length - 5; i -= 1) {
            const msgVars = chat[i]?.variables;
            if (msgVars && typeof msgVars === 'object') {
                for (const name of mvuNamesFromVariables(msgVars)) {
                    names.add(name);
                }
                if (names.size > 0) {
                    break;
                }
            }
        }
    } catch {
        // 读变量失败不影响后面的世界书扫描。
    }

    // 2) 再从角色卡世界书的 [InitVar] 条目里找（兼容顶层直接是角色名或包一层 stat_data）。
    const ch = ctx?.characters?.[ctx.characterId] || null;
    const entries = ch?.data?.character_book?.entries || [];
    for (const entry of entries) {
        const comment = String(entry?.comment || '');
        const content = String(entry?.content || '');
        if (!/\[initvar\]/i.test(comment) && !/\[initvar\]/i.test(content.slice(0, 200))) {
            continue;
        }
        let parsed = null;
        try {
            parsed = JSON.parse(content);
        } catch {
            parsed = null;
        }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const name of mvuNamesFromVariables(parsed)) {
                names.add(name);
            }
            continue;
        }
        // 解析不了就退回 YAML 键扫描，再退回深度扫描，只认第一层的键。
        const yaml = yamlNames(content);
        if (yaml.length) {
            for (const name of yaml) {
                names.add(name);
            }
            continue;
        }
        for (const key of topLevelKeys(content)) {
            if (!MVU_SKIP_KEYS.test(key) && !MVU_NON_CHARACTER.test(key) && key.length <= 4) {
                names.add(key);
            }
        }
    }
    return [...names];
}

/** 当前对话里的角色名（没注册 MVU 也能用）。 */
function currentCharacterName(ctx = liveContext()) {
    return ctx?.name2 || ctx?.characters?.[ctx.characterId]?.name || '';
}

// ---------------------------------------------------------------------------
// 注入
// ---------------------------------------------------------------------------

/** 合集是否绑定了一个当前不在场的角色。extraText 是本轮尚未进入聊天记录的输入。 */
function bindingActive(deck, ctx, extraText = '') {
    const binding = deck.binding || DEFAULT_BINDING;
    if (!binding.name || binding.type === 'none') {
        return true;
    }
    // 绑定角色：最近 10 条消息里出现过这个名字才生效，避免给 A 抽 B 的衣服。
    const recent = (ctx?.chat || []).slice(-10).map((msg) => String(msg.mes || '')).join('\n');
    return `${recent}\n${extraText}`.includes(binding.name);
}

function refreshInjections() {
    const ctx = liveContext();
    const store = getStore();
    if (!ctx?.setExtensionPrompt) {
        return;
    }
    if (!settings.enabled || !store) {
        clearInjections(ctx, store?.decks || []);
        updateInjectPreview();
        return;
    }
    for (const deck of store.decks) {
        if (deck.enabled === false || !bindingActive(deck, ctx)) {
            ctx.setExtensionPrompt(promptKey(deck.id), '', PROMPT_POSITION.chat, 0, false, PROMPT_ROLE.system);
            continue;
        }
        injectDeck(ctx, deck, currentItems(store.state, deck));
    }
    // 已经删除的合集，把残留的注入键清掉。
    const alive = new Set(store.decks.map((deck) => promptKey(deck.id)));
    for (const key of Object.keys(ctx.extensionPrompts || {})) {
        if (key.startsWith('stateEngine:deck:') && !alive.has(key)) {
            ctx.setExtensionPrompt(key, '', 0, 0, false, 0);
        }
    }
    // 导演提示只列此刻真的会生效的合集：绑定角色不在场就别让模型白申请。
    const directorDecks = store.decks.filter((deck) => deck.enabled !== false && bindingActive(deck, ctx));
    const itemsByDeck = Object.fromEntries(store.decks.map((deck) => [deck.id, Array.isArray(deck.items) ? deck.items : []]));
    const director = buildDirectorPrompt(directorDecks, settings.aiTemplate, itemsByDeck);
    const aiDepth = Math.max(0, Number(settings.aiDepth) || 4);
    ctx.setExtensionPrompt(DIRECTOR_KEY, director, PROMPT_POSITION.chat, aiDepth, false, PROMPT_ROLE.system);
    updateInjectPreview();
}

/**
 * 把当前真正挂在 extensionPrompts 上的内容展示出来。
 * 用户不用去翻后台，就能确认「插件到底发了什么给 AI」。
 */
function updateInjectPreview() {
    const panel = document.getElementById(PANEL_ID);
    const pre = panel?.querySelector('#se-inject-preview');
    if (!pre) {
        return;
    }
    const ctx = liveContext();
    const store = getStore();
    if (!store || !store.decks.length) {
        pre.textContent = '还没有合集。先新建或导入一个。';
        return;
    }
    const blocks = [];
    for (const deck of store.decks) {
        if (deck.enabled === false) {
            continue;
        }
        const prompt = ctx?.extensionPrompts?.[promptKey(deck.id)];
        const text = String(prompt?.value || '').trim();
        const inactive = bindingActive(deck, ctx) ? '' : '\n（绑定角色不在场，本轮不生效）';
        if (text) {
            blocks.push(`${text}${inactive}`);
        } else {
            blocks.push(`【${deck.name}】\n（还没抽中内容，点「抽一次」或等触发）${inactive}`);
        }
    }
    const director = String(ctx?.extensionPrompts?.[DIRECTOR_KEY]?.value || '').trim();
    if (director) {
        blocks.push(`【AI 判定提示】（有合集开了「AI 判定」，这段说明会跟着一起发）\n${director}`);
    }
    pre.textContent = blocks.join('\n\n') || '（空）';
}

// ---------------------------------------------------------------------------
// 触发
// ---------------------------------------------------------------------------

function markersInLastAiMessage() {
    const ctx = liveContext();
    const chat = ctx?.chat || [];
    const last = chat[chat.length - 1];
    if (!last || last.is_user || last.is_system) {
        return [];
    }
    const text = String(last.mes || '');
    const ids = [];
    for (const match of text.matchAll(TRIGGER_RE)) {
        ids.push(match[1]);
    }
    return [...new Set(ids)];
}

/** 模型主动喊停：<!--SE-END:合集id-->（合集 hold.mode === 'ai' 时用）。 */
function endMarkersInLastAiMessage() {
    const ctx = liveContext();
    const chat = ctx?.chat || [];
    const last = chat[chat.length - 1];
    if (!last || last.is_user || last.is_system) {
        return [];
    }
    const text = String(last.mes || '');
    const ids = [];
    for (const match of text.matchAll(END_RE)) {
        ids.push(match[1]);
    }
    return [...new Set(ids)];
}

function keywordHit(text, keyword) {
    const kw = String(keyword || '').trim();
    if (!kw || kw.length > 120) {
        return false;
    }
    // /正则/ 写法；长度受控，避免导入的包拿灾难性回溯卡住页面。
    if (kw.length > 2 && kw.startsWith('/') && kw.endsWith('/')) {
        try {
            return new RegExp(kw.slice(1, -1), 'i').test(text);
        } catch {
            return false;
        }
    }
    return text.toLowerCase().includes(kw.toLowerCase());
}

/** 从角色卡/用户设定/世界书里取一段文本（按创作者勾选的来源）。 */
function scanFieldText(scan, ctx) {
    const fields = Array.isArray(scan?.fields) ? scan.fields : [];
    if (fields.length === 0) {
        return '';
    }
    const char = ctx?.characters?.[ctx?.characterId];
    const parts = [];
    if (fields.includes('description')) parts.push(char?.description || '');
    if (fields.includes('personality')) parts.push(char?.personality || '');
    if (fields.includes('scenario')) parts.push(char?.scenario || '');
    if (fields.includes('persona')) parts.push(ctx?.powerUserSettings?.persona_description || '');
    if (fields.includes('notes')) parts.push(char?.data?.creator_notes || char?.creator_notes || '');
    if (fields.includes('lorebook')) {
        const entries = char?.data?.character_book?.entries || [];
        for (const entry of entries) {
            parts.push(`${entry?.comment || ''}\n${entry?.content || ''}`);
        }
    }
    return parts.join('\n');
}

/**
 * 关键词触发：按合集的扫描设置看最近几条消息，以及创作者勾选的角色信息。
 * 返回 { hit, msgIndex }：msgIndex 是命中消息在 chat 里的下标；
 * 本轮还没落盘的用户输入记成 chat.length（下一轮它落盘后下标相同，用来去重）；
 * 静态来源（角色描述等）记成 -2，靠 ds.keywordFieldFired 只触发一次。
 */
function matchDeckKeywords(deck, ctx, extraText = '') {
    const keywords = deck.keywords || [];
    if (keywords.length === 0) {
        return { hit: false, msgIndex: -1 };
    }
    const scan = deck.scan || DEFAULT_SCAN;
    const chat = ctx?.chat || [];
    const depth = Number(scan.depth) || 0;
    const start = depth > 0 ? Math.max(0, chat.length - depth) : 0;
    for (let i = start; i < chat.length; i += 1) {
        const msg = chat[i];
        if (!msg || msg.is_system) {
            continue;
        }
        if (scan.source === 'user' && !msg.is_user) {
            continue;
        }
        if (scan.source === 'ai' && msg.is_user) {
            continue;
        }
        if (keywords.some((kw) => keywordHit(String(msg.mes || ''), kw))) {
            return { hit: true, msgIndex: i };
        }
    }
    // 普通发送时 GENERATION_STARTED 早于消息写入聊天，所以本轮输入要单独看一眼。
    if (extraText && scan.source !== 'ai' && keywords.some((kw) => keywordHit(extraText, kw))) {
        return { hit: true, msgIndex: chat.length };
    }
    const fieldText = scanFieldText(scan, ctx);
    if (fieldText && keywords.some((kw) => keywordHit(fieldText, kw))) {
        return { hit: true, msgIndex: -2 };
    }
    return { hit: false, msgIndex: -1 };
}

/**
 * 生成开始时的推进：
 * 1. 楼层自动：到点了就抽；
 * 2. 关键词：最近消息里命中词就抽；
 * 3. AI 判定：上一条 AI 消息申请了标记就抽；
 * 4. 重新注入当前值。
 */
function advanceOnGeneration() {
    const store = getStore({ create: true });
    if (!store) {
        return;
    }
    const ctx = liveContext();
    syncTurn(store.state, ctx?.chat?.length ?? 0);
    const floor = store.state.turn;

    if (!settings.enabled) {
        refreshInjections();
        return;
    }

    // 普通发送时，用户这句话还没进聊天记录，单独取出来参与关键词/绑定判断。
    const pendingInput = String(document.getElementById('send_textarea')?.value || '').trim();

    // 标记只处理一次（同一个楼层）。
    const markers = markersInLastAiMessage();
    const markerFloor = Number(store.state.markerFloor ?? -1);
    const freshMarkers = markers.length > 0 && markerFloor !== floor ? markers : [];
    const fired = [];

    // 按「持续多久」的设定，过期内容先清掉，后面的抽签才会补新的。
    for (const deck of store.decks) {
        if (deck.enabled !== false) {
            expireIfDue(store.state, deck);
        }
    }
    // 模型主动喊停的内容。
    const endMarkers = endMarkersInLastAiMessage();
    if (endMarkers.length > 0 && markerFloor !== floor) {
        for (const deck of store.decks) {
            if (deck.enabled !== false && endMarkers.includes(deck.id)) {
                endHold(store.state, deck);
            }
        }
    }

    for (const deck of store.decks) {
        if (deck.enabled === false || !bindingActive(deck, ctx, pendingInput)) {
            continue;
        }
        // 「只在递归阶段激活」的合集，普通触发时跳过。
        if ((deck.recursion || DEFAULT_RECURSION).delay === true) {
            continue;
        }
        const trigger = deck.trigger || DEFAULT_TRIGGER;
        const ds = deckState(store.state, deck.id);
        const dueAuto = trigger.auto === true
            && (floor - Number(ds.lastTurn ?? -1) >= Math.max(1, Number(trigger.autoEvery) || 3));
        const keywordResult = trigger.keyword === true
            ? matchDeckKeywords(deck, ctx, pendingInput)
            : { hit: false, msgIndex: -1 };
        const dueKeyword = keywordResult.hit && (keywordResult.msgIndex === -2
            ? ds.keywordFieldFired !== true
            : keywordResult.msgIndex > Number(ds.keywordMsgIndex ?? -1));
        const dueMarker = trigger.ai === true && freshMarkers.includes(deck.id);
        if (!dueAuto && !dueKeyword && !dueMarker) {
            continue;
        }
        // 自动/关键词/AI 都不是「用户主动要换」，同楼重生成要沿用上次结论。
        const result = drawDeck(store.state, deck, {
            force: false,
            cause: dueMarker ? 'ai' : dueKeyword ? 'keyword' : 'auto',
        });
        if (result.changed) {
            if (dueKeyword) {
                if (keywordResult.msgIndex === -2) {
                    ds.keywordFieldFired = true;
                } else {
                    ds.keywordMsgIndex = keywordResult.msgIndex;
                }
            }
            fired.push(deck.id);
        }
    }

    // 递归：只让「抽中后继续叫醒别的合集」的合集作为起点，最多三层。
    const MAX_RECURSION_ROUNDS = 3;
    const visited = new Set(fired);
    let frontier = fired.filter((id) => {
        const deck = store.decks.find((item) => item.id === id);
        return (deck?.recursion || DEFAULT_RECURSION).canRecurse === true;
    });
    for (let round = 0; round < MAX_RECURSION_ROUNDS && frontier.length > 0; round += 1) {
        const sourceText = frontier.map((id) => {
            const target = store.decks.find((deck) => deck.id === id);
            return target ? currentItems(store.state, target).map((item) => item.text).join('\n') : '';
        }).join('\n');
        const nextFrontier = [];
        for (const deck of store.decks) {
            if (visited.has(deck.id) || deck.enabled === false || !bindingActive(deck, ctx)) {
                continue;
            }
            const recursion = deck.recursion || DEFAULT_RECURSION;
            if (recursion.canBeRecursed === false) {
                continue;
            }
            if (deck.trigger?.keyword !== true || (deck.keywords || []).length === 0) {
                continue;
            }
            if (!deck.keywords.some((kw) => keywordHit(sourceText, kw))) {
                continue;
            }
            drawDeck(store.state, deck, { force: false, cause: 'recursive' });
            visited.add(deck.id);
            if (recursion.canRecurse === true) {
                nextFrontier.push(deck.id);
            }
        }
        frontier = nextFrontier;
    }
    if (freshMarkers.length > 0) {
        store.state.markerFloor = floor;
    }

    saveStore({ immediate: fired.length > 0 });
    refreshInjections();
    refreshPanelLight();
}

// ---------------------------------------------------------------------------
// 合集操作
// ---------------------------------------------------------------------------

function drawOne(deckId, { reroll = false } = {}) {
    if (!liveContext()?.chatId) {
        toast('warning', '先打开一个聊天，再抽合集。');
        return null;
    }
    const store = getStore({ create: true });
    const deck = store?.decks.find((item) => item.id === deckId);
    if (!store || !deck) {
        return null;
    }
    const ds = deckState(store.state, deckId);
    // 每按一次「抽/重抽」都推进一期随机流：同楼层同一个 nonce 只会得到同一个结果。
    ds.nonce = (Number(ds.nonce) || 0) + 1;
    const result = drawDeck(store.state, deck, { force: true, cause: reroll ? 'reroll' : 'manual' });
    saveStore({ immediate: true });
    refreshInjections();
    refreshPanelLight();
    return result;
}

function uniqueDeckId(base) {
    const decks = getDecks();
    let id = base || 'deck';
    let n = 2;
    while (decks.some((deck) => deck.id === id)) {
        id = `${base}-${n}`;
        n += 1;
    }
    return id;
}

function createDeck() {
    const store = getStore({ create: true });
    if (!store) {
        toast('warning', '先打开一个聊天，再新建合集。');
        return;
    }
    const deck = {
        schema: 3,
        id: uniqueDeckId('deck'),
        name: '新合集',
        enabled: true,
        binding: { ...DEFAULT_BINDING },
        trigger: { ...DEFAULT_TRIGGER },
        keywords: [],
        scan: { ...DEFAULT_SCAN },
        inject: { ...DEFAULT_INJECT },
        cooldown: 2,
        pick: 1,
        aiPrompt: '',
        items: [],
    };
    store.decks.push(deck);
    selectedDeckId = deck.id;
    saveStore({ immediate: true });
    refreshInjections();
    renderPanel();
}

function uniqueItemId(deck, base = 'item') {
    const ids = new Set((deck.items || []).map((item) => item.id));
    let id = base;
    let n = 2;
    while (ids.has(id)) {
        id = `${base}-${n}`;
        n += 1;
    }
    return id;
}

function addItem(deckId) {
    const store = getStore();
    const deck = store?.decks.find((item) => item.id === deckId);
    if (!store || !deck) {
        return;
    }
    deck.items.push({ id: uniqueItemId(deck), name: '', text: '', weight: 1 });
    saveStore();
    renderPanel();
}

function deleteItem(deckId, itemId) {
    const store = getStore();
    const deck = store?.decks.find((item) => item.id === deckId);
    if (!store || !deck) {
        return;
    }
    deck.items = deck.items.filter((item) => item.id !== itemId);
    // 抽到的当前值如果正好是这条，一并清掉，避免注入一条已经不存在的条目。
    const ds = deckState(store.state, deckId);
    ds.current = (ds.current || []).filter((id) => id !== itemId);
    ds.recent = (ds.recent || []).filter((id) => id !== itemId);
    saveStore({ immediate: true });
    refreshInjections();
    renderPanel();
}

function removeDeck(deckId) {
    const store = getStore();
    const deck = store?.decks.find((item) => item.id === deckId);
    if (!store || !deck) {
        return;
    }
    if (!globalThis.confirm(`删除合集「${deck.name}」？\n这只影响当前聊天，原始文件不受影响。`)) {
        return;
    }
    store.decks = store.decks.filter((item) => item.id !== deckId);
    delete store.state.decks?.[deckId];
    if (selectedDeckId === deckId) {
        selectedDeckId = store.decks[0]?.id || null;
    }
    saveStore({ immediate: true });
    refreshInjections();
    renderPanel();
}

function setDeckField(deckId, path, value) {
    const store = getStore();
    const deck = store?.decks.find((item) => item.id === deckId);
    if (!store || !deck) {
        return;
    }
    const [head, tail] = path.split('.');
    if (tail) {
        deck[head] ||= {};
        deck[head][tail] = value;
    } else if (path === 'keywords') {
        deck.keywords = normalizeKeywords(value);
    } else {
        deck[path] = value;
    }
    // 绑定关掉时顺手清掉名字，避免标题里留一个已经失效的角色名。
    if (path === 'binding.type' && value === 'none') {
        deck.binding.name = '';
    }
    saveStore();
    refreshInjections();
    // 只更新会变的部分，避免整块重绘导致折叠状态和输入焦点丢失。
    syncEditor(deck);
}

/** 就地更新编辑区里依赖数据的部分（不重建 DOM）。 */
function syncEditor(deck) {
    const root = document.getElementById('se-editor');
    const store = getStore();
    if (!root || !store || !deck) {
        return;
    }
    const trigger = deck.trigger || DEFAULT_TRIGGER;
    const inject = deck.inject || DEFAULT_INJECT;
    root.querySelector('.se-keyword-row')?.toggleAttribute('hidden', !trigger.keyword);
    root.querySelector('.se-ai-row')?.toggleAttribute('hidden', !trigger.ai);
    const hold = deck.hold || DEFAULT_HOLD;
    const holdTurnsField = root.querySelector('[data-deck-field="hold.turns"]')?.closest('.se-field');
    if (holdTurnsField) {
        holdTurnsField.toggleAttribute('hidden', hold.mode !== 'turns');
    }
    const depthField = root.querySelector('[data-deck-field="inject.depth"]')?.closest('.se-field');
    if (depthField) {
        depthField.toggleAttribute('hidden', inject.position !== 'chat');
    }
    const value = root.querySelector('.se-current-value');
    if (value) {
        value.textContent = currentLabel(deck, store);
    }
    // 冷却条数也在这里更新，否则抽完之后要等整块重绘才变。
    const meta = root.querySelector('.se-current-meta');
    if (meta) {
        const cooldown = Math.max(0, Number(deck.cooldown) || 0);
        const recent = deckState(store.state, deck.id).recent || [];
        const cooling = cooldown > 0 ? Math.min(recent.length, cooldown) : 0;
        meta.textContent = `冷却中：${cooling > 0 ? `${cooling} 条` : '无'}`;
    }
    const count = root.querySelector('.se-items-count');
    if (count) {
        count.textContent = `${(deck.items || []).length} 条`;
    }
    renderSidebar(store);
    updateInjectPreview();
}

/**
 * 生成/抽签之后的轻量刷新：只更新当前值、侧栏、账本。
 * 不重建编辑区，免得把创作者正在输入的条目内容和滚动位置冲掉。
 */
function refreshPanelLight() {
    const root = document.getElementById(PANEL_ID);
    const store = getStore();
    if (!root || !store) {
        return;
    }
    const deck = store.decks.find((item) => item.id === selectedDeckId) || store.decks[0];
    if (deck) {
        syncEditor(deck);
    } else {
        renderSidebar(store);
    }
    const ledger = root.querySelector('#se-ledger-text');
    if (ledger) {
        ledger.textContent = formatLedger(store.state, 30);
    }
}

function setItemField(deckId, itemId, field, value) {
    const store = getStore();
    const deck = store?.decks.find((item) => item.id === deckId);
    const item = deck?.items.find((entry) => entry.id === itemId);
    if (!store || !deck || !item) {
        return;
    }
    item[field] = field === 'weight' ? Math.max(0, Number(value) || 0) : value;
    saveStore();
    refreshInjections();
    // 改名字时当前值/侧栏里的显示要跟着变，但不整块重绘。
    syncEditor(deck);
}

// ---------------------------------------------------------------------------
// 导入导出
// ---------------------------------------------------------------------------

function downloadJson(payload, filename) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportDecks() {
    const store = getStore();
    const decks = store?.decks || [];
    if (decks.length === 0) {
        toast('warning', '还没有可导出的合集');
        return;
    }
    downloadJson(decks.map((deck) => serializePack(deck)), `state-engine-decks-${new Date().toISOString().slice(0, 10)}.json`);
    toast('success', `已导出 ${decks.length} 个合集`);
}

function exportDeck(deckId) {
    const deck = deckById(deckId);
    if (!deck) {
        return;
    }
    downloadJson(serializePack(deck), `state-engine-${deck.id}.json`);
    toast('success', `已导出「${deck.name}」`);
}

function importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) {
        return;
    }
    const startedChatId = liveContext()?.chatId;
    if (!startedChatId) {
        toast('warning', '先打开一个聊天，再导入合集。');
        return;
    }
    let pending = files.length;
    const added = [];
    const errors = [];

    const done = () => {
        pending -= 1;
        if (pending > 0) {
            return;
        }
        // 读文件期间可能已经切了聊天：别把包写进另一个聊天的状态里。
        if (liveContext()?.chatId !== startedChatId) {
            toast('warning', '导入途中切换了聊天，这次导入已取消。');
            return;
        }
        const store = getStore({ create: true });
        if (!store) {
            return;
        }
        for (const pack of added) {
            const existing = store.decks.findIndex((deck) => deck.id === pack.id);
            if (existing >= 0) {
                // 同 id 视为更新：替换内容，但保留已经抽过的当前值。
                store.decks[existing] = { ...pack, enabled: store.decks[existing].enabled !== false };
                // 条目 id 可能变了，把已经不存在的当前值/冷却记录清掉。
                const ds = deckState(store.state, pack.id);
                const ids = new Set((pack.items || []).map((item) => item.id));
                ds.current = (ds.current || []).filter((id) => ids.has(id));
                ds.recent = (ds.recent || []).filter((id) => ids.has(id));
            } else {
                store.decks.push({ ...pack, enabled: true });
                resetDeckState(store.state, pack.id);
            }
        }
        saveStore({ immediate: true });
        refreshInjections();
        renderPanel();
        if (added.length > 0) {
            toast('success', `已导入 ${added.length} 个合集`);
        }
        if (errors.length > 0) {
            toast('error', errors[0]);
            console.warn('[state-engine] 导入失败：', errors);
        }
    };

    for (const file of files) {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const parsed = JSON.parse(String(reader.result));
                const list = Array.isArray(parsed) ? parsed : [parsed];
                for (const raw of list) {
                    const result = validatePack(raw);
                    if (result.ok) {
                        added.push(result.pack);
                    } else {
                        errors.push(`${file.name || '文件'}：${result.errors.join('；')}`);
                    }
                }
            } catch (error) {
                errors.push(`${file.name || '文件'}：不是合法 JSON（${error.message}）`);
            }
            done();
        };
        reader.onerror = () => {
            errors.push(`${file.name || '文件'}：读取失败`);
            done();
        };
        reader.readAsText(file, 'utf-8');
    }
}

// ---------------------------------------------------------------------------
// 面板
// ---------------------------------------------------------------------------

function currentLabel(deck, store) {
    const items = currentItems(store.state, deck);
    if (items.length === 0) {
        return '还没抽过';
    }
    return items.map((item) => item.name || item.text.slice(0, 12)).join('、');
}

function triggerSummary(deck) {
    const trigger = deck.trigger || DEFAULT_TRIGGER;
    const parts = [];
    if (trigger.manual !== false) parts.push('手动');
    if (trigger.auto) parts.push(`每${trigger.autoEvery}楼`);
    if (trigger.keyword) parts.push('关键词');
    if (trigger.ai) parts.push('AI判定');
    return parts.join(' / ') || '无';
}

function renderSidebar(store) {
    const list = document.getElementById('se-deck-list');
    if (!list) {
        return;
    }
    const decks = store?.decks || [];
    if (decks.length === 0) {
        list.innerHTML = '<div class="se-side-empty">还没有合集</div>';
        return;
    }
    if (!selectedDeckId || !decks.some((deck) => deck.id === selectedDeckId)) {
        selectedDeckId = decks[0].id;
    }
    list.innerHTML = decks.map((deck) => `
        <button type="button" class="se-deck-item ${deck.id === selectedDeckId ? 'active' : ''}" data-action="select-deck" data-deck="${escapeHtml(deck.id)}">
            <span class="se-deck-item-name">${escapeHtml(deck.name || '未命名')}</span>
            <span class="se-deck-item-meta">${escapeHtml(deck.binding?.name || triggerSummary(deck))}</span>
            <span class="se-deck-item-value">${escapeHtml(currentLabel(deck, store))}</span>
        </button>`).join('');
}

function renderItems(deck) {
    const rows = (deck.items || []).map((item) => `
        <div class="se-item-row" data-item="${escapeHtml(item.id)}">
            <input type="text" class="text_pole se-item-name" data-item-field="name" value="${escapeHtml(item.name || '')}" placeholder="条目名称">
            <textarea class="text_pole se-item-text" data-item-field="text" rows="2" placeholder="这一条要交给 AI 的内容">${escapeHtml(item.text || '')}</textarea>
            <input type="number" class="text_pole se-item-weight" data-item-field="weight" min="0" step="1" value="${Number(item.weight) || 0}" title="相对权重：1 是基准，0 表示永不出现">
            <button type="button" class="menu_button se-icon-btn" data-action="delete-item" data-deck="${escapeHtml(deck.id)}" data-item="${escapeHtml(item.id)}" title="删除这条">×</button>
        </div>`).join('');
    return `
        <div class="se-items">
            <div class="se-item-row se-item-head">
                <span>名称</span>
                <span>内容</span>
                <span title="相对权重：1 是基准，3 大约是 1 的三倍；0 表示永不出现">权重</span>
                <span></span>
            </div>
            ${rows || '<div class="se-items-empty">还没有条目。点下面的「+ 添加条目」。</div>'}
        </div>
        <div class="se-items-foot">
            <button type="button" class="menu_button" data-action="add-item" data-deck="${escapeHtml(deck.id)}">+ 添加条目</button>
        </div>`;
}

function renderEditor(store) {
    const root = document.getElementById('se-editor');
    if (!root) {
        return;
    }
    const deck = store?.decks.find((item) => item.id === selectedDeckId) || null;
    if (!deck) {
        root.innerHTML = '<div class="se-empty"><p>左边还没有合集。</p><p>点右上角「新建合集」，或者「导入 JSON」。</p></div>';
        return;
    }
    const trigger = deck.trigger || DEFAULT_TRIGGER;
    const inject = deck.inject || DEFAULT_INJECT;
    const scan = deck.scan || DEFAULT_SCAN;
    const recursion = deck.recursion || DEFAULT_RECURSION;
    const hold = deck.hold || DEFAULT_HOLD;
    const binding = deck.binding || DEFAULT_BINDING;
    const ds = deckState(store.state, deck.id);
    const cooldown = Math.max(0, Number(deck.cooldown) || 0);
    const cooling = cooldown > 0 ? ds.recent.slice(-cooldown).length : 0;

    const mvuNames = detectMvuNames();
    const charName = currentCharacterName();
    const bindingOptions = [
        { value: 'none', label: '不绑定' },
        { value: 'character', label: 'MVU 角色' },
        { value: 'chat', label: '当前角色' },
        { value: 'manual', label: '手动输入' },
    ];
    const bindingSelect = bindingOptions.map((opt) => `<option value="${opt.value}" ${binding.type === opt.value ? 'selected' : ''}>${opt.label}</option>`).join('');
    const mvuHint = mvuNames.length > 0
        ? `检测到 MVU 角色：${mvuNames.join('、')}`
        : '这张卡没有检测到 MVU 角色（可以在世界书里放 [InitVar] 条目）。';

    const nameSuggestions = [...new Set([charName, ...mvuNames].filter(Boolean))];

    const sameDeck = root.dataset.deck === deck.id;
    const prevSettingsOpen = root.querySelector('.se-deck-settings')?.open === true;
    const prevScroll = sameDeck ? root.scrollTop : 0;
    if (!sameDeck) {
        root.dataset.deck = deck.id;
        root.scrollTop = 0;
    }

    root.innerHTML = `
        <div class="se-editor-head">            <label class="se-switch"><input type="checkbox" data-deck-field="enabled" ${deck.enabled === false ? '' : 'checked'}><span>启用这个合集</span></label>
            <div class="se-editor-actions">
                <button type="button" class="menu_button" data-action="draw" data-deck="${escapeHtml(deck.id)}">抽一次</button>
                <button type="button" class="menu_button" data-action="reroll" data-deck="${escapeHtml(deck.id)}">重抽</button>
                <button type="button" class="menu_button" data-action="clear" data-deck="${escapeHtml(deck.id)}">清空记录</button>
                <button type="button" class="menu_button" data-action="export-deck" data-deck="${escapeHtml(deck.id)}">导出此合集</button>
                <button type="button" class="menu_button se-danger" data-action="delete-deck" data-deck="${escapeHtml(deck.id)}">删除合集</button>
            </div>
        </div>

        <div class="se-current">
            <span class="se-current-label">当前值</span>
            <span class="se-current-value">${escapeHtml(currentLabel(deck, store))}</span>
            <span class="se-current-meta">冷却中：${cooling > 0 ? `${cooling} 条` : '无'}</span>
        </div>

        <details class="se-deck-settings">
            <summary>合集设置</summary>
        <div class="se-settings-grid">
        <div class="se-settings-col">
        <div class="se-form">
            <label class="se-field se-field-name">
                <span>合集名称</span>
                <input type="text" class="text_pole" data-deck-field="name" value="${escapeHtml(deck.name || '')}">
            </label>
            <label class="se-field se-field-binding">
                <span>绑定</span>
                <span class="se-binding-row">
                    <select class="text_pole" data-deck-field="binding.type">${bindingSelect}</select>
                    <input type="text" class="text_pole" list="se-mvu-names" data-deck-field="binding.name" value="${escapeHtml(binding.name || '')}" placeholder="角色名">
                    <datalist id="se-mvu-names">${nameSuggestions.map((name) => `<option value="${escapeHtml(name)}"></option>`).join('')}</datalist>
                </span>
            </label>
            <label class="se-field">
                <span>每次抽取</span>
                <input type="number" class="text_pole" data-deck-field="pick" min="1" step="1" value="${Number(deck.pick) || 1}">
            </label>
            <label class="se-field">
                <span>冷却轮数</span>
                <input type="number" class="text_pole" data-deck-field="cooldown" min="0" step="1" value="${cooldown}">
            </label>
        </div>
        <div class="se-hint se-binding-hint">${escapeHtml(mvuHint)}</div>

        <div class="se-section-title">什么时候抽</div>
        <div class="se-triggers">
            <label><input type="checkbox" data-trigger-field="manual" ${trigger.manual !== false ? 'checked' : ''}><span>手动（面板按钮）</span></label>
            <label><input type="checkbox" data-trigger-field="auto" ${trigger.auto ? 'checked' : ''}><span>楼层自动，每</span></label>
            <input type="number" class="text_pole se-tiny" data-trigger-field="autoEvery" min="1" step="1" value="${Number(trigger.autoEvery) || 3}">
            <label><input type="checkbox" data-trigger-field="keyword" ${trigger.keyword ? 'checked' : ''}><span>关键词</span></label>
            <label><input type="checkbox" data-trigger-field="ai" ${trigger.ai ? 'checked' : ''}><span>AI 判定</span></label>
        </div>

        <div class="se-form se-keyword-row" ${trigger.keyword ? '' : 'hidden'}>
            <label class="se-field se-field-wide">
                <span>关键词（逗号或换行分隔；/正则/ 也可以）</span>
                <textarea class="text_pole" data-deck-field="keywords" rows="2" placeholder="换衣服，外套，雨伞">${escapeHtml((deck.keywords || []).join('，'))}</textarea>
            </label>
            <label class="se-field">
                <span>扫描最近</span>
                <span class="se-inline"><input type="number" class="text_pole se-tiny" data-deck-field="scan.depth" min="0" step="1" value="${Number(scan.depth) || 0}"><span>条</span></span>
            </label>
            <label class="se-field">
                <span>来源</span>
                <select class="text_pole" data-deck-field="scan.source">
                    <option value="both" ${scan.source === 'both' ? 'selected' : ''}>用户 + AI</option>
                    <option value="user" ${scan.source === 'user' ? 'selected' : ''}>只看用户</option>
                    <option value="ai" ${scan.source === 'ai' ? 'selected' : ''}>只看 AI</option>
                </select>
            </label>
            <div class="se-field se-field-wide">
                <span>除了聊天，还从这些地方找（可多选）</span>
                <div class="se-checks">
                    ${SCAN_FIELDS.map((field) => `<label><input type="checkbox" data-scan-field="${field}" ${(scan.fields || []).includes(field) ? 'checked' : ''}><span>${SCAN_LABELS[field] || field}</span></label>`).join('')}
                </div>
            </div>
        </div>
        </div>
        <div class="se-settings-col">
        <div class="se-section-title">递归</div>
        <div class="se-checks se-recursion">
            <label><input type="checkbox" data-recursion-field="canBeRecursed" ${recursion.canBeRecursed !== false ? 'checked' : ''}><span>可以被其它合集递归激活</span></label>
            <label><input type="checkbox" data-recursion-field="canRecurse" ${recursion.canRecurse ? 'checked' : ''}><span>抽中后继续叫醒别的合集</span></label>
            <label><input type="checkbox" data-recursion-field="delay" ${recursion.delay ? 'checked' : ''}><span>只在递归阶段激活</span></label>
        </div>

        <div class="se-section-title">抽中的内容持续多久</div>
        <div class="se-form se-hold-form">
            <label class="se-field">
                <span>方式</span>
                <select class="text_pole" data-deck-field="hold.mode">
                    <option value="turns" ${hold.mode === 'turns' ? 'selected' : ''}>按轮数</option>
                    <option value="forever" ${hold.mode === 'forever' ? 'selected' : ''}>永久（直到重抽或清空）</option>
                    <option value="ai" ${hold.mode === 'ai' ? 'selected' : ''}>由 AI 判断结束</option>
                </select>
            </label>
            <label class="se-field" ${hold.mode === 'turns' ? '' : 'hidden'}>
                <span>持续轮数</span>
                <input type="number" class="text_pole" data-deck-field="hold.turns" min="1" step="1" value="${Number(hold.turns) || 1}">
            </label>
        </div>
        <div class="se-hint">按轮数时，抽中那一轮算第 1 轮；选「由 AI 判断结束」时，模型可以在回复里写 &lt;!--SE-END:${deck.id}--&gt; 主动结束。</div>

        <div class="se-section-title">注入到哪</div>
        <div class="se-form se-inject-form">
            <label class="se-field">
                <span>位置</span>
                <select class="text_pole" data-deck-field="inject.position">
                    <option value="chat" title="插入到倒数第 N 条聊天消息之前，N 就是下面的深度" ${inject.position === 'chat' ? 'selected' : ''}>聊天记录里</option>
                    <option value="prompt" title="拼在系统提示的最后" ${inject.position === 'prompt' ? 'selected' : ''}>系统提示末尾</option>
                    <option value="before" title="放在最前面，模型最先看到" ${inject.position === 'before' ? 'selected' : ''}>提示词最前</option>
                </select>
            </label>
            <label class="se-field" ${inject.position === 'chat' ? '' : 'hidden'}>
                <span>深度</span>
                <input type="number" class="text_pole" data-deck-field="inject.depth" min="0" step="1" value="${Number(inject.depth) || 0}">
            </label>
            <label class="se-field">
                <span>角色</span>
                <select class="text_pole" data-deck-field="inject.role">
                    <option value="system" ${inject.role === 'system' ? 'selected' : ''}>System</option>
                    <option value="user" ${inject.role === 'user' ? 'selected' : ''}>User</option>
                    <option value="assistant" ${inject.role === 'assistant' ? 'selected' : ''}>Assistant</option>
                </select>
            </label>
        </div>

        <div class="se-ai-row" ${trigger.ai ? '' : 'hidden'}>
            <div class="se-section-title">AI 判定补充说明</div>
            <textarea class="text_pole" data-deck-field="aiPrompt" rows="2" placeholder="比如：只有在她准备出门时才申请换装。">${escapeHtml(deck.aiPrompt || '')}</textarea>
            <div class="se-hint">模型会在回复末尾写标记，下一轮按标记抽。模板在底部「设置」里改。</div>
        </div>
        </div>
        </div>

        </details>

        <div class="se-items-block">
            <div class="se-section-title se-items-title"><span>条目</span><span class="se-items-count">${(deck.items || []).length} 条</span></div>
            ${renderItems(deck)}
        </div>

        <details class="se-ledger se-inject-preview-block">
            <summary>本轮注入预览（真正发给 AI 的内容）</summary>
            <pre id="se-inject-preview"></pre>
        </details>
    `;

    if (sameDeck && prevSettingsOpen) {
        const settingsBlock = root.querySelector('.se-deck-settings');
        if (settingsBlock) {
            settingsBlock.open = true;
        }
    }
    if (sameDeck) {
        root.scrollTop = prevScroll;
    }
}

function renderPanel() {
    const root = document.getElementById(PANEL_ID);
    if (!root) {
        return;
    }
    const store = getStore();
    const enabled = root.querySelector('#se-enabled');
    if (enabled) {
        enabled.checked = settings.enabled !== false;
    }
    const ledger = root.querySelector('#se-ledger-text');
    if (ledger) {
        ledger.textContent = store ? formatLedger(store.state, 30) : '（还没有记录）';
    }
    const aiTemplate = root.querySelector('#se-ai-template');
    if (aiTemplate && document.activeElement !== aiTemplate) {
        aiTemplate.value = settings.aiTemplate || DEFAULT_AI_TEMPLATE;
    }
    const aiDepthInput = root.querySelector('#se-ai-depth');
    if (aiDepthInput && document.activeElement !== aiDepthInput) {
        aiDepthInput.value = String(Math.max(0, Number(settings.aiDepth) || 4));
    }
    if (!store) {
        const list = root.querySelector('#se-deck-list');
        const editor = root.querySelector('#se-editor');
        if (list) list.innerHTML = '';
        if (editor) {
            editor.innerHTML = '<div class="se-empty"><p>先打开一个聊天。</p><p>合集内容跟着聊天走，没有聊天时不会创建记录。</p></div>';
        }
        return;
    }
    renderSidebar(store);
    renderEditor(store);
    updateInjectPreview();
}

function buildPanel() {
    return `
        <div id="${PANEL_ID}" class="drawer-content closedDrawer">
            <div class="se-head">
                <div class="se-title">状态引擎 <span class="se-sub">清单抽签框架</span></div>
                <div class="se-head-actions">
                    <label class="se-switch"><input type="checkbox" id="se-enabled"><span>启用插件</span></label>
                    <button type="button" class="menu_button" data-action="new-deck">新建合集</button>
                    <button type="button" class="menu_button" data-action="import">导入</button>
                    <button type="button" class="menu_button" data-action="export-all">导出全部</button>
                    <input type="file" id="se-file" accept=".json,application/json" multiple hidden>
                </div>
            </div>
            <div class="se-body">
                <div id="se-deck-list" class="se-sidebar"></div>
                <div id="se-editor" class="se-editor"></div>
            </div>
            <details class="se-ledger">
                <summary>后台记录</summary>
                <pre id="se-ledger-text"></pre>
            </details>
            <details class="se-ledger se-settings">
                <summary>设置</summary>
                <label class="se-field se-field-wide">
                    <span>AI 判定的提示词模板（{{decks}} 会被替换成各合集自己的标记和可选项）</span>
                    <textarea id="se-ai-template" class="text_pole" rows="8"></textarea>
                </label>
                <label class="se-field">
                    <span>AI 判定提示的插入深度（倒数第几条之前）</span>
                    <input id="se-ai-depth" type="number" class="text_pole" min="0" step="1">
                </label>
                <button type="button" class="menu_button" data-action="reset-ai-template">恢复默认模板</button>
                <div class="se-hint">这段文字会在启用「AI 判定」时随每轮生成发给模型。深度越小离当前输入越近，模型越容易照做。改完点一下别处就会保存。</div>
            </details>
        </div>`;
}

function ensureTopBarEntry() {
    if (document.getElementById(BUTTON_ID)) {
        return true;
    }
    const holder = document.getElementById('top-settings-holder');
    if (!holder) {
        return false;
    }
    const anchor = document.getElementById('WI-SP-button');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
        <div id="${BUTTON_ID}" class="drawer">
            <div class="drawer-toggle drawer-header">
                <div id="state-engine-drawer-icon" class="drawer-icon fa-solid fa-dice-d20 fa-fw closedIcon interactable" title="状态引擎" tabindex="0"></div>
            </div>
            ${buildPanel()}
        </div>`;
    const drawer = wrapper.firstElementChild;
    if (anchor?.parentElement === holder) {
        anchor.insertAdjacentElement('afterend', drawer);
    } else {
        holder.appendChild(drawer);
    }
    return true;
}

function togglePanel(forceOpen) {
    const drawer = document.getElementById(BUTTON_ID);
    if (!drawer) {
        return;
    }
    const content = drawer.querySelector('.drawer-content');
    const icon = drawer.querySelector('.drawer-icon');
    const isOpen = content?.classList.contains('openDrawer');
    const shouldOpen = forceOpen === undefined ? !isOpen : forceOpen;

    // 先关掉其它抽屉，保持和 ST 一致的行为。
    document.querySelectorAll('.openDrawer:not(.pinnedOpen)').forEach((el) => {
        if (!el.closest(`#${BUTTON_ID}`)) {
            el.classList.remove('openDrawer');
            el.classList.add('closedDrawer');
        }
    });
    document.querySelectorAll('.openIcon').forEach((el) => {
        if (el !== icon) {
            el.classList.remove('openIcon');
            el.classList.add('closedIcon');
        }
    });

    content?.classList.toggle('openDrawer', shouldOpen);
    content?.classList.toggle('closedDrawer', !shouldOpen);
    icon?.classList.toggle('openIcon', shouldOpen);
    icon?.classList.toggle('closedIcon', !shouldOpen);
    if (shouldOpen) {
        renderPanel();
    }
}

function bindPanelEvents() {
    const root = document.getElementById(PANEL_ID);
    if (!root) {
        return;
    }

    root.querySelector('#se-enabled')?.addEventListener('change', (event) => {
        settings.enabled = !!event.target.checked;
        saveSettings();
        refreshInjections();
        renderPanel();
    });

    root.querySelector('#se-file')?.addEventListener('change', (event) => {
        importFiles(event.target.files);
        event.target.value = '';
    });

    root.querySelector('#se-ai-template')?.addEventListener('change', (event) => {
        settings.aiTemplate = event.target.value || DEFAULT_AI_TEMPLATE;
        saveSettings();
        refreshInjections();
        toast('success', 'AI 判定提示词已保存');
    });

    root.querySelector('#se-ai-depth')?.addEventListener('change', (event) => {
        settings.aiDepth = Math.max(0, Number(event.target.value) || 0);
        event.target.value = String(settings.aiDepth);
        saveSettings();
        refreshInjections();
        toast('success', `AI 判定提示改到倒数第 ${settings.aiDepth} 条之前`);
    });

    // 图标在 panel 外面（drawer 内），要单独绑。
    // 阻止冒泡：ST 自己的 .drawer-toggle 点击会把同一个抽屉再 toggle 一次。
    document.getElementById('state-engine-drawer-icon')?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        togglePanel();
    });

    root.addEventListener('click', (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) {
            return;
        }
        const action = button.dataset.action;
        const deckId = button.dataset.deck || selectedDeckId;
        if (action === 'new-deck') {
            createDeck();
        } else if (action === 'import') {
            root.querySelector('#se-file')?.click();
        } else if (action === 'export-all') {
            exportDecks();
        } else if (action === 'reset-ai-template') {
            settings.aiTemplate = DEFAULT_AI_TEMPLATE;
            saveSettings();
            refreshInjections();
            renderPanel();
            toast('success', 'AI 判定模板已恢复默认');
        } else if (action === 'select-deck') {
            selectedDeckId = deckId;
            renderPanel();
        } else if (action === 'draw' || action === 'reroll') {
            drawOne(deckId, { reroll: action === 'reroll' });
        } else if (action === 'clear') {
            const store = getStore();
            if (store) {
                clearDeckHistory(store.state, deckId);
                saveStore();
                refreshInjections();
                renderPanel();
            }
        } else if (action === 'export-deck') {
            exportDeck(deckId);
        } else if (action === 'delete-deck') {
            removeDeck(deckId);
        } else if (action === 'add-item') {
            addItem(deckId);
        } else if (action === 'delete-item') {
            deleteItem(deckId, button.dataset.item);
        }
    });

    root.addEventListener('change', (event) => {
        const target = event.target;
        const deckId = selectedDeckId;
        if (!deckId || !deckById(deckId)) {
            return;
        }
        if (target.dataset.deckField) {
            const field = target.dataset.deckField;
            let value;
            if (target.type === 'checkbox') {
                value = target.checked;
            } else if (target.type === 'number') {
                value = Math.max(0, Number(target.value) || 0);
            } else {
                value = target.value;
            }
            if (field === 'keywords') {
                setDeckField(deckId, 'keywords', value);
            } else if (field === 'pick' || field === 'cooldown' || field === 'scan.depth' || field === 'inject.depth') {
                setDeckField(deckId, field, Math.max(field === 'pick' ? 1 : 0, Number(value) || 0));
            } else if (field === 'hold.turns') {
                setDeckField(deckId, field, Math.max(1, Math.floor(Number(value) || 1)));
            } else {
                setDeckField(deckId, field, value);
            }
        } else if (target.dataset.triggerField) {
            const field = target.dataset.triggerField;
            const value = target.type === 'checkbox' ? target.checked : Math.max(1, Number(target.value) || 3);
            setDeckField(deckId, `trigger.${field}`, value);
        } else if (target.dataset.recursionField) {
            setDeckField(deckId, `recursion.${target.dataset.recursionField}`, target.checked);
        } else if (target.dataset.scanField) {
            const root = document.getElementById('se-editor');
            const fields = [...(root?.querySelectorAll('[data-scan-field]') || [])]
                .filter((el) => el.checked)
                .map((el) => el.dataset.scanField);
            setDeckField(deckId, 'scan.fields', fields);
        } else if (target.dataset.itemField) {
            const row = target.closest('.se-item-row');
            if (row?.dataset.item) {
                setItemField(deckId, row.dataset.item, target.dataset.itemField, target.value);
            }
        }
    });
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

function onChatChanged() {
    try {
        selectedDeckId = null;
        renderPanel();
        refreshInjections();
        // ST 切聊天时 chat_metadata 的赋值与事件顺序不保证，先跑一次再补两次，
        // 避免第一次拿到空 store 把注入清空后再也没人重建。
        setTimeout(() => {
            try {
                renderPanel();
                refreshInjections();
            } catch (error) {
                console.warn('[state-engine] chat changed retry failed', error);
            }
        }, 50);
        setTimeout(() => {
            try {
                refreshInjections();
            } catch (error) {
                console.warn('[state-engine] chat changed retry 2 failed', error);
            }
        }, 400);
    } catch (error) {
        console.warn('[state-engine] chat changed failed', error);
    }
}

function onGenerationStarted(type, _params, isDryRun) {
    if (type === 'quiet' || isDryRun) {
        return;
    }
    try {
        advanceOnGeneration();
    } catch (error) {
        console.warn('[state-engine] generation failed', error);
    }
}

export async function init() {
    try {
        context = globalThis.SillyTavern?.getContext?.();
        const { eventSource, eventTypes, extensionSettings } = context;
        settings = { ...settings, ...(extensionSettings?.[SETTINGS_KEY] || {}) };
        if (!settings.aiTemplate) {
            settings.aiTemplate = DEFAULT_AI_TEMPLATE;
        }
        if (!Number.isFinite(Number(settings.aiDepth))) {
            settings.aiDepth = 4;
        }
        if (!document.getElementById('state-engine-button')) {
            ensureTopBarEntry();
        }
        bindPanelEvents();
        eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
        eventSource.on(eventTypes.GENERATION_STARTED, onGenerationStarted);
        renderPanel();
        refreshInjections();
        console.log('[state-engine] ready');
    } catch (error) {
        console.error('[state-engine] init failed', error);
    }
}

export async function clean() {
    try {
        const ctx = liveContext();
        const { eventSource, eventTypes } = ctx;
        eventSource?.removeListener?.(eventTypes.CHAT_CHANGED, onChatChanged);
        eventSource?.removeListener?.(eventTypes.GENERATION_STARTED, onGenerationStarted);
        clearInjections(ctx, getDecks());
        document.getElementById(BUTTON_ID)?.remove();
        delete ctx?.extensionSettings?.[SETTINGS_KEY];
    } catch (error) {
        console.warn('[state-engine] clean failed', error);
    }
}
