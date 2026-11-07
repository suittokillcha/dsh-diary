// llm.js — 调用 dsh 的 LLM 服务做「情绪标注 / 轻压缩 / 检索摘要」。
// 关键安全策略：
//  1) 用「动态 import」加载 @deepseek-ai/dsh-llm，避免模块缺失导致插件加载期崩溃；
//  2) 任何失败都返回 null，由调用方降级（AI 只是增强，非核心）。
import { safeLog } from './util.js';

// 缓存最近一次见到的 provider/model（供 23:00 等无 agent 场景使用）。
let lastTarget = null;
export function rememberTarget(provider, model) {
  if (provider && model) lastTarget = { provider, model };
}
export function getTarget(agent) {
  if (agent?.options?.provider && agent?.options?.model)
    return { provider: agent.options.provider, model: agent.options.model };
  return lastTarget;
}

/**
 * 调用 LLM 返回纯文本。失败返回 null。
 * @param {object} ctx
 * @param {{provider:string,model:string}} target
 * @param {string} systemText
 * @param {string} userText
 * @param {object} opts { maxTokens, sessionId, signal }
 */
export async function callLLM(ctx, target, systemText, userText, opts = {}) {
  if (!target?.provider || !target?.model) return null;
  try {
    const llm = ctx?.llm;
    if (!llm?.stream) return null;
    const mod = await import('@deepseek-ai/dsh-llm');
    const { createUserMessage, createSystemMessage, BlockAssembler } = mod;
    const messages = [];
    if (systemText) messages.push(createSystemMessage(systemText));
    messages.push(createUserMessage({
      content: [{ type: 'text', text: userText }],
      source: { kind: 'dsh-diary' },
    }));
    const assembler = new BlockAssembler();
    const params = {
      provider: target.provider,
      model: target.model,
      maxTokens: opts.maxTokens || 1500,
      messages,
      purpose: 'dsh-diary',
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    for await (const chunk of llm.stream(params)) {
      assembler.push(chunk);
    }
    const finish = assembler.finish;
    if (!finish || finish.kind !== 'stop') return null;
    const text = assembler.blocks()
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim();
    return text || null;
  } catch (e) {
    safeLog(ctx?.logger, 'error', 'dsh-diary: callLLM failed (degraded):', e?.message || e);
    return null;
  }
}
