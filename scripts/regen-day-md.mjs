// 一次性/可复用：用干净 JSONL 重新生成某天「日记正文」md（header + 原始对话 + 图片段）。
// 复用 rollup.js 的 renderDayMd（单一渲染来源），只重写正文，不碰情绪段/月度索引/state。
// 用途：当 tmp JSONL 被清理/回填后，让 md 与 JSONL 重新一致（去掉泄漏的内部路径等）。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { paths, readJsonl } from '../lib/storage.js';
import { renderDayMd } from '../lib/rollup.js';

const diaryDir = process.env.DIARY_DIR || path.join(process.env.USERPROFILE || process.env.HOME, '.dsh', 'diary');
const dateKey = process.argv[2];
if (!dateKey) { console.error('用法: node regen-day-md.mjs <YYYYMMDD>'); process.exit(2); }

const P = paths(diaryDir);
const records = await readJsonl(P.tmp(dateKey));
const md = renderDayMd(records, dateKey);
await fs.writeFile(P.dayMd(dateKey), md, 'utf8');
console.log(`[regen-day-md] ${dateKey}：用 ${records.length} 条记录重写 ${P.dayMd(dateKey)}`);
console.log(`  - - Image: 残留: ${(md.match(/Image:\s*C:/g) || []).length}（应为 0）`);
console.log(`  - 图片引用: ${(md.match(/^!\[/gm) || []).length}`);
