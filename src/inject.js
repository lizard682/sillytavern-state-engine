/**
 * 注入层：把抽到的条目按合集设置送进上下文。
 *
 * 注入位置学世界书：
 * - chat   聊天记录里，带深度（setExtensionPrompt position=1 IN_CHAT）
 * - prompt 系统提示（position=0 IN_PROMPT）
 * - before 提示词最前（position=2 BEFORE_PROMPT）
 */

export const PROMPT_POSITION = { chat: 1, prompt: 0, before: 2 };
export const PROMPT_ROLE = { system: 0, user: 1, assistant: 2 };
export const DIRECTOR_KEY = 'stateEngine:director';

/** 每个合集的注入键。删除合集时要按这个前缀清残留。 */
export function promptKey(deckId) {
    return `stateEngine:deck:${deckId}`;
}

/** 只把条目的内容拼起来，不套任何模板。绑定角色时标题带上角色名。 */
export function compileDeckText(deck, items) {
    if (!items || items.length === 0) {
        return '';
    }
    const binding = deck.binding || {};
    const owner = binding.type !== 'none' ? String(binding.name || '').trim() : '';
    const head = owner ? `【${owner}·${deck.name}】` : `【${deck.name}】`;
    const body = items.map((item) => item.text).join('\n');
    return `${head}\n${body}`;
}

/** 把一个合集的当前值写进（或清出）上下文。 */
export function injectDeck(ctx, deck, items) {
    if (!ctx?.setExtensionPrompt) {
        return;
    }
    const key = promptKey(deck.id);
    const text = compileDeckText(deck, items);
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
    '可以申请的清单（括号里是这份清单里可用的选项）：',
    '{{decks}}',
].join('\n');

/**
 * AI 判定触发用的「导演提示」。
 * 只列合集自己开了 trigger.ai 的；模板由用户编辑，{{decks}} 会被替换。
 * itemsByDeck 用来把每份清单的可选项一并告诉模型，否则它不知道库里有什么。
 */
export function buildDirectorPrompt(decks, template = '', itemsByDeck = {}) {
    const usable = decks.filter((deck) => deck.enabled !== false && deck.trigger?.ai === true);
    // 有些合集不是靠 AI 触发，而是靠 AI 决定「什么时候结束」。
    const endable = decks.filter((deck) => deck.enabled !== false
        && deck.hold?.mode === 'ai'
        && deck.trigger?.ai !== true);
    if (usable.length === 0 && endable.length === 0) {
        return '';
    }
    const lines = usable.map((deck) => {
        const extra = String(deck.aiPrompt || '').trim();
        const items = Array.isArray(itemsByDeck[deck.id]) ? itemsByDeck[deck.id] : [];
        const names = items
            .map((item) => String(item?.name || '').trim())
            .filter(Boolean)
            .slice(0, 24);
        const more = items.length > names.length ? `…（共 ${items.length} 条）` : '';
        const options = names.length ? `${names.join('、')}${more}` : '';
        const tail = [options, extra ? `说明：${extra}` : ''].filter(Boolean).join('；');
        return `- ${deck.name}：<!--SE:${deck.id}-->${tail ? `\n  ${tail}` : ''}`;
    });
    const body = usable.length > 0
        ? (template || DEFAULT_AI_TEMPLATE).replace('{{decks}}', lines.join('\n'))
        : '';
    if (endable.length === 0) {
        return body;
    }
    const endLines = endable.map((deck) => `- ${deck.name}：<!--SE-END:${deck.id}-->`);
    const endBlock = `如果下面这些内容已经不需要了，可以在回复的最后单独一行写标记结束：\n${endLines.join('\n')}`;
    return body ? `${body}\n\n${endBlock}` : endBlock;
}
