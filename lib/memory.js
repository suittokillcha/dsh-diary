// memory.js — 开局注入（两块）+ 按日期开门 + 被动召回。
//
// 2026-11-02 定稿，注入的东西变了：
//   ① 最近 30 天表 —— 日期 + 星期 + 起止时间 + 关键词串（关键词由封章时写，见 keywords.js）
//   ② 今天的摘要全文 —— 不截断、不压缩
// 不再注入「最近 7 天轻压缩」那份东西了：它把摘要压了第二遍、还砍掉早上，
// 实测 10-31 那天 9800 字只留最后 6000 字，早上到下午整段没进模型眼睛。
//
// 安全：所有回调 try/catch；注入「先放行后异步生成」，生成失败也只是不注入（裸开）；
// 绝不抛错冒泡；子代理默认不注入（避免一回合几十次 LLM / 撑爆上下文）。
import { paths, readText, writeText, readJsonl, ensureBase, lastNDates, localParts, dateFromKey } from './storage.js';
import { callLLM, getTarget, rememberTarget } from './llm.js';
import { messageText, tokenize, safeLog, isAutoRecord } from './util.js';
import { expandTokens } from './synonyms.js';
import { readDigest, readDigestBlocks, readTail } from './digest.js';
import { readKeywords } from './keywords.js';
import { agentAllowed, sessionAllowed } from './preset-gate.js';

// 每个会话的被动召回缓冲（用户消息命中旧档后写入，下一轮 prompt 即带上）。
const recallMap = new Map();

// 注入文本的同步缓存。
// 关键：DSH 的 PromptSection.text 只接受「同步字符串」（string | (ctx) => string），
// 返回 Promise 会被当成空 → 注入永远失效（历史 bug）。所以这里异步算好、同步读出。
const bootCache = new Map();

// 正在后台重算的会话（防重入，见 refreshBootCache）。
const refreshing = new Set();

const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEKDAYS = 7;

/** 某天有没有原文 / 摘要。 */
async function dayExists(diaryDir, dateKey) {
  const P = paths(diaryDir);
  const [dig, raw] = await Promise.all([readText(P.digest(dateKey)), readText(P.tmp(dateKey))]);
  return { hasDigest: !!dig.trim(), hasRaw: !!raw.trim(), digestChars: dig.length };
}

/** 从原文里算起止时间（HH:MM）。 */
function rawSpan(records) {
  const withTs = records.filter((r) => r.ts);
  if (!withTs.length) return '';
  const a = String(withTs[0].ts).slice(11, 16);
  const b = String(withTs[withTs.length - 1].ts).slice(11, 16);
  return a && b ? `${a}–${b}` : '';
}

/**
 * 生成「最近 30 天表」。
 * 一行一天：MM-DD 周X  起–止  关键词串
 * 没有记录的日子不占行。
 */
export async function buildTable(ctx, cfg, days = 30) {
  const P = paths(cfg.diaryDir);
  const dates = lastNDates(days + 1).slice(0, -1).reverse(); // 不含今天，从新到旧
  const kws = await readKeywords(cfg.diaryDir);
  const lines = [];
  for (const d of dates) {
    const { hasDigest, hasRaw } = await dayExists(cfg.diaryDir, d);
    if (!hasDigest && !hasRaw) continue;

    const dt = dateFromKey(d);
    const mmdd = `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const wd = WD[dt.getDay()];

    let span = '';
    if (hasRaw) {
      const recs = await readJsonl(P.tmp(d));
      span = rawSpan(recs);
    }

    const kw = (kws[d] || '').trim();
    let tail = '';
    if (kw) tail = `  ${kw}`;
    else if (!hasDigest) tail = '  [有原文，无摘要]';

    lines.push(`${mmdd} ${wd}  ${span}${tail}`.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

/** boot 段文本：30 天表 + 今天全文 + 被动召回。三者皆空则返回 ''。 */
async function bootText(ctx, agent, cfg) {
  try {
    // 预设闸门：助手模式一个字都不注入。放在最前，后面三块（30 天表 /
    // 今天摘要 / 未摘要尾巴）一起断，不会出现「关了两块漏了一块」。
    if (!agentAllowed(ctx, agent)) return '';
    const today = localParts().dateKey;
    const recall = recallMap.get(String(agent?.session?.id || '')) || '';
    const blocks = [];

    if (cfg.injectTable !== false) {
      const table = await buildTable(ctx, cfg, cfg.tableDays || 30);
      if (table) blocks.push(`# 最近 ${cfg.tableDays || 30} 天（有记录的日期）\n${table}`);
    }

    if (cfg.injectToday !== false) {
      const digest = await readDigest(cfg.diaryDir, today);
      if (digest) {
        const blocks2 = await readDigestBlocks(cfg.diaryDir, today);
        blocks.push(`# 今天（进行中，${blocks2.length} 块）\n${digest}`);
      }
    }

    if (recall.trim()) blocks.push(`# 想起的相关旧对话\n${recall.trim()}`);

    // 尾巴注入（2026-11-03）：digest 每凑够 N 条才压一块，
    // 还没进摘要的那几条只躺在 tmp/{date}.jsonl 里。换会话时一起带上，
    // 不然上个会话最后那几句就丢了。纯读文件，不调模型。
    //
    // 2026-11-04 改：**只补今天，不回溯昨天**。
    // 原来今天没尾巴时会 `readTail(昨天)` 兜底，结果第二天早上开的每个新会话
    // 第一轮都带着昨晚睡前那几句话（实测：11-05 早上注入 11-04 23:31 的原文）。
    // 「换会话别丢上一句」的初衷只该覆盖当天的空档，跨天回溯就是把昨天的
    // 私房话塞进今天所有新会话 —— 哪怕对方根本不是爱弥斯模式。
    if (cfg.injectTail !== false) {
      const tail = await readTail(cfg.diaryDir, today);
      if (tail) blocks.push(`# 还没整理的尾巴（原话，未摘要）\n${tail}`);
    }

    return blocks.join('\n\n').trim();
  } catch {
    return '';
  }
}

/** 后台刷新某会话的注入文本，写进同步缓存。 */
function refreshBootCache(ctx, agent, cfg) {
  const sid = String(agent?.session?.id || 'unknown');
  // 防重入：text() 里发现缓存空会顺手补一次，一轮组装里可能被调好几次。
  // 不挡的话同一份数据会被并发读好几遍（30 天表 + 今天全文 + 尾巴，都是磁盘 IO）。
  if (refreshing.has(sid)) return;
  refreshing.add(sid);
  void (async () => {
    try {
      const t = await bootText(ctx, agent, cfg);
      // 空结果也要写进去：写 '' 表示「已确认这轮没有内容」，
      // 不写的话 text() 会以为还没算过、每次组装都重来一遍。
      bootCache.set(sid, t || '');
    } catch (e) {
      safeLog(ctx?.logger, 'error', 'dsh-diary: refreshBootCache failed (ignored):', e?.message || e);
    } finally {
      refreshing.delete(sid);
    }
  })();
}

/**
 * 检索：在最近 N 天的分块摘要里找命中块。
 * 返回 [{ date, range, body, score }]，按命中词数降序。
 *
 * 三条规则（2026-11-02 定）：
 *   1) 人称词已由 tokenize 扔掉（「我」「你」「大肥鱼」是背景音，不是关键词）
 *   2) 只切 2 字（3/4 字滑窗切出来的是拼接，只增误命中）
 *   3) 同义词展开（「下水」→「走出去/伸脚/试水/水温」）
 */
export async function searchDigestBlocks(diaryDir, query, days = 30, maxBlocks = 6) {
  const tokens = expandTokens(tokenize(query));
  if (!tokens.length) return [];
  const today = localParts().dateKey;
  const dates = lastNDates(days + 1).slice(0, -1).reverse();
  const hits = [];
  for (const d of dates) {
    const blocks = await readDigestBlocks(diaryDir, d);
    for (const b of blocks) {
      const body = b.body.toLowerCase();
      let score = 0;
      for (const t of tokens) if (body.includes(t)) score++;
      if (score > 0) hits.push({ date: d, range: b.range, body: b.body, score });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, maxBlocks);
}

/** 兼容旧调用：返回拼好的文本。 */
export async function searchDiary(diaryDir, query, maxChars = 2000) {
  try {
    const hits = await searchDigestBlocks(diaryDir, query, 30, 6);
    if (!hits.length) return '';
    let out = hits
      .map((h) => `【${h.date} ${h.range}】\n${h.body}`)
      .join('\n---\n');
    if (out.length > maxChars) out = out.slice(0, maxChars) + '\n…（已截断）';
    return out;
  } catch {
    return '';
  }
}

/** 取某天某个时间窗的原文（按记录时间戳筛，不按序号跳）。 */
export async function readRawWindow(diaryDir, dateKey, range) {
  const P = paths(diaryDir);
  const recs = await readJsonl(P.tmp(dateKey));
  let seg = recs;
  if (range && /^\d{2}:\d{2}\s*[–-]\s*\d{2}:\d{2}$/.test(range.trim())) {
    const [a, b] = range.split(/[–-]/).map((s) => s.trim());
    seg = recs.filter((r) => {
      const hm = String(r.ts || '').slice(11, 16);
      return hm >= a && hm <= b;
    });
  }
  return seg.map((r) => {
    const who = r.role === 'user' ? '你' : '我';
    const hm = String(r.ts || '').slice(11, 16);
    if (r.type === 'image') return `${hm} ${who}：[图片]`;
    return `${hm} ${who}：${String(r.text || '').replace(/\n/g, ' ')}`;
  }).join('\n');
}

/** 注册「按日期开门」和「搜摘要」两个工具。 */
async function registerTools(ctx, agent, cfg) {
  if (!agent?.ctx?.tools?.register) return;
  try {
    const { defineTool } = await import('@deepseek-ai/dsh-tools');
    const text = {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    };

    // ① 按日期开门
    agent.ctx.tools.register(defineTool({
      name: 'diary_open',
      description:
        '按日期打开那天的记忆。传 date（YYYYMMDD 或 YYYY-MM-DD）得到那天全部分块摘要；' +
        '再传 range（如 "10:35–10:52"）得到那段原文原话。' +
        '用户说得出具体哪天（昨天/前天/11月1号/上周六）时用它，比关键词搜更准。',
      parameters: {
        date: { type: 'string', required: true },
        range: { type: 'string' },
      },
      output: text,
      execute: async ({ date, range }) => {
        // 工具是创建时注册的，用户可能之后才切到助手模式 —— 调用时再判一次。
        // 不加这一道，切过去之后它还能自己翻旧档。
        if (!agentAllowed(ctx, agent)) return '（当前模式没有日记）';
        const d = String(date || '').replace(/[^0-9]/g, '');
        if (d.length !== 8) return '日期格式不对，要 YYYYMMDD 或 YYYY-MM-DD。';
        if (range && String(range).trim()) {
          const raw = await readRawWindow(cfg.diaryDir, d, String(range));
          return raw || `（${d} ${range} 那段没有原文记录）`;
        }
        const blocks = await readDigestBlocks(cfg.diaryDir, d);
        if (!blocks.length) {
          const raw = await readRawWindow(cfg.diaryDir, d, '');
          return raw ? `（${d} 没有分块摘要，只有原文，共 ${raw.split('\n').length} 条）\n${raw.slice(0, 3000)}` : `（${d} 没有任何记录）`;
        }
        return `【${d} 分块摘要，共 ${blocks.length} 块】\n` +
          blocks.map((b) => `## [${b.range}]\n${b.body}`).join('\n');
      },
    }));

    // ② 搜摘要（说不出日期时用）
    agent.ctx.tools.register(defineTool({
      name: 'diary',
      description:
        '想不起是哪天时用：传关键词，在最近 30 天的分块摘要里找命中的块。' +
        '会自动展开同义词（「下水」→「走出去/试水/水温」）。' +
        '说得清是哪天时，优先用 diary_open。',
      parameters: { query: { type: 'string', required: true } },
      output: text,
      execute: async ({ query }) => {
        if (!agentAllowed(ctx, agent)) return '（当前模式没有日记）';
        const hits = await searchDigestBlocks(cfg.diaryDir, query, 30, 6);
        if (!hits.length) return '（最近 30 天里没找到相关对话）';
        return hits
          .map((h) => `【${h.date} ${h.range}】\n${h.body}`)
          .join('\n---\n');
      },
    }));
  } catch (e) {
    safeLog(ctx?.logger, 'error', 'dsh-diary: tool register failed (ignored):', e?.message || e);
  }
}

/**
 * 在 agent 创建时挂载：记忆注入段 + diary / diary_open 工具。
 * 关键：先让会话打开；注入文本异步生成，生成前 boot 段为空（裸开），生成后下一轮自动带上。
 */
export async function attachMemory(ctx, agent, cfg) {
  try {
    rememberTarget(agent?.options?.provider, agent?.options?.model);
    const sp = agent?.ctx?.systemPrompt;
    const isSub = !!agent?.session?.parent;
    // 预设闸门：助手模式不挂注入段、也不注册 diary / diary_open 检索工具。
    // 只关注入不关工具，等于留了个后门让它自己去翻旧档。
    const allowed = agentAllowed(ctx, agent);

    // section 无条件挂载，由 text() 每次组装时自己判断要不要出内容。
    //
    // 为什么不按创建时的判断决定挂不挂：会话创建那一刻可能是 cordis，
    // 用户之后才切到 assistant；反过来也一样。挂载是一次性的，判断是
    // 每次组装都要重做的 —— 把判断放进 text() 才跟得上切换。
    if (sp?.section && (cfg.injectSubagents || !isSub)) {
      try {
        const sid = String(agent?.session?.id || 'unknown');
        sp.section({
          name: 'dsh-diary',
          order: -150,
          interpolate: false,
          // 必须同步返回字符串；缓存由 refreshBootCache 在后台填充（下一轮生效）。
          //
          // 每次组装都实时重判一次预设：这个 section 是 agent 创建时挂上的，
          // 之后用户可能在下拉里切走（会话日志里会有 agent-preset/selected）。
          // 只靠创建时那一次判断，切到助手模式后旧注入会一直跟着 —— 踩过。
          text: () => {
            if (!agentAllowed(ctx, agent)) return '';
            const cached = bootCache.get(sid);
            // 缓存是空的就顺手补一次（异步，下一轮生效）。
            // 否则「创建时是助手模式 → 缓存从没填过 → 后来切回爱弥斯」
            // 会一直空着，人回来了日记却还没回来。
            if (!cached) refreshBootCache(ctx, agent, cfg);
            return cached || '';
          },
        });
      } catch (e) {
        safeLog(ctx?.logger, 'error', 'dsh-diary: section register failed (ignored):', e?.message || e);
      }
      refreshBootCache(ctx, agent, cfg);
    }

    if (allowed) await registerTools(ctx, agent, cfg);
  } catch (e) {
    safeLog(ctx?.logger, 'error', 'dsh-diary: attachMemory failed (ignored):', e?.message || e);
  }
}

/** 被动召回：用户消息到达时，命中旧档则写入本会话召回缓冲（下一轮 prompt 即带上）。 */
export async function onUserMessage(ctx, agent, message, cfg) {
  try {
    // 预设闸门：助手模式不做被动召回（不扫旧档、不往上下文塞东西）。
    if (!agentAllowed(ctx, agent)) return;
    const text = messageText(message);
    if (!text) return;
    // 太短的消息（「嗯」「好」）不值得搜，省一次全盘扫描
    if (tokenize(text).length === 0) return;
    const hit = await searchDiary(cfg.diaryDir, text);
    if (hit) {
      const sid = String(agent?.session?.id || 'unknown');
      const prev = recallMap.get(sid) || '';
      recallMap.set(sid, `${prev}\n${hit}`.trim().slice(-2000));
    }
  } catch (e) {
    safeLog(ctx?.logger, 'error', 'dsh-diary: onUserMessage failed (ignored):', e?.message || e);
  }
}
