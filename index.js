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
    DEFAULT_NESTING,
    DEFAULT_RECURSION,
    DEFAULT_SCAN,
    DEFAULT_SUMMON,
    DEFAULT_TRIGGER,
    SCAN_FIELDS,
    normalizeKeywords,
    normalizeRequires,
    serializePack,
    validatePack,
} from './src/pack.js';
import {
    clearDeckHistory,
    clearProgress,
    createState,
    currentItems,
    deckState,
    doneSet,
    drawDeck,
    drawDeckTree,
    endHold,
    expireIfDue,
    hasCurrent,
    itemRef,
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
let airExpanded = false;
// 用户手动关掉「卡里带了合集」提示条后，记住是哪张卡、多少个，避免一直弹。
let cardHintDismissed = '';

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
    if (!deck.summon || typeof deck.summon !== 'object') {
        deck.summon = { ...DEFAULT_SUMMON, by: [] };
    } else {
        deck.summon.by = Array.isArray(deck.summon.by) ? [...new Set(deck.summon.by.filter((id) => typeof id === 'string'))] : [];
        deck.summon.only = deck.summon.only === true;
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
    if (typeof deck.parent !== 'string') {
        deck.parent = DEFAULT_NESTING.parent;
    }
    if (typeof deck.onlyFromParent !== 'boolean') {
        deck.onlyFromParent = DEFAULT_NESTING.onlyFromParent;
    }
    const entryWeight = Number(deck.entryWeight);
    deck.entryWeight = Number.isFinite(entryWeight) ? Math.max(0, entryWeight) : DEFAULT_NESTING.entryWeight;
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
            if (typeof item.once !== 'boolean') {
                item.once = item.once === true;
            }
            if (!Array.isArray(item.requires)) {
                item.requires = [];
            } else {
                item.requires = normalizeRequires(item.requires);
            }
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
// 角色卡携带：把合集写进卡里，换人开店也能带走
// ---------------------------------------------------------------------------

const CARD_EXT_KEY = 'stateEngine';
const CARD_EXT_SCHEMA = 1;
const CARD_PROMPT_COMMENT = '[状态引擎] 本卡需要安装插件';
const CARD_PROMPT_KEYS = ['状态引擎', 'state engine'];
const CARD_PLUGIN_URL = 'https://github.com/lizard682/sillytavern-state-engine';
const FIRST_MES_GUARD_KEY = 'firstMesGuard';
const FIRST_MES_WARNING_PREFIX = '⚠️ 这张卡需要「状态引擎」插件';
const FIRST_MES_WARNING = `${FIRST_MES_WARNING_PREFIX}

这张角色卡自带了由插件抽取的清单（衣服、动作、场景、道具等）。
你的酒馆里还没有安装这个插件，所以这些内容不会出现，只能玩到基础剧情。

插件地址：${CARD_PLUGIN_URL}

装好插件后重新打开这张卡：这条提醒会自动消失，开局会换回作者写的那一条。`;

/** 当前角色对象（带 avatar / data）。 */
function currentCharacterCard() {
    const ctx = liveContext();
    return ctx?.characters?.[ctx.characterId] || null;
}

/** 角色卡里由本插件写入的合集（没写就是空数组）。 */
function cardDecksOf(character) {
    const raw = character?.data?.extensions?.[CARD_EXT_KEY];
    if (!raw || !Array.isArray(raw.decks)) {
        return [];
    }
    return raw.decks.filter((deck) => deck && typeof deck === 'object' && deck.id);
}

/** 导出时改写第一句开场留下的备份（有就说明这张卡的开局被我们换成了安装提醒）。 */
function firstMesGuardOf(character) {
    const guard = character?.data?.extensions?.[CARD_EXT_KEY]?.[FIRST_MES_GUARD_KEY];
    return guard && typeof guard.original === 'string' ? guard : null;
}

function isFirstMesWarning(text) {
    return typeof text === 'string' && text.trimStart().startsWith(FIRST_MES_WARNING_PREFIX);
}

/**
 * 把种子合集沿三种关系扩成闭包：
 * 上级（parent）、下级（谁把 parent 指向我）、被谁唤起（summon.by 里的来源）。
 */function collectRelatedDecks(decks, seedIds) {
    const byId = new Map(decks.map((deck) => [deck.id, deck]));
    const seen = new Set();
    const queue = [...seedIds].filter((id) => byId.has(id));
    while (queue.length > 0) {
        const id = queue.shift();
        if (seen.has(id) || !byId.has(id)) {
            continue;
        }
        seen.add(id);
        const deck = byId.get(id);
        if (deck.parent && byId.has(deck.parent) && !seen.has(deck.parent)) {
            queue.push(deck.parent);
        }
        for (const other of decks) {
            if (other.parent === id && !seen.has(other.id)) {
                queue.push(other.id);
            }
        }
        for (const sourceId of deck.summon?.by || []) {
            if (byId.has(sourceId) && !seen.has(sourceId)) {
                queue.push(sourceId);
            }
        }
    }
    return [...seen].map((id) => byId.get(id)).filter(Boolean);
}

/** 绑定到当前角色的合集 id（手动输入的别的名字不算）。 */
function boundDeckIds(store, ctx) {
    const name = currentCharacterName(ctx);
    return store.decks
        .filter((deck) => {
            const binding = deck.binding || DEFAULT_BINDING;
            if (!binding.name) {
                return false;
            }
            return binding.type === 'character' || binding.name === name;
        })
        .map((deck) => deck.id);
}

/** 写进角色卡的一条世界书提示，让没装插件的人也能看到「这张卡需要插件」。 */
function buildCardPromptEntry(character) {
    const entries = character?.data?.character_book?.entries || [];
    if (entries.some((entry) => entry?.comment === CARD_PROMPT_COMMENT)) {
        return null;
    }
    return {
        id: entries.length + 1,
        keys: CARD_PROMPT_KEYS,
        secondary_keys: [],
        comment: CARD_PROMPT_COMMENT,
        content: `这张角色卡自带了「状态引擎」的清单抽签数据。\n如果酒馆顶栏没有骰子图标，说明还没安装插件；装上之后，打开这张卡会提示你导入自带的合集。\n插件地址：${CARD_PLUGIN_URL}`,
        constant: false,
        selective: true,
        insertion_order: 100,
        enabled: true,
        position: 'after_char',
        extensions: {},
    };
}

async function saveCharacterMerge(payload) {
    const ctx = liveContext();
    const headers = ctx?.getRequestHeaders?.() || { 'Content-Type': 'application/json' };
    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`保存角色卡失败（${response.status}）${detail.slice(0, 120)}`);
    }
}

/** 把「绑定到当前角色的合集 + 和它们有关联的合集」写进角色卡。 */
async function exportDecksToCard() {
    const ctx = liveContext();
    const character = currentCharacterCard();
    const store = getStore();
    if (!character?.avatar) {
        toast('error', '先在右侧选一张角色卡');
        return;
    }
    if (!store || store.decks.length === 0) {
        toast('error', '当前聊天还没有合集');
        return;
    }
    const seeds = boundDeckIds(store, ctx);
    const chosen = collectRelatedDecks(store.decks, seeds.length > 0 ? seeds : store.decks.map((deck) => deck.id));
    const list = chosen.map((deck) => deck.name || deck.id).join('、');
    const ok = window.confirm(
        `把 ${chosen.length} 个合集写进「${character.name || '这张卡'}」？\n\n${list}\n\n写进去之后，你在酒馆里导出这张角色卡时，数据会跟着卡一起走。\n同时会把这张卡的开局第一条换成「需要安装插件」的提醒，原来的开局挪到第二开局；装了插件的人打开时会自动换回来。`,
    );
    if (!ok) {
        return;
    }
    const decks = JSON.parse(JSON.stringify(chosen));
    // 第一次导出记下原文；以后再导出时沿用原文，避免把提醒本身当成开局又备份一次。
    const guard = firstMesGuardOf(character);
    const originalFirstMes = String(guard?.original ?? character.data?.first_mes ?? '');
    const existingGreetings = Array.isArray(character.data?.alternate_greetings)
        ? character.data.alternate_greetings.filter((text) => typeof text === 'string' && text !== originalFirstMes)
        : [];
    const data = {
        first_mes: FIRST_MES_WARNING,
        alternate_greetings: [originalFirstMes, ...existingGreetings],
        extensions: {
            [CARD_EXT_KEY]: {
                schema: CARD_EXT_SCHEMA,
                savedAt: new Date().toISOString(),
                count: decks.length,
                decks,
                [FIRST_MES_GUARD_KEY]: {
                    original: originalFirstMes,
                    addedAt: new Date().toISOString(),
                },
            },
        },
    };
    const promptEntry = buildCardPromptEntry(character);
    if (promptEntry) {
        data.character_book = {
            entries: [...(character.data.character_book?.entries || []), promptEntry],
        };
    }
    try {
        // 先清掉旧的一份，避免上一次导出的合集残留在数组里。
        await saveCharacterMerge({
            avatar: character.avatar,
            data: {
                extensions: { [CARD_EXT_KEY]: '__@@UNSET@@__' },
                alternate_greetings: '__@@UNSET@@__',
            },
        });
        await saveCharacterMerge({ avatar: character.avatar, data });
        // 本地对象同步一份，免得面板上还显示旧提示。
        character.data = character.data || {};
        character.data.first_mes = data.first_mes;
        character.data.alternate_greetings = data.alternate_greetings;
        character.data.extensions = { ...(character.data.extensions || {}), ...data.extensions };
        if (data.character_book) {
            character.data.character_book = data.character_book;
        }
        toast('success', `已把 ${decks.length} 个合集写进「${character.name || '这张卡'}」`);
        renderPanel();
    } catch (error) {
        console.error('[state-engine] 写角色卡失败', error);
        toast('error', error.message || '写角色卡失败');
    }
}

/** 角色卡里有、当前聊天里还没有的合集。 */
function pendingCardDecks() {
    const character = currentCharacterCard();
    const store = getStore();
    if (!character || !store) {
        return [];
    }
    const have = new Set(store.decks.map((deck) => deck.id));
    return cardDecksOf(character).filter((deck) => !have.has(deck.id));
}

/** 把角色卡里的合集导进当前聊天。 */
function importCardDecks() {
    const character = currentCharacterCard();
    const store = getStore({ create: true });
    if (!character || !store) {
        toast('error', '先打开一个聊天');
        return;
    }
    const incoming = cardDecksOf(character);
    if (incoming.length === 0) {
        toast('info', '这张卡里没有自带合集');
        return;
    }
    let added = 0;
    let replaced = 0;
    for (const raw of incoming) {
        let deck;
        try {
            deck = normalizeDeckShape(JSON.parse(JSON.stringify(raw)));
        } catch (error) {
            console.warn('[state-engine] 卡内合集格式异常', raw?.id, error);
            continue;
        }
        const index = store.decks.findIndex((item) => item.id === deck.id);
        if (index >= 0) {
            store.decks[index] = deck;
            replaced += 1;
        } else {
            store.decks.push(deck);
            added += 1;
        }
    }
    saveStore({ immediate: true });
    refreshInjections();
    renderPanel();
    cardHintDismissed = '';
    toast('success', `已从角色卡导入：新增 ${added} 个，覆盖 ${replaced} 个`);
    return { added, replaced };
}

/**
 * 把被改成「安装提醒」的开局换回原文：
 * first_mes 复原、把原开局从第二开局的数组里摘掉、删掉备份标记。
 */
async function restoreFirstMesFor(character) {
    const guard = firstMesGuardOf(character);
    if (!guard || !character?.avatar) {
        return false;
    }
    const greetings = (Array.isArray(character.data?.alternate_greetings) ? character.data.alternate_greetings : [])
        .filter((text) => typeof text === 'string' && text !== guard.original);
    await saveCharacterMerge({
        avatar: character.avatar,
        data: { first_mes: guard.original, alternate_greetings: '__@@UNSET@@__' },
    });
    await saveCharacterMerge({
        avatar: character.avatar,
        data: { alternate_greetings: greetings },
    });
    await saveCharacterMerge({
        avatar: character.avatar,
        data: { extensions: { [CARD_EXT_KEY]: { [FIRST_MES_GUARD_KEY]: '__@@UNSET@@__' } } },
    });
    character.data.first_mes = guard.original;
    character.data.alternate_greetings = greetings;
    const ext = character.data.extensions?.[CARD_EXT_KEY];
    if (ext && typeof ext === 'object') {
        delete ext[FIRST_MES_GUARD_KEY];
    }
    return true;
}

/** 如果当前聊天第一条还是安装提醒，把它换成原开局。 */
async function fixChatFirstMessage(character, original) {
    const ctx = liveContext();
    const first = ctx?.chat?.[0];
    if (!first || !isFirstMesWarning(first.mes)) {
        return false;
    }
    first.mes = original;
    try {
        await ctx.saveChat?.();
    } catch (error) {
        console.warn('[state-engine] 保存聊天失败', error);
    }
    return true;
}

/**
 * 聊天里还留着安装提醒时，用当前角色卡的开局换掉它。
 * 插件装了、但玩家是在装插件之前建的聊天，就会走到这里。
 */
async function fixWarningChatMessage() {
    const ctx = liveContext();
    const first = ctx?.chat?.[0];
    if (!first || !isFirstMesWarning(first.mes)) {
        return false;
    }
    const original = currentCharacterCard()?.data?.first_mes;
    if (typeof original !== 'string' || !original.trim() || isFirstMesWarning(original)) {
        return false;
    }
    first.mes = original;
    try {
        await ctx.saveChat?.();
    } catch (error) {
        console.warn('[state-engine] 保存聊天失败', error);
    }
    return true;
}

/** 扫描所有角色卡，把带安装提醒的卡恢复成正常开局（最多一次处理 5 张）。 */
async function restoreFirstMesAll() {
    const ctx = liveContext();
    const characters = ctx?.characters;
    if (!Array.isArray(characters) || characters.length === 0) {
        return;
    }
    const currentAvatar = currentCharacterCard()?.avatar;
    const pending = characters
        .map((character) => ({ character, guard: firstMesGuardOf(character) }))
        .filter((item) => item.guard);
    for (const { character, guard } of pending.slice(0, 5)) {
        try {
            await restoreFirstMesFor(character);
            if (currentAvatar && character.avatar === currentAvatar) {
                const fixed = await fixChatFirstMessage(character, guard.original);
                if (fixed) {
                    toast('info', `「${character.name || '角色卡'}」的安装提醒已换回原开局`);
                }
            }
        } catch (error) {
            console.warn('[state-engine] 恢复开局失败', character?.name, error);
        }
    }
    if (pending.length > 0) {
        renderPanel();
    }
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
    // 导演提示只列此刻真的会生效的合集：绑定角色不在场、或只能被上级抽中的子合集，都别让模型白申请。
    const directorDecks = store.decks.filter((deck) => deck.enabled !== false && deck.onlyFromParent !== true && deck.summon?.only !== true && bindingActive(deck, ctx));
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
        // 「只能被上级抽中」的子合集，正常对话的自动/关键词/AI 都不碰它。
        if (deck.onlyFromParent === true) {
            continue;
        }
        // 「只在被唤起时出场」的合集，普通对话的自动/关键词/AI 都不碰它。
        if ((deck.summon || DEFAULT_SUMMON).only === true) {
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
        const tree = drawDeckTree(store.state, store.decks, deck.id, {
            force: false,
            cause: dueMarker ? 'ai' : dueKeyword ? 'keyword' : 'auto',
        });
        const result = tree.result || null;
        if (result?.changed) {
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

    // 唤起：谁抽中了，就顺手把「被它唤起」的合集各抽一次，最多三层。
    const summoned = applySummons(store, ctx, fired);
    if (summoned.length > 0) {
        fired.push(...summoned);
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

// 谁抽中了，就把「被它唤起」的合集各抽一次，最多三层。
function applySummons(store, ctx, seededIds) {
    const MAX_SUMMON_ROUNDS = 3;
    const visited = new Set(seededIds);
    const fired = [];
    let frontier = seededIds.slice();
    for (let round = 0; round < MAX_SUMMON_ROUNDS && frontier.length > 0; round += 1) {
        const nextFrontier = [];
        for (const sourceId of frontier) {
            for (const deck of store.decks) {
                if (visited.has(deck.id) || deck.enabled === false || !bindingActive(deck, ctx)) {
                    continue;
                }
                // 只认上级合集的子合集，不参与「被唤起」。
                if (deck.onlyFromParent === true) {
                    continue;
                }
                const summon = deck.summon || DEFAULT_SUMMON;
                if (!Array.isArray(summon.by) || !summon.by.includes(sourceId)) {
                    continue;
                }
                const result = drawDeck(store.state, deck, { force: false, cause: 'summoned' });
                visited.add(deck.id);
                nextFrontier.push(deck.id);
                if (result?.changed) {
                    fired.push(deck.id);
                }
            }
        }
        frontier = nextFrontier;
    }
    return fired;
}

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
    const tree = drawDeckTree(store.state, store.decks, deckId, {
        force: true,
        cause: reroll ? 'reroll' : 'manual',
    });
    const result = tree.result || null;
    // 手动抽也算一次「抽中」，把「被它唤起」的合集顺带抽出来。
    const seeded = [deckId, ...(tree.nested && tree.deck?.id ? [tree.deck.id] : [])];
    applySummons(store, liveContext(), seeded);
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
        schema: 4,
        id: uniqueDeckId('deck'),
        name: '新合集',
        enabled: true,
        parent: '',
        onlyFromParent: false,
        entryWeight: 1,
        binding: { ...DEFAULT_BINDING },
        trigger: { ...DEFAULT_TRIGGER },
        keywords: [],
        scan: { ...DEFAULT_SCAN },
        recursion: { ...DEFAULT_RECURSION },
        summon: { by: [], only: false },
        hold: { ...DEFAULT_HOLD },
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
    if (path === 'parent') {
        // 不许挂到自己身上，也不许挂到自己的后代下面（否则合集树成环，抽签永远出不来）。
        if (value === deckId || isInSubtree(store.decks, value, deckId)) {
            toast('warning', '不能把合集挂到它自己的下级里。');
            return;
        }
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
    if (path === 'parent') {
        // 父级变了，下拉选项和层级缩进都要重算，只能整块重绘。
        renderPanel();
        return;
    }
    syncEditor(deck);
}

/** nodeId 是不是 rootId 的后代（沿 parent 链往上找）。 */
function isInSubtree(decks, nodeId, rootId) {
    if (!nodeId || !rootId) {
        return false;
    }
    let cursor = decks.find((item) => item.id === nodeId);
    const seen = new Set();
    while (cursor?.parent) {
        if (cursor.parent === rootId) {
            return true;
        }
        if (seen.has(cursor.parent)) {
            return false;
        }
        seen.add(cursor.parent);
        cursor = decks.find((item) => item.id === cursor.parent);
    }
    return false;
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
    // 本轮上场槽与抽条预览：抽完立刻反映，不用等整块重绘。
    renderAir(store, airExpanded);
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
    item[field] = field === 'weight'
        ? Math.max(0, Number(value) || 0)
        : field === 'once'
            ? value === true || value === 'true'
            : value;
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
        // 跨包导入时上级可能不在：断链的合集自动回到顶层，别让它永远抽不出来。
        const aliveIds = new Set(store.decks.map((deck) => deck.id));
        for (const deck of store.decks) {
            if (deck.parent && !aliveIds.has(deck.parent)) {
                deck.parent = '';
                deck.onlyFromParent = false;
                errors.push(`「${deck.name}」的上级合集不在这份聊天里，已改为顶层`);
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

/** 合集在树里的层级：沿 parent 往上数，最多 3 层，防环。 */
function deckDepth(decks, deck) {
    let depth = 0;
    let cursor = deck;
    const seen = new Set([deck.id]);
    while (cursor?.parent && depth < 3) {
        const parent = decks.find((item) => item.id === cursor.parent);
        if (!parent || seen.has(parent.id)) {
            break;
        }
        seen.add(parent.id);
        depth += 1;
        cursor = parent;
    }
    return depth;
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
    list.innerHTML = decks.map((deck) => {
        const depth = deckDepth(decks, deck);
        const childCount = decks.filter((item) => item.parent === deck.id).length;
        return `
        <button type="button" class="se-deck-item ${deck.id === selectedDeckId ? 'active' : ''} ${depth > 0 ? 'se-deck-child' : ''}" data-action="select-deck" data-deck="${escapeHtml(deck.id)}" style="padding-left:${10 + depth * 16}px">
            <span class="se-deck-item-name">${depth > 0 ? '└ ' : ''}${escapeHtml(deck.name || '未命名')}${childCount > 0 ? ` <span class="se-deck-count">${childCount}</span>` : ''}</span>
            <span class="se-deck-item-meta">${escapeHtml(deck.binding?.name || triggerSummary(deck))}</span>
            <span class="se-deck-item-value">${escapeHtml(currentLabel(deck, store))}</span>
        </button>`;
    }).join('');
}

/**
 * 条目「前置条件」的多选清单。
 * - 列出全部合集的全部条目，排除自己。
 * - 已经出现过的条目打个「已出现」标记，方便作者顺着剧情线连。
 * - 条目多时用搜索框过滤，不一次渲染几千行也能用。
 */
function renderRequireList(deck, item, store) {
    const done = doneSet(store.state);
    const selfRef = itemRef(deck.id, item.id);
    const selected = new Set(Array.isArray(item.requires) ? item.requires : []);
    const options = [];
    for (const other of store.decks) {
        for (const entry of other.items || []) {
            const ref = itemRef(other.id, entry.id);
            if (ref === selfRef) {
                continue;
            }
            options.push({
                ref,
                deckName: other.name || other.id,
                itemName: entry.name || entry.id,
                done: done.has(ref),
            });
        }
    }
    const chosen = options.filter((option) => selected.has(option.ref));
    const summary = chosen.length
        ? `前置：已选 ${chosen.length} 个（${chosen.slice(0, 2).map((option) => option.itemName).join('、')}${chosen.length > 2 ? '…' : ''}）`
        : '前置：无';
    const rows = options
        .slice(0, 600)
        .map((option) => `
            <label class="se-require-row" data-search="${escapeHtml(`${option.deckName} ${option.itemName}`.toLowerCase())}">
                <input type="checkbox" data-require-ref="${escapeHtml(option.ref)}" ${selected.has(option.ref) ? 'checked' : ''}>
                <span>${escapeHtml(option.deckName)} › ${escapeHtml(option.itemName)}${option.done ? ' <em>已出现</em>' : ''}</span>
            </label>`)
        .join('');
    return `
        <details class="se-multi-select se-require-block">
            <summary>${escapeHtml(summary)}</summary>
            <div class="se-require-panel">
                <input type="text" class="text_pole se-require-search" data-require-search placeholder="搜索条目名或合集名…">
                <div class="se-require-list">${rows || '<div class="se-muted">没有可选的条目（这个聊天里只有这一条）。</div>'}</div>
            </div>
        </details>`;
}

function renderItems(deck, store) {
    const items = deck.items || [];
    const done = doneSet(store.state);
    const rows = items.map((item) => {
        const weight = Math.max(0, Number(item.weight) || 0);
        const used = item.once && done.has(itemRef(deck.id, item.id));
        const needCount = Array.isArray(item.requires) ? item.requires.length : 0;
        const flags = [
            used ? '已出现' : '',
            item.once ? '一次性' : '',
            needCount ? `前置 ${needCount}` : '',
        ].filter(Boolean).join(' · ');
        return `
        <div class="se-item-row" data-item="${escapeHtml(item.id)}">
            <div class="se-item-main" data-action="toggle-item">
                <span class="se-item-name-view">${escapeHtml(item.name || '未命名')}${flags ? `<em class="se-item-flag">${escapeHtml(flags)}</em>` : ''}</span>
                <input type="number" class="text_pole se-item-weight" data-item-field="weight" min="0" step="1" value="${weight}" title="相对权重：1 是基准，0 表示永不出现">
                <button type="button" class="se-icon-btn" data-action="delete-item" data-deck="${escapeHtml(deck.id)}" data-item="${escapeHtml(item.id)}" title="删除这条">×</button>
            </div>
            <div class="se-item-edit">
                <input type="text" class="text_pole se-item-name" data-item-field="name" value="${escapeHtml(item.name || '')}" placeholder="条目名称">
                <textarea class="text_pole se-item-text" data-item-field="text" rows="3" placeholder="这一条要交给 AI 的内容">${escapeHtml(item.text || '')}</textarea>
                <label class="se-check se-check-wide">
                    <input type="checkbox" data-item-field="once" ${item.once ? 'checked' : ''}>
                    <span>只出现一次（抽中后不再进候选池）</span>
                </label>
                ${renderRequireList(deck, item, store)}
            </div>
        </div>`;
    }).join('');
    return `
        <div class="se-items">
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
    const summon = deck.summon || DEFAULT_SUMMON;
    const summonNames = (summon.by || []).map((id) => store.decks.find((item) => item.id === id)?.name || id);
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
    // 上级候选：不能是自己，也不能是自己的后代（否则成环）。
    const parentCandidates = store.decks.filter((item) => item.id !== deck.id && !isInSubtree(store.decks, item.id, deck.id));
    const parentSelect = [
        `<option value="">（顶层）</option>`,
        ...parentCandidates.map((item) => `<option value="${escapeHtml(item.id)}" ${deck.parent === item.id ? 'selected' : ''}>${escapeHtml(item.name || item.id)}</option>`),
    ].join('');
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
        <div class="se-items-block">
            <div class="se-items-title"><span class="se-items-deck">${escapeHtml(deck.name || deck.id)}</span><span class="se-items-count">${(deck.items || []).length} 条</span></div>
            ${renderItems(deck, store)}
        </div>

        <details class="se-deck-settings">
            <summary>合集设置：名称、绑定、抽取规则、触发方式、注入位置</summary>        <div class="se-settings-grid">
        <div class="se-settings-col">
        <div class="se-form">
            <label class="se-field se-field-name">
                <span>合集名称</span>
                <input type="text" class="text_pole" data-deck-field="name" value="${escapeHtml(deck.name || '')}">
            </label>
            <label class="se-field" title="结构关系：上层合集抽签时先抽子合集，再让子合集抽自己的条目，最多三层。">
                <span>上级合集</span>
                <select class="text_pole" data-deck-field="parent">${parentSelect}</select>
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
        <div class="se-form se-nest-row" ${deck.parent ? '' : 'hidden'}>
            <label class="se-field">
                <span>在上级里的权重</span>
                <input type="number" class="text_pole" data-deck-field="entryWeight" min="0" step="1" value="${Number(deck.entryWeight) || 0}">
            </label>
            <label class="se-check"><input type="checkbox" data-deck-field="onlyFromParent" ${deck.onlyFromParent ? 'checked' : ''}><span>只能被上级抽中（正常对话不碰它）</span></label>
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

        <div class="se-ai-row" ${trigger.ai ? '' : 'hidden'}>
            <div class="se-section-title">AI 判定补充说明</div>
            <textarea class="text_pole" data-deck-field="aiPrompt" rows="2" placeholder="比如：只有在她准备出门时才申请换装。">${escapeHtml(deck.aiPrompt || '')}</textarea>
            <div class="se-hint">模型会在回复末尾写标记，下一轮按标记抽。模板在底部「设置」里改。</div>
        </div>
        </div>
        <div class="se-settings-col">
        <div class="se-section-title">被谁唤起</div>
        <div class="se-hint">勾中的合集抽中时，会顺手把我抽一次（最多三层，不会循环）。不勾就是没人能唤起我。</div>
        <details class="se-multi-select">
            <summary id="se-summon-summary" title="${escapeHtml(summonNames.join('、'))}">${escapeHtml(summonNames.length ? `已选 ${summonNames.length} 个：${summonNames.join('、')}` : '还没有合集能唤起它，点这里选择')}</summary>
            <div class="se-summon-list">
                ${store.decks.filter((item) => item.id !== deck.id).map((item) => `<label><input type="checkbox" data-summon-by="${escapeHtml(item.id)}" ${(summon.by || []).includes(item.id) ? 'checked' : ''}><span>${escapeHtml(item.name || item.id)}</span></label>`).join('') || '<span class="se-hint">还没有别的合集。</span>'}
            </div>
        </details>
        <label class="se-checks se-check-wide"><input type="checkbox" data-summon-only ${summon.only ? 'checked' : ''}><span>只在被唤起时出场（平时的楼层自动、关键词、AI 判定都不碰它）</span></label>

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

        </div>
        </div>

        <div class="se-deck-ops">
            <label class="se-check"><input type="checkbox" data-deck-field="enabled" ${deck.enabled === false ? '' : 'checked'}><span>启用这个合集</span></label>
            <span class="se-ops-spacer"></span>
            <button type="button" class="menu_button" data-action="export-deck" data-deck="${escapeHtml(deck.id)}">导出此合集</button>
            <button type="button" class="menu_button" data-action="clear" data-deck="${escapeHtml(deck.id)}">清空记录</button>
            <button type="button" class="menu_button se-danger" data-action="delete-deck" data-deck="${escapeHtml(deck.id)}">删除合集</button>
        </div>

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
    renderCardHint();
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
        renderAir(null);
        return;
    }
    renderAir(store, airExpanded);
    renderSidebar(store);
    renderEditor(store);
    updateInjectPreview();
}

function buildPanel() {
    return `
        <div id="${PANEL_ID}" class="drawer-content closedDrawer">
            <div class="se-head">
                <div class="se-title">状态引擎</div>
                <div class="se-head-actions">
                    <label class="se-switch"><input type="checkbox" id="se-enabled"><span>启用</span></label>
                    <button type="button" class="menu_button" data-action="new-deck">新建合集</button>
                    <button type="button" class="menu_button" data-action="import">导入</button>
                    <button type="button" class="menu_button" data-action="export-all">导出全部</button>
                    <button type="button" class="menu_button" data-action="export-card" title="把绑定到这张卡的合集（以及和它们有关联的合集）写进角色卡，导出卡时一起带走">随卡导出</button>
                    <input type="file" id="se-file" accept=".json,application/json" multiple hidden>
                </div>
            </div>

            <div id="se-card-hint" class="se-card-hint" hidden></div>

            <div id="se-air" class="se-air"></div>

            <div class="se-body">
                <div id="se-deck-list" class="se-sidebar"></div>
                <div id="se-editor" class="se-editor"></div>
            </div>

            <div class="se-takebar">
                <span id="se-take-preview" class="se-take-preview"></span>
                <button type="button" class="menu_button se-take-btn" data-action="draw">抽一条 <kbd>空格</kbd></button>
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
                <details class="se-ledger se-inject-preview-block">
                    <summary>本轮注入预览（真正发给 AI 的内容）</summary>
                    <pre id="se-inject-preview"></pre>
                </details>
            </details>
        </div>`;
}

// 合集 → 父 → 祖父的名字链（最多三层）。
function deckChain(decks, deck) {
    const names = [deck.name || deck.id];
    let cursor = deck;
    let guard = 0;
    while (cursor?.parent && guard < 3) {
        const parent = decks.find((item) => item.id === cursor.parent);
        if (!parent) {
            break;
        }
        names.unshift(parent.name || parent.id);
        cursor = parent;
        guard += 1;
    }
    return names;
}

// 本轮上场：每一条正在生效的内容一行。
function airEntries(store) {
    if (!store) {
        return [];
    }
    const turn = Number(store.state?.turn) || 0;
    return (store.decks || [])
        .filter((deck) => deck.enabled !== false)
        .map((deck) => {
            const ds = deckState(store.state, deck.id);
            const current = Array.isArray(ds.current) ? ds.current : [];
            if (current.length === 0) {
                return null;
            }
            const items = deck.items || [];
            const names = current.map((id) => items.find((item) => item.id === id)?.name || id);
            const hold = deck.hold || DEFAULT_HOLD;
            const total = Math.max(1, Number(hold.turns) || 1);
            const start = Number(ds.holdStart);
            const used = Number.isFinite(start) && start >= 0 ? Math.max(0, turn - start) : 0;
            const left = hold.mode === 'turns' ? Math.max(0, total - used) : null;
            const pct = hold.mode === 'turns' ? Math.max(0, Math.min(100, Math.round((left / total) * 100))) : 100;
            return { deck, chain: deckChain(store.decks, deck), names, hold, left, pct, current };
        })
        .filter(Boolean);
}

function renderAir(store, expanded = false) {
    const air = document.getElementById('se-air');
    if (!air) {
        return;
    }
    if (!store) {
        air.innerHTML = '<div class="se-air-empty">先打开一个聊天。</div>';
        return;
    }
    const entries = airEntries(store);
    const visible = expanded ? entries : entries.slice(0, 3);
    const hiddenCount = Math.max(0, entries.length - 3);
    const rows = visible.map((entry) => {
        const path = [...entry.chain, entry.names.join('、')].map(escapeHtml).join(' › ');
        let timeMark;
        if (entry.hold.mode === 'turns') {
            timeMark = `<span class="se-air-bar"><i style="width:${entry.pct}%"></i></span><span class="se-air-left">剩 ${entry.left} 楼</span>`;
        } else if (entry.hold.mode === 'ai') {
            timeMark = `<span class="se-air-left se-air-dim">由 AI 结束</span>`;
        } else {
            timeMark = `<span class="se-air-left se-air-dim">— 常驻 —</span>`;
        }
        return `
            <div class="se-air-row">
                <span class="se-air-path">${path}</span>
                ${timeMark}
            </div>`;
    }).join('');
    const more = hiddenCount > 0
        ? `<button type="button" class="se-air-more" data-action="toggle-air">${expanded ? '收起' : `＋ 另有 ${hiddenCount} 条`}</button>`
        : '';
    air.innerHTML = `
        <div class="se-air-head">
            <span class="se-air-lamp ${entries.length > 0 ? 'on' : ''}"></span>
            <span class="se-air-label">本轮上场</span>
            <span class="se-air-count">${entries.length > 0 ? `${entries.length} 条在播` : ''}</span>
        </div>
        ${rows || '<div class="se-air-empty">本轮还没有上场的内容。点下面的「抽一条」。</div>'}
        ${more}
    `;

    const preview = document.getElementById('se-take-preview');
    if (preview) {
        const deck = store.decks.find((item) => item.id === selectedDeckId);
        if (!deck) {
            preview.textContent = '待抽 · 先在左边选一个合集';
        } else {
            const totalWeight = (deck.items || []).reduce((sum, item) => sum + Math.max(0, Number(item.weight) || 0), 0);
            preview.innerHTML = `待抽 · <b>${escapeHtml(deck.name || deck.id)}</b> · ${deck.items?.length || 0} 条可选 · 权重合计 ${totalWeight}`;
        }
    }
}

/** 面板里「这张卡自带了合集」的提示条。 */
function renderCardHint() {
    const hint = document.getElementById('se-card-hint');
    if (!hint) {
        return;
    }
    const pending = pendingCardDecks();
    const character = currentCharacterCard();
    const key = pending.length > 0 ? `${character?.avatar || ''}:${pending.length}` : '';
    if (pending.length === 0 || key === cardHintDismissed) {
        hint.hidden = true;
        hint.innerHTML = '';
        return;
    }
    const names = pending.map((deck) => deck.name || deck.id).join('、');
    hint.hidden = false;
    hint.innerHTML = `
        <span class="se-card-hint-text">「${escapeHtml(character?.name || '这张卡')}」自带了 ${pending.length} 个合集：${escapeHtml(names)}</span>
        <button type="button" class="menu_button" data-action="import-card-decks">导入</button>
        <button type="button" class="menu_button" data-action="dismiss-card-hint">先不用</button>`;
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

    // 空格 = 抽一条（面板打开、焦点不在输入框时）。
    if (!bindPanelEvents.hotkeyBound) {
        bindPanelEvents.hotkeyBound = true;
        document.addEventListener('keydown', (event) => {
            if (event.code !== 'Space' || event.repeat) {
                return;
            }
            const panel = document.getElementById(PANEL_ID);
            if (!panel?.classList.contains('openDrawer')) {
                return;
            }
            const el = document.activeElement;
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) {
                return;
            }
            event.preventDefault();
            if (selectedDeckId) {
                drawOne(selectedDeckId, {});
            }
        });
    }

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
        } else if (action === 'export-card') {
            exportDecksToCard();
        } else if (action === 'import-card-decks') {
            importCardDecks();
        } else if (action === 'dismiss-card-hint') {
            const character = currentCharacterCard();
            cardHintDismissed = `${character?.avatar || ''}:${pendingCardDecks().length}`;
            renderCardHint();
        } else if (action === 'reset-ai-template') {
            settings.aiTemplate = DEFAULT_AI_TEMPLATE;
            saveSettings();
            refreshInjections();
            renderPanel();
            toast('success', 'AI 判定模板已恢复默认');
        } else if (action === 'toggle-air') {
            airExpanded = !airExpanded;
            renderAir(getStore(), airExpanded);
        } else if (action === 'toggle-item') {
            if (event.target.closest('input, textarea')) {
                return;
            }
            const row = button.closest('.se-item-row');
            const wasOpen = row?.classList.contains('open');
            root.querySelectorAll('.se-item-row.open').forEach((el) => el.classList.remove('open'));
            if (row && !wasOpen) {
                row.classList.add('open');
                row.querySelector('.se-item-text')?.focus();
            }
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

    // 前置条件清单的搜索框：按 data-search 就地过滤，不重绘。
    root.addEventListener('input', (event) => {
        const search = event.target.closest?.('[data-require-search]');
        if (!search) {
            return;
        }
        const panel = search.closest('.se-require-panel');
        const query = String(search.value || '').trim().toLowerCase();
        panel?.querySelectorAll('.se-require-row').forEach((row) => {
            row.hidden = Boolean(query) && !(row.dataset.search || '').includes(query);
        });
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
        } else if (target.dataset.summonBy) {
            const root = document.getElementById('se-editor');
            const by = [...(root?.querySelectorAll('[data-summon-by]') || [])]
                .filter((el) => el.checked)
                .map((el) => el.dataset.summonBy);
            setDeckField(deckId, 'summon.by', by);
            const fresh = getStore();
            const freshDeck = fresh?.decks.find((item) => item.id === deckId);
            const names = (freshDeck?.summon?.by || []).map((id) => fresh.decks.find((item) => item.id === id)?.name || id);
            const summary = document.getElementById('se-summon-summary');
            if (summary) {
                summary.textContent = names.length ? `已选 ${names.length} 个：${names.join('、')}` : '还没有合集能唤起它，点这里选择';
                summary.title = names.join('、');
            }
        } else if ('summonOnly' in target.dataset) {
            setDeckField(deckId, 'summon.only', target.checked);
        } else if (target.dataset.scanField) {
            const root = document.getElementById('se-editor');
            const fields = [...(root?.querySelectorAll('[data-scan-field]') || [])]
                .filter((el) => el.checked)
                .map((el) => el.dataset.scanField);
            setDeckField(deckId, 'scan.fields', fields);
        } else if (target.dataset.itemField) {
            const row = target.closest('.se-item-row');
            if (row?.dataset.item) {
                // 勾选框传 checked；普通输入框传 value。
                const value = target.type === 'checkbox' ? target.checked : target.value;
                setItemField(deckId, row.dataset.item, target.dataset.itemField, value);
            }
        } else if (target.dataset.requireRef) {
            const row = target.closest('.se-item-row');
            if (row?.dataset.item) {
                const checked = [...row.querySelectorAll('[data-require-ref]')].filter((el) => el.checked);
                const refs = checked.map((el) => el.dataset.requireRef);
                setItemField(deckId, row.dataset.item, 'requires', refs);
                // 只更新这一行的摘要，不重绘整块（否则正在勾的列表会被收起来）。
                const summary = row.querySelector('.se-require-block > summary');
                if (summary) {
                    const names = checked.map((el) => el.closest('label')?.querySelector('span')?.textContent?.trim() || el.dataset.requireRef);
                    summary.textContent = names.length
                        ? `前置：已选 ${names.length} 个（${names.slice(0, 2).join('、')}${names.length > 2 ? '…' : ''}）`
                        : '前置：无';
                }
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
        setTimeout(() => {
            restoreFirstMesFor(currentCharacterCard()).catch((error) => {
                console.warn('[state-engine] 恢复开局失败', error);
            });
        }, 600);
        setTimeout(() => {
            fixWarningChatMessage().catch((error) => {
                console.warn('[state-engine] 修复聊天开头失败', error);
            });
        }, 1200);
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
        // 装了插件的人打开带提醒的卡时，把开局换回作者写的那一条。
        setTimeout(() => {
            restoreFirstMesAll()
                .then(() => fixWarningChatMessage())
                .catch((error) => console.warn('[state-engine] 恢复开局失败', error));
        }, 4000);
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
