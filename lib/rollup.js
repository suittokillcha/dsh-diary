// rollup.js — 每日汇总（两阶段）+ 索引 + 转换健康检查 + 补偿。
//
// 2026-11-02 重写。核心修复：**不许给今天盖章**。
//
// 为什么（实测证据）：
//   10-31：草稿 433 条，本子只写 5 条，本子写于 00:25（那天刚开始二十五分钟）
//   11-01：草稿 223 条，本子 36 条，本子写于 11:23
//   11-02：草稿 159 条，本子 22 条，本子写于 08:22
//   只有 10-29 是完整的——因为它是第二天才被补写的。
//
// 根因：compensate() 每次开会话都跑，它把「今天」也当成该补的日子，
//       写完立刻盖章 status=ok，之后再没人碰。
//
// 现在的规矩：
//   · 日期 === 今天 → 只按最新草稿重抄 md，**不盖章、不往月度追加、不标情绪**
//   · 日期 <  今天 → 正常写、标情绪、生成关键词、盖章
//
// 另外：月度文件（daily-diaryYYYYMM.md / indexYYYYMM.md）不再写——方案定稿已废弃它们。
//       检索全部走分块摘要 + diary_open 工具。
import {
  paths, readJsonl, writeText, readText, appendText, fileExists,
  readJSON, writeJSON, dateFromKey, localParts, ensureBase, listTmpDates, cleanupMedia,
} from './storage.js';
import { callLLM, getTarget, rememberTarget } from './llm.js';
import { safeLog, isAutoRecord } from './util.js';
import { readDigest } from './digest.js';
import { genKeywords } from './keywords.js';

// 并发保护：补偿 / 00:10 那一轮不应该重入。
let running = false;

const VOCAB_USER = '平静 / 开心 / 焦虑 / 沮丧 / 兴奋 / 愤怒 / 无奈 / 期待 / 失落 / 满足';
const VOCAB_AI = '中性 / 关切 / 耐心 / 幽默 / 鼓励 / 严肃 / 共情 / 轻松 / 好奇 / 歉意';

/** 把 dateKey(YYYYMMDD) 格式化成「2026年10月30日」。 */
function dateLabel(dateKey) {
  const y = Number(dateKey.slice(0, 4));
  const m = Number(dateKey.slice(4, 6));
  const d = Number(dateKey.slice(6, 8));
  return `${y}年${m}月${d}日`;
}

/** 今天（本地时区）的 dateKey。 */
function todayKey() {
  return localParts().dateKey;
}

/**
 * 原始对话渲染：日期写在代码块外上方，代码块内每行「HH:MM  你/大肥鱼：内容」。
 * 零压缩、纯文本。定时会话的模板话跳过（原文 jsonl 里保留，但不进 md）。
 */
export function renderRaw(records, dateKey) {
  const sorted = [...records].sort((a, b) => String(a?.ts || '').localeCompare(String(b?.ts || '')));
  const turns = [];
  for (const r of sorted) {
    if (isAutoRecord(r)) continue; // 定时会话模板话不进日记
    const who = r.role === 'user' ? '你' : '大肥鱼';
    const time = String(r.ts || '').slice(11, 16) || '--:--';
    if (r.type === 'image') {
      turns.push(`${time}  ${who}：[图片]`);
    } else {
      const t = String(r.text || '').trim();
      if (!t) continue;
      turns.push(`${time}  ${who}：${t.replace(/\n/g, ' ')}`);
    }
  }
  if (!turns.length) return '（当天无聊天文本记录）';
  const label = dateKey ? dateLabel(dateKey) : '';
  return `${label}\n\n\`\`\`\n${turns.join('\n')}\n\`\`\``;
}

function readState(diaryDir) {
  return readJSON(paths(diaryDir).state(), { latestSummarized: null, summaries: {} });
}
function readHealth(diaryDir) {
  return readJSON(paths(diaryDir).health(), { alerts: [], updated: null });
}

/** 由当天 records 确定性生成「日记正文」md（header + 原始对话 + 图片段）。 */
export function renderDayMd(records, dateKey) {
  const raw = renderRaw(records, dateKey);
  const imgs = records
    .filter((r) => r.type === 'image' && r.src && !isAutoRecord(r))
    .sort((a, b) => String(a?.ts || '').localeCompare(String(b?.ts || '')));
  let imgSection = '';
  if (imgs.length) {
    imgSection = '\n## 图片\n' + imgs.map((r) => {
      const who = r.role === 'user' ? '你' : '大肥鱼';
      const time = String(r.ts || '').slice(11, 16) || '--:--';
      const url = 'file:///' + String(r.src).replace(/\\/g, '/');
      return `![${who} ${time}](${url})`;
    }).join('\n') + '\n';
  }
  return (
    `# 日记 ${dateKey}\n\n` +
    `> 本地时区归档，原始对话零压缩。情绪标注见下方「情绪变化」段（由 AI 生成，失败也不影响原文）。\n\n` +
    `## 原始对话\n${raw || '（当天无聊天文本记录）'}\n` +
    imgSection
  );
}

/** 阶段A：确定性地把当天 JSONL 原样转成 md（不调 LLM，几乎不会失败）。 */
async function stageA(ctx, dateKey, records, P) {
  let md = renderDayMd(records, dateKey);
  const digest = await readDigest(P.base, dateKey);
  if (digest) md += `\n## 今日实时摘要\n${digest.replace(/^## /gm, '### ')}\n`;
  await writeText(P.dayMd(dateKey), md);
  return { md };
}

/** 阶段B：AI 把一天切成情绪段落并标注（可失败，不致命）。只在封章那天做。 */
async function stageB(ctx, cfg, dateKey, records, P) {
  const target = getTarget(null) || (cfg.fallbackTarget || null);
  if (!target) return { ok: false, curve: null };
  const raw = renderRaw(records, dateKey);
  const firstTime = String(records.find((r) => r.ts)?.ts || '').slice(11, 16);
  const lastTime = String([...records].reverse().find((r) => r.ts)?.ts || '').slice(11, 16);
  const fullRange = (firstTime && lastTime) ? `${firstTime}–${lastTime}` : '';
  const system =
    '你是「大肥鱼」的情绪分析师。下面是一天里「你」（用户）与「大肥鱼」（AI助手）的全部原始对话（已带 HH:MM 时间戳）。\n' +
    '请按情绪变化把这一天切成若干「段落」，并标注每段双方的情绪。规则：\n' +
    `1) 用户情绪词表：${VOCAB_USER}\n` +
    `2) 大肥鱼情绪词表：${VOCAB_AI}\n` +
    '3) 段落必须覆盖全天对话，不遗漏、不编造；段落边界请使用对话里真实出现的 HH:MM 时间戳。\n' +
    '4) 第一行只输出全天情绪曲线总览，格式：你:从→到; 大肥鱼:从→到（不超过 60 字，不要带时间范围、不要寒暄）。\n' +
    '5) 之后每行输出一个情绪段落，格式：起–止  你:状态; 大肥鱼:状态（起止用 HH:MM，段落之间首尾相接）。\n' +
    '只输出上述内容，不要加标题、不要寒暄。';
  const user = `日期 ${dateKey} 的原始对话：\n\n${raw}`;
  const out = await callLLM(ctx, target, system, user, { maxTokens: 1200 });
  if (!out) return { ok: false, curve: null };
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const curve = (lines[0] || '').slice(0, 80);
  const segmentLines = lines.slice(1).join('\n');
  const moodBody =
    `${dateLabel(dateKey)}\n` +
    `${fullRange}  ${curve}\n` +
    (segmentLines ? segmentLines + '\n' : '');
  const moodSection = `## 情绪变化（你 / 大肥鱼）\n${moodBody}`;
  const existing = await readText(P.dayMd(dateKey));
  if (!existing.includes('## 情绪变化')) {
    await appendText(P.dayMd(dateKey), `\n${moodSection}`);
  }
  return { ok: true, curve };
}

/**
 * 转换健康检查：md 是否真实生成、是否完整。
 * 关键修复：比对的是「这一天全部的记录」，不是「此刻的记录」。
 * 原来拿「盖章那一刻的草稿」去比，5 条比 5 条永远通过，所以它永远发现不了自己少写。
 */
async function verifyConversion(ctx, dateKey, records, P) {
  const mdPath = P.dayMd(dateKey);
  if (!(await fileExists(mdPath))) return { ok: false, reason: 'md 未生成' };
  const md = await readText(mdPath);
  if (!md.trim()) return { ok: false, reason: 'md 为空' };
  const expected = records.filter((r) => !isAutoRecord(r) && (r.text?.trim() || r.type === 'image')).length;
  const mdMsgCount = (md.match(/^\S{5}\s+(你|大肥鱼)：/gm) || []).length;
  const mdImgCount = (md.match(/^\S{5}\s+(你|大肥鱼)：\[图片\]/gm) || []).length;
  if (expected > 0 && mdMsgCount < expected * 0.95) {
    return { ok: false, reason: `条目缺失（md ${mdMsgCount} < 应有 ${expected}）` };
  }
  return { ok: true, reason: '' };
}

/**
 * 汇总单天。
 *
 * ★ 核心规则：dateKey === 今天 → 只重抄，不盖章。
 *   原因见文件头注释（10-31 那天 433 条只写了 5 条）。
 */
export async function rollupDay(ctx, dateKey, cfg) {
  const P = paths(cfg.diaryDir);
  await ensureBase(cfg.diaryDir);
  const state = await readState(cfg.diaryDir);
  const isToday = dateKey === todayKey();
  const existing = state.summaries?.[dateKey];

  // 已经封过章的日子，跳过（今天永远不走这条）
  if (!isToday && existing && (existing.status === 'ok' || existing.status === 'empty')) {
    return existing;
  }

  const records = await readJsonl(P.tmp(dateKey));
  const ts = new Date().toISOString();

  if (records.length === 0) {
    if (!isToday) {
      state.summaries = state.summaries || {};
      state.summaries[dateKey] = { status: 'empty', ts };
      state.latestSummarized = dateKey;
      await writeJSON(P.state(), state);
      return state.summaries[dateKey];
    }
    return existing || { status: 'pending' };
  }

  // 阶段A：确定性原文（今天也做——保证换会话能看到最新内容）
  await stageA(ctx, dateKey, records, P);

  // 今天是「进行中」：只重抄，不标情绪、不写关键词、不盖章
  if (isToday) {
    state.summaries = state.summaries || {};
    state.summaries[dateKey] = { status: 'in_progress', ts };
    await writeJSON(P.state(), state);
    return state.summaries[dateKey];
  }

  // 以下只对「过去的日子」执行
  let moodInfo = { ok: false };
  if (cfg.enableMood !== false) {
    moodInfo = await stageB(ctx, cfg, dateKey, records, P);
  }

  // 关键词（一天一行，塞进 30 天表）
  let kw = null;
  if (cfg.enableKeywords !== false) {
    kw = await genKeywords(ctx, cfg, dateKey);
  }

  // 健康检查
  const v = await verifyConversion(ctx, dateKey, records, P);
  let status = 'ok';
  let error;
  if (!v.ok) {
    status = 'failed';
    error = v.reason;
    const health = await readHealth(cfg.diaryDir);
    health.alerts = health.alerts || [];
    health.alerts.push({ date: dateKey, type: 'conversion_failed', msg: v.reason, ts });
    health.updated = ts;
    health.alerts = health.alerts.slice(-200);
    await writeJSON(P.health(), health);
    safeLog(ctx?.logger, 'warn', `dsh-diary: ${dateKey} 转换异常但原文已保留：${v.reason}`);
  } else if (cfg.enableMood !== false && !moodInfo.ok) {
    status = 'partial';
  }

  state.summaries = state.summaries || {};
  state.summaries[dateKey] = { status, mood: moodInfo.ok, keywords: !!kw, error, ts };
  state.latestSummarized = dateKey;
  await writeJSON(P.state(), state);
  return state.summaries[dateKey];
}

/**
 * 补偿：扫描 tmp 里所有日期，按序补齐。
 *
 * ★ 关键：今天只重抄不盖章（rollupDay 里判）。
 *   这样 23:00–24:00 说的话不会掉——它们进草稿，第二天封章时一起收进去。
 */
export async function compensate(ctx, cfg) {
  if (running) return;
  running = true;
  try {
    await ensureBase(cfg.diaryDir);
    const dates = await listTmpDates(cfg.diaryDir);
    const state = await readState(cfg.diaryDir);
    const today = todayKey();
    for (const d of dates) {
      const s = state.summaries?.[d];
      if (d !== today && s && (s.status === 'ok' || s.status === 'empty')) continue;
      try {
        await rollupDay(ctx, d, cfg);
      } catch (e) {
        safeLog(ctx?.logger, 'error', `dsh-diary: rollup ${d} failed:`, e?.message || e);
      }
    }
  } catch (e) {
    safeLog(ctx?.logger, 'error', 'dsh-diary: compensate failed:', e?.message || e);
  } finally {
    try { await cleanupMedia(cfg.mediaDir, cfg.mediaKeepDays || 90); } catch { /* ignore */ }
    running = false;
  }
}

/** 开场告警：若 health 有未解决告警，返回一句给大肥鱼看的话。 */
export async function pendingHealthWarning(diaryDir) {
  try {
    const health = await readHealth(diaryDir);
    const open = (health.alerts || []).filter((a) => a.type === 'conversion_failed');
    if (!open.length) return '';
    const latest = open[open.length - 1];
    return `[警告] ${latest.date} 日记转换曾异常，原始对话已保留在 tmp，未丢失，将自动重试。`;
  } catch {
    return '';
  }
}
