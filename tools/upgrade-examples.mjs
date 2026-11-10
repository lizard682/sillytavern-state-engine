/**
 * 把 examples/ 里的 schema 2 示例升级成 schema 3。
 * 运行：node tools/upgrade-examples.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePack, serializePack } from '../src/pack.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'examples');

const extra = {
    'outfit-demo': { keywords: ['换衣服', '外套', '出门'], scan: { depth: 4, source: 'both' }, inject: { position: 'chat', depth: 4, role: 'system' } },
    'action-demo': { keywords: ['回应', '沉默', '被夸奖'], scan: { depth: 3, source: 'both' }, inject: { position: 'chat', depth: 2, role: 'system' } },
    'scene-demo': { keywords: ['去哪', '出发', '约会'], scan: { depth: 4, source: 'both' }, inject: { position: 'chat', depth: 4, role: 'system' } },
    'npc-skill-demo': { keywords: ['登场', '自我介绍'], scan: { depth: 5, source: 'ai' }, inject: { position: 'chat', depth: 3, role: 'system' } },
    'item-demo': { keywords: ['道具', '拿出', '包里'], scan: { depth: 3, source: 'both' }, inject: { position: 'chat', depth: 2, role: 'system' } },
};

for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json'))) {
    const full = path.join(dir, file);
    const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    const result = validatePack({
        schema: 3,
        id: raw.id,
        name: raw.name,
        binding: { type: 'none', name: '' },
        trigger: { manual: true, auto: raw.trigger?.auto === true, autoEvery: 3, keyword: true, ai: false },
        keywords: extra[raw.id]?.keywords || [],
        scan: extra[raw.id]?.scan || { depth: 4, source: 'both' },
        inject: extra[raw.id]?.inject || { position: 'chat', depth: 4, role: 'system' },
        cooldown: raw.cooldown ?? 2,
        pick: raw.pick ?? 1,
        aiPrompt: '',
        items: raw.items.map((item) => ({ id: item.id, name: item.name, text: item.text, weight: item.weight ?? 1 })),
    });
    if (!result.ok) {
        console.error(file, result.errors);
        process.exit(1);
    }
    fs.writeFileSync(full, JSON.stringify(serializePack(result.pack), null, 2) + '\n', 'utf8');
    console.log(`upgraded ${file}: ${result.pack.items.length} items`);
}
