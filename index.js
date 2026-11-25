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
    PACK_SCHEMA,
    DEFAULT_SCAN,
    DEFAULT_SUMMON,
    DEFAULT_TRIGGER,
    SCAN_FIELDS,
    normalizeKeywords,
    normalizeRequires,
    normalizeExcludes,
    normalizeFatigue,
    normalizeLockTargets,
    normalizeTimeUnit,
    serializePack,
    validatePack,
} from './src/pack.js';
import {
    applyInitial,
    captureFrame,
    clearDeckHistory,
    clearCurrent,
    clearProgress,
    createState,
    currentItems,
    deckState,
    doneSet,
    drawDeck,
    drawDeckTree,
    activeLockDeck,
    availableItems,
    currentGameDay,
    deckExhausted,
    endHold,
    expireIfDue,
    hasCurrent,
    holdActive,
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
/** 时间提示的默认模板：{{time}} 现在的时间，{{paths}} 要改的变量路径，{{example}} 一条示例。 */
const DEFAULT_TIME_TEMPLATE = [
    '【时间】现在是 {{time}}。',
    '如果这一轮剧情确实跨到了新的一天，请把时间和日期一起改掉（用这张卡本来改变量的写法）：',
    '{{paths}}',
    '{{example}}',
    '没跨天就不要改；也不要为了更新时间而硬推进剧情。',
].join('\n');

let settings = { enabled: true, aiTemplate: DEFAULT_AI_TEMPLATE, aiDepth: 4, timeTemplate: DEFAULT_TIME_TEMPLATE, timeDepth: 4, autoCardSync: false, globalDecks: [] };
/** 合集数据改动过、还没写进角色卡。勾了「导出时自动带上」时，导出那一刻才真正写。 */
let cardSyncDirty = false;
let selectedDeckId = null;
let airExpanded = false;
// 条目列表一次渲染多少条：条目多时先渲染一段，剩下的点「显示更多」再补。
const ITEMS_PAGE_SIZE = 60;
let itemsShown = ITEMS_PAGE_SIZE;
let itemsDeckId = '';
// 用户手动关掉「卡里带了合集」提示条后，记住是哪张卡、多少个，避免一直弹。
let cardHintDismissed = '';
let lastPromptedAvatar = '';

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
    deck.lock = deck.lock === true;
    deck.lockTargets = normalizeLockTargets(deck.lockTargets);
    deck.reveal = deck.reveal === 'deck' ? 'deck' : 'items';
    deck.timeUnit = normalizeTimeUnit(deck.timeUnit);
    deck.compose = Array.isArray(deck.compose)
        ? [...new Set(deck.compose.filter((id) => typeof id === 'string' && id))]
        : [];
    if (!deck.hold) {
        deck.hold = { ...DEFAULT_HOLD };
    } else {
        if (!['turns', 'days', 'forever', 'ai'].includes(deck.hold.mode)) {
            deck.hold.mode = DEFAULT_HOLD.mode;
        }
        const turns = Number(deck.hold.turns);
        deck.hold.turns = Number.isFinite(turns) ? Math.max(1, Math.floor(turns)) : DEFAULT_HOLD.turns;
        const days = Number(deck.hold.days);
        deck.hold.days = Number.isFinite(days) ? Math.max(1, Math.floor(days)) : DEFAULT_HOLD.days;
    }
    // 导出的包把层级写在 nesting 里，导入时映射回内部的 parent / onlyFromParent / entryWeight。
    if (deck.nesting && typeof deck.nesting === 'object') {
        if (typeof deck.parent !== 'string') {
            deck.parent = typeof deck.nesting.parent === 'string' ? deck.nesting.parent : DEFAULT_NESTING.parent;
        }
        if (typeof deck.onlyFromParent !== 'boolean') {
            deck.onlyFromParent = deck.nesting.onlyFromParent === true;
        }
        if (!Number.isFinite(Number(deck.entryWeight))) {
            deck.entryWeight = Number.isFinite(Number(deck.nesting.entryWeight))
                ? Math.max(0, Number(deck.nesting.entryWeight))
                : DEFAULT_NESTING.entryWeight;
        }
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
            if (!Array.isArray(item.excludes)) {
                item.excludes = [];
            } else {
                item.excludes = normalizeExcludes(item.excludes);
            }
            item.enabled = item.enabled !== false;
            item.excludeSiblings = item.excludeSiblings === true;
            item.initial = item.initial === true;
            const ownCooldown = Number(item.cooldown);
            item.cooldown = Number.isFinite(ownCooldown) && item.cooldown !== null && item.cooldown !== '' ? Math.max(0, Math.floor(ownCooldown)) : null;
            // 条目自己的持续时长：没设就是 null（跟随合集）。
            if (item.hold && typeof item.hold === 'object' && ['turns', 'days', 'forever', 'ai'].includes(item.hold.mode)) {
                item.hold = {
                    mode: item.hold.mode,
                    turns: Math.max(1, Number(item.hold.turns) || 3),
                    days: Math.max(1, Number(item.hold.days) || 1),
                };
            } else {
                item.hold = null;
            }
            // 动态权重（疲劳 / 增益）：没设就是 null。
            item.fatigue = normalizeFatigue(item.fatigue);
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
    cardSyncDirty = true;
    const ctx = liveContext();
    // 每次落盘前给当前楼层拍一张快照，删楼 / 重生成 / 切分支时才能跟着回退。
    const store = getStore({ create: false });
    if (store?.state) {
        try {
            captureFrame(store.state);
        } catch (error) {
            console.warn('[state-engine] snapshot failed', error);
        }
    }
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
async function exportDecksToCard(options = {}) {
    const { silent = false } = options;
    const ctx = liveContext();
    const character = currentCharacterCard();
    const store = getStore();
    if (!character?.avatar) {
        if (!silent) {
            toast('error', '先在右侧选一张角色卡');
        }
        return false;
    }
    if (!store || store.decks.length === 0) {
        if (!silent) {
            toast('error', '当前聊天还没有合集');
        }
        return false;
    }
    const seeds = boundDeckIds(store, ctx);
    const chosen = collectRelatedDecks(store.decks, seeds.length > 0 ? seeds : store.decks.map((deck) => deck.id));
    if (chosen.length === 0) {
        return false;
    }
    if (!silent) {
        const list = chosen.map((deck) => deck.name || deck.id).join('、');
        const ok = window.confirm(
            `把 ${chosen.length} 个合集写进「${character.name || '这张卡'}」？\n\n${list}\n\n写进去之后，你在酒馆里导出这张角色卡时，数据会跟着卡一起走。\n同时会把这张卡的开局第一条换成「需要安装插件」的提醒，原来的开局挪到第二开局；装了插件的人打开时会自动换回来。`,
        );
        if (!ok) {
            return false;
        }
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
            alternate_greetings: '__@@UNSET@@__',
            data: {
                extensions: { [CARD_EXT_KEY]: '__@@UNSET@@__' },
                alternate_greetings: '__@@UNSET@@__',
            },
        });
        await saveCharacterMerge({
            avatar: character.avatar,
            first_mes: data.first_mes,
            alternate_greetings: data.alternate_greetings,
            data,
        });
        // 本地对象同步一份，免得面板上还显示旧提示。
        character.first_mes = data.first_mes;
        character.alternate_greetings = data.alternate_greetings;
        character.data = character.data || {};
        character.data.first_mes = data.first_mes;
        character.data.alternate_greetings = data.alternate_greetings;
        character.data.extensions = { ...(character.data.extensions || {}), ...data.extensions };
        if (data.character_book) {
            character.data.character_book = data.character_book;
        }
        if (!silent) {
            toast('success', `已把 ${decks.length} 个合集写进「${character.name || '这张卡'}」`);
        }
        cardSyncDirty = false;
        if (!silent) {
            renderPanel();
        }
        return true;
    } catch (error) {
        console.error('[state-engine] 写角色卡失败', error);
        if (!silent) {
            toast('error', error.message || '写角色卡失败');
        }
        return false;
    }
}

/**
 * 勾了「导出角色卡时自动带上合集」之后：
 * 在酒馆把卡发出去之前，先把手上的合集写进卡；导出完成后再把本地卡的开场白恢复，
 * 免得你自己的卡一直停在「请安装插件」的提醒状态。
 */
function installCardExportHook() {
    if (installCardExportHook.installed) {
        return;
    }
    installCardExportHook.installed = true;
    const originalFetch = window.fetch;
    installCardExportHook.originalFetch = originalFetch;
    window.fetch = async function patchedFetch(input, init) {
        let url = '';
        try {
            url = typeof input === 'string' ? input : String(input?.url || '');
        } catch {
            url = '';
        }
        const isExport = url.includes('/api/characters/export');
        const autoSync = settings.autoCardSync === true;
        if (!isExport || !autoSync || !cardSyncDirty) {
            return originalFetch.call(this, input, init);
        }
        const character = currentCharacterCard();
        if (!character?.avatar) {
            return originalFetch.call(this, input, init);
        }
        let wrote = false;
        try {
            wrote = await exportDecksToCard({ silent: true });
        } catch (error) {
            console.error('[state-engine] 导出前同步失败', error);
        }
        const response = await originalFetch.call(this, input, init);
        if (wrote) {
            try {
                await restoreFirstMesFor(character);
            } catch (error) {
                console.error('[state-engine] 导出后恢复开场白失败', error);
            }
        }
        return response;
    };
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

/** 把角色卡里的合集导进当前聊天。默认只补缺失，不覆盖已有内容。 */
function importCardDecks(options = {}) {
    const overwrite = options.overwrite === true;
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
    let skipped = 0;
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
            if (overwrite) {
                store.decks[index] = deck;
                replaced += 1;
            } else {
                skipped += 1;
            }
        } else {
            store.decks.push(deck);
            added += 1;
        }
    }
    saveStore({ immediate: true });
    refreshInjections();
    renderPanel();
    cardHintDismissed = '';
    if (skipped > 0 && !overwrite) {
        toast('success', `已导入：新增 ${added} 个；${skipped} 个同名合集已存在，保持原样没有覆盖`);
    } else {
        toast('success', `已从角色卡导入：新增 ${added} 个，覆盖 ${replaced} 个`);
    }
    return { added, replaced, skipped };
}

// ---------------------------------------------------------------------------
// 公共合集库：存在扩展设置里，跨聊天、跨角色卡。只做「复制一份」，
// 复制进聊天后就变成普通合集，各聊天的修改互不影响。
// ---------------------------------------------------------------------------

function globalDecks() {
    return Array.isArray(settings.globalDecks) ? settings.globalDecks : [];
}

const GLOBAL_CACHE_KEY = 'stateEngine.globalDecks';
const GLOBAL_CACHE_LIMIT = 2 * 1024 * 1024;
let globalCacheWarned = false;

/** 往 localStorage 里留一份公共库镜像；太大或存不下时只警告一次，不挡正常保存。 */
function mirrorGlobalDecks() {
    const serialized = JSON.stringify(Array.isArray(settings.globalDecks) ? settings.globalDecks : []);
    try {
        if (serialized.length > GLOBAL_CACHE_LIMIT) {
            localStorage.removeItem(GLOBAL_CACHE_KEY);
            if (!globalCacheWarned) {
                globalCacheWarned = true;
                toast('warning', '公共库太大了，浏览器里不再留副本（不影响正常保存）。建议定期点「导出公共库」备份。');
            }
            return;
        }
        localStorage.setItem(GLOBAL_CACHE_KEY, serialized);
    } catch (error) {
        if (!globalCacheWarned) {
            globalCacheWarned = true;
            toast('warning', '浏览器本地存储满了，公共库副本没写成。请点「导出公共库」备份一次。');
        }
    }
}

function saveGlobalDecks(list) {
    settings.globalDecks = Array.isArray(list) ? list : [];
    mirrorGlobalDecks();
    saveSettings();
}

/** 把当前聊天里的某个合集存进公共库（同 id 视为更新）。 */
function publishDeckToGlobal(deckId) {
    const store = getStore();
    const deck = store?.decks.find((item) => item.id === deckId);
    if (!deck) {
        toast('error', '先在左栏选一个合集');
        return;
    }
    const family = [deck, ...descendantDecks(store.decks, deck.id)];
    const snapshots = family.map((item) => normalizeDeckShape(JSON.parse(JSON.stringify(item))));
    const ids = new Set(snapshots.map((snapshot) => snapshot.id));
    const list = globalDecks().filter((item) => !ids.has(item?.id));
    list.push(...snapshots);
    saveGlobalDecks(list);
    renderGlobalBlock();
    const extra = snapshots.length - 1;
    toast('success', extra > 0
        ? `「${deck.name}」和它的 ${extra} 个子合集已发布到公共库`
        : `「${snapshotName(snapshots[0])}」已发布到公共库（${snapshots[0].items?.length || 0} 条）`);
}

function snapshotName(deck) {
    return deck?.name || deck?.id || '合集';
}

/** 把公共库里的合集复制一份到当前聊天，id 冲突时自动改名。 */
function copyGlobalToChat(globalId) {
    const all = globalDecks();
    const source = all.find((item) => item?.id === globalId);
    const store = getStore({ create: true });
    if (!source || !store) {
        toast('error', '先打开一个聊天');
        return;
    }
    const group = [source, ...descendantDecks(all, source.id)];
    const idMap = new Map();
    const used = new Set(store.decks.map((item) => item.id));
    for (const item of group) {
        const base = item.id || 'deck';
        let nextId = base;
        let n = 2;
        while (used.has(nextId)) {
            nextId = `${base}-${n}`;
            n += 1;
        }
        used.add(nextId);
        idMap.set(item.id, nextId);
    }
    const copies = group.map((item) => {
        const deck = normalizeDeckShape(JSON.parse(JSON.stringify(item)));
        const originalId = deck.id;
        deck.id = idMap.get(originalId);
        if (deck.id !== originalId) {
            deck.name = `${deck.name || originalId}（副本）`;
        }
        if (deck.parent) {
            deck.parent = idMap.get(deck.parent) || deck.parent;
        }
        return deck;
    });
    store.decks.push(...copies);
    selectedDeckId = copies[0]?.id || source.id;
    saveStore({ immediate: true });
    refreshInjections();
    renderPanel();
    toast('success', `已把「${copies[0]?.name || source.name || source.id}」复制到当前聊天（${copies[0]?.items?.length || 0} 条）`);
}

function removeGlobalDeck(globalId) {
    saveGlobalDecks(globalDecks().filter((item) => item?.id !== globalId));
    renderGlobalBlock();
}

function renderGlobalBlock() {
    const list = document.getElementById('se-global-list');
    if (!list) {
        return;
    }
    const decks = globalDecks();
    if (decks.length === 0) {
        list.innerHTML = '<p class="se-muted">公共库是空的。选中一个合集后点「把当前合集发布到公共库」，以后任何聊天都能一键复制。</p>';
        return;
    }
    list.innerHTML = orderedDecks(decks).map(({ deck, depth }) => {
        const childCount = decks.filter((item) => item && item.parent === deck.id).length;
        const parts = [`${(deck.items || []).length} 条`];
        if (childCount > 0) {
            parts.push(`${childCount} 个子合集`);
        }
        const indent = depth * 16;
        const prefix = depth > 0 ? '└ ' : '';
        return `
        <div class="se-global-row">
            <span class="se-global-name" style="padding-left:${indent}px">${prefix}${escapeHtml(deck.name || deck.id)}</span>
            <span class="se-global-count">${parts.join(' · ')}</span>
            <button type="button" class="menu_button" data-action="copy-global" data-deck="${escapeHtml(deck.id)}">复制到本聊天</button>
            <button type="button" class="menu_button" data-action="delete-global" data-deck="${escapeHtml(deck.id)}">移出公共库</button>
        </div>
    `;
    }).join('');
}

async function importGlobalFiles(files) {
    const list = [...globalDecks()];
    let added = 0;
    for (const file of files) {
        let parsed;
        try {
            parsed = JSON.parse(await file.text());
        } catch (error) {
            toast('error', `${file.name} 不是合法 JSON`);
            continue;
        }
        const packs = Array.isArray(parsed) ? parsed : [parsed];
        for (const raw of packs) {
            const result = validatePack(raw);
            if (!result.ok) {
                toast('error', `${file.name}：${result.errors[0] || '格式不对'}`);
                continue;
            }
            const deck = normalizeDeckShape(JSON.parse(JSON.stringify(result.pack)));
            const index = list.findIndex((item) => item?.id === deck.id);
            if (index >= 0) {
                list[index] = deck;
            } else {
                list.push(deck);
                added += 1;
            }
        }
    }
    saveGlobalDecks(list);
    renderGlobalBlock();
    toast('success', `公共库已更新（新增 ${added} 个）`);
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
        first_mes: guard.original,
        data: { first_mes: guard.original, alternate_greetings: '__@@UNSET@@__' },
    });
    await saveCharacterMerge({
        avatar: character.avatar,
        alternate_greetings: greetings,
        data: { alternate_greetings: greetings },
    });
    await saveCharacterMerge({
        avatar: character.avatar,
        data: { extensions: { [CARD_EXT_KEY]: { [FIRST_MES_GUARD_KEY]: '__@@UNSET@@__' } } },
    });
    character.first_mes = guard.original;
    character.alternate_greetings = greetings;
    character.data.first_mes = guard.original;
    character.data.alternate_greetings = greetings;
    const ext = character.data.extensions?.[CARD_EXT_KEY];
    if (ext && typeof ext === 'object') {
        delete ext[FIRST_MES_GUARD_KEY];
    }
    return true;
}

/**
 * 角色编辑面板里的「开场白」输入框如果还显示着安装提醒，当场换成原文。
 * 恢复是要写回角色卡的，写完不一定有人重绘面板，所以这里直接补一刀。
 */
function refreshCharacterEditorFirstMes(original) {
    if (typeof original !== 'string' || !original.trim()) {
        return;
    }
    const textarea = document.getElementById('firstmessage_textarea');
    if (textarea && isFirstMesWarning(textarea.value)) {
        textarea.value = original;
    }
    const wrapper = document.getElementById('firstMessageWrapper');
    if (wrapper) {
        const preview = wrapper.querySelector('.mes_text');
        if (preview && isFirstMesWarning(preview.textContent || '')) {
            preview.textContent = original;
        }
    }
}

/**
 * 改完 chat[0] 还要刷新界面上那条消息。
 * 不用 ctx.updateMessageBlock：ST 1.19 里它内部会读 reasoning 元素的属性，
 * 直接调用会抛 getAttribute 错误，所以这里只替换第一楼正文的文字。
 */
function refreshFirstMessageDom(text) {
    try {
        let el = document.querySelector('#chat .mes[mesid="0"] .mes_text');
        if (!el) {
            // 长聊天会把前几楼折叠起来，这时 mesid="0" 根本不在 DOM 里；
            // 退一步：找 #chat 下第一条正文以提醒开头的消息替换掉。
            const first = [...document.querySelectorAll('#chat .mes')].find((node) => isFirstMesWarning(node.querySelector('.mes_text')?.textContent || ''));
            el = first?.querySelector('.mes_text') || null;
        }
        if (el) {
            el.textContent = text;
        }
    } catch (error) {
        console.warn('[state-engine] 刷新第一条消息显示失败', error);
    }
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
    refreshFirstMessageDom(original);
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
    refreshFirstMessageDom(original);
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

/**
 * 新聊天第一次打开时，把勾了「作为初始值」的条目直接生效。
 * 返回 true 表示这次改动了数据，调用方负责保存。
 */
function seedInitialDecks(store) {
    if (!store) {
        return false;
    }
    let changed = false;
    for (const deck of store.decks) {
        if (deck.enabled === false) {
            continue;
        }
        const { applied } = applyInitial(store.state, deck);
        if (applied.length > 0) {
            changed = true;
        }
    }
    return changed;
}

/**
 * 插件在 MVU 变量里注册的时间字段（stat_data 下），变量管理器里能直接看到、能改。
 * 卡自己已经有日期时不动它；没有才写这块。
 */
const MVU_TIME_KEY = '状态引擎时间';

function mvuRoot(ctx) {
    const md = ctx?.chatMetadata;
    if (!md) {
        return null;
    }
    if (!md.variables || typeof md.variables !== 'object') {
        md.variables = {};
    }
    if (!md.variables.stat_data || typeof md.variables.stat_data !== 'object') {
        md.variables.stat_data = {};
    }
    return md.variables.stat_data;
}

/** 读（必要时创建）插件在 MVU 里的时间字段。 */
function ensureMvuTime(ctx) {
    const root = mvuRoot(ctx);
    if (!root) {
        return null;
    }
    const existing = root[MVU_TIME_KEY];
    if (existing && typeof existing === 'object') {
        if (!existing.日期) existing.日期 = '第1天';
        if (!existing.时间) existing.时间 = '08:00';
        if (!existing.天气) existing.天气 = '晴';
        return existing;
    }
    const seed = { 日期: '第1天', 时间: '08:00', 天气: '晴' };
    root[MVU_TIME_KEY] = seed;
    return seed;
}

/** 「第12天」→ 12；认不出返回 null。 */
function parsePluginDay(text) {
    const match = String(text || '').match(/第\s*(\d{1,6})\s*天/);
    return match ? Number(match[1]) : null;
}

const DATE_LIKE_RE = /(\d{1,5})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/;

/** 从变量里找可读的日期文本（卡自带的「天元482年7月15日」这类），找不到返回空串。 */
function currentDateText(ctx) {
    const variables = ctx?.chatMetadata?.variables;
    const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 4) {
            return '';
        }
        for (const [key, value] of Object.entries(node)) {
            if (typeof value === 'string' && (DATE_LIKE_RE.test(value) || /^第\s*\d+\s*天/.test(value))) {
                if (/日期|时间|date|time|day/i.test(key) || DATE_LIKE_RE.test(value)) {
                    return value.trim();
                }
            }
            if (value && typeof value === 'object') {
                const found = walk(value, depth + 1);
                if (found) {
                    return found;
                }
            }
        }
        return '';
    };
    return walk(variables, 0);
}

/**
 * 给模型看的时间提示：告诉它现在是哪一天，以及跨天时按 MVU 规则更新哪个变量。
 * 没有日期时返回空串（不注入）。
 */
/** 看这张卡本来用什么方式改变量，时间提示才能给出对得上的写法。 */
function mvuUpdateStyle(ctx) {
    const char = currentCharacterCard();
    const bag = [];
    if (char) {
        const data = char.data || {};
        bag.push(data.description, data.personality, data.scenario, data.system_prompt,
            data.post_history_instructions, data.first_mes);
        for (const entry of data.character_book?.entries || []) {
            bag.push(entry.content, entry.comment);
        }
    }
    const text = bag.filter(Boolean).join('\n');
    if (!text) {
        return 'none';
    }
    if (/<UpdateVariable>/i.test(text) || /JSONPatch/i.test(text)) {
        return 'patch';
    }
    if (/变量更新|更新变量|stat_data|变量管理器/.test(text)) {
        return 'generic';
    }
    return 'none';
}

/** 时间提示的默认模板：{{time}} 现在的时间，{{paths}} 要改的变量路径，{{example}} 一条示例。 */
function buildTimeHint(ctx) {
    const dateText = currentDateText(ctx);
    const root = ctx?.chatMetadata?.variables?.stat_data;
    const time = root && typeof root === 'object' && root[MVU_TIME_KEY] && typeof root[MVU_TIME_KEY] === 'object'
        ? root[MVU_TIME_KEY]
        : null;
    const fallback = time ? String(time.日期 || '') : '';
    const text = dateText || fallback;
    if (!text) {
        return '';
    }
    const extra = time && (time.时间 || time.天气) ? `（${[time.时间, time.天气].filter(Boolean).join(' · ')}）` : '';
    const style = mvuUpdateStyle(ctx);
    const paths = style === 'patch'
        ? `- /${MVU_TIME_KEY}/日期\n- /${MVU_TIME_KEY}/时间\n- /${MVU_TIME_KEY}/天气`
        : style === 'generic'
            ? `- ${MVU_TIME_KEY}.日期 / ${MVU_TIME_KEY}.时间 / ${MVU_TIME_KEY}.天气`
            : '';
    const example = style === 'patch'
        ? [
            '照下面这个块写，三条一起放进同一个 JSONPatch（值按剧情改）：',
            '<UpdateVariable>',
            '<Analysis>跨到了新的一天，把日期和时间一起推进。</Analysis>',
            '<JSONPatch>',
            '[',
            `  {"op":"replace","path":"/${MVU_TIME_KEY}/日期","value":"第 2 天"},`,
            `  {"op":"replace","path":"/${MVU_TIME_KEY}/时间","value":"清晨"},`,
            `  {"op":"replace","path":"/${MVU_TIME_KEY}/天气","value":"晴"}`,
            ']',
            '</JSONPatch>',
            '</UpdateVariable>',
        ].join('\n')
        : '';
    const template = String(settings.timeTemplate || DEFAULT_TIME_TEMPLATE);
    const lines = [];
    for (const line of template.split('\n')) {
        if (line.includes('{{paths}}') && !paths) {
            continue;
        }
        if (line.includes('{{example}}') && !example) {
            continue;
        }
        lines.push(line
            .replace(/\{\{time\}\}/g, `${text}${extra}`)
            .replace(/\{\{paths\}\}/g, paths)
            .replace(/\{\{example\}\}/g, example));
    }
    return lines.join('\n').trim();
}

/**
 * 插件自带的时间：卡里没有 MVU 日期时，用它来推进「按天」的清单。
 * 写进 MVU 变量（stat_data.状态引擎时间），变量管理器里能看到。
 */
const WEATHERS = ['晴', '多云', '阴', '小雨', '雪'];

function ensurePluginTime(store, ctx) {
    const time = ensureMvuTime(ctx || liveContext());
    if (!time) {
        return null;
    }
    if (!store?.state) {
        return time;
    }
    // 把「每几楼过一天」这类插件配置放在 state 里，变量本身放在 MVU 里。
    const config = store.state.timeConfig && typeof store.state.timeConfig === 'object' ? store.state.timeConfig : {};
    if (!Number.isFinite(Number(config.advanceEvery))) {
        config.advanceEvery = 0;
    }
    if (!Number.isFinite(Number(config.lastTurn))) {
        config.lastTurn = -1;
    }
    store.state.timeConfig = config;
    return time;
}

/**
 * 当前游戏内天数：优先卡自带的 MVU 日期，没有就用插件在 MVU 里注册的时间。
 * 两者都没有时返回 null（按天冷却的合集就退回按楼层）。
 */
function effectiveGameDay(store, ctx) {
    const fromCard = currentGameDay(ctx);
    if (fromCard !== null) {
        store.state.timeSource = 'card';
        return fromCard;
    }
    const time = ensurePluginTime(store, ctx);
    if (!time) {
        return null;
    }
    store.state.timeSource = 'plugin';
    const day = parsePluginDay(time.日期);
    return day !== null ? day : 1;
}

function syncGameDay(store) {
    // 抽签前先把「今天」算出来，抽中的条目才能记下起始日期（按天持续用得上）。
    try {
        const day = effectiveGameDay(store, liveContext());
        if (Number.isFinite(Number(day))) {
            store.state.gameDay = day;
        }
    } catch {
        // 日期读不到就保持原值，按天的规则会自己跳过。
    }
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
    if (seedInitialDecks(store)) {
        saveStore({ immediate: true });
    }
    // 打开聊天、每轮生成前都顺手检查一次：第一条如果还是安装提醒，就换回原开局。
    fixWarningChatMessage().catch(() => {});
    // 卡里没有日期时，插件只在 MVU 变量里放一个初始日期（不自动推进），供「按天」的清单读取。
    ensureMvuTime(ctx);
    const gameDay = effectiveGameDay(store, ctx);
    if (gameDay !== null) {
        store.state.gameDay = gameDay;
    }
    // 时间提示：告诉模型现在是哪一天，跨天时按 MVU 规则更新「状态引擎时间」。
    const timeDepth = Math.max(0, Number(settings.timeDepth) || 0);
    ctx.setExtensionPrompt('stateEngine:time', buildTimeHint(ctx), PROMPT_POSITION.chat, timeDepth, false, PROMPT_ROLE.system);
    for (const deck of store.decks) {
        if (deck.enabled === false || !bindingActive(deck, ctx)) {
            ctx.setExtensionPrompt(promptKey(deck.id), '', PROMPT_POSITION.chat, 0, false, PROMPT_ROLE.system);
            continue;
        }
        injectDeck(ctx, deck, currentItems(store.state, deck), deckState(store.state, deck.id).rendered || {});
    }
    // 已经删除的合集，把残留的注入键清掉。
    const alive = new Set(store.decks.map((deck) => promptKey(deck.id)));
    for (const key of Object.keys(ctx.extensionPrompts || {})) {
        if (key.startsWith('stateEngine:deck:') && !alive.has(key)) {
            ctx.setExtensionPrompt(key, '', 0, 0, false, 0);
        }
    }
    // 导演提示只列此刻真的会生效的合集：绑定角色不在场、或只能被上级抽中的子合集，都别让模型白申请。
    // 不可打断生效时，只把锁定合集和「没被它压制」的例外交给模型。
    const lockDeck = activeLockDeck(store.state, store.decks);
    const suppressedIds = lockDeck
        ? store.decks.filter((deck) => lockSuppresses(deck, lockDeck)).map((deck) => deck.id)
        : [];
    const directorDecks = store.decks.filter((deck) => {
        if (deck.enabled === false || !bindingActive(deck, ctx)) {
            return false;
        }
        if (lockDeck) {
            return deck.id === lockDeck.id || !lockSuppresses(deck, lockDeck);
        }
        return deck.onlyFromParent !== true && deck.summon?.only !== true;
    });
    const itemsByDeck = Object.fromEntries(store.decks.map((deck) => [deck.id, Array.isArray(deck.items) ? deck.items : []]));
    // 告诉模型「每份清单现在停在哪一条、后面还有哪些」——嵌套剧情线时它才知道下一幕是什么。
    const currentByDeck = Object.fromEntries(store.decks.map((deck) => {
        const ids = (store.state?.decks?.[deck.id]?.current || []).map((item) => item?.id).filter(Boolean);
        return [deck.id, ids];
    }));
    const director = buildDirectorPrompt(directorDecks, settings.aiTemplate, itemsByDeck, {
        currentByDeck,
        done: doneSet(store.state),
        state: store.state,
        // 只有真的压住了别人，才告诉模型「有东西在休眠」；否则它会把例外项也当成不能申请的。
        lockName: lockDeck && suppressedIds.length > 0 ? lockDeck.name : '',
        suppressedCount: suppressedIds.length,
    });
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
 * 「不可打断」到底压制谁：
 * - 没有指定压制名单时，只压同一层的其它合集（父合集相同）；
 * - 指定了名单时，只压名单里的合集，其它层级的完全不受影响。
 */
function lockSuppresses(deck, lockDeck) {
    if (!lockDeck || !deck || deck.id === lockDeck.id) {
        return false;
    }
    const targets = Array.isArray(lockDeck.lockTargets) ? lockDeck.lockTargets : [];
    if (targets.length > 0) {
        return targets.includes(deck.id);
    }
    return String(deck.parent || '') === String(lockDeck.parent || '');
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
    syncGameDay(store);
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
    const endedIds = [];
    if (endMarkers.length > 0 && markerFloor !== floor) {
        for (const deck of store.decks) {
            if (deck.enabled === false || (deck.trigger || DEFAULT_TRIGGER).ai !== true) {
                continue;
            }
            if (endMarkers.includes(deck.id)) {
                if (endHold(store.state, deck)) {
                    endedIds.push(deck.id);
                }
            }
        }
    }

    // 「不可打断」的合集在管事时，自动抽取（楼层/关键词/AI）只认它。
    const lockDeck = activeLockDeck(store.state, store.decks);

    for (const deck of store.decks) {
        if (deck.enabled === false || !bindingActive(deck, ctx, pendingInput)) {
            continue;
        }
        if (lockSuppresses(deck, lockDeck)) {
            continue;
        }
        // 已经抽无可抽的合集，不再参与自动抽取。
        if (deckExhausted(store.state, store.decks, deck.id)) {
            continue;
        }
        // 开着「不可打断」的合集就是此刻的焦点：哪怕它是子合集 / 只能被上级抽中，
        // 也允许 AI 直接推进它，否则锁住了却没人能抽，等于卡死。
        const isLockedDeck = Boolean(lockDeck && deck.id === lockDeck.id);
        if (!isLockedDeck) {
            // 「只能被上级抽中」的子合集，正常对话的自动/关键词/AI 都不碰它。
            if (deck.onlyFromParent === true) {
                continue;
            }
            // 有上级合集的，什么时候抽由上级决定：自己不参与楼层自动/关键词/AI 判定。
            if (deck.parent) {
                continue;
            }
            // 「只在被唤起时出场」的合集，普通对话的自动/关键词/AI 都不碰它。
            if ((deck.summon || DEFAULT_SUMMON).only === true) {
                continue;
            }
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

    // 只喊了结束、没有接上新内容的合集：这里补抽一次，避免剧情断在半路。
    for (const endedId of endedIds) {
        if (fired.includes(endedId)) {
            continue;
        }
        const deck = store.decks.find((item) => item.id === endedId);
        if (!deck || deck.enabled === false || !bindingActive(deck, ctx, pendingInput)) {
            continue;
        }
        if (deckExhausted(store.state, store.decks, deck.id)) {
            continue;
        }
        // 换一条：推一下随机流，别又抽回刚结束的那条。
        const endedState = deckState(store.state, deck.id);
        endedState.nonce = (Number(endedState.nonce) || 0) + 1;
        const tree = drawDeckTree(store.state, store.decks, deck.id, {
            force: true,
            cause: 'ai',
            ignoreHold: true,
        });
        if (tree.result?.changed) {
            fired.push(deck.id);
        }
    }

    // 只有真的抽中了才记住「这一楼处理过标记」，否则一次失败会把这个楼层永久锁死。
    if (freshMarkers.length > 0 && fired.length > 0) {
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
    // 锁定中的合集管事时，别人不能被唤起。
    const lockDeck = activeLockDeck(store.state, store.decks);
    let frontier = seededIds.slice();
    for (let round = 0; round < MAX_SUMMON_ROUNDS && frontier.length > 0; round += 1) {
        const nextFrontier = [];
        for (const sourceId of frontier) {
            for (const deck of store.decks) {
                if (visited.has(deck.id) || deck.enabled === false || !bindingActive(deck, ctx)) {
                    continue;
                }
                if (lockSuppresses(deck, lockDeck)) {
                    continue;
                }
                if (deckExhausted(store.state, store.decks, deck.id)) {
                    continue;
                }
                // 当前内容还在持续期里，就别把它换掉。
                if (holdActive(store.state, deck)) {
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
    syncGameDay(store);
    // 「不可打断」的合集开着时，手动抽别的会被自动抽取忽略，先说一句。
    const lockDeck = activeLockDeck(store.state, store.decks);
    if (lockDeck && lockSuppresses(deck, lockDeck)) {
        toast('info', `「${lockDeck.name || lockDeck.id}」开着不可打断，自动抽取不会碰这个合集。`);
    }
    // 每按一次「抽/重抽」都推进一期随机流：同楼层同一个 nonce 只会得到同一个结果。
    ds.nonce = (Number(ds.nonce) || 0) + 1;
    const tree = drawDeckTree(store.state, store.decks, deckId, {
        force: true,
        cause: reroll ? 'reroll' : 'manual',
        ignoreHold: true,
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
        compose: [],
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
    const descendants = descendantDecks(store.decks, deckId);
    const extra = descendants.length > 0 ? `\n它下面的 ${descendants.length} 个子合集也会一起删除。` : '';
    if (!globalThis.confirm(`删除合集「${deck.name}」？${extra}\n这只影响当前聊天，原始文件不受影响。`)) {
        return;
    }
    const removeIds = new Set([deckId, ...descendants.map((item) => item.id)]);
    store.decks = store.decks.filter((item) => !removeIds.has(item.id));
    for (const id of removeIds) {
        if (store.state.decks) {
            delete store.state.decks[id];
        }
    }
    if (selectedDeckId && removeIds.has(selectedDeckId)) {
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
    } else if (path === 'lockTargets') {
        deck.lockTargets = normalizeLockTargets(value);
    } else if (path === 'reveal') {
        deck.reveal = value === 'deck' ? 'deck' : 'items';
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
    if (path === 'parent' || path === 'lock') {
        // 父级变了，下拉选项和层级缩进都要重算；开关「不可打断」也要露出/收起压制范围。
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
    const holdDaysField = root.querySelector('[data-deck-field="hold.days"]')?.closest('.se-field');
    if (holdDaysField) {
        holdDaysField.toggleAttribute('hidden', hold.mode !== 'days');
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
/**
 * 立即判断一次：用当前上下文原样问模型一次「现在要不要抽」，不必等下一轮生成。
 * 走 ST 的 generateQuietPrompt，不写入聊天记录，只把模型返回的申请标记拿来抽。
 */
async function judgeNow() {
    const store = getStore({ create: true });
    if (!store) {
        toast('warning', '先打开一个聊天。');
        return;
    }
    if (judgeNow.running) {
        return;
    }
    // 酒馆自己正在生成时再插一次静默生成，会把这边的请求也卡住，先让它跑完。
    const stopBtn = document.getElementById('mes_stop');
    if (stopBtn && getComputedStyle(stopBtn).display !== 'none') {
        toast('info', '酒馆正在生成，等这一轮结束再点「立即判断」。');
        return;
    }
    const ctx = liveContext();
    syncGameDay(store);
    if (typeof ctx?.generateQuietPrompt !== 'function') {
        toast('error', '当前酒馆版本不支持静默生成。');
        return;
    }
    const usable = store.decks.filter((deck) => deck.enabled !== false
        && deck.trigger?.ai === true
        && bindingActive(deck, ctx));
    if (usable.length === 0) {
        toast('info', '没有合集开着「AI 判定」，先勾上再判断。');
        return;
    }
    judgeNow.running = true;
    const btn = document.querySelector('[data-action="judge-now"]');
    btn?.classList.add('se-busy');
    try {
        const itemsByDeck = Object.fromEntries(store.decks.map((deck) => [deck.id, Array.isArray(deck.items) ? deck.items : []]));
        const currentByDeck = Object.fromEntries(store.decks.map((deck) => {
            const ids = (store.state?.decks?.[deck.id]?.current || []).map((item) => item?.id).filter(Boolean);
            return [deck.id, ids];
        }));
        const lockDeck = activeLockDeck(store.state, store.decks);
        const suppressedCount = lockDeck
            ? store.decks.filter((deck) => lockSuppresses(deck, lockDeck)).length
            : 0;
        const prompt = buildDirectorPrompt(
            lockDeck ? usable.filter((deck) => deck.id === lockDeck.id || !lockSuppresses(deck, lockDeck)) : usable,
            settings.aiTemplate,
            itemsByDeck,
            {
                currentByDeck,
                done: doneSet(store.state),
                state: store.state,
                lockName: lockDeck && suppressedCount > 0 ? lockDeck.name : '',
                suppressedCount,
            },
        );
        if (!prompt) {
            toast('info', '现在没有可申请的清单。');
            return;
        }
        toast('info', '正在让模型判断一次…');
        const reply = await Promise.race([
            ctx.generateQuietPrompt({ quietPrompt: prompt, skipWIAN: true }),
            new Promise((resolve) => setTimeout(() => resolve(null), 60000)),
        ]);
        if (reply === null) {
            toast('warning', '模型 60 秒内没有回话，这次判断取消了。');
            return;
        }
        const markers = [...String(reply || '').matchAll(/<!--\s*SE:([a-zA-Z0-9_-]{1,64})\s*-->/g)].map((match) => match[1]);
        if (markers.length === 0) {
            toast('info', '模型这次没有申请任何清单。');
            return;
        }
        let fired = 0;
        for (const id of new Set(markers)) {
            const deck = usable.find((item) => item.id === id);
            if (!deck) {
                continue;
            }
            const tree = drawDeckTree(store.state, store.decks, deck.id, { force: true, cause: 'ai', ignoreHold: true });
            if (tree.result?.changed) {
                fired += 1;
            }
        }
        saveStore({ immediate: fired > 0 });
        refreshInjections();
        refreshPanelLight();
        toast(fired > 0 ? 'success' : 'info', fired > 0 ? `立即判断：抽了 ${fired} 个合集。` : '模型申请了，但没有可抽的条目。');
    } catch (error) {
        toast('error', `立即判断失败：${error?.message || error}`);
    } finally {
        judgeNow.running = false;
        btn?.classList.remove('se-busy');
    }
}

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
    if (field === 'hold.mode') {
        // 空值 = 这条不单独设，跟随合集。
        const mode = String(value || '');
        if (!mode) {
            item.hold = null;
        } else {
            const base = item.hold && typeof item.hold === 'object' ? item.hold : {};
            item.hold = {
                mode,
                turns: Math.max(1, Number(base.turns) || 3),
                days: Math.max(1, Number(base.days) || 1),
            };
        }
    } else if (field === 'hold.turns' || field === 'hold.days') {
        const base = item.hold && typeof item.hold === 'object' ? item.hold : { mode: 'turns', turns: 3, days: 1 };
        item.hold = {
            mode: base.mode || 'turns',
            turns: Math.max(1, Number(base.turns) || 3),
            days: Math.max(1, Number(base.days) || 1),
        };
        item.hold[field.split('.')[1]] = Math.max(1, Math.floor(Number(value) || 1));
    } else if (field.startsWith('fatigue.')) {
        const key = field.split('.')[1];
        if (key === 'mode') {
            const mode = String(value || '');
            item.fatigue = mode && mode !== 'off' ? normalizeFatigue({ ...(item.fatigue || {}), mode }) : null;
        } else if (item.fatigue) {
            item.fatigue = normalizeFatigue({
                ...item.fatigue,
                [key]: key === 'ratio' ? value === true || value === 'true' : Number(value),
            });
        }
    } else {
        item[field] = field === 'weight'
        ? Math.max(0, (Number(value) || 0) / 100)
        : field === 'once'
            ? value === true || value === 'true'
            : field === 'initial'
                ? value === true || value === 'true'
                : field === 'excludeSiblings'
                ? value === true || value === 'true'
                : field === 'cooldown'
                    ? (String(value ?? '').trim() === '' ? null : Math.max(0, Math.floor(Number(value) || 0)))
                    : field === 'requires'
                ? normalizeRequires(value)
                : field === 'excludes'
                    ? normalizeExcludes(value)
                    : value;
    }
    saveStore();
    refreshInjections();
    // 改名字时当前值/侧栏里的显示要跟着变，但不整块重绘。
    syncEditor(deck);
    // 名称输入框在展开的编辑区里，行首那行标题是另渲染的，得就地同步一下，
    // 否则改完名字、折叠回去还是旧标题。
    if (field === 'name') {
        const row = [...document.querySelectorAll('#se-editor .se-item-row')]
            .find((node) => node.dataset.item === itemId);
        const view = row?.querySelector('.se-item-name-view');
        if (view) {
            const label = item.name || '未命名';
            const first = view.firstChild;
            if (first && first.nodeType === Node.TEXT_NODE) {
                first.nodeValue = label;
            } else {
                view.insertAdjacentText('afterbegin', label);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 导入导出
// ---------------------------------------------------------------------------

function downloadText(text, filename, mime = 'text/markdown') {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function downloadJson(data, filename) {
    downloadText(JSON.stringify(data, null, 2), filename, 'application/json');
}

/**
 * 给「其他 AI」看的合集编写说明书：把格式、字段、写法建议和一份能直接导入的示例
 * 打包成一篇 Markdown，用户丢给别的模型就能让它照着写合集。
 */
export function buildAiGuide() {
    const example = [
        {
            schema: PACK_SCHEMA,
            id: 'guide-outfit',
            name: '示例衣柜',
            binding: { type: 'none', name: '' },
            trigger: { manual: true, auto: false, autoEvery: 3, keyword: false, ai: false },
            keywords: ['换衣服', '出门'],
            scan: { depth: 4, source: 'both', fields: [] },
            inject: { position: 'chat', depth: 4, role: 'system' },
            cooldown: 2,
            pick: 1,
            hold: { mode: 'forever', turns: 3 },
            items: [
                { id: 'coat', name: '旧风衣', text: '一件洗得发白的旧风衣，袖口磨出了毛边，口袋里总有一小截地铁票。', weight: 1 },
                { id: 'dress', name: '墨绿连衣裙', text: '一条墨绿色连衣裙，裙摆到小腿，转身时会轻轻扫过桌角。', weight: 2 },
                { id: 'once-coat', name: '第一次穿的风衣', text: '那件只在第一场雨里穿过一次的风衣，肩线还留着一道水痕。', weight: 1, once: true },
            ],
        },
        {
            schema: PACK_SCHEMA,
            id: 'guide-story',
            name: '示例剧情',
            binding: { type: 'none', name: '' },
            trigger: { manual: true, auto: false, autoEvery: 3, keyword: true, ai: false },
            keywords: ['答应', '拒绝'],
            scan: { depth: 6, source: 'both', fields: [] },
            inject: { position: 'chat', depth: 2, role: 'system' },
            cooldown: 0,
            pick: 1,
            hold: { mode: 'forever', turns: 3 },
            items: [
                { id: 'accept', name: '答应', text: '她点了点头，把杯子放回桌上，说好。', weight: 1, once: true },
                { id: 'refuse', name: '拒绝', text: '她把杯子推开了一点，说这件事能不能先放一放。', weight: 1, once: true, excludes: ['guide-story::accept'] },
                { id: 'after-accept', name: '答应之后', text: '第二天她来得比平时早，门口多了一双摆得很整齐的鞋。', weight: 1, requires: ['guide-story::accept'] },
            ],
        },
    ];
    const lines = [];
    lines.push('# 状态引擎 · 合集编写说明（给 AI 用）');
    lines.push('');
    lines.push('你正在为一个酒馆（SillyTavern）插件「状态引擎」编写**合集**。');
    lines.push('插件的工作方式：作者把内容拆成一份份清单（合集），每份清单里有很多条（条目）；游戏进行中，插件会按设定随机抽若干条，把抽中的文字发给模型。');
    lines.push('所以你要产出的不是「提示词」，而是**可以被抽的内容**：每条都要能单独成立、直接读、不依赖上下文。');
    lines.push('');
    lines.push('## 输出格式');
    lines.push('');
    lines.push('- 输出一个 JSON **数组**，每个元素是一个合集；一次可以写多个合集。');
    lines.push('- 只输出 JSON，不要写解释、不要用 Markdown 代码块包住（除非用户另外要求）。');
    lines.push(`- 每个合集必须有 schema: ${PACK_SCHEMA}、name、items；其他字段可省略，省略时用默认值。`);
    lines.push('- id 只能用英文字母、数字、下划线、短横线，最长 64 个字符；同一个合集内条目 id 不能重复。');
    lines.push('- 用中文写 name、text；id 用简短英文（例如 coat、refuse、after-accept）。');
    lines.push('');
    lines.push('## 合集字段');
    lines.push('');
    lines.push('| 字段 | 类型 | 默认 | 说明 |');
    lines.push('| --- | --- | --- | --- |');
    lines.push('| schema | 数字 | 必填 | 当前版本 ' + PACK_SCHEMA + ' |');
    lines.push('| name | 字符串 | 必填 | 合集名，例如「衣柜」「剧情」「场景」 |');
    lines.push('| binding | 对象 | 不绑定 | { type: "none" | "character" | "chat" | "npc", name: "角色名" }；绑定后只在那个角色/聊天/NPC 在场时生效 |');
    lines.push('| trigger | 对象 | 手动 | { manual, auto, autoEvery, keyword, ai }：面板按钮 / 每 N 楼自动 / 关键词 / AI 自己申请 |');
    lines.push('| keywords | 字符串数组 | [] | 触发关键词；写在 /.../ 里表示正则 |');
    lines.push('| scan | 对象 | 最近 4 条、用户+AI | { depth, source: "user" | "ai" | "both", fields: [] }；fields 可加 "description"、"personality"、"scenario"、"persona"、"notes"、"lorebook" |');
    lines.push('| inject | 对象 | 聊天记录第 4 条前、System | { position: "chat" | "prompt" | "before", depth, role: "system" | "user" | "assistant" } |');
    lines.push('| cooldown | 数字 | 2 | 抽中后至少隔几轮才会再被抽到 |');
    lines.push('| pick | 数字 | 1 | 每次抽几条 |');
    lines.push('| hold | 对象 | 永久 | { mode: "forever" | "turns" | "ai", turns: 3 }：抽中内容持续多久 |');
    lines.push('| summon | 对象 | 无 | { by: ["其它合集id"], only: false }：被哪些合集抽中时顺带抽我 |');
    lines.push('| nesting | 对象 | 顶层 | { parent: "上级合集id", onlyFromParent: false, entryWeight: 1 }：合集嵌套 |');
    lines.push('| items | 数组 | 必填 | 条目列表 |');
    lines.push('');
    lines.push('## 条目字段');
    lines.push('');
    lines.push('| 字段 | 类型 | 默认 | 说明 |');
    lines.push('| --- | --- | --- | --- |');
    lines.push('| id | 字符串 | 必填 | 合集内唯一 |');
    lines.push('| name | 字符串 | 必填 | 条目名，显示在面板上 |');
    lines.push('| text | 字符串 | 必填 | 真正发给模型的内容 |');
    lines.push('| weight | 数字 | 1 | 相对权重；0 表示永不出现 |');
    lines.push('| once | 布尔 | false | 抽中一次后永不再进候选池 |');
    lines.push('| requires | 字符串数组 | [] | 前置条件：这些条目**全部出现过**才可抽；格式 "合集id::条目id" |');
    lines.push('| excludes | 字符串数组 | [] | 排除条件：这些条目**出现过任何一条**就永不出现；格式同上 |');
    lines.push('');
    lines.push('## 内容怎么写');
    lines.push('');
    lines.push('- 一条只写一件事：一套穿搭、一个动作、一个地点、一件道具。不要把三件事塞进一条。');
    lines.push('- 20～120 字，具体、可观察：写材质、动作、声音、气味，不写情绪总结和评价。');
    lines.push('- 不写成指令（不要「你应该…」「请描写…」），只给素材；模型会自己接。');
    lines.push('- 同一份清单里的条目要能互相替换：风格统一、长度接近，抽到哪条都不突兀。');
    lines.push('- 需要剧情推进时，用 once + requires/excludes 串线，不要靠关键词堆叠。');
    lines.push('');
    lines.push('## 一份可以直接导入的示例');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(example, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('把上面的 JSON 保存成 .json 文件，在插件面板点「导入」即可。');
    return lines.join('\n');
}

function exportAiGuide() {
    const stamp = new Date().toISOString().slice(0, 10);
    downloadText(buildAiGuide(), `状态引擎-合集模板-${stamp}.md`);
    toast('success', '已导出合集模板，可以直接丢给别的 AI');
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
    const store = getStore();
    const deck = deckById(deckId);
    if (!deck) {
        return;
    }
    const descendants = store ? descendantDecks(store.decks, deck.id) : [];
    const packs = [deck, ...descendants].map((item) => serializePack(item));
    downloadJson(packs, `state-engine-${deck.id}.json`);
    toast('success', descendants.length > 0
        ? `已导出「${deck.name}」和它的 ${descendants.length} 个子合集`
        : `已导出「${deck.name}」`);
}

/** 某个合集的全部后代（按层级顺序，防环）。 */
function descendantDecks(decks, rootId) {
    const out = [];
    const seen = new Set([rootId]);
    const walk = (id) => {
        for (const item of decks) {
            if (item.parent === id && !seen.has(item.id)) {
                seen.add(item.id);
                out.push(item);
                walk(item.id);
            }
        }
    };
    walk(rootId);
    return out;
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
    if (trigger.auto) parts.push(`每${Number(trigger.autoEvery) || 1}楼`);
    if (trigger.keyword) parts.push('关键词');
    if (trigger.ai) parts.push('AI判定');
    if (parts.length === 0) {
        return '无';
    }
    // 侧栏一行只放得下几个字：只写第一个，其余用「+N」带过，完整内容在合集设置里。
    return parts.length === 1 ? parts[0] : `${parts[0]}+${parts.length - 1}`;
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

/**
 * 把合集按「树」排好序：每个母合集后面紧跟它自己的子合集。
 * 直接按数组顺序渲染时，后挂上去的子合集会留在原来的位置，跑到别的母合集底下，
 * 所以侧栏必须先按 parent 分组再走一遍。
 */
function orderedDecks(decks) {
    const byParent = new Map();
    for (const deck of decks) {
        const key = deck.parent || '';
        if (!byParent.has(key)) {
            byParent.set(key, []);
        }
        byParent.get(key).push(deck);
    }
    const out = [];
    const seen = new Set();
    const walk = (parentId, depth) => {
        for (const deck of byParent.get(parentId) || []) {
            if (seen.has(deck.id)) {
                continue;
            }
            seen.add(deck.id);
            out.push({ deck, depth });
            if (depth < 3) {
                walk(deck.id, depth + 1);
            }
        }
    };
    walk('', 0);
    // 挂成环或在更深层捡不到的，兜底按原顺序列出来，至少不会凭空消失。
    for (const deck of decks) {
        if (!seen.has(deck.id)) {
            out.push({ deck, depth: 0 });
        }
    }
    return out;
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
    list.innerHTML = orderedDecks(decks).map(({ deck, depth }) => {
        const childCount = decks.filter((item) => item.parent === deck.id).length;
        const empty = deckExhausted(store.state, decks, deck.id);
        const badge = deck.lock === true ? '<span class="se-deck-count se-deck-lock" title="不可打断：自动抽取只抽它">锁</span>'
            : (empty ? '<span class="se-deck-count se-deck-empty" title="没有可抽的条目了">空</span>' : '');
        return `
        <div class="se-deck-item ${deck.id === selectedDeckId ? 'active' : ''} ${depth > 0 ? 'se-deck-child' : ''} ${empty ? 'se-deck-done' : ''} ${deck.enabled === false ? 'se-deck-off' : ''}" data-action="select-deck" data-deck="${escapeHtml(deck.id)}" title="拖动标题可以调整同层顺序" style="padding-left:${10 + depth * 16}px">
            <label class="se-deck-toggle" title="启用 / 停用这个合集">
                <input type="checkbox" data-deck-enabled="${escapeHtml(deck.id)}" ${deck.enabled === false ? '' : 'checked'}>
            </label>
            <span class="se-deck-item-name" draggable="true" data-drag-handle="deck">${depth > 0 ? '└ ' : ''}${escapeHtml(deck.name || '未命名')}${childCount > 0 ? ` <span class="se-deck-count">${childCount}</span>` : ''}${badge}</span>
            <span class="se-deck-item-meta">${escapeHtml(deck.binding?.name || triggerSummary(deck))}</span>
            <span class="se-deck-item-value">${escapeHtml(currentLabel(deck, store))}</span>
        </div>`;
    }).join('');
}

/**
 * 条目「前置条件 / 排除条件」的多选清单。
 * - 列出全部合集的全部条目，排除自己。
 * - 已经出现过的条目打个「已出现」标记，方便作者顺着剧情线连。
 * - 条目多时用搜索框过滤，不一次渲染几千行也能用。
 * kind：'requires'（前置，全部出现过才轮得到）或 'excludes'（排除，出现任意一条就不进池）。
 */
function renderRequireList(deck, item, store, kind = 'requires') {
    const isExclude = kind === 'excludes';
    const done = doneSet(store.state);
    const selfRef = itemRef(deck.id, item.id);
    const selected = new Set(Array.isArray(item[kind]) ? item[kind] : []);
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
    const label = isExclude ? '排除' : '前置';
    const summary = chosen.length
        ? `${label}：已选 ${chosen.length} 个（${chosen.slice(0, 2).map((option) => option.itemName).join('、')}${chosen.length > 2 ? '…' : ''}）`
        : `${label}：无`;
    const rows = options
        .slice(0, 600)
        .map((option) => `
            <label class="se-require-row" data-search="${escapeHtml(`${option.deckName} ${option.itemName}`.toLowerCase())}">
                <input type="checkbox" data-${isExclude ? 'exclude' : 'require'}-ref="${escapeHtml(option.ref)}" ${selected.has(option.ref) ? 'checked' : ''}>
                <span>${escapeHtml(option.deckName)} › ${escapeHtml(option.itemName)}${option.done ? ' <em>已出现</em>' : ''}</span>
            </label>`)
        .join('');
    return `
        <details class="se-multi-select se-require-block${isExclude ? ' se-exclude-block' : ''}">
            <summary>${escapeHtml(summary)}</summary>
            <div class="se-require-panel">
                <input type="text" class="text_pole se-require-search" data-require-search placeholder="搜索条目名或合集名…">
                <div class="se-require-list">${rows || '<div class="se-muted">没有可选的条目（这个聊天里只有这一条）。</div>'}</div>
            </div>
        </details>`;
}

function holdLabel(hold) {
    const h = hold || {};
    if (h.mode === 'turns') {
        return `按轮数 ${Number(h.turns) || 3} 轮`;
    }
    if (h.mode === 'days') {
        return `按天数 ${Number(h.days) || 1} 天`;
    }
    if (h.mode === 'ai') {
        return '由 AI 结束';
    }
    return '一直保留';
}

function fatigueLabel(cfg) {
    const f = cfg;
    if (!f) {
        return '关闭（固定权重）';
    }
    const every = Number(f.everyTurns) || 3;
    const amount = Number(f.amount) || 10;
    const step = f.ratio ? `当前值的 ${amount}%` : `${amount}%`;
    if (f.mode === 'decay') {
        return `降权：每抽中一次 −${step}（间隔 ${every} 轮内），低于 ${Number(f.floorPercent) || 1}% 冷却 ${Number(f.recoverTurns) || 5} 轮`;
    }
    if (f.mode === 'boost') {
        return `增权：每 ${every} 轮没抽中 +${step}，最高 ${Number(f.maxPercent) || 300}%`;
    }
    return '关闭（固定权重）';
}

function renderItems(deck, store) {
    const items = deck.items || [];
    const done = doneSet(store.state);
    // 条目多的时候只先渲染一部分：300+ 条一次性铺开，光 DOM 就够卡住整块面板。
    const shown = items.slice(0, itemsShown);
    const rest = items.length - shown.length;
    const rows = shown.map((item) => {
        const weight = Math.max(0, Number(item.weight) || 0);
        // 界面上用百分比：1 是基准 = 100%。
        const weightPercent = Math.round(weight * 100);
        const used = item.once && done.has(itemRef(deck.id, item.id));
        const needCount = Array.isArray(item.requires) ? item.requires.length : 0;
        const avoidCount = Array.isArray(item.excludes) ? item.excludes.length : 0;
        const flags = [
            used ? '已出现' : '',
            item.once ? '一次性' : '',
            item.initial ? '初始' : '',
            needCount ? `前置 ${needCount}` : '',
            avoidCount ? `互斥 ${avoidCount}` : '',
        ].filter(Boolean).join(' · ');
        return `
        <div class="se-item-row ${item.enabled === false ? 'se-item-off' : ''}" data-item="${escapeHtml(item.id)}">
            <div class="se-item-main" data-action="toggle-item">
                <label class="se-item-toggle" title="启用 / 停用这条（停用后不参与抽签，内容保留）">
                    <input type="checkbox" data-item-enabled="${escapeHtml(item.id)}" ${item.enabled === false ? '' : 'checked'}>
                </label>
                <span class="se-item-name-view" draggable="true" data-drag-handle="item">${escapeHtml(item.name || '未命名')}${flags ? `<em class="se-item-flag">${escapeHtml(flags)}</em>` : ''}</span>
                <input type="number" class="text_pole se-item-weight" data-item-field="weight" min="0" step="10" value="${weightPercent}" title="出现概率：100% 是基准；填 0 表示永不出现。填 200% 就是基准的两倍。">
                <button type="button" class="se-icon-btn" data-action="delete-item" data-deck="${escapeHtml(deck.id)}" data-item="${escapeHtml(item.id)}" title="删除这条">×</button>
            </div>
            <div class="se-item-edit">
                <input type="text" class="text_pole se-item-name" data-item-field="name" value="${escapeHtml(item.name || '')}" placeholder="条目名称">
                <textarea class="text_pole se-item-text" data-item-field="text" rows="3" placeholder="这一条要交给 AI 的内容">${escapeHtml(item.text || '')}</textarea>
                <label class="se-check se-check-wide">
                    <input type="checkbox" data-item-field="once" ${item.once ? 'checked' : ''}>
                    <span>只出现一次（抽中后不再进候选池）</span>
                </label>
                <label class="se-check se-check-wide">
                    <input type="checkbox" data-item-field="initial" ${item.initial ? 'checked' : ''}>
                    <span>作为初始值（新聊天第一次打开时直接选中，不用先抽）</span>
                </label>
                <label class="se-check se-check-wide">
                    <input type="checkbox" data-item-field="excludeSiblings" ${item.excludeSiblings ? 'checked' : ''}>
                    <span>排除本合集的其它条目（同合集里只要先出现过别的条目，这条就永久不进池）</span>
                </label>
                <label class="se-check se-check-wide se-item-cooldown-row">
                    <span>这条自己的冷却（轮）</span>
                    <input type="number" class="text_pole se-item-cooldown" data-item-field="cooldown" min="0" step="1" value="${item.cooldown === null || item.cooldown === undefined ? '' : item.cooldown}" placeholder="跟随合集 ${Number(deck.cooldown) || 0} 轮" title="填数字后，这条被抽中后要隔这么多轮才可能再出现；留空就用合集设置的冷却（${Number(deck.cooldown) || 0} 轮）">
                </label>
                <label class="se-field se-item-hold-mode">
                    <span>这条自己的持续</span>
                    <select class="text_pole" data-item-field="hold.mode">
                        <option value="" ${item.hold ? '' : 'selected'}>不设（一直保留到下次抽中）</option>
                        <option value="turns" ${item.hold?.mode === 'turns' ? 'selected' : ''}>按轮数</option>
                        <option value="days" ${item.hold?.mode === 'days' ? 'selected' : ''}>按游戏内天数</option>
                        <option value="forever" ${item.hold?.mode === 'forever' ? 'selected' : ''}>一直保留</option>
                        <option value="ai" ${item.hold?.mode === 'ai' ? 'selected' : ''}>由 AI 结束</option>
                    </select>
                </label>
                <label class="se-field se-item-hold-turns" ${item.hold?.mode === 'turns' ? '' : 'hidden'}>
                    <span>持续轮数</span>
                    <input type="number" class="text_pole" data-item-field="hold.turns" min="1" step="1" value="${Number(item.hold?.turns) || 3}">
                </label>
                <label class="se-field se-item-hold-days" ${item.hold?.mode === 'days' ? '' : 'hidden'}>
                    <span>持续天数</span>
                    <input type="number" class="text_pole" data-item-field="hold.days" min="1" step="1" value="${Number(item.hold?.days) || 1}">
                </label>
                <details class="se-multi-select se-fatigue-block" ${item.fatigue ? 'open' : ''}>
                    <summary>动态权重：${fatigueLabel(item.fatigue)}</summary>
                    <div class="se-fatigue-grid">
                        <label class="se-field">
                            <span>玩法</span>
                            <select class="text_pole" data-item-field="fatigue.mode">
                                <option value="off" ${item.fatigue ? '' : 'selected'}>关闭（固定权重）</option>
                                <option value="decay" ${item.fatigue?.mode === 'decay' ? 'selected' : ''}>降权（越抽越少）</option>
                                <option value="boost" ${item.fatigue?.mode === 'boost' ? 'selected' : ''}>增权（越不抽越多）</option>
                            </select>
                        </label>
                        <label class="se-field">
                            <span>间隔（轮）</span>
                            <input type="number" class="text_pole" data-item-field="fatigue.everyTurns" min="1" step="1" value="${item.fatigue?.everyTurns ?? 3}" ${item.fatigue ? '' : 'disabled'}>
                        </label>
                        <label class="se-field">
                            <span>幅度（%）</span>
                            <input type="number" class="text_pole" data-item-field="fatigue.amount" min="0" step="5" value="${item.fatigue?.amount ?? 10}" ${item.fatigue ? '' : 'disabled'}>
                        </label>
                        <label class="se-check se-check-wide">
                            <input type="checkbox" data-item-field="fatigue.ratio" ${item.fatigue?.ratio ? 'checked' : ''} ${item.fatigue ? '' : 'disabled'}>
                            <span>按比例算（每次乘/除当前值，不按固定百分点）</span>
                        </label>
                        <label class="se-field se-fatigue-decay" ${item.fatigue?.mode === 'decay' ? '' : 'hidden'}>
                            <span>低于多少%进冷却</span>
                            <input type="number" class="text_pole" data-item-field="fatigue.floorPercent" min="0" step="1" value="${item.fatigue?.floorPercent ?? 1}">
                        </label>
                        <label class="se-field se-fatigue-decay" ${item.fatigue?.mode === 'decay' ? '' : 'hidden'}>
                            <span>冷却几轮</span>
                            <input type="number" class="text_pole" data-item-field="fatigue.recoverTurns" min="1" step="1" value="${item.fatigue?.recoverTurns ?? 5}">
                        </label>
                        <label class="se-field se-fatigue-boost" ${item.fatigue?.mode === 'boost' ? '' : 'hidden'}>
                            <span>最高涨到（%）</span>
                            <input type="number" class="text_pole" data-item-field="fatigue.maxPercent" min="100" step="50" value="${item.fatigue?.maxPercent ?? 300}">
                        </label>
                    </div>
                    <div class="se-hint">降权：每被抽中一次就往下掉，掉到下限进冷却，冷却结束回到 100%。增权：隔一段时间没被抽中就往上加，被抽中后回到 100%。</div>
                </details>
                <div class="se-require-slot" data-slot="requires"></div>
                <div class="se-require-slot" data-slot="excludes"></div>
            </div>
        </div>`;
    }).join('');
    return `
        <div class="se-items">
            ${rows || '<div class="se-items-empty">还没有条目。点下面的「+ 添加条目」。</div>'}
            ${rest > 0 ? `<div class="se-items-more"><button type="button" class="menu_button" data-action="show-more-items">显示更多（还有 ${rest} 条）</button></div>` : ''}
        </div>
        <div class="se-items-foot">
            <button type="button" class="menu_button" data-action="add-item" data-deck="${escapeHtml(deck.id)}">+ 添加条目</button>
        </div>`;
}

// 前置 / 排除的选择器很重（要把全部合集全部条目铺成勾选框），只在条目真正展开时才生成。
function fillRequireSlots(row, deck, store) {
    if (!row || !deck || !store) {
        return;
    }
    const itemId = row.dataset.item;
    const item = (deck.items || []).find((entry) => entry.id === itemId);
    if (!item) {
        return;
    }
    for (const kind of ['requires', 'excludes']) {
        const slot = row.querySelector(`.se-require-slot[data-slot="${kind}"]`);
        if (!slot || slot.dataset.filled === '1') {
            continue;
        }
        slot.innerHTML = renderRequireList(deck, item, store, kind);
        slot.dataset.filled = '1';
    }
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
    const compose = Array.isArray(deck.compose) ? deck.compose : [];
    const composeNames = compose.map((id) => store.decks.find((item) => item.id === id)?.name || id);
    const lockTargets = Array.isArray(deck.lockTargets) ? deck.lockTargets : [];
    const lockNames = lockTargets.map((id) => store.decks.find((item) => item.id === id)?.name || id);
    const hold = deck.hold || DEFAULT_HOLD;
    const binding = deck.binding || DEFAULT_BINDING;
    // 有上级合集的，什么时候抽由上级决定，自己那套触发条件不生效。
    const parentDeck = deck.parent ? store.decks.find((item) => item.id === deck.parent) : null;
    const isChildDeck = Boolean(deck.parent);
    const ds = deckState(store.state, deck.id);
    const cooldown = Math.max(0, Number(deck.cooldown) || 0);
    const cooling = cooldown > 0 ? ds.recent.slice(-cooldown).length : 0;

    // 换合集时把「显示到第几条」重置回第一页。
    if (itemsDeckId !== deck.id) {
        itemsDeckId = deck.id;
        itemsShown = ITEMS_PAGE_SIZE;
    }

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
    const prevScroll = sameDeck ? (root.querySelector('.se-view-scroll')?.scrollTop || 0) : 0;
    if (!sameDeck) {
        root.dataset.deck = deck.id;
        root.scrollTop = 0;
    }

    root.innerHTML = `
        <div class="se-view-head">
            <span class="se-view-deck">${escapeHtml(deck.name || deck.id)}</span>
            <span class="se-view-count">${(deck.items || []).length} 条</span>
            <span class="se-view-sub">${isChildDeck ? `挂在「${escapeHtml(parentDeck?.name || deck.parent)}」下` : (deck.lock === true ? '不可打断' : '')}</span>
        </div>
        <div class="se-view-scroll">

        <div class="se-items-block">
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
            <div class="se-deck-id-row">
                <span class="se-deck-id-label">合集标记</span>
                <code class="se-deck-id">${escapeHtml(`<!--SE:${deck.id}-->`)}</code>
                <button type="button" class="menu_button se-copy-id" data-action="copy-deck-id" title="复制这串标记，可以写进「AI 判定补充说明」里指定什么时候调用它">复制</button>
            </div>
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
            <label class="se-field">
                <span>按什么算冷却</span>
                <select class="text_pole" data-deck-field="timeUnit">
                    <option value="turn" ${deck.timeUnit === 'day' ? '' : 'selected'}>按楼层</option>
                    <option value="day" ${deck.timeUnit === 'day' ? 'selected' : ''}>按游戏内天数（读 MVU 日期）</option>
                </select>
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

        <div class="se-trigger-block" ${isChildDeck ? 'hidden' : ''}>
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
        ${isChildDeck ? `<div class="se-hint se-child-hint">挂在「${escapeHtml(parentDeck?.name || deck.parent)}」下面，什么时候抽由上级决定：轮到它时，它按权重和上级的其它内容竞争，抽中就进。它自己的手动/楼层/关键词/AI 判定都不生效。</div>` : ''}
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

        <div class="se-section-title">AI 能看到什么</div>
        <div class="se-hint">申请清单里，除了合集名，要不要把里面有什么条目也告诉 AI。条目很多又没什么可选的（比如纯推进剧情），选「只给合集名」能省 token 也不干扰它。</div>
        <select class="text_pole" data-deck-field="reveal">
            <option value="items" ${deck.reveal !== 'deck' ? 'selected' : ''}>合集名 + 条目名（默认）</option>
            <option value="deck" ${deck.reveal === 'deck' ? 'selected' : ''}>只给合集名</option>
        </select>

        <div class="se-section-title">组合（配套抽取）</div>
        <div class="se-hint">抽中这里的条目时，会从下面勾选的合集里顺带各抽一次，把结果填进条目文本的 {合集名} 占位符。例：条目写「{颜色}的连衣裙」，颜色抽到白色，注入就是「白色的连衣裙」。</div>
        <details class="se-multi-select">
            <summary id="se-compose-summary" title="${escapeHtml(composeNames.join('、'))}">${escapeHtml(composeNames.length ? `已选 ${composeNames.length} 个：${composeNames.join('、')}` : '还没有组合来源，点这里选择')}</summary>
            <div class="se-summon-list">
                ${store.decks.filter((item) => item.id !== deck.id).map((item) => `<label><input type="checkbox" data-compose-by="${escapeHtml(item.id)}" ${(compose || []).includes(item.id) ? 'checked' : ''}><span>${escapeHtml(item.name || item.id)}</span></label>`).join('') || '<span class="se-hint">还没有别的合集。</span>'}
            </div>
        </details>

        <div class="se-section-title">不可打断</div>
        <label class="se-checks se-check-wide"><input type="checkbox" data-deck-field="lock" ${deck.lock ? 'checked' : ''}><span>开着时只抽它：被它压制的合集暂时休眠，直到它抽无可抽</span></label>
        ${deck.lock ? `<details class="se-multi-select se-lock-scope">
            <summary id="se-lock-summary" title="${escapeHtml(lockNames.join('、'))}">${escapeHtml(lockNames.length ? `压制 ${lockNames.length} 个：${lockNames.join('、')}` : '不指定：只压同一层的其它合集')}</summary>
            <div class="se-summon-list">
                ${store.decks.filter((item) => item.id !== deck.id).map((item) => `<label><input type="checkbox" data-lock-target="${escapeHtml(item.id)}" ${(lockTargets || []).includes(item.id) ? 'checked' : ''}><span>${escapeHtml(item.name || item.id)}</span></label>`).join('') || '<span class="se-hint">还没有别的合集。</span>'}
            </div>
        </details>` : ''}

        <div class="se-hint">持续的时长改成由「条目自己」决定了：展开任意条目，在最下面的「这条自己的持续」里设。内容还在持续期里时，这个合集不会被自动抽到下一次（手动「抽一条」或「重抽」不受限制）。</div>

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
        </div>
    `;

    if (sameDeck && prevSettingsOpen) {
        const settingsBlock = root.querySelector('.se-deck-settings');
        if (settingsBlock) {
            settingsBlock.open = true;
        }
    }
    if (sameDeck) {
        const scroller = root.querySelector('.se-view-scroll');
        if (scroller) {
            scroller.scrollTop = prevScroll;
        }
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
    const timeTemplate = root.querySelector('#se-time-template');
    if (timeTemplate && document.activeElement !== timeTemplate) {
        timeTemplate.value = settings.timeTemplate || DEFAULT_TIME_TEMPLATE;
    }
    const timeDepthInput = root.querySelector('#se-time-depth');
    if (timeDepthInput && document.activeElement !== timeDepthInput) {
        timeDepthInput.value = String(Math.max(0, Number(settings.timeDepth) || 0));
    }
    const autoCardSyncInput = root.querySelector('#se-auto-card-sync');
    if (autoCardSyncInput) {
        autoCardSyncInput.checked = settings.autoCardSync === true;
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
    renderGlobalBlock();
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
                    <label class="se-switch" title="勾上后，你在酒馆里点「导出」的那一刻会把当前合集写进角色卡，不用再单独点按钮">
                        <input type="checkbox" id="se-auto-card-sync"><span>随卡导出</span>
                    </label>
                    <button type="button" class="menu_button" data-action="open-settings" title="跳到插件设置（AI 模板、插入深度、公共合集库）">设置</button>
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
                <div class="se-take-actions">
                    <button type="button" class="menu_button se-judge-btn" data-action="judge-now" title="现在就用当前上下文问一次模型「要不要抽」，不等下一轮生成（会消耗一次额外的生成额度）">立即判断</button>
                    <button type="button" class="menu_button se-clear-btn" data-action="clear-current" title="只清空当前抽中的内容；条目的「已出现」记录和冷却都不重置">清除</button>
                    <button type="button" class="menu_button se-take-btn" data-action="draw">抽一条 <kbd>空格</kbd></button>
                </div>
            </div>

            <details class="se-ledger">
                <summary>后台记录</summary>
                <pre id="se-ledger-text"></pre>
            </details>
            <details class="se-ledger se-settings">
                <summary>设置</summary>
                <div class="se-set-group">
                    <div class="se-section-title">AI 判定提示词</div>
                    <label class="se-field se-field-wide">
                        <span>发给模型的说明（清单由插件自动接在最后，不用写 {{decks}}）</span>
                        <textarea id="se-ai-template" class="text_pole" rows="8"></textarea>
                    </label>
                    <div class="se-hint">启用「AI 判定」时，每轮生成前把这段发给模型；改完点一下别处就保存。改坏了点下面「恢复默认提示词」。</div>
                    <label class="se-field">
                        <span>插入深度（倒数第几条之前；越小越靠近当前输入，模型越容易照做）</span>
                        <input id="se-ai-depth" type="number" class="text_pole" min="0" step="1">
                    </label>
                    <div class="se-global-actions">
                        <button type="button" class="menu_button" data-action="reset-ai-template">恢复默认提示词</button>
                    </div>
                </div>
                <div class="se-set-group">
                    <div class="se-section-title">时间提示</div>
                    <label class="se-field">
                        <span>每轮随生成发给模型的时间说明</span>
                        <textarea id="se-time-template" class="text_pole" rows="5"></textarea>
                    </label>
                    <div class="se-hint">可用占位符：{{time}} 现在的时间、{{paths}} 要改的变量路径、{{example}} 一条 JSONPatch 示例。后面两个按卡里有没有 MVU 自动生成；没有就整行省略。</div>
                    <label class="se-field">
                        <span>插入深度（倒数第几条之前；越小越靠近当前输入）</span>
                        <input id="se-time-depth" type="number" class="text_pole" min="0" step="1">
                    </label>
                    <div class="se-global-actions">
                        <button type="button" class="menu_button" data-action="reset-time-template">恢复默认时间提示</button>
                    </div>
                </div>
                <div class="se-set-group">
                    <div class="se-section-title">随卡导出</div>
                    <div class="se-hint">勾上顶栏的「随卡导出」后，导出角色卡时会自动带上绑定到这张卡的合集（以及和它们有关联的合集）；导出完成会把本地卡的开场白恢复原样。</div>
                </div>
                <div class="se-set-group">
                    <div class="se-section-title">给别的 AI 写合集</div>
                    <div class="se-global-actions">
                        <button type="button" class="menu_button" data-action="export-guide">导出合集模板（给 AI 看）</button>
                    </div>
                    <div class="se-hint">导出的是一份说明书：格式、字段、写法建议，外加一份能直接导入的示例。把它丢给别的模型，让它照格式写合集。</div>
                </div>
                <div class="se-set-group">
                    <div class="se-section-title">从角色卡导入</div>
                    <div class="se-global-actions">
                        <button type="button" class="menu_button" data-action="import-card-decks" title="把这张角色卡里带着的合集补进当前聊天">把卡里带的合集导入本聊天</button>
                    </div>
                    <div class="se-hint">只补缺的：已经有同名合集时保持原样，不会覆盖你现在的内容。</div>
                </div>
                <div class="se-global-block">
                    <div class="se-section-title">公共合集库 <span class="se-muted">（存在插件设置里，任何聊天、任何角色卡都能用）</span></div>
                    <div class="se-global-actions">
                        <button type="button" class="menu_button" data-action="publish-global">把当前合集发布到公共库</button>
                        <button type="button" class="menu_button" data-action="export-global">导出公共库</button>
                        <button type="button" class="menu_button" data-action="import-global">从 JSON 导入到公共库</button>
                        <input id="se-global-file" type="file" accept="application/json,.json" multiple hidden>
                    </div>
                    <div id="se-global-list" class="se-global-list"></div>
                </div>
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
            const hold = ds.hold || deck.hold || DEFAULT_HOLD;
            const total = Math.max(1, Number(hold.turns) || 1);
            const start = Number(ds.holdStart);
            const used = Number.isFinite(start) && start >= 0 ? Math.max(0, turn - start) : 0;
            let left = hold.mode === 'turns' ? Math.max(0, total - used) : null;
            if (hold.mode === 'days') {
                const days = Math.max(1, Number(hold.days) || 1);
                const startDay = Number(ds.holdStartDay);
                const nowDay = Number(store.state?.gameDay);
                left = Number.isFinite(startDay) && startDay >= 0 && Number.isFinite(nowDay)
                    ? Math.max(0, days - (nowDay - startDay))
                    : null;
            }
            const pct = left === null ? 100 : Math.max(0, Math.min(100, Math.round((left / (hold.mode === 'days' ? Math.max(1, Number(hold.days) || 1) : total)) * 100)));
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
        } else if (entry.hold.mode === 'days') {
            timeMark = entry.left === null
                ? `<span class="se-air-left se-air-dim">按天（卡里没有日期）</span>`
                : `<span class="se-air-bar"><i style="width:${entry.pct}%"></i></span><span class="se-air-left">剩 ${entry.left} 天</span>`;
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

/**
 * 角色卡自带合集时，用酒馆自己的弹窗问一句要不要导入。
 * 不再在插件面板里放提示条——不是每个玩家都会去开插件面板。
 */
let cardImportPopupKey = '';
let cardImportPopupOpen = false;

async function maybeShowCardImportPopup() {
    if (cardImportPopupOpen) {
        return;
    }
    // 只在「这个聊天还是空的」时补一次；已经有合集的聊天绝不动，避免拿卡里的旧快照覆盖。
    const current = getStore();
    if (current && Array.isArray(current.decks) && current.decks.length > 0) {
        return;
    }
    const pending = pendingCardDecks();
    if (pending.length === 0) {
        return;
    }
    // 新聊天开出来是空的，直接从角色卡把合集带进来（不再弹窗问，问一次就烦一次）。
    cardImportPopupOpen = true;
    try {
        importCardDecks();
    } catch (error) {
        console.warn('[state-engine] 自动带上角色卡的合集失败', error);
    } finally {
        cardImportPopupOpen = false;
    }
}

/** 面板里不再显示提示条，统一走弹窗。 */
function renderCardHint() {
    const hint = document.getElementById('se-card-hint');
    if (hint) {
        hint.hidden = true;
        hint.innerHTML = '';
    }
    maybeShowCardImportPopup();
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

/**
 * 拖动排序：侧栏合集只能在「同一层」内换位置；条目按当前合集内的顺序换。
 */
function applyReorder(kind, fromId, toId, after) {
    const store = getStore();
    if (!store || !fromId || !toId || fromId === toId) {
        return false;
    }
    if (kind === 'deck') {
        const fromDeck = store.decks.find((item) => item.id === fromId);
        const toDeck = store.decks.find((item) => item.id === toId);
        if (!fromDeck || !toDeck) {
            return false;
        }
        if (String(fromDeck.parent || '') !== String(toDeck.parent || '')) {
            toast('info', '合集只能在「同一层」内拖动排序；换层级请用「上级合集」。');
            return false;
        }
        const from = store.decks.indexOf(fromDeck);
        const to = store.decks.indexOf(toDeck);
        store.decks.splice(from, 1);
        const insert = (from < to ? to - 1 : to) + (after ? 1 : 0);
        store.decks.splice(Math.max(0, Math.min(insert, store.decks.length)), 0, fromDeck);
    } else {
        const deck = store.decks.find((item) => item.id === selectedDeckId);
        if (!deck || !Array.isArray(deck.items)) {
            return false;
        }
        const from = deck.items.findIndex((item) => item.id === fromId);
        const to = deck.items.findIndex((item) => item.id === toId);
        if (from < 0 || to < 0) {
            return false;
        }
        const [moved] = deck.items.splice(from, 1);
        const insert = (from < to ? to - 1 : to) + (after ? 1 : 0);
        deck.items.splice(Math.max(0, Math.min(insert, deck.items.length)), 0, moved);
    }
    saveStore({ immediate: true });
    renderPanel();
    return true;
}

/**
 * 面板上的拖动排序（原生 HTML5 drag & drop）。
 */
function setupDragSort(root) {
    if (!root || setupDragSort.done) {
        return;
    }
    setupDragSort.done = true;
    let kind = '';
    let dragId = '';
    const selectorOf = (targetKind) => (targetKind === 'deck' ? '#se-deck-list .se-deck-item' : '#se-editor .se-item-row');
    const clearMarks = () => {
        root.querySelectorAll('.se-dragging, .se-drop-before, .se-drop-after').forEach((el) => {
            el.classList.remove('se-dragging', 'se-drop-before', 'se-drop-after');
        });
    };
    root.addEventListener('dragstart', (event) => {
        // 只有「折叠后的标题」能拖：在正文、输入框、勾选框里拖一律不排序。
        const handle = event.target.closest('[data-drag-handle]');
        if (!handle || event.target.closest('input, textarea, select')) {
            event.preventDefault();
            return;
        }
        const deckEl = handle.closest('#se-deck-list .se-deck-item');
        const itemEl = handle.closest('#se-editor .se-item-row');
        const el = deckEl || itemEl;
        if (!el) {
            event.preventDefault();
            return;
        }
        kind = deckEl ? 'deck' : 'item';
        dragId = deckEl ? deckEl.dataset.deck : itemEl.dataset.item;
        clearMarks();
        el.classList.add('se-dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', dragId);
    });
    root.addEventListener('dragover', (event) => {
        if (!kind) {
            return;
        }
        const target = event.target.closest(selectorOf(kind));
        if (!target) {
            return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        clearMarks();
        const rect = target.getBoundingClientRect();
        const after = event.clientY - rect.top > rect.height / 2;
        target.classList.add(after ? 'se-drop-after' : 'se-drop-before');
    });
    root.addEventListener('drop', (event) => {
        if (!kind) {
            return;
        }
        const target = event.target.closest(selectorOf(kind));
        if (!target) {
            clearMarks();
            kind = '';
            dragId = '';
            return;
        }
        event.preventDefault();
        const targetId = kind === 'deck' ? target.dataset.deck : target.dataset.item;
        const rect = target.getBoundingClientRect();
        const after = event.clientY - rect.top > rect.height / 2;
        clearMarks();
        const moved = applyReorder(kind, dragId, targetId, after);
        if (!moved) {
            clearMarks();
        }
        kind = '';
        dragId = '';
    });
    root.addEventListener('dragend', () => {
        clearMarks();
        kind = '';
        dragId = '';
    });
}

function bindPanelEvents() {
    const root = document.getElementById(PANEL_ID);
    if (!root) {
        return;
    }
    setupDragSort(root);

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

    root.querySelector('#se-global-file')?.addEventListener('change', (event) => {
        importGlobalFiles(event.target.files);
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

    root.querySelector('#se-time-template')?.addEventListener('change', (event) => {
        settings.timeTemplate = event.target.value || DEFAULT_TIME_TEMPLATE;
        saveSettings();
        refreshInjections();
        toast('success', '时间提示已保存');
    });

    root.querySelector('#se-time-depth')?.addEventListener('change', (event) => {
        settings.timeDepth = Math.max(0, Number(event.target.value) || 0);
        event.target.value = String(settings.timeDepth);
        saveSettings();
        refreshInjections();
        toast('success', `时间提示改到倒数第 ${settings.timeDepth} 条之前`);
    });

    root.querySelector('#se-auto-card-sync')?.addEventListener('change', (event) => {
        settings.autoCardSync = event.target.checked === true;
        saveSettings();
        if (settings.autoCardSync) {
            cardSyncDirty = true;
            toast('success', '以后导出角色卡时会自动带上当前合集');
        } else {
            toast('info', '不再自动写卡；需要时点「随卡导出」');
        }
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
        // 点合集前面的启用勾选时，不要顺带把这一项选中（否则会重绘，勾选状态又被打回）。
        if (event.target.closest('.se-deck-toggle')) {
            return;
        }
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
        } else if (action === 'reset-time-template') {
            settings.timeTemplate = DEFAULT_TIME_TEMPLATE;
            saveSettings();
            refreshInjections();
            renderPanel();
            toast('success', '时间提示已恢复默认');
        } else if (action === 'export-guide') {
            exportAiGuide();
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
                // 前置/排除的勾选清单这时才生成，避免几百条一起铺开卡住面板。
                const store = getStore();
                const deck = store?.decks.find((item) => item.id === selectedDeckId);
                fillRequireSlots(row, deck, store);
                row.querySelector('.se-item-text')?.focus();
            }
        } else if (action === 'show-more-items') {
            itemsShown += ITEMS_PAGE_SIZE;
            renderPanel();
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
        } else if (action === 'publish-global') {
            publishDeckToGlobal(deckId);
        } else if (action === 'copy-global') {
            copyGlobalToChat(deckId);
        } else if (action === 'delete-global') {
            removeGlobalDeck(deckId);
        } else if (action === 'export-global') {
            const list = globalDecks();
            if (list.length === 0) {
                toast('info', '公共库是空的');
            } else {
                const packs = list.map((deck) => serializePack(deck));
                downloadJson(packs.length === 1 ? packs[0] : packs, `state-engine-public-${Date.now()}.json`);
                toast('success', `已导出公共库（${list.length} 个合集）`);
            }
        } else if (action === 'import-global') {
            document.getElementById('se-global-file')?.click();
        } else if (action === 'copy-deck-id') {
            const marker = `<!--SE:${deckId}-->`;
            const done = () => toast('success', `已复制 ${marker}`);
            const fallback = () => window.prompt('复制这串标记：', marker);
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(marker).then(done).catch(fallback);
            } else {
                fallback();
            }
        } else if (action === 'judge-now') {
            judgeNow();
        } else if (action === 'open-settings') {
            const settingsBlock = document.querySelector('#state-engine-panel details.se-settings');
            if (settingsBlock) {
                settingsBlock.open = true;
                settingsBlock.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
        } else if (action === 'clear-current') {
            const store = getStore();
            const deck = store?.decks.find((item) => item.id === deckId);
            if (store && deck) {
                const { removed } = clearCurrent(store.state, deck);
                saveStore({ immediate: true });
                refreshInjections();
                renderPanel();
                toast(removed.length > 0 ? 'success' : 'info', removed.length > 0
                    ? `已清空「${deck.name || deck.id}」当前抽中的内容（条目状态不变）`
                    : `「${deck.name || deck.id}」现在没有抽中的内容`);
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
            } else if (field === 'hold.turns' || field === 'hold.days') {
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
        } else if (target.dataset.composeBy) {
            const root = document.getElementById('se-editor');
            const ids = [...(root?.querySelectorAll('[data-compose-by]') || [])]
                .filter((el) => el.checked)
                .map((el) => el.dataset.composeBy);
            setDeckField(deckId, 'compose', ids);
            const fresh = getStore();
            const freshDeck = fresh?.decks.find((item) => item.id === deckId);
            const names = (freshDeck?.compose || []).map((id) => fresh.decks.find((item) => item.id === id)?.name || id);
            const summary = document.getElementById('se-compose-summary');
            if (summary) {
                summary.textContent = names.length ? `已选 ${names.length} 个：${names.join('、')}` : '还没有组合来源，点这里选择';
                summary.title = names.join('、');
            }
        } else if (target.dataset.lockTarget) {
            const root = document.getElementById('se-editor');
            const ids = [...(root?.querySelectorAll('[data-lock-target]') || [])]
                .filter((el) => el.checked)
                .map((el) => el.dataset.lockTarget);
            setDeckField(deckId, 'lockTargets', ids);
            const fresh = getStore();
            const freshDeck = fresh?.decks.find((item) => item.id === deckId);
            const names = (freshDeck?.lockTargets || []).map((id) => fresh.decks.find((item) => item.id === id)?.name || id);
            const summary = document.getElementById('se-lock-summary');
            if (summary) {
                summary.textContent = names.length ? `压制 ${names.length} 个：${names.join('、')}` : '不指定：只压同一层的其它合集';
                summary.title = names.join('、');
            }
        } else if (target.dataset.scanField) {
            const root = document.getElementById('se-editor');
            const fields = [...(root?.querySelectorAll('[data-scan-field]') || [])]
                .filter((el) => el.checked)
                .map((el) => el.dataset.scanField);
            setDeckField(deckId, 'scan.fields', fields);
        } else if (target.dataset.itemEnabled) {
            const row = target.closest('.se-item-row');
            const checked = target.checked;
            setItemField(deckId, target.dataset.itemEnabled, 'enabled', checked);
            row?.classList.toggle('se-item-off', !checked);
            const store = getStore();
            const deck = store?.decks.find((d) => d.id === deckId);
            const item = deck?.items.find((i) => i.id === target.dataset.itemEnabled);
            if (item) {
                item.enabled = checked;
            }
            refreshInjections();
        } else if (target.dataset.deckEnabled) {
            const id = target.dataset.deckEnabled;
            const checked = target.checked;
            setDeckField(id, 'enabled', checked);
            target.closest('.se-deck-item')?.classList.toggle('se-deck-off', !checked);
            refreshInjections();
        } else if (target.dataset.itemField) {
            const row = target.closest('.se-item-row');
            if (row?.dataset.item) {
                // 勾选框传 checked；普通输入框传 value。
                const value = target.type === 'checkbox' ? target.checked : target.value;
                setItemField(deckId, row.dataset.item, target.dataset.itemField, value);
                // 「这条自己的持续」选轮数/天数时，把对应的数字框显出来。
                if (target.dataset.itemField === 'hold.mode') {
                    row.querySelector('.se-item-hold-turns')?.toggleAttribute('hidden', value !== 'turns');
                    row.querySelector('.se-item-hold-days')?.toggleAttribute('hidden', value !== 'days');
                }
                // 动态权重换玩法时，把对应的参数块显出来（关闭时全部变灰）。
                if (target.dataset.itemField === 'fatigue.mode') {
                    const on = value && value !== 'off';
                    row.querySelectorAll('.se-fatigue-decay').forEach((el) => el.toggleAttribute('hidden', value !== 'decay'));
                    row.querySelectorAll('.se-fatigue-boost').forEach((el) => el.toggleAttribute('hidden', value !== 'boost'));
                    row.querySelectorAll('[data-item-field^="fatigue."]').forEach((el) => {
                        if (el.dataset.itemField !== 'fatigue.mode') {
                            el.disabled = !on;
                        }
                    });
                }
                // 动态权重的摘要要跟着参数走：改幅度/间隔/上限，摘要立刻重算。
                if (String(target.dataset.itemField || '').startsWith('fatigue.')) {
                    const summary = row.querySelector('.se-fatigue-block > summary');
                    if (summary) {
                        const item = getStore()?.decks.find((d) => d.id === deckId)?.items.find((i) => i.id === row.dataset.item);
                        summary.textContent = `动态权重：${fatigueLabel(item?.fatigue)}`;
                    }
                }
            }
        } else if (target.dataset.requireRef || target.dataset.excludeRef) {
            const row = target.closest('.se-item-row');
            if (row?.dataset.item) {
                const isExclude = Boolean(target.dataset.excludeRef);
                const refKey = isExclude ? 'excludeRef' : 'requireRef';
                const checked = [...row.querySelectorAll(`[data-${isExclude ? 'exclude' : 'require'}-ref]`)].filter((el) => el.checked);
                const refs = checked.map((el) => el.dataset[refKey]);
                setItemField(deckId, row.dataset.item, isExclude ? 'excludes' : 'requires', refs);
                // 只更新这一行的摘要，不重绘整块（否则正在勾的列表会被收起来）。
                const summary = row.querySelector(isExclude ? '.se-exclude-block > summary' : '.se-require-block:not(.se-exclude-block) > summary');
                if (summary) {
                    const names = checked.map((el) => el.closest('label')?.querySelector('span')?.textContent?.trim() || el.dataset[refKey]);
                    const label = isExclude ? '排除' : '前置';
                    summary.textContent = names.length
                        ? `${label}：已选 ${names.length} 个（${names.slice(0, 2).join('、')}${names.length > 2 ? '…' : ''}）`
                        : `${label}：无`;
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
        // 新聊天开出来是空的：如果这张卡自带合集，就自动带进来（不再弹窗问）。
        // 已经有合集的聊天绝不动，避免拿卡里的旧快照覆盖聊天内容。
        setTimeout(() => {
            try {
                renderCardHint();
            } catch (error) {
                console.warn('[state-engine] card hint failed', error);
            }
        }, 900);
        // 装了插件的人打开带提醒的卡：立刻换回作者写的开场白，
        // 不等轮询、也不等用户刷新页面。恢复是幂等的，guard 删掉之后就不会再跑。
        restoreSelectedCharacterFirstMes();
        setTimeout(restoreSelectedCharacterFirstMes, 500);
        setTimeout(() => {
            restoreSelectedCharacterFirstMes();
            fixWarningChatMessage().catch(() => {});
        }, 1600);
    } catch (error) {
        console.warn('[state-engine] chat changed failed', error);
    }
}

/** 当前选中的角色卡如果带着安装提醒，立刻恢复成原文并顺手刷新界面。 */
function restoreSelectedCharacterFirstMes() {
    try {
        const character = currentCharacterCard();
        const guard = firstMesGuardOf(character);
        if (!guard) {
            return;
        }
        restoreFirstMesFor(character)
            .then((done) => {
                if (!done) {
                    return;
                }
                refreshCharacterEditorFirstMes(guard.original);
                fixChatFirstMessage(character, guard.original).catch(() => {});
            })
            .catch((error) => console.warn('[state-engine] 恢复开局失败', error));
    } catch (error) {
        console.warn('[state-engine] 恢复开局失败', error);
    }
}

/** 角色列表/角色面板加载后补一刀：把还带着安装提醒的卡换回原文。 */
function onCharacterPageLoaded() {
    setTimeout(restoreSelectedCharacterFirstMes, 250);
    setTimeout(() => {
        // 恢复可能已经把 guard 删了，这时用角色卡上已经换好的开场白再刷一次输入框。
        const original = currentCharacterCard()?.data?.first_mes;
        if (typeof original === 'string' && !isFirstMesWarning(original)) {
            refreshCharacterEditorFirstMes(original);
        }
    }, 900);
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

/**
 * AI 消息落地后立刻认标记并抽签。
 * 这样下一轮生成时注入已经是最新内容，不会出现「这一轮白跑、下一轮才换」。
 */
function onMessageReceived() {
    // 等 ST 把消息写进 chat 再读。
    setTimeout(() => {
        try {
            const store = getStore({ create: false });
            if (!store || !settings.enabled) {
                return;
            }
            processAiMarkers(store, liveContext());
        } catch (error) {
            console.warn('[state-engine] marker handling failed', error);
        }
    }, 150);
}

/**
 * 删楼之后把状态跟回去：楼层变短了，就去最近的那张快照。
 */
function onMessageDeleted() {
    setTimeout(() => {
        try {
            const store = getStore({ create: false });
            if (!store || !store.state) {
                return;
            }
            const ctx = liveContext();
            syncTurn(store.state, ctx?.chat?.length ?? 0);
            saveStore({ immediate: true });
            refreshInjections();
            refreshPanelLight();
        } catch (error) {
            console.warn('[state-engine] rollback failed', error);
        }
    }, 120);
}

/**
 * 只处理上一楼 AI 消息里的申请标记（不含楼层自动、关键词）。
 * 返回真正抽中的合集数。
 */
function processAiMarkers(store, ctx) {
    if (!store || !ctx) {
        return 0;
    }
    syncTurn(store.state, ctx?.chat?.length ?? 0);
    syncGameDay(store);
    const floor = Number(store.state.turn) || 0;
    // 先处理「结束」：模型可能在同一楼里既喊结束、又申请下一段。
    // 不先清掉当前内容的话，下面抽签会被「还在持续」挡住，看起来就像没反应。
    const endMarkers = endMarkersInLastAiMessage();
    if (endMarkers.length > 0) {
        for (const deck of store.decks) {
            if (deck.enabled === false || (deck.trigger || DEFAULT_TRIGGER).ai !== true) {
                continue;
            }
            if (endMarkers.includes(deck.id)) {
                endHold(store.state, deck);
            }
        }
    }
    const markers = markersInLastAiMessage();
    if (markers.length === 0) {
        return 0;
    }
    if (Number(store.state.markerFloor ?? -1) === floor) {
        return 0;
    }
    const lockDeck = activeLockDeck(store.state, store.decks);
    const fired = [];
    for (const deck of store.decks) {
        if (deck.enabled === false || !bindingActive(deck, ctx)) {
            continue;
        }
        if (lockSuppresses(deck, lockDeck)) {
            continue;
        }
        if ((deck.trigger || DEFAULT_TRIGGER).ai !== true) {
            continue;
        }
        if (!markers.includes(deck.id)) {
            continue;
        }
        if (deckExhausted(store.state, store.decks, deck.id)) {
            continue;
        }
        // 锁定的合集就是焦点：跳过「只能由上级抽中 / 有上级」的限制。
        const isLockedDeck = Boolean(lockDeck && deck.id === lockDeck.id);
        if (!isLockedDeck && (deck.onlyFromParent === true || deck.parent || (deck.summon || DEFAULT_SUMMON).only === true)) {
            continue;
        }
        const tree = drawDeckTree(store.state, store.decks, deck.id, { force: false, cause: 'ai' });
        if (tree.result?.changed) {
            fired.push(deck.id);
        }
    }
    if (fired.length === 0) {
        return 0;
    }
    const summoned = applySummons(store, ctx, fired);
    if (summoned.length > 0) {
        fired.push(...summoned);
    }
    store.state.markerFloor = floor;
    saveStore({ immediate: true });
    refreshInjections();
    refreshPanelLight();
    return fired.length;
}

export async function init() {
    try {
        context = globalThis.SillyTavern?.getContext?.();
        const { eventSource, eventTypes, extensionSettings } = context;
        settings = { ...settings, ...(extensionSettings?.[SETTINGS_KEY] || {}) };
        // 公共库是全局的，settings.json 偶尔会因为「保存还没落盘就刷新」丢掉最后一次改动。
        // 这里用 localStorage 做一层镜像：本地缓存比设置里多，就以本地为准补回来。
        if (!Array.isArray(settings.globalDecks)) {
            settings.globalDecks = [];
        }
        try {
            const cached = JSON.parse(localStorage.getItem(GLOBAL_CACHE_KEY) || '[]');
            if (Array.isArray(cached) && cached.length > settings.globalDecks.length) {
                settings.globalDecks = cached;
                saveSettings();
                console.info('[state-engine] 从本地缓存恢复公共库', cached.length);
            }
            mirrorGlobalDecks();
        } catch (error) {
            /* 缓存坏了就忽略 */
        }
        // 老版本默认模板（没改过的）跟着升级；用户自己改过的保留。
        const tplText = typeof settings.aiTemplate === 'string' ? settings.aiTemplate : '';
        const legacyTemplate = tplText.includes('可以申请的清单（下面会写清每份清单现在停在哪')
            || tplText.includes('可以申请的清单如下：');
        if (!settings.aiTemplate || legacyTemplate) {
            settings.aiTemplate = DEFAULT_AI_TEMPLATE;
        }
        if (!Number.isFinite(Number(settings.aiDepth))) {
            settings.aiDepth = 4;
        }
        settings.autoCardSync = settings.autoCardSync === true;
        if (!document.getElementById('state-engine-button')) {
            ensureTopBarEntry();
        }
        bindPanelEvents();
        installCardExportHook();
        const autoSyncBox = document.getElementById('se-auto-card-sync');
        if (autoSyncBox) {
            autoSyncBox.checked = settings.autoCardSync === true;
        }
        eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
        eventSource.on(eventTypes.GENERATION_STARTED, onGenerationStarted);
        // 消息一落地就认标记，别等下一轮生成开头：那样会白白浪费一整轮。
        eventSource.on(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
        // 删楼 / 切分支要把状态跟回去。
        eventSource.on(eventTypes.MESSAGE_DELETED, onMessageDeleted);
        eventSource.on(eventTypes.CHARACTER_PAGE_LOADED, onCharacterPageLoaded);
        eventSource.on(eventTypes.CHARACTER_EDITOR_OPENED, onCharacterPageLoaded);
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
        eventSource?.removeListener?.(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
        eventSource?.removeListener?.(eventTypes.MESSAGE_DELETED, onMessageDeleted);
        eventSource?.removeListener?.(eventTypes.CHARACTER_PAGE_LOADED, onCharacterPageLoaded);
        eventSource?.removeListener?.(eventTypes.CHARACTER_EDITOR_OPENED, onCharacterPageLoaded);
        clearInjections(ctx, getDecks());
        if (installCardExportHook.installed && installCardExportHook.originalFetch) {
            window.fetch = installCardExportHook.originalFetch;
            installCardExportHook.installed = false;
        }
        document.getElementById(BUTTON_ID)?.remove();
        delete ctx?.extensionSettings?.[SETTINGS_KEY];
    } catch (error) {
        console.warn('[state-engine] clean failed', error);
    }
}
