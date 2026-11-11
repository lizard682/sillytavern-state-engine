/**
 * 卡组包（deck pack）模型 —— schema 3。
 *
 * 一个合集 = 创作者写的一份清单。
 * 插件不内置任何内容，所有内容都在面板里直接编辑，或导入 JSON。
 *
 * 设计取舍（2026-11-08 用户定稿）：
 * - 没有「类型」：合集就是合集，条目内容直接注入，不套模板。
 * - 没有「字数预算」：内容多就多花 token，内容少就少花。
 * - 没有「归属」下拉：要绑定角色就绑 MVU 里的角色名，否则不绑。
 * - 触发方式四种：手动 / 每 N 楼 / 关键词 / AI 判定，全部是合集级。
 * - 注入位置学世界书：聊天里（带深度）/ 系统提示 / 提示词最前。
 */

/** 当前格式版本。导入时接受 1 / 2 / 3 旧版并自动升级。 */
export const PACK_SCHEMA = 4;
const ACCEPTED_SCHEMA = [1, 2, 3, 4];

/**
 * 合集嵌套（schema 4）：
 * - parent：上级合集的 id。空字符串 = 顶层合集。
 *   顶层合集抽签时，如果它有子合集，会先抽一个子合集，再抽子合集里的条目。
 * - onlyFromParent：只能被上级合集抽中时激活；正常楼层自动 / 关键词 / AI 判定都不碰它。
 * - entryWeight：这个合集作为「别人家的子合集」时，被上级抽中的相对权重。
 */
export const DEFAULT_NESTING = {
    parent: '',
    onlyFromParent: false,
    entryWeight: 1,
};

export const DEFAULT_TRIGGER = {
    manual: true,
    auto: false,
    autoEvery: 3,
    keyword: false,
    ai: false,
};

export const DEFAULT_INJECT = {
    position: 'chat', // chat | prompt | before
    depth: 4,
    role: 'system',   // system | user | assistant
};

export const DEFAULT_SCAN = {
    depth: 4,        // 只扫最近 N 条消息；0 = 全部
    source: 'both',  // user | ai | both
    // 除了聊天消息，还可以从这些地方找关键词（由创作者决定）。
    fields: [],
};

/** 扫描字段的白名单：对应角色卡里的文本。 */
export const SCAN_FIELDS = ['description', 'personality', 'scenario', 'persona', 'notes', 'lorebook'];

export const DEFAULT_BINDING = { type: 'none', name: '' };

/** 不能当 id 用：这些键写进普通对象会碰到 Object.prototype。 */
const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * 递归规则（交给创作者设定，不写死）：
 * - canBeRecursed：别的合集抽中后，能不能把我叫起来（世界书的「可被递归激活」）
 * - canRecurse：我抽中后，能不能继续叫醒别的合集（世界书的「进一步递归」）
 * - delay：只在递归阶段才激活，普通触发跳过（世界书的「延迟到递归」）
 */
export const DEFAULT_RECURSION = {
    canBeRecursed: true,
    canRecurse: false,
    delay: false,
};

/**
 * 「被谁唤起」：直接写关系，不靠关键词。
 * - by: 哪些合集抽中时，顺手把我抽一次
 * - only: 我只在被人唤起时出场，平时的自动/手动/关键词都不碰我
 */
export const DEFAULT_SUMMON = {
    by: [],
    only: false,
};

const SUMMON_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * 抽中之后，这条内容在对话里「保持」多久：
 * - mode: 'turns' → 持续 turns 轮（抽中那一轮算第 1 轮）
 * - mode: 'forever' → 一直保留，直到重抽 / 清空记录
 * - mode: 'ai' → 一直保留，直到模型输出 <!--SE-END:合集id--> 主动结束
 */
export const DEFAULT_HOLD = {
    mode: 'forever',
    turns: 3,
};

const HOLD_MODES = ['turns', 'forever', 'ai'];

function normalizeHold(raw) {
    const h = isPlainObject(raw) ? raw : {};
    return {
        mode: HOLD_MODES.includes(h.mode) ? h.mode : DEFAULT_HOLD.mode,
        turns: asInt(h.turns, DEFAULT_HOLD.turns, 1),
    };
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function asInt(value, fallback, min, max = Number.MAX_SAFE_INTEGER) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(n)));
}

/** 把关键词输入整理成数组（支持逗号/顿号/换行分隔，去重）。 */
export function normalizeKeywords(raw) {
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，、\n]+/);
    const out = [];
    for (const item of list) {
        const word = asString(item);
        if (word && !out.includes(word)) {
            out.push(word);
        }
    }
    return out;
}

/** 整理触发设置；兼容旧版 pack 的 auto / autoEvery / marker 字段。 */
export function normalizeTrigger(raw, legacy = {}) {
    const t = isPlainObject(raw) ? raw : {};
    return {
        manual: t.manual !== false,
        auto: typeof t.auto === 'boolean' ? t.auto : legacy.auto === true,
        autoEvery: asInt(t.autoEvery, asInt(legacy.autoEvery, DEFAULT_TRIGGER.autoEvery, 1), 1),
        keyword: typeof t.keyword === 'boolean' ? t.keyword : t.marker === true,
        ai: t.ai === true,
    };
}

function normalizeInject(raw) {
    const i = isPlainObject(raw) ? raw : {};
    const positions = ['chat', 'prompt', 'before'];
    const roles = ['system', 'user', 'assistant'];
    return {
        position: positions.includes(i.position) ? i.position : DEFAULT_INJECT.position,
        depth: asInt(i.depth, DEFAULT_INJECT.depth, 0),
        role: roles.includes(i.role) ? i.role : DEFAULT_INJECT.role,
    };
}

function normalizeScan(raw) {
    const s = isPlainObject(raw) ? raw : {};
    const sources = ['user', 'ai', 'both'];
    const fields = Array.isArray(s.fields)
        ? s.fields.filter((field) => SCAN_FIELDS.includes(field))
        : [];
    return {
        depth: asInt(s.depth, DEFAULT_SCAN.depth, 0),
        source: sources.includes(s.source) ? s.source : DEFAULT_SCAN.source,
        fields,
    };
}

function normalizeRecursion(raw) {
    const r = isPlainObject(raw) ? raw : {};
    return {
        canBeRecursed: r.canBeRecursed !== false,
        canRecurse: r.canRecurse === true,
        delay: r.delay === true,
    };
}

function normalizeSummon(raw) {
    const s = isPlainObject(raw) ? raw : {};
    const by = Array.isArray(s.by)
        ? [...new Set(s.by.map((id) => asString(id)).filter((id) => SUMMON_ID_RE.test(id) && !RESERVED_IDS.has(id)))]
        : [];
    return {
        by,
        only: s.only === true,
    };
}

function normalizeBinding(raw) {
    const b = isPlainObject(raw) ? raw : {};
    const types = ['none', 'character', 'chat', 'manual'];
    return {
        type: types.includes(b.type) ? b.type : DEFAULT_BINDING.type,
        name: asString(b.name),
    };
}

function normalizeNesting(raw) {
    const n = isPlainObject(raw) ? raw : {};
    const parent = asString(n.parent);
    return {
        // 上级 id 只接受合法格式；不合法就当顶层，避免导入一份坏包把整棵树带歪。
        parent: /^[a-zA-Z0-9_-]{1,64}$/.test(parent) ? parent : '',
        onlyFromParent: n.onlyFromParent === true,
        entryWeight: Number.isFinite(Number(n.entryWeight)) ? Math.max(0, Number(n.entryWeight)) : 1,
    };
}

/**
 * 把一条清单项整理成固定形状。
 * 允许作者只写字符串（会被当成标题），也允许写完整对象。
 */
export function normalizeItem(raw, index = 0) {
    if (typeof raw === 'string') {
        const text = raw.trim();
        return { id: `item-${index + 1}`, name: text, text, weight: 1 };
    }
    if (!isPlainObject(raw)) {
        return null;
    }
    const name = asString(raw.name) || asString(raw.title) || asString(raw.text).slice(0, 20);
    const id = asString(raw.id) || `item-${index + 1}`;
    if (!name) {
        return null;
    }
    return {
        id,
        name,
        text: asString(raw.text) || name,
        // 出现概率：相对权重，默认 1；0 表示这一条永不出现（但保留在清单里）。
        weight: Number.isFinite(Number(raw.weight)) ? Math.max(0, Number(raw.weight)) : 1,
    };
}

/**
 * 校验并补全一个合集。返回 { ok, pack, errors }，绝不抛异常。
 */
export function validatePack(raw) {
    const errors = [];
    if (!isPlainObject(raw)) {
        return { ok: false, pack: null, errors: ['文件内容不是 JSON 对象'] };
    }
    if (!ACCEPTED_SCHEMA.includes(raw.schema)) {
        errors.push(`schema 必须是 ${ACCEPTED_SCHEMA.join(' / ')} 之一`);
    }
    const id = asString(raw.id);
    if (!id) {
        errors.push('缺少 id');
    } else if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
        errors.push('id 只能用字母、数字、下划线、短横线，最多 64 个字符');
    } else if (RESERVED_IDS.has(id)) {
        errors.push(`id 不能用保留字「${id}」`);
    }
    if (!Array.isArray(raw.items)) {
        errors.push('items 必须是数组（可以是空数组：纯容器合集靠子合集抽签）');
    }

    const items = [];
    if (Array.isArray(raw.items)) {
        raw.items.forEach((item, index) => {
            const normalized = normalizeItem(item, index);
            if (!normalized) {
                errors.push(`第 ${index + 1} 条清单项无法识别`);
                return;
            }
            items.push(normalized);
        });
    }
    const seen = new Set();
    for (const item of items) {
        if (seen.has(item.id)) {
            errors.push(`清单项 id 重复：${item.id}`);
        }
        seen.add(item.id);
    }

    if (errors.length) {
        return { ok: false, pack: null, errors };
    }

    return {
        ok: true,
        errors: [],
        pack: {
            schema: PACK_SCHEMA,
            id,
            name: asString(raw.name) || id,
            ...normalizeNesting(raw),
            binding: normalizeBinding(raw.binding),
            trigger: normalizeTrigger(raw.trigger, raw),
            keywords: normalizeKeywords(raw.keywords),
            scan: normalizeScan(raw.scan),
            recursion: normalizeRecursion(raw.recursion),
            summon: normalizeSummon(raw.summon),
            hold: normalizeHold(raw.hold),
            inject: normalizeInject(raw.inject),
            cooldown: asInt(raw.cooldown, 2, 0),
            pick: asInt(raw.pick, 1, 1),
            aiPrompt: asString(raw.aiPrompt),
            items,
        },
    };
}

/** 导出时把内部合集还原成可读 JSON。 */
export function serializePack(pack) {
    return {
        schema: PACK_SCHEMA,
        id: pack.id,
        name: pack.name,
        ...normalizeNesting(pack),
        binding: normalizeBinding(pack.binding),
        trigger: normalizeTrigger(pack.trigger),
        keywords: normalizeKeywords(pack.keywords),
        scan: normalizeScan(pack.scan),
        recursion: normalizeRecursion(pack.recursion),
        summon: normalizeSummon(pack.summon),
        hold: normalizeHold(pack.hold),
        inject: normalizeInject(pack.inject),
        cooldown: asInt(pack.cooldown, 2, 0),
        pick: asInt(pack.pick, 1, 1),
        aiPrompt: asString(pack.aiPrompt),
        items: pack.items.map((item) => ({
            id: item.id,
            name: item.name,
            text: item.text,
            weight: item.weight ?? 1,
        })),
    };
}
