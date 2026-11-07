// index.js — dsh-diary 插件入口。
//
// 2026-11-02 定稿后的结构：
//   ① 每轮原文落盘（record.js）—— 零压缩，一切的地基
//   ② 每 5 条分块摘要（digest.js）—— 第一人称、不压平、跳过定时会话模板话
//   ③ 开局注入两块（memory.js）—— 最近 30 天表 + 今天全文
//   ④ 按日期开门 / 搜摘要两个工具（memory.js）
//   ⑤ 00:10 封章（rollup.js）—— 只封「过去的日子」，今天永远只重抄
//
// 安全红线（贯穿）：所有监听器全异步 + try/catch，绝不抛错冒泡；
// 日期用本地时区；存储独立 .dsh/diary/；注入服务只写真实存在的 'llm'。
import { defaultDiaryDir, ensureBase, defaultMediaDir, ensureMediaBase } from './storage.js';
import path from 'node:path';
import { homedir } from 'node:os';
import { recordEvent } from './record.js';
import { attachMemory, onUserMessage } from './memory.js';
import { presetOfAgent, rememberSessionPreset } from './preset-gate.js';
import { compensate, pendingHealthWarning } from './rollup.js';
import { safeLog } from './util.js';

export const inject = ['llm'];

const DEFAULTS = {
  diaryDir: defaultDiaryDir(),
  mediaDir: defaultMediaDir(),
  mediaKeepDays: 90,
  incomingMediaDirs: [
    path.join(homedir(), '.dsh-qqbot', 'media'),
  ],
  enableMood: true,          // 封章时 AI 情绪标注
  enableKeywords: true,      // 封章时生成「30 天表」的关键词列
  injectTable: true,         // 开局注入「最近 30 天表」
  injectToday: true,         // 开局注入「今天摘要全文」
  injectSubagents: false,    // 不给工具型子代理注入（避免一回合几十次 LLM）
  tableDays: 30,             // 表覆盖多少天
  enableDigest: true,        // 今日实时摘要
  digestChunk: 5,            // 每 5 条有文本的消息做一次分块摘要
  // 封章时点：00:10（原来是 23:00——23 点封等于亲手扔掉 23:00–24:00 那一小时，
  // 而且之后补偿看到「已封」就跳过，永远补不上）
  reviewHour: 0,
  reviewMinute: 10,
  fallbackTarget: null,
};

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  safeLog(ctx?.logger, 'info', 'dsh-diary: applying (diaryDir =', cfg.diaryDir, ', mediaDir =', cfg.mediaDir, ')');

  void ensureBase(cfg.diaryDir).catch(() => {});
  void ensureMediaBase(cfg.mediaDir).catch(() => {});

  // ① 每轮原始对话落盘（所有会话）。只处理 user/assistant 文本消息，不记工具。
  ctx.on('session/event', (session, event) => {
    try {
      if (!event || !session) return;
      if (event.type === 'user/message' || event.type === 'assistant/message') {
        void recordEvent(ctx, session, event, cfg);
      }
    } catch (e) {
      safeLog(ctx?.logger, 'error', 'dsh-diary: session/event handler (ignored):', e?.message || e);
    }
  });

  // ② 会话创建：挂载注入段 + 工具，并做一次补偿汇总。
  ctx.on('agent/created', ({ agent }) => {
    try {
      // 先把这个会话挂的预设记下来：写侧（session/event）晚到，
      // 靠 ctx.agents.get 反查可能扑空，缓存是那道保险。
      rememberSessionPreset(agent?.session?.id, presetOfAgent(ctx, agent));
      void attachMemory(ctx, agent, cfg);
      void compensate(ctx, cfg).catch(() => {});
    } catch (e) {
      safeLog(ctx?.logger, 'error', 'dsh-diary: agent/created handler (ignored):', e?.message || e);
    }
  });

  // ③ 被动召回：用户消息到达时命中旧档则补入本会话上下文。
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    try {
      if (message?.source?.kind === 'user') void onUserMessage(ctx, agent, message, cfg);
    } catch (e) {
      safeLog(ctx?.logger, 'error', 'dsh-diary: inbox/inserted handler (ignored):', e?.message || e);
    }
  });

  // ④ 启动补偿：dsh 启动时先补齐错过的汇总（幂等、容错）。
  void Promise.resolve().then(() =>
    compensate(ctx, cfg).catch((e) => safeLog(ctx?.logger, 'error', 'dsh-diary: startup compensate failed:', e?.message || e)),
  );

  // ⑤ 00:10 封章（只封过去的日子）。
  const scheduleDaily = () => {
    try {
      const now = new Date();
      const next = new Date(now);
      next.setHours(cfg.reviewHour ?? 0, cfg.reviewMinute ?? 10, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      const timer = setTimeout(async () => {
        try {
          await compensate(ctx, cfg);
          const warn = await pendingHealthWarning(cfg.diaryDir);
          if (warn) safeLog(ctx?.logger, 'warn', 'dsh-diary:', warn);
        } catch (e) {
          safeLog(ctx?.logger, 'error', 'dsh-diary: daily rollup failed:', e?.message || e);
        }
        scheduleDaily();
      }, next - now);
      if (timer && typeof timer.unref === 'function') timer.unref();
      safeLog(ctx?.logger, 'info', `dsh-diary: 封章时点 ${String(cfg.reviewHour ?? 0).padStart(2, '0')}:${String(cfg.reviewMinute ?? 10).padStart(2, '0')}（只封过去的日子）`);
    } catch (e) {
      safeLog(ctx?.logger, 'error', 'dsh-diary: scheduleDaily failed:', e?.message || e);
    }
  };
  scheduleDaily();

  safeLog(ctx?.logger, 'info', 'dsh-diary: applied, watching all sessions.');
}
