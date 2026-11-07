// image.js — 把会话里的图片（用户发的 / 大肥鱼生图）压缩存到 mediaDir（默认 D 盘），
// JSONL 只记引用路径。压缩由同目录的 compress_image.py（Pillow）完成，Node 侧 spawn 调用。
// 设计：绝不抛错、绝不阻塞主流程；失败则跳过该图，原始对话文本照常记录。
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, 'compress_image.py');
const MAX_BYTES = 2 * 1024 * 1024; // 2MB
const Q0 = 95;   // JPEG 质量（截图档位）
const QMIN = 30; // 降质底线

/** 动态列出 dsh 自带运行时的 python（不写死用户名/运行时名，跨机器可用）。 */
function runtimePythons() {
  const out = [];
  try {
    const base = path.join(homedir(), '.dsh', 'dsh-runtimes');
    if (fs.existsSync(base)) {
      for (const d of fs.readdirSync(base)) {
        for (const rel of [
          ['dependencies', 'python', 'python.exe'],
          ['dependencies', 'python', 'python3'],
          ['dependencies', 'python', 'bin', 'python3'],
          ['python', 'python.exe'],
        ]) {
          out.push(path.join(base, d, ...rel));
        }
      }
    }
  } catch { /* ignore */ }
  return out;
}

/** 定位 python：优先环境变量，其次 dsh 自带运行时（动态探测，需带 Pillow），再次系统 python。 */
function findPython() {
  const cands = [
    process.env.DSH_PYTHON,
    ...runtimePythons(),
    'python3', 'python',
  ];
  for (const c of cands) {
    if (c && typeof c === 'string') {
      try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
    }
  }
  return 'python';
}

function runPython(py, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(py, [SCRIPT, ...args], { windowsHide: true });
      let out = '', err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', () => resolve(null));
      child.on('close', (code) => {
        if (code !== 0) { resolve(null); return; }
        try { resolve(JSON.parse(out.trim())); } catch { resolve(null); }
      });
    } catch { resolve(null); }
  });
}

/** 从 dsh 的 image 块里尽量解析出图片源（兼容多种形态：url / image_url / src / path / file / data / source）。 */
export function parseImageSpec(block) {
  if (!block || typeof block !== 'object') return null;
  const iu = block.image_url;
  if (typeof block.url === 'string') return { kind: 'url', value: block.url };
  if (iu && typeof iu === 'object' && typeof iu.url === 'string') {
    return iu.url.startsWith('data:')
      ? { kind: 'b64', value: iu.url }
      : { kind: 'url', value: iu.url };
  }
  if (typeof block.src === 'string') return block.src.startsWith('http') ? { kind: 'url', value: block.src } : { kind: 'path', value: block.src };
  if (typeof block.path === 'string') return { kind: 'path', value: block.path };
  if (typeof block.file === 'string') return { kind: 'path', value: block.file };
  if (typeof block.data === 'string') return { kind: 'b64', value: block.data };
  if (block.source && typeof block.source === 'object') {
    if (block.source.type === 'url' && typeof block.source.url === 'string') return { kind: 'url', value: block.source.url };
    if (block.source.type === 'base64' && typeof block.source.data === 'string') return { kind: 'b64', value: block.source.data };
  }
  if (typeof block.content === 'string' && block.content.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(block.content)) {
    return { kind: 'b64', value: block.content };
  }
  return null;
}

/** 判断一个字符串是否像本地图片路径。 */
function looksLikeImagePath(p) {
  if (typeof p !== 'string') return false;
  if (!/\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(p)) return false;
  return /^[A-Za-z]:[\\/]/.test(p) || /^\//.test(p) || p.startsWith('file://');
}

/**
 * 从消息文本里抽取图片文件路径。
 * 兼容两种形态：
 *   - "- Image: C:/.../x.jpg"（QQ 桥注入的绝对路径行）
 *   - 行内的裸本地图片路径（其他桥/来源）
 * 返回去重后的绝对路径数组（只收本地存在的路径由调用方再校验）。
 */
export function collectImagePathsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  const push = (p) => {
    if (p && looksLikeImagePath(p) && !out.includes(p)) out.push(p);
  };
  for (const line of text.split('\n')) {
    const m = line.match(/[-–]\s*Image:\s*(\S+)/i) || line.match(/^\s*Image:\s*(\S+)/i);
    if (m) push(m[1].trim().replace(/["')\]]+$/, ''));
  }
  // 兜底：抓行内的裸路径（Windows 盘符 / 类 Unix 绝对路径），避免漏掉非 "- Image:" 前缀的格式
  for (const line of text.split('\n')) {
    const m = line.match(/([A-Za-z]:\\[^\s"')\]]+\.(?:jpg|jpeg|png|gif|webp|bmp))|(\/[^\s"')\]]+\.(?:jpg|jpeg|png|gif|webp|bmp))/i);
    if (m) push(m[1] || m[2]);
  }
  return out;
}

// 已导入的「源文件」绝对路径集合（持久化到 mediaDir/.imported.json），
// 用于目录扫描兜底时避免重复导入同一张图、也避免重启后重复计入。
let importedCache = null;
function importedPathFile(mediaDir) { return path.join(mediaDir, '.imported.json'); }
function loadImported(mediaDir) {
  if (importedCache) return importedCache;
  let set = new Set();
  try {
    const f = importedPathFile(mediaDir);
    if (fs.existsSync(f)) {
      const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(arr)) set = new Set(arr);
    }
  } catch { /* ignore */ }
  importedCache = set;
  return set;
}
function markImported(mediaDir, p) {
  const set = loadImported(mediaDir);
  set.add(p);
  try { fs.writeFileSync(importedPathFile(mediaDir), JSON.stringify([...set])); } catch { /* ignore */ }
}

/**
 * 目录扫描兜底：当消息只有 `[image]`/`[图片]` 占位、文本里没有路径时，
 * 到 QQ 桥等来源的 media 目录里找「消息时刻前后刚下好、且尚未导入」的图片并落盘。
 * @param {string[]} folders  待扫描的源目录（绝对路径）
 * @param {number} tsMs       消息的毫秒时间戳
 * @param {number} limit      最多导入几张（防止一次消息误吞多张）
 * @returns {Array}  saveImage 的返回（含 src 指向我们 media 目录里的文件）
 */
export async function scanIncoming(folders, dateKey, mediaDir, tsMs, limit = 4) {
  if (!folders || !folders.length) return [];
  const set = loadImported(mediaDir);
  const saved = [];
  for (const folder of folders) {
    let files;
    try { files = fs.readdirSync(folder); } catch { continue; }
    const cands = [];
    for (const f of files) {
      if (!/\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(f)) continue;
      const abs = path.join(folder, f);
      if (set.has(abs)) continue;
      let st; try { st = fs.statSync(abs); } catch { continue; }
      const dt = st.mtimeMs - tsMs; // 相对消息时刻的偏差（毫秒）
      if (dt >= -60000 && dt <= 180000) cands.push({ abs, mtime: st.mtimeMs }); // 消息前 1 分 ~ 后 3 分
    }
    cands.sort((a, b) => b.mtime - a.mtime);
    for (const c of cands.slice(0, Math.max(0, limit - saved.length))) {
      const r = await saveImage({ path: c.abs }, dateKey, mediaDir);
      if (r) { markImported(mediaDir, c.abs); saved.push(r); }
    }
    if (saved.length >= limit) break;
  }
  return saved;
}

/**
 * 保存一张图片到 mediaDir/<dateKey>/<sha256>.jpg（压缩、去重）。
 * @returns {{src:string,hash:string,size:number,width:number,height:number}|null}
 */
export async function saveImage(block, dateKey, mediaDir) {
  const spec = parseImageSpec(block);
  if (!spec) return null;
  const dayDir = path.join(mediaDir, dateKey);
  try { fs.mkdirSync(dayDir, { recursive: true }); } catch { /* ignore */ }

  let inp;
  let tmpRaw = null;
  if (spec.kind === 'url') {
    inp = 'url:' + spec.value;
  } else if (spec.kind === 'path') {
    let p = spec.value;
    if (p.startsWith('file://')) p = p.slice(7);
    if (p.startsWith('/') && /^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    inp = p;
    if (!fs.existsSync(p)) return null;
  } else {
    // base64：先落临时文件，避免 argv 超长（大图 base64 可能 >32KB）
    const clean = spec.value.includes(',') ? spec.value.split(',', 2)[1] : spec.value;
    tmpRaw = path.join(dayDir, `_raw_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`);
    try { fs.writeFileSync(tmpRaw, Buffer.from(clean, 'base64')); } catch { return null; }
    inp = tmpRaw;
  }

  const tmpOut = path.join(dayDir, `_c_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
  const py = findPython();
  const res = await runPython(py, ['--in', inp, '--out', tmpOut, '--max', String(MAX_BYTES), '--q0', String(Q0), '--qmin', String(QMIN)]);
  if (tmpRaw) { try { fs.unlinkSync(tmpRaw); } catch { /* ignore */ } }
  if (!res || !res.ok) { try { fs.unlinkSync(tmpOut); } catch { /* ignore */ } return null; }

  const finalName = `${res.hash}.jpg`;
  const finalPath = path.join(dayDir, finalName);
  if (fs.existsSync(finalPath)) {
    try { fs.unlinkSync(tmpOut); } catch { /* ignore */ } // 已存在 → 去重，删临时
  } else {
    try { fs.renameSync(tmpOut, finalPath); } catch { try { fs.unlinkSync(tmpOut); } catch { /* ignore */ } return null; }
  }
  return { src: finalPath, hash: res.hash, size: res.size, width: res.width, height: res.height };
}
