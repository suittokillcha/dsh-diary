// 一次性/可复用：清理某天 JSONL 文本记录里残留的图片占位行
// （"- Image: <路径>" / 独立 "[image]" / "[图片]"），让源头干净。
// 只动 type 缺省（文本）记录的 text 字段；图片记录(type:'image')原样保留。幂等。
import { promises as fs } from 'node:fs';
import path from 'node:path';

const diaryDir = process.env.DIARY_DIR || path.join(process.env.USERPROFILE || process.env.HOME, '.dsh', 'diary');
const dateKey = process.argv[2];
if (!dateKey) { console.error('用法: node cleanup-jsonl.mjs <YYYYMMDD>'); process.exit(2); }

const re1 = /^[\s]*[-–]\s*Image:\s*\S+$/i;   // "- Image: C:/..."
const re2 = /^\[\s*(?:image|图片)\s*\]\s*$/i; // 独立 [image] / [图片]

const p = path.join(diaryDir, 'tmp', `${dateKey}.jsonl`);
const raw = await fs.readFile(p, 'utf8');
const lines = raw.split('\n').filter((l) => l.trim());
let changed = 0;
const out = lines.map((l) => {
  let r;
  try { r = JSON.parse(l); } catch { return l; }
  if (typeof r.text === 'string') {
    const cleaned = r.text
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        if (re1.test(t)) return false;
        if (re2.test(t)) return false;
        return true;
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (cleaned !== r.text) { r.text = cleaned; changed++; }
  }
  return JSON.stringify(r);
});
await fs.writeFile(p, out.join('\n') + '\n', 'utf8');
console.log(`[cleanup-jsonl] ${dateKey}：清理文本记录 ${changed} 条，已写回 ${p}`);
