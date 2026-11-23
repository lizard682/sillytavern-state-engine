/**
 * 注入层：把抽到的条目按合集设置送进上下文。
 *
 * 注入位置学世界书：
 * - chat   聊天记录里，带深度（setExtensionPrompt position=1 IN_CHAT）
 * - prompt 系统提示（position=0 IN_PROMPT）
 * - before 提示词最前（position=2 BEFORE_PROMPT）
 */

import { availableItems } from './state.js';

export const PROMPT_POSITION = { chat: 1, prompt: 0, before: 2 };
export const PROMPT_ROLE = { system: 0, user: 1, assistant: 2 };
export const DIRECTOR_KEY = 'stateEngine:director';

/** 每个合集的注入键。删除合集时要按这个前缀清残留。 */
export function promptKey(deckId) {
    return `stateEngine:deck:${deckId}`;
}

/** 只把条目的内容拼起来，不套任何模板。绑定角色时标题带上角色名。
 *  rendered 是「组合」之后的文本（按条目 id），没有就退回条目原文。 */
export function compileDeckText(deck, items, rendered = {}) {
    if (!items || items.length === 0) {
        return '';
    }
    const binding = deck.binding || {};
    const owner = binding.type !== 'none' ? String(binding.name || '').trim() : '';
    const head = owner ? `【${owner}·${deck.name}】` : `【${deck.name}】`;
    const body = items
        .map((item) => String((rendered && rendered[item.id]) ?? item.text ?? ''))
        .join('\n');
    return `${head}\n${body}`;
}

/** 把一个合集的当前值写进（或清出）上下文。 */
export function injectDeck(ctx, deck, items, rendered = {}) {
    if (!ctx?.setExtensionPrompt) {
        return;
    }
    const key = promptKey(deck.id);
    const text = compileDeckText(deck, items, rendered);
    if (!text) {
        ctx.setExtensionPrompt(key, '', PROMPT_POSITION.chat, 0, false, PROMPT_ROLE.system);
        return;
    }
    const inject = deck.inject || {};
    const position = PROMPT_POSITION[inject.position] ?? PROMPT_POSITION.chat;
    const role = PROMPT_ROLE[inject.role] ?? PROMPT_ROLE.system;
    const depth = position === PROMPT_POSITION.chat ? Math.max(0, Number(inject.depth) || 0) : 0;
    ctx.setExtensionPrompt(key, text, position, depth, false, role);
}

/** 清掉所有合集注入，并顺手清理已经删除的合集留下的键。 */
export function clearInjections(ctx, decks = []) {
    if (!ctx?.setExtensionPrompt) {
        return;
    }
    const alive = new Set(decks.map((deck) => promptKey(deck.id)));
    for (const key of Object.keys(ctx.extensionPrompts || {})) {
        if (key.startsWith('stateEngine:deck:') && !alive.has(key)) {
            ctx.setExtensionPrompt(key, '', 0, 0, false, 0);
        }
    }
    for (const deck of decks) {
        ctx.setExtensionPrompt(promptKey(deck.id), '', 0, 0, false, 0);
    }
    ctx.setExtensionPrompt(DIRECTOR_KEY, '', PROMPT_POSITION.chat, 0, false, PROMPT_ROLE.system);
}

/** 默认的 AI 判定说明（可以在面板里改）。 */
export const DEFAULT_AI_TEMPLATE = [
    '你可以在剧情自然需要时申请调整下面这些清单。先在心里过一遍：',
    '1. 观察：这一轮发生在什么场景，角色正在做什么。',
    '2. 判断：是否出现了「必须换一套 / 换一个」的明确理由（换衣服、到新地点、用技能、顺手拿道具……）。',
    '3. 克制：理由不充分就不要申请；同一件事不要连续两轮申请。',
    '决定申请时，在回复的最后单独一行输出标记，格式：<!--SE:合集id-->',
    '标记是写给系统看的，不会出现在正文里；只输出标记本身，不要解释，也不要重复清单内容。',
    '',
    '可以申请的清单（下面会写清每份清单现在停在哪、后面还有哪些）：',
    '{{decks}}',
].join('\n');

/**
 * AI 判定触发用的「导演提示」。
 * 只列合集自己开了 trigger.ai 的；模板由用户编辑，{{decks}} 会被替换。
 * itemsByDeck 用来把每份清单的可选项一并告诉模型，否则它不知道库里有什么。
 * contextInfo.currentByDeck / contextInfo.done 用来告诉模型「现在是哪一条、后面还有哪些」，
 * 尤其是嵌套的剧情线：模型得知道下一章是什么，才判断得出该不该申请下一轮。
 */
export function buildDirectorPrompt(decks, template = '', itemsByDeck = {}, contextInfo = {}) {
    const currentByDeck = contextInfo.currentByDeck || {};
    const done = contextInfo.done instanceof Set ? contextInfo.done : new Set(contextInfo.done || []);
    const state = contextInfo.state || null;
    const usable = decks.filter((deck) => deck.enabled !== false && deck.trigger?.ai === true);
    // 有些合集不是靠 AI 触发，而是靠 AI 决定「什么时候结束」。
    const endable = decks.filter((deck) => deck.enabled !== false
        && deck.hold?.mode === 'ai'
        && deck.trigger?.ai !== true);
    const lockName = String(contextInfo.lockName || '').trim();
    if (usable.length === 0 && endable.length === 0) {
        return lockName
            ? `现在「${lockName}」开着不可打断，其它清单暂时休眠；等它抽无可抽，再申请调别的。`
            : '';
    }

    const nameOf = (deckId, itemId) => {
        const items = Array.isArray(itemsByDeck[deckId]) ? itemsByDeck[deckId] : [];
        return String(items.find((item) => item?.id === itemId)?.name || '').trim();
    };
    const currentNames = (deckId) => (Array.isArray(currentByDeck[deckId]) ? currentByDeck[deckId] : [])
        .map((id) => nameOf(deckId, id))
        .filter(Boolean);
    // 真正现在能抽到的条目：冷却、权重、一次性、前置、排除都算过之后的结果。
    const availableIds = (deck) => {
        if (!state || !deck) {
            return null;
        }
        try {
            return new Set(availableItems(state, deck).map((item) => item?.id).filter(Boolean));
        } catch {
            return null;
        }
    };
    const splitPending = (deck, items) => {
        const avail = availableIds(deck);
        const pending = [];
        const locked = [];
        for (const item of items) {
            const id = item?.id;
            if (!id || done.has(`${deck.id}::${id}`)) {
                continue;
            }
            const name = String(item.name || '').trim();
            if (!name) {
                continue;
            }
            if (!avail || avail.has(id)) {
                pending.push(name);
            } else if (Number(item.weight) > 0) {
                locked.push(name);
            }
        }
        return { pending, locked };
    };

    const lines = usable.map((deck) => {
        const extra = String(deck.aiPrompt || '').trim();
        const items = Array.isArray(itemsByDeck[deck.id]) ? itemsByDeck[deck.id] : [];
        const cur = currentNames(deck.id);
        const { pending, locked } = splitPending(deck, items);
        const parts = [];
        if (cur.length) {
            parts.push(`当前：${cur.join('、')}`);
        }
        if (pending.length) {
            const more = pending.length > 12 ? '…' : '';
            parts.push(`现在可以抽：${pending.slice(0, 12).join('、')}${more}`);
        }
        if (locked.length) {
            const more = locked.length > 6 ? '…' : '';
            parts.push(`还没解锁：${locked.slice(0, 6).join('、')}${more}`);
        }
        if (!cur.length && !pending.length && !locked.length && items.length === 0) {
            parts.push('（这份清单还没有条目）');
        }
        // 挂在它下面的支线：把每条支线当前停在哪、后面还有哪几幕告诉模型。
        const children = decks.filter((item) => item.parent === deck.id && item.enabled !== false);
        if (children.length > 0) {
            const childLines = children.map((child) => {
                const childCur = currentNames(child.id);
                const childItems = Array.isArray(itemsByDeck[child.id]) ? itemsByDeck[child.id] : [];
                const { pending: childPending } = splitPending(child, childItems);
                const bits = [];
                if (childCur.length) {
                    bits.push(`当前：${childCur.join('、')}`);
                }
                if (childPending.length) {
                    bits.push(`接下来：${childPending.slice(0, 8).join('、')}`);
                }
                return `  └ ${child.name}${bits.length ? `｜${bits.join('｜')}` : ''}｜要推进它就申请抽「${deck.name}」`;
            });
            parts.push(`支线：\n${childLines.join('\n')}`);
        }
        if (extra) {
            parts.push(`说明：${extra}`);
        }
        const tail = parts.join('\n  ');
        return `- ${deck.name}｜申请时写这串：<!--SE:${deck.id}-->${tail ? `\n  ${tail}` : ''}`;
    });
    const lockLine = lockName
        ? `现在「${lockName}」开着不可打断，只处理它；其它清单暂时休眠，等它抽无可抽再说。\n`
        : '';
    const body = usable.length > 0
        ? lockLine + (template || DEFAULT_AI_TEMPLATE).replace('{{decks}}', lines.join('\n'))
        : '';
    if (endable.length === 0) {
        return body;
    }
    const endLines = endable.map((deck) => `- ${deck.name}：<!--SE-END:${deck.id}-->`);
    const endBlock = `如果下面这些内容已经不需要了，可以在回复的最后单独一行写标记结束：\n${endLines.join('\n')}`;
    return body ? `${body}\n\n${endBlock}` : endBlock;
}
