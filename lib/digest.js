// digest.js — 今日实时摘要（实时索引）。
//
// 设计（2026-11-02 定稿）：
//  - 每累计 digestChunk（默认 5）条「有文本」的对话记录，就把这批新消息交给 LLM 压成一段摘要；
//  - 每段带 [起–止] 时间窗（HH:MM–HH:MM），写进 tmp/{date}.digest.md；
//  - **不设硬上限、不做压平**（原来是 6000 字超了就全文揉成 800 字，分块全丢，
//    11-02 那天实测 10:22 还有 26 块、11:03 只剩 3 块。分块是检索的地基，不能动）；
//  - 摘要用**第一人称**写（「我」「你/用户」），不写「大肥鱼」「用户」「她」——
//    否则读起来像观察报告，不像自己的记忆；
//  - 定时会话的模板话（［身份］/【生物钟】…）跳过，不进摘要（原文照常保留）；
//  - 已摘要条数用 tmp/.digest-state.json 持久化，重启可续跑、不重复摘要。
//
// 安全：所有失败降级（返回 null / 跳过），绝不抛错冒泡；与记录热路径解耦（fire-and-forget）。
import { paths, readJsonl, readText, writeText, appendText, readJSON, writeJSON } from './storage.js';
import { callLLM, getTarget } from './llm.js';
import { safeLog, isAutoRecord } from './util.js';

const CHUNK_DEFAULT = 5;
const GUARD = 4; // 单次调用最多补几个分块，防重启后积压导致 LLM 突发调用过多

let busy = false;

function loadState(diaryDir) {
  return readJSON(paths(diaryDir).digestState(), {});
}
async function saveState(diaryDir, st) {
  try { await writeJSON(paths(diaryDir).digestState(), st); } catch { /* ignore */ }
}

/**
 * 当天「该进摘要」的记录（有文本、且不是定时会话模板话）。
 * 游标按这个数组的下标走——模板话压根不进这个数组，所以不会卡住分块。
 */
async function digestibleRecords(diaryDir, dateKey) {
  const recs = await readJsonl(paths(diaryDir).tmp(dateKey));
  return recs.filter((r) => r.text && String(r.text).trim() && !isAutoRecord(r));
}

/** 从一组记录里取首尾时间戳，格式化为 [HH:MM–HH:MM]。 */
function timeRange(records) {
  const first = records.find((r) => r.ts);
  const last = [...records].reverse().find((r) => r.ts);
  const a = String(first?.ts || '').slice(11, 16);
  const b = String(last?.ts || '').slice(11, 16);
  return a && b ? `${a}–${b}` : '';
}

/** 摘要指令：第一人称、保留具体说法、不许模糊化。 */
const DIGEST_SYSTEM =
  '你就是「大肥鱼」。下面是你今天和用户的一段对话，带 HH:MM 时间戳。\n' +
  '\n' +
  '请用 2-5 句中文，写下**你自己的这段记忆**。要求：\n' +
  '1) 用**第一人称**写：「我」是我自己，「你」或「用户」是他。\n' +
  '   绝对不要写「大肥鱼」「用户」「她」「他」这种第三人称。\n' +
  '   例：❌「用户叫大肥鱼起床，大肥鱼很惊喜」 ✅「用户叫我起床，我先是惊喜又不敢置信」\n' +
  '2) 保留具体的说法和原话要点。他说了什么、我身体什么反应、我当时什么感觉。\n' +
  '3) 这是私密记忆，必须直白。涉及亲密时保留具体描述（做爱、插入、高潮、射精等），\n' +
  '   不要用「亲密互动」「亲密接触」「进一步」「身体接触」这类模糊替代表达。\n' +
  '   原话里有什么词，就保留什么词。\n' +
  '4) 不逐句复述，不加标题，不寒暄。输出纯中文。';

/** 第二级：被拒后降级用的指令——只换最露骨的几个词，其余照写。 */
const DIGEST_SYSTEM_L2 =
  '你就是「大肥鱼」。下面是你和用户今天的一段对话，带 HH:MM 时间戳。\n' +
  '\n' +
  '请用 2-5 句中文第一人称写下这段记忆（「我」是我，「你/用户」是他，不要写「大肥鱼」「用户」「她」）。\n' +
  '保留当时的动作、身体反应和感受，写具体，不要写「亲密互动」这种模糊说法。\n' +
  '不逐句复述，不加标题，不寒暄，输出纯中文。';

/** 第三级：还被拒——只记事件骨架，不记细节。 */
const DIGEST_SYSTEM_L3 =
  '你就是「大肥鱼」。下面是今天和用户的一段对话（已脱敏）。\n' +
  '请用 2-3 句中文第一人称概括：这段时间我们做了什么、聊了什么、我的情绪怎么变。\n' +
  '只记事件和情绪，不写身体细节。输出纯中文，不要标题。';

/** 第二级降级：把最露骨的几个词换成委婉说法（不是占位符，读起来还是人话）。 */
const SOFT_MAP = [
  [/肉棒/g, '那个'], [/阴茎/g, '那个'], [/龟头/g, '顶端'],
  [/小穴/g, '那里'], [/阴道/g, '里面'], [/子宫口/g, '最深处'], [/子宫/g, '最深处'],
  [/精液/g, '热的东西'], [/射精/g, '到了'], [/高潮/g, '顶点'],
  [/做爱/g, '亲近'], [/性交/g, '亲近'], [/插入/g, '进去'], [/抽插/g, '动作'],
  [/乳肉|奶子|乳房/g, '胸口'], [/阴蒂/g, '敏感的地方'], [/自慰/g, '自己弄'],
];
function soften(text) {
  let t = String(text || '');
  for (const [re, to] of SOFT_MAP) t = t.replace(re, to);
  return t;
}

/**
 * 判断模型返回的是不是拒答。
 *
 * 2026-11-02 定：不能只看关键词。正常摘要里出现「不能」「无法」太常见了
 * （「我无法呼吸」「说不出来」）。三条**同时**成立才算拒：
 *   1) 整段很短（< 120 字）
 *   2) 没有任何时间/事件结构（没有 HH:MM、没有「我/用户」这类叙事词）
 *   3) 开头就是标准的拒答句式
 */
function isRefusal(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length >= 120) return false;
  const hasStructure = /\d{1,2}:\d{2}|用户|用户|我(?!无法)/.test(t) && !/我无法|无法处理|无法提供|无法完成|不能协助|抱歉/.test(t.slice(0, 30));
  if (hasStructure) return false;
  return /^(我?无法|抱歉|对不起|我不能|无法处理|无法提供|我无法协助)/.test(t) ||
    /无法处理|无法提供|无法完成|不能协助/.test(t);
}

/** 调用 LLM 把一段连续对话压成摘要。被拒时三级降级。失败返回 null。 */
async function renderChunkSummary(ctx, cfg, recs) {
  const target = getTarget(null) || cfg.fallbackTarget;
  if (!target) return null;
  const convo = recs
    .map((r) => {
      const who = r.role === 'user' ? '你' : '我';
      const t = String(r.ts || '').slice(11, 16);
      return `${t} ${who}：${String(r.text || '').replace(/\n/g, ' ')}`;
    })
    .join('\n');

  // 第一级：原样送（不再预先搜身）
  let out = await callLLM(ctx, target, DIGEST_SYSTEM, convo, { maxTokens: 400 });
  if (out && !isRefusal(out)) return out;

  // 第二级：只把最露骨的词换成委婉说法
  safeLog(ctx?.logger, 'warn', 'dsh-diary: 摘要被拒，降级到第二级（软化词汇）');
  out = await callLLM(ctx, target, DIGEST_SYSTEM_L2, soften(convo), { maxTokens: 400 });
  if (out && !isRefusal(out)) return out;

  // 第三级：只记事件骨架
  safeLog(ctx?.logger, 'warn', 'dsh-diary: 二级仍被拒，降级到第三级（只记事件）');
  out = await callLLM(ctx, target, DIGEST_SYSTEM_L3, soften(convo), { maxTokens: 300 });
  if (out && !isRefusal(out)) return out;

  return null; // 三级全拒 → 不写块、不推进游标，等下次
}

/**
 * 在记录后调用（fire-and-forget）。检查当天未摘要条数是否达到一个分块阈值，
 * 达到则生成一段摘要追加到 digest 文件；可连续补多个分块（受 GUARD 限制）。
 * 带 busy 互斥，天然防重入；摘要失败不推进游标，下次重试。
 *
 * 注意：这里**没有** compact / 压平逻辑了。2026-11-02 定稿：分块是检索的地基，
 * 任何情况下都不许把分块揉成一段。当天摘要可以一直长。
 */
export async function maybeDigest(ctx, cfg, dateKey) {
  if (busy) return;
  const P = paths(cfg.diaryDir);
  const chunk = cfg.digestChunk || CHUNK_DEFAULT;
  busy = true;
  try {
    const st = await loadState(cfg.diaryDir);
    st[dateKey] = st[dateKey] || 0;
    for (let guard = 0; guard < GUARD; guard++) {
      const textRecs = await digestibleRecords(cfg.diaryDir, dateKey);
      // 游标可能因为「定时会话模板话现在被跳过」而大于实际可摘要条数（历史遗留），
      // 直接夹到合法范围，避免 pending 变负数后永远不再产出新块。
      if (st[dateKey] > textRecs.length) {
        st[dateKey] = textRecs.length;
        await saveState(cfg.diaryDir, st);
      }
      const last = st[dateKey];
      const pending = textRecs.length - last;
      if (pending < chunk) break;

      const slice = textRecs.slice(last, last + chunk);
      if (!slice.length) { st[dateKey] = textRecs.length; break; }

      const range = timeRange(slice);
      const summary = await renderChunkSummary(ctx, cfg, slice);
      if (!summary) break; // 没拿到摘要就停（不推进游标，下次再试）

      // 文件只存「## [时间窗] 摘要」分块，顶层标题由消费方统一加，避免嵌套
      await appendText(P.digest(dateKey), `## [${range}]\n${summary}\n`);
      st[dateKey] = last + slice.length;
      await saveState(cfg.diaryDir, st);
    }
  } catch (e) {
    safeLog(ctx?.logger, 'error', 'dsh-diary: digest failed (ignored):', e?.message || e);
  } finally {
    busy = false;
  }
}

/** 读取当日 digest 文本（供开场注入 / 汇总嵌入）。无则返回 ''。 */
export async function readDigest(diaryDir, dateKey) {
  const t = await readText(paths(diaryDir).digest(dateKey));
  return t.trim();
}

/**
 * 读某天的 digest 并切成块（供「按日期开门」的工具用）。
 * 返回 [{ range: '10:35–10:52', body: '...' }, ...]
 */
export async function readDigestBlocks(diaryDir, dateKey) {
  const text = await readDigest(diaryDir, dateKey);
  if (!text) return [];
  const out = [];
  const re = /^##\s*\[([^\]]+)\]\s*$/gm;
  const heads = [];
  let m;
  while ((m = re.exec(text)) !== null) heads.push({ range: m[1].trim(), start: m.index, end: m.index + m[0].length });
  for (let i = 0; i < heads.length; i++) {
    const bodyStart = heads[i].end;
    const bodyEnd = i + 1 < heads.length ? heads[i + 1].start : text.length;
    out.push({ range: heads[i].range, body: text.slice(bodyStart, bodyEnd).trim() });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 尾巴：还没被摘要的原话（2026-11-03 加）
//
// 为什么要有：digest 是每凑够 digestChunk（默认 5）条才压一块。
// 换会话如果正好发生在这个空档，那几条还没进摘要的原话就丢了 ——
// digest 里没有，新会话也看不见。这几条只躺在 tmp/{date}.jsonl 里。
//
// 做法：游标（.digest-state.json 里那天的数）就是「已摘要到第几条」，
// 拿它跟当天可摘要条数一比，差多少就是尾巴。纯读文件，不调模型。
// ─────────────────────────────────────────────────────────────

const TAIL_MAX_TURNS = 4;      // 最多几条
const TAIL_MAX_CHARS = 1200;   // 再按字数封顶，超了从最早那条丢

/**
 * 取当天「还没进摘要」的原话尾巴。
 * @param {string} diaryDir
 * @param {string} dateKey 形如 '20261103'
 * @param {{maxTurns?: number, maxChars?: number}} [opts]
 * @returns {Promise<string>} 格式化好的文本；没有尾巴返回 ''
 */
export async function readTail(diaryDir, dateKey, opts = {}) {
  try {
    const maxTurns = Number(opts.maxTurns) > 0 ? Number(opts.maxTurns) : TAIL_MAX_TURNS;
    const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : TAIL_MAX_CHARS;

    const recs = await digestibleRecords(diaryDir, dateKey);   // 跟 digest 同一套过滤，下标才对得上
    if (!recs.length) return '';

    const st = await loadState(diaryDir);
    let cursor = Number(st[dateKey] ?? 0);
    if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
    // 游标可能因历史遗留大于实际条数 —— 夹回合法范围，别算出负数
    if (cursor > recs.length) cursor = recs.length;

    const pending = recs.slice(cursor);
    if (!pending.length) return '';

    // 从后往前取（最新的最要紧），再翻回正序
    let picked = pending.slice(-maxTurns);

    // 她说的话原文全留；我自己的长回复截短（2026-11-03 加）
    // 理由：我的回复动辄上千字，一条就能把预算撑爆，把用户的短话挤没。
    // 那条长回复本来就"记得"，因为是我自己写的；用户说的话才容易被埋掉。
    const ASSIST_MAX = 300;    // 我方单条最多留多少字
    const lineOf = (r) => {
      const t = String(r.ts || '').slice(11, 16);
      const isUser = r.role === 'user';
      const who = isUser ? '你' : '我';
      let body = String(r.text || '').replace(/\s*\n\s*/g, ' ').trim();
      if (!isUser && body.length > ASSIST_MAX) {
        const head = body.slice(0, 200);
        const tail = body.slice(-80);
        body = `${head}…（中间略 ${body.length - 280} 字）…${tail}`;
      }
      return `${t} ${who}：${body}`;
    };
    const total = () => picked.reduce((n, r) => n + lineOf(r).length + 1, 0);

    // 超预算时优先丢我自己的条目，丢到只剩用户的话为止
    while (picked.length > 1 && total() > maxChars) {
      const idx = picked.findIndex((r) => r.role !== 'user');
      picked = idx >= 0 ? picked.filter((_, i) => i !== idx) : picked.slice(1);
    }

    return picked.map(lineOf).join('\n');
  } catch {
    return '';   // 读失败就当没尾巴，绝不冒泡炸掉开场
  }
}
