// storage.js — 路径规划、本地时区、state/health、文件读写辅助。
// 设计原则：存储完全独立于 .memory；所有日期用本地时区；所有读写都吞错。
import { homedir } from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

/** 默认根目录：~/.dsh/diary（不碰 .memory）。可通过配置 diaryDir 覆盖。 */
export function defaultDiaryDir() {
  return path.join(homedir(), '.dsh', 'diary');
}

/** 图片存放根目录：默认 D 盘独立位置（与文本日记分离，便于单独管理/搬迁）。 */
export function defaultMediaDir() {
  return 'D:/DDSH_Diary/media';
}

const pad = (n) => String(n).padStart(2, '0');

/** 把 Date 拆成「本地时区」的各个部分，绝不用 toISOString（UTC 会在 +8 区跨日错位）。 */
export function localParts(d = new Date()) {
  const Y = d.getFullYear();
  const M = d.getMonth() + 1;
  const D = d.getDate();
  const h = d.getHours();
  const m = d.getMinutes();
  const s = d.getSeconds();
  const offMin = -d.getTimezoneOffset(); // 本地相对 UTC 的分钟偏移（东八区为 +480）
  const sign = offMin >= 0 ? '+' : '-';
  const oh = Math.floor(Math.abs(offMin) / 60);
  const om = Math.abs(offMin) % 60;
  return {
    Y, M, D, h, m, s,
    dateKey: `${Y}${pad(M)}${pad(D)}`,     // 20261029
    ym: `${Y}${pad(M)}`,                    // 202610
    y: `${Y}`,
    mm: `${pad(M)}`,
    ts: `${Y}-${pad(M)}-${pad(D)}T${pad(h)}:${pad(m)}:${pad(s)}${sign}${pad(oh)}:${pad(om)}`,
    tsMs: d.getTime(), // 毫秒时间戳，用于按消息时刻匹配 QQ 桥刚下好的图片
  };
}

/** 给定 dateKey(YYYYMMDD) 返回本地 Date（用于调度计算）。 */
export function dateFromKey(dateKey) {
  const Y = Number(dateKey.slice(0, 4));
  const M = Number(dateKey.slice(4, 6));
  const D = Number(dateKey.slice(6, 8));
  return new Date(Y, M - 1, D, 0, 0, 0, 0);
}

/** 下一天 / 上一天的 dateKey。 */
export function nextDateKey(dateKey) {
  const d = dateFromKey(dateKey);
  d.setDate(d.getDate() + 1);
  return localParts(d).dateKey;
}
export function prevDateKey(dateKey) {
  const d = dateFromKey(dateKey);
  d.setDate(d.getDate() - 1);
  return localParts(d).dateKey;
}

/** 最近 N 天的 dateKey 数组（含今天），从旧到新。 */
export function lastNDates(n = 7, anchor = new Date()) {
  const out = [];
  const base = dateFromKey(localParts(anchor).dateKey);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    out.push(localParts(d).dateKey);
  }
  return out;
}

/** 根据 diaryDir 计算各类路径。 */
export function paths(diaryDir) {
  const base = diaryDir;
  return {
    base,
    tmp: (dateKey) => path.join(base, 'tmp', `${dateKey}.jsonl`),
    dayMd: (dateKey) => {
      const p = localParts(dateFromKey(dateKey));
      return path.join(base, p.y, p.mm, `${dateKey}.md`);
    },
    // 月度汇总文件已废弃（2026-11-02 定稿）：检索改走分块摘要 + diary_open 工具，
    // 不再写 daily-diaryYYYYMM.md / indexYYYYMM.md。留着路径函数只为兼容旧数据读取。
    cache: (dateKey) => path.join(base, 'cache', `7day-${dateKey}.md`),
    state: () => path.join(base, 'state.json'),
    health: () => path.join(base, 'health.json'),
    // 今日实时摘要（digest）实时索引文件与续跑状态
    digest: (dateKey) => path.join(base, 'tmp', `${dateKey}.digest.md`),
    digestState: () => path.join(base, 'tmp', '.digest-state.json'),
    // 30 天表的关键词列（一天一行，封章时写）
    keywords: () => path.join(base, 'keywords.json'),
  };
}

export async function ensureDir(dir) {
  try { await fs.mkdir(dir, { recursive: true }); } catch { /* 已存在或权限问题，后续写入会再报错并被吞掉 */ }
}

export async function ensureBase(diaryDir) {
  await ensureDir(diaryDir);
  await ensureDir(path.join(diaryDir, 'tmp'));
  await ensureDir(path.join(diaryDir, 'cache'));
}

/** 确保图片根目录存在。 */
export async function ensureMediaBase(mediaDir) {
  await ensureDir(mediaDir);
}

/**
 * 清理过期的图片目录（按 dateKey 目录名判断，保留最近 keepDays 天）。
 * 失败时静默跳过，绝不抛错。
 */
export async function cleanupMedia(mediaDir, keepDays = 90) {
  try {
    const entries = await fs.readdir(mediaDir);
    const cutoff = Date.now() - keepDays * 86400000;
    for (const e of entries) {
      if (!/^\d{8}$/.test(e)) continue; // 只处理 20261029 这种日期目录
      const t = dateFromKey(e).getTime();
      if (!isNaN(t) && t < cutoff) {
        await fs.rm(path.join(mediaDir, e), { recursive: true, force: true });
      }
    }
  } catch { /* 目录不存在或无权限，忽略 */ }
}

export async function fileExists(p) {
  try { const s = await fs.stat(p); return s.isFile(); } catch { return false; }
}
export async function readText(p) {
  try { return await fs.readFile(p, 'utf8'); } catch { return ''; }
}
export async function writeText(p, text) {
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, text, 'utf8');
}
export async function appendText(p, text) {
  await ensureDir(path.dirname(p));
  await fs.appendFile(p, text, 'utf8');
}
/** 读取 jsonl 文件，返回行对象数组（坏行跳过）。 */
export async function readJsonl(p) {
  const raw = await readText(p);
  if (!raw) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 跳过坏行，绝不抛 */ }
  }
  return out;
}

export async function readJSON(p, fallback) {
  try {
    const t = await fs.readFile(p, 'utf8');
    return t ? JSON.parse(t) : fallback;
  } catch { return fallback; }
}
export async function writeJSON(p, obj) {
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, JSON.stringify(obj, null, 2), 'utf8');
}

/** 列出 tmp 目录下所有已记录的日期（dateKey 数组，从旧到新）。 */
export async function listTmpDates(diaryDir) {
  const dir = path.join(diaryDir, 'tmp');
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((f) => f.endsWith('.jsonl') && /^\d{8}\.jsonl$/.test(f))
      .map((f) => f.slice(0, 8))
      .sort();
  } catch { return []; }
}
