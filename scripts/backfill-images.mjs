// backfill-images.mjs — 一次性回填：把历史 JSONL 里「文本带图片路径」或「只有 [image] 占位、无路径」的
// 用户消息，真正导入到 mediaDir（D 盘）并补写 type:image 记录；再把「## 图片」段追加到当日 md。
// 用法：node scripts/backfill-images.mjs [YYYYMMDD]   （不传则处理今天）
import { paths, readJsonl, appendText, readText, writeText, defaultDiaryDir, defaultMediaDir, localParts, dateFromKey } from '../lib/storage.js';
import { saveImage, collectImagePathsFromText, scanIncoming } from '../lib/image.js';
import path from 'node:path';
import { homedir } from 'node:os';
import fs from 'node:fs';

const diaryDir = defaultDiaryDir();
const mediaDir = defaultMediaDir();
const incomingMediaDirs = [path.join(homedir(), '.dsh-qqbot', 'media')];

const arg = process.argv[2];
const dateKey = arg || localParts(new Date()).dateKey;
const P = paths(diaryDir);

const records = await readJsonl(P.tmp(dateKey));
console.log(`[backfill] ${dateKey}: 读取 ${records.length} 条记录`);

const tsWithImage = new Set(records.filter(r => r.type === 'image').map(r => r.ts));
const imageRecords = [];
let imported = 0;

for (const r of records) {
  if (r.type === 'image') continue;
  if (r.role !== 'user') continue;
  if (tsWithImage.has(r.ts)) continue; // 该 ts 已有图片记录，跳过
  const text = r.text || '';
  const pathsInText = collectImagePathsFromText(text);
  let saved = [];
  for (const p of pathsInText) {
    const s = await saveImage({ path: p }, dateKey, mediaDir);
    if (s) { saved.push(s); tsWithImage.add(r.ts); }
  }
  if (saved.length === 0 && /\[(?:image|图片)\]/i.test(text)) {
    const tsMs = Date.parse(r.ts);
    const scanned = await scanIncoming(incomingMediaDirs, dateKey, mediaDir, tsMs);
    for (const s of scanned) { saved.push(s); }
    if (saved.length) tsWithImage.add(r.ts);
  }
  for (const s of saved) {
    imageRecords.push({
      sessionId: r.sessionId, ts: r.ts, turn: r.turn, role: r.role, type: 'image',
      src: s.src, hash: s.hash, size: s.size, width: s.width, height: s.height,
    });
    imported++;
  }
}

if (imageRecords.length) {
  const bulk = imageRecords.map(o => JSON.stringify(o) + '\n').join('');
  await appendText(P.tmp(dateKey), bulk);
  console.log(`[backfill] 补写 ${imageRecords.length} 条图片记录到 tmp/${dateKey}.jsonl`);
} else {
  console.log(`[backfill] 没有需要补写的图片记录`);
}

// 把「## 图片」段追加到当日 md（若还不存在），渲染指向我们 media 目录的图片
const mdPath = P.dayMd(dateKey);
let md = await readText(mdPath);
if (md) {
  // 顺手清理原始对话里残留的图片系统行 / 占位（统一成新格式「你：[图片]」），避免泄漏 QQ 桥内部路径
  const cleaned = md.split('\n').map((line) => {
    const m = line.match(/^(\d{1,2}:\d{2}\s+[你大肥鱼]：)(.*)$/);
    if (!m) return line;
    const prefix = m[1];
    let body = m[2]
      .replace(/\s*[-–]\s*Image:\s*\S+/gi, '')   // 去掉 "- Image: 路径"
      .replace(/\s*\[(?:image|图片)\]\s*/gi, '')  // 去掉 [image]/[图片] 占位
      .trim();
    if (!body) body = '[图片]';
    return prefix + body;
  }).join('\n');
  md = cleaned;
}
if (md && !md.includes('## 图片')) {
  const all = records.concat(imageRecords);
  const imgs = all.filter(x => x.type === 'image' && x.src);
  if (imgs.length) {
    const section = '\n## 图片\n' + imgs.map(r => {
      const who = r.role === 'user' ? '你' : '大肥鱼';
      const t = String(r.ts || '').slice(11, 16) || '--:--';
      const url = 'file:///' + String(r.src).replace(/\\/g, '/');
      return `![${who} ${t}](${url})`;
    }).join('\n') + '\n';
    await writeText(mdPath, md.replace(/\n*$/, '\n') + section);
    console.log(`[backfill] 向 ${mdPath} 追加 ## 图片（${imgs.length} 张）`);
  }
} else if (md && md.includes('## 图片')) {
  // 已有图片段：仅把清理后的原始对话写回（保留图片段），避免残留系统路径
  await writeText(mdPath, md);
  console.log(`[backfill] ${mdPath} 已清理原始对话并保留 ## 图片 段`);
}

console.log(`[backfill] 完成，本次导入 ${imported} 张图片到 ${mediaDir}`);
