// record.js — 每轮原始对话零压缩落盘（所有会话生效）。
// 钩子：session/event 的 user/message（source.kind==='user'）与 assistant/message。
// 策略：每条消息到达即异步 append 一行 JSONL，绝不阻塞本轮、绝不抛错。
import { localParts, paths, appendText, ensureBase, ensureMediaBase } from './storage.js';
import { messageText, safeLog } from './util.js';
import { saveImage, collectImagePathsFromText, scanIncoming } from './image.js';
import { maybeDigest } from './digest.js';
import { sessionAllowed } from './preset-gate.js';

/** 落盘成功时，清掉对话文本里残留的图片占位行，让日记只留真实的话。 */
function cleanImagePlaceholders(text) {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (/^[-–]\s*Image:\s*\S+$/i.test(t)) return false;        // "- Image: C:/..."
      if (/^\[(?:image|图片)\]\s*$/i.test(t)) return false;       // 独立的 [image] / [图片]
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 每个会话的当前回合号（同轮 user+assistant 同号）。
const turnCounters = new Map();

/**
 * 记录一条消息。设计为「尽力而为」：任何异常都被吞掉，绝不让监听器冒泡崩溃。
 * @param {object} ctx          cordis 上下文（提供 logger）
 * @param {object} session      dsh session（含 id）
 * @param {object} event        session/event 的 event（含 type / data）
 * @param {object} cfg          配置（含 diaryDir）
 */
export async function recordEvent(ctx, session, event, cfg) {
  try {
    if (!event || !session) return;
    // 预设闸门：助手模式不落盘。放在最前面，后面的 digest / 游标 / 图片
    // 全都自然不触发 —— 不是「记了但藏起来」，是根本没写。
    if (!sessionAllowed(ctx, String(session.id ?? ''))) return;
    let role = null;
    if (event.type === 'user/message') {
      // 只记真实用户输入，排除召回/系统注入的消息
      if (event.data?.source?.kind !== 'user') return;
      role = 'user';
    } else if (event.type === 'assistant/message') {
      role = 'assistant';
    } else {
      return;
    }

    // 结构差异：user/message 的文本在 event.data.content，assistant/message 被 dsh 多包一层
    // 到 event.data.message.content（anchor-gate.mjs 第160行有同类写法）。双轨兼容。
    let msg = event.data?.message ?? event.data;
    // assistant 消息可能带 reasoning / tool-calls 字段，过滤掉避免污染日志
    if (role === 'assistant' && msg?.content) {
      msg = { ...msg, content: msg.content.filter(b => b?.type !== 'reasoning' && b?.type !== 'tool-call' && b?.type !== 'tool_result') };
    }
    const text = messageText(msg);

    // 收集消息里的图片块（多模态，独立于文本；原图压缩存到 mediaDir，JSONL 只记引用）
    const origMsg = event.data?.message ?? event.data;
    const imageBlocks = [];
    const pushImg = (b) => { if (b && typeof b === 'object' && b.type === 'image') imageBlocks.push(b); };
    if (Array.isArray(origMsg?.content)) origMsg.content.forEach(pushImg);
    if (Array.isArray(origMsg?.images)) origMsg.images.forEach(pushImg);
    if (Array.isArray(origMsg?.files)) origMsg.files.forEach(pushImg);

    // 文本里的图片路径（QQ 桥等会把图下到本地并在文本里写入 "- Image: <绝对路径>"）
    const textPaths = collectImagePathsFromText(text);
    // 仅占位、无真实路径时，用目录扫描兜底（按消息时刻找 QQ 桥刚下好的图）
    const placeholderOnly = imageBlocks.length === 0 && textPaths.length === 0 && /\[(?:image|图片)\]/i.test(text || '');

    if (!text && imageBlocks.length === 0 && textPaths.length === 0 && !placeholderOnly) return;

    const sessionId = String(session.id ?? 'unknown');
    const lp = localParts();
    let turn = turnCounters.get(sessionId) || 0;
    if (role === 'user') {
      turn = turn + 1;
      turnCounters.set(sessionId, turn);
    }
    // assistant 沿用当前回合号（0 表示异常顺序，也照常记录）

    const p = paths(cfg.diaryDir);
    await ensureBase(cfg.diaryDir);
    await ensureMediaBase(cfg.mediaDir);

    // 图片落盘（三路：内容块 / 文本路径 / 目录扫描兜底），全部不阻塞、不抛错
    const savedImages = [];
    const trySave = async (spec) => {
      try {
        const s = await saveImage(spec, lp.dateKey, cfg.mediaDir);
        if (s) savedImages.push(s);
      } catch (ie) {
        safeLog(ctx?.logger, 'warn', 'dsh-diary: saveImage skipped:', ie?.message || ie);
      }
    };
    for (const ib of imageBlocks) await trySave(ib);
    for (const tp of textPaths) await trySave({ path: tp });
    if (savedImages.length === 0 && placeholderOnly) {
      const scanned = await scanIncoming(cfg.incomingMediaDirs || [], lp.dateKey, cfg.mediaDir, lp.tsMs);
      for (const s of scanned) savedImages.push(s);
    }

    // 落盘后 → 无条件清掉文本里的图片占位行（[image]/[图片]/"- Image: 路径"），只留真实的话。
    // 无条件清理（而非仅存到图时才清）是为了让 JSONL 源头永远干净：
    // 这样 23:00 汇总 stageA 从 JSONL 重渲染时，raw 对话与 ## 图片 段都不会再泄漏 QQ 桥内部路径。
    const cleanText = cleanImagePlaceholders(text);

    // 文本行：仅当有真实文字时写（纯图片消息只写图片记录）
    if (cleanText) {
      const line = JSON.stringify({
        sessionId, ts: lp.ts, turn, role, text: cleanText,
      }) + '\n';
      await appendText(p.tmp(lp.dateKey), line);
    }

    // 图片引用行：压缩落盘后写（src 指向我们 media 目录里的文件）
    for (const s of savedImages) {
      const imgLine = JSON.stringify({
        sessionId, ts: lp.ts, turn, role, type: 'image',
        src: s.src, hash: s.hash, size: s.size,
        width: s.width, height: s.height,
      }) + '\n';
      await appendText(p.tmp(lp.dateKey), imgLine);
    }

    // 今日实时摘要（每 N 条分块一次；fire-and-forget，不阻塞、不抛错）
    if (cfg.enableDigest !== false) {
      void maybeDigest(ctx, cfg, lp.dateKey).catch(() => {});
    }
  } catch (e) {
    // 关键：吞掉一切异常，绝不冒泡到事件分发（防「家打不开」类崩溃）
    safeLog(ctx?.logger, 'error', 'dsh-diary: recordEvent failed (ignored):', e?.message || e);
  }
}
