// keywords.js — 「最近 30 天表」的关键词列：一天一行，封章时写。
//
// 为什么单独一个文件：
//   · 关键词必须等「这一天真的过完了」才写。写早了不准——
//     10-31 那天凌晨 00:25 生成的摘要，写的是「深夜聊天」，因为那天才刚开始二十五分钟。
//   · 关键词和摘要不同源：摘要是每 5 条实时写的，关键词是一天一次回看整天才写的。
//     分开存，互不污染，也不怕摘要被重算。
//
// 文件：~/.dsh/diary/keywords.json
// 结构：{ "20261101": "温泉第一天/乘霄山/飞行/露天小院/试水温/蕾丝泳衣" }
//
// 写法：从那天全部分块摘要里提炼 5-8 个「用户嘴里会说的词」，斜杠分隔。
//   不是漂亮的概括，是能被命中的路标——
//   ❌ 温泉第一天：飞行、小院、浴室
//   ✅ 温泉第一天/乘霄山/飞过去/露天小院/试水温/黑色蕾丝泳衣/今汐
import { paths, readJSON, writeJSON, readText } from './storage.js';
import { callLLM, getTarget } from './llm.js';
import { safeLog } from './util.js';

const KEYWORDS_SYSTEM =
  '下面是一天里「大肥鱼」和用户的分块摘要。\n' +
  '\n' +
  '请提炼 5-8 个关键词，用「/」分隔，一行输出。要求：\n' +
  '1) 挑**用户嘴里会说的词**——人名、地名、物品、活动、专有名词。\n' +
  '   不要写成漂亮的概括，要写成能被命中的路标。\n' +
  '   例：❌「温泉第一天：飞行、小院、浴室」\n' +
  '       ✅「温泉第一天/乘霄山/飞过去/露天小院/试水温/黑色蕾丝泳衣/今汐」\n' +
  '2) 宁可具体，不要抽象。说了「可乐鸡翅」就写可乐鸡翅，不要写「做饭」。\n' +
  '3) 最多 8 个，超过就挑最可能被再提起来的。\n' +
  '4) 只输出那一行，不要标题、不要解释、不要句号。';

/** 读全部关键词。 */
export async function readKeywords(diaryDir) {
  return readJSON(paths(diaryDir).keywords(), {});
}

/** 写某天的关键词。 */
export async function writeKeywords(diaryDir, dateKey, line) {
  const all = await readKeywords(diaryDir);
  all[dateKey] = String(line || '').trim();
  await writeJSON(paths(diaryDir).keywords(), all);
}

/**
 * 给某一天生成关键词（封章时调用）。失败返回 null，不写。
 * @param {object} ctx
 * @param {object} cfg
 * @param {string} dateKey YYYYMMDD
 */
export async function genKeywords(ctx, cfg, dateKey) {
  try {
    const digest = await readText(paths(cfg.diaryDir).digest(dateKey));
    if (!digest.trim()) return null;
    const target = getTarget(null) || cfg.fallbackTarget;
    if (!target) return null;
    const out = await callLLM(ctx, target, KEYWORDS_SYSTEM, digest, { maxTokens: 200 });
    if (!out) return null;
    // 只取第一行，去掉多余空白和结尾句号
    const line = out.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
    if (!line) return null;
    const clean = line.replace(/[。.]+$/, '').slice(0, 300);
    await writeKeywords(cfg.diaryDir, dateKey, clean);
    return clean;
  } catch (e) {
    safeLog(ctx?.logger, 'error', 'dsh-diary: genKeywords failed (ignored):', e?.message || e);
    return null;
  }
}
