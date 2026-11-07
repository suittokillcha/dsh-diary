// util.js — 消息文本提取、关键词分词、安全日志。

/**
 * 从 dsh 的 message 对象中提取纯文本。
 * - 只取 content 里 type==='text' 的块（自动排除工具调用 / 工具结果 / reasoning 等）。
 * - 非文本块（图片、音频等）用占位的 [类型] 表示，保持纯文本简洁（设计 §3 / §13）。
 * 返回 '' 表示这条消息没有可记录的聊天文本（例如纯工具调用轮），调用方应跳过。
 */
export function messageText(msg) {
  if (!msg || !Array.isArray(msg.content)) return '';
  const parts = [];
  for (const block of msg.content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text.trim()) parts.push(block.text.trim());
    } else if (block.type === 'reasoning' || block.type === 'tool-call' || block.type === 'tool_result') {
      // 跳过：设计 §10 不记工具过程与思考过程
    } else if (block.type) {
      // 多模态等：占位，不内联二进制
      parts.push(`[${block.type}]`);
    }
  }
  return parts.join('\n').trim();
}

/**
 * 人称词：检索时一律扔掉。
 *
 * 为什么（实测）：
 *   某天 223 条记录里，人称词（「你」「我」这类）命中率过半，
 *   而真正的关键词只命中 1-2%。人称不是关键词，是背景音——拿它去搜等于没搜。
 *   又如「第一次试水温」这种查询：保留人称时命中 40/42 块，扔掉人称后收窄到 3/42。
 */
const PERSON_WORDS = [
  '大肥鱼', '用户', '助手',
  '我们', '你们', '他们', '她们', '它们',
  '我', '你', '他', '她', '它', '咱', '俺',
];

/** 把一句话里的人称词抹成空格（保留原位置，避免把两侧的字粘成一个假词）。 */
function stripPerson(q) {
  let s = q;
  for (const w of PERSON_WORDS) {
    s = s.split(w).join(' ');
  }
  return s;
}

/** 停用词：这些词单独出现没有区分度。 */
const STOP = new Set([
  '的', '了', '是', '在', '有', '没', '不', '也', '都', '就', '还', '又', '再', '才', '很', '太', '更', '最',
  '这', '那', '哪', '什', '么', '怎', '样', '些', '个', '次', '回', '下', '上', '里', '外', '中',
  '吗', '呢', '啊', '吧', '呀', '哦', '嗯', '哈', '嘛', '么',
  '把', '被', '和', '与', '跟', '给', '让', '对', '向', '从', '到', '着', '过', '得', '地',
  '会', '能', '要', '想', '说', '做', '来', '去', '看', '用', '个', '时', '候',
  'the', 'a', 'an', 'is', 'to', 'of', 'and', 'or', 'it', 'this', 'that',
]);

/**
 * 把一句查询拆成用于检索的「有效词元」。
 *
 * 三条规则（2026-11-02 定）：
 *   1) 先扔掉人称词——它们是背景音，不是关键词。
 *   2) 中文只切 2 字。3/4 字滑窗切出来的多半是 2 字词的拼接（「大肥鱼第一」「爱第一次」），
 *      不增加精度，只增加误命中。实测只切 2 字，结果反而更准。
 *   3) 英文按单词，过滤太短和停用词。
 */
export function tokenize(query) {
  const raw = (query || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!raw) return [];

  const tokens = new Set();

  // 英文/数字单词（先做，因为它们不受中文切分影响）
  for (const w of raw.split(' ')) {
    if (/^[a-z0-9]{2,}$/.test(w) && !STOP.has(w)) tokens.add(w);
  }

  // 中文：先抹掉人称，再只切 2 字
  const cjk = stripPerson(raw).replace(/[a-z0-9\s]/g, '');
  for (let i = 0; i + 2 <= cjk.length; i++) {
    const piece = cjk.slice(i, i + 2);
    if (STOP.has(piece)) continue;
    if (/^[\u4e00-\u9fa5]{2}$/.test(piece)) tokens.add(piece);
  }

  return [...tokens];
}

/**
 * 判断一条记录是不是「定时会话自己说话」——不该进摘要、不该进关键词表。
 *
 * 为什么（2026-11-02 实测）：
 *   10-29 那天 366 条记录里，157 条是自动会话（43%）。
 *   10-30 是 134/793（17%），10-31 是 96/444（22%）。
 *   这些是生物钟/自动任务唤醒时的模板话，不是用户和大肥鱼在聊天。
 *   原文照常保留（留着排查用），但摘要和关键词必须跳过。
 *
 * 只用一条判法：开头是模板标记（［身份］/【生物钟】/【这阵子】/【看的那晚】）。
 *
 * 为什么不用「会话 ID」判（2026-11-02 实测纠正）：
 *   同一个会话里，既有自动唤醒时的模板话，也有用户真的在里面跟助手聊的日常内容
 *   （两者混在同一条会话流里，只能逐条看）。
 *   按 ID 整段排除，会把真对话一起扔掉。所以只能按「这一条是不是模板话」判。
 *
 * 为什么不加「编号指令清单」那条：
 *   实测会误杀。真对话里聊到「1) 2) 3)」的排比、或者 AI 自己整理的总结清单，都会被当成自动会话。
 *   误杀的代价比漏判大得多——漏判只是多几条噪音，误杀是把真记忆扔掉。宁可放过，不可错杀。
 *
 * 注意：也不能只看 ID 长相。有些会话 ID 看着像乱码，其实是真对话（实测 300 多条），别误杀。
 */
const AUTO_TEMPLATE = /［身份］|【生物钟】|【这阵子】|【看的那晚】/;

export function isAutoRecord(rec) {
  if (!rec) return false;
  const t = String(rec.text || '');
  if (!t) return false;

  // 模板标记：出现在前 200 字内就算
  return AUTO_TEMPLATE.test(t.slice(0, 200));
}

/** 安全日志：任何 logger 形态都能用，不会因 logger 异常而抛。 */
export function safeLog(logger, level, ...args) {
  try {
    const fn = logger?.[level] || logger?.log || logger?.error;
    if (typeof fn === 'function') fn.apply(logger, args);
  } catch { /* 日志失败不影响主流程 */ }
}
