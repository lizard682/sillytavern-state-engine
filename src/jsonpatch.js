/**
 * 最小的 JSON Patch（RFC 6902）应用器，只处理角色卡变量这种普通对象。
 * 支持 add / replace / remove / copy / move；test 只做校验、不改值。
 * 路径按 "/" 分段，首段若是 stat_data 会剥掉；中文键名原样保留。
 */
function parsePath(path) {
    return String(path || '')
        .replace(/^\//, '')
        .split('/')
        .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'))
        .filter((seg) => seg !== '');
}

function getAtPath(root, segs) {
    let cur = root;
    for (const key of segs) {
        if (cur === null || typeof cur !== 'object') {
            return undefined;
        }
        cur = cur[key];
    }
    return cur;
}

function setAtPath(root, segs, value) {
    let cur = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
        const key = segs[i];
        if (!cur[key] || typeof cur[key] !== 'object') {
            cur[key] = {};
        }
        cur = cur[key];
    }
    cur[segs[segs.length - 1]] = value;
}

export function applyJsonPatch(doc, operations) {
    if (!doc || typeof doc !== 'object' || !Array.isArray(operations)) {
        return 0;
    }
    let changed = 0;
    for (const op of operations) {
        if (!op || typeof op !== 'object') {
            continue;
        }
        const kind = String(op.op || '').toLowerCase();
        const segs = parsePath(op.path);
        if (segs[0] === 'stat_data') {
            segs.shift();
        }
        if (!segs.length && kind !== 'test') {
            continue;
        }
        if (kind === 'add' || kind === 'replace') {
            setAtPath(doc, segs, op.value);
            changed += 1;
        } else if (kind === 'remove') {
            const parent = getAtPath(doc, segs.slice(0, -1));
            if (parent && typeof parent === 'object') {
                delete parent[segs[segs.length - 1]];
                changed += 1;
            }
        } else if (kind === 'copy' || kind === 'move') {
            const fromSegs = parsePath(op.from);
            if (fromSegs[0] === 'stat_data') {
                fromSegs.shift();
            }
            const value = getAtPath(doc, fromSegs);
            if (value === undefined) {
                continue;
            }
            setAtPath(doc, segs, value);
            if (kind === 'move') {
                const fromParent = getAtPath(doc, fromSegs.slice(0, -1));
                if (fromParent && typeof fromParent === 'object') {
                    delete fromParent[fromSegs[fromSegs.length - 1]];
                }
            }
            changed += 1;
        }
    }
    return changed;
}

/** 从一段 AI 回复里抽出所有 <UpdateVariable> 块里的 JSONPatch 操作。 */
export function extractPatches(text) {
    const source = String(text || '');
    const out = [];
    const blockRe = /<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/gi;
    let block;
    while ((block = blockRe.exec(source)) !== null) {
        const inner = block[1] || '';
        const patchRe = /<JSONPatch>([\s\S]*?)<\/JSONPatch>/gi;
        let patch;
        let matched = false;
        while ((patch = patchRe.exec(inner)) !== null) {
            matched = true;
            const ops = parsePatchBody(patch[1]);
            if (ops.length) {
                out.push(...ops);
            }
        }
        if (!matched) {
            const ops = parsePatchBody(inner);
            if (ops.length) {
                out.push(...ops);
            }
        }
    }
    return out;
}

function parsePatchBody(body) {
    const cleaned = String(body || '')
        .replace(/```(?:json)?/gi, '')
        .replace(/```/g, '')
        .trim();
    if (!cleaned) {
        return [];
    }
    try {
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) {
            return parsed;
        }
        if (parsed && typeof parsed === 'object') {
            return [parsed];
        }
    } catch {
        // 不是合法 JSON 数组，往下走「一行一个对象」的兜底。
    }
    const ops = [];
    for (const line of cleaned.split('\n')) {
        const trimmed = line.trim().replace(/,$/, '');
        if (!trimmed.startsWith('{')) {
            continue;
        }
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object') {
                ops.push(parsed);
            }
        } catch {
            // 单行解析失败就跳过，不让整段作废。
        }
    }
    return ops;
}
