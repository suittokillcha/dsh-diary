/**
 * preset-gate.js — 日记侧的「预设闸门」。
 *
 * 规则是一条**黑名单**，只有一个名字：`assistant`（助手模式）。
 * 那套预设是干净的 AI 助手，不落盘、不摘要、不注入、不召回、不给检索工具。
 * 其余所有预设（standard / cordis / redteam / preset-plus / 以后新加的）
 * 一律当爱弥斯处理，全量记录 + 全量注入。
 *
 * 为什么用黑名单而不是白名单：下个月有人加了个新预设，默认应该是
 * 「她在」，而不是「悄悄谁都不在」。
 *
 * 三道写（record.js）+ 四道读（memory.js）共用这里的判断，
 * 避免任何一处口径不一致。
 *
 * @module dsh-diary/preset-gate
 */

/** 不记录、不注入的预设 id。 */
export const SILENT_PRESETS = new Set(['assistant']);

/**
 * 会话 → 预设 id 的缓存。
 *
 * `agent/created` 时由 index.js 写进来，`session/event`（写侧）直接读。
 * 为什么不只靠 ctx.agents.get(sessionId)：写侧拿到的是 session 对象，
 * 万一 id 对不上或 agent 已释放，查不到就会「放行」—— 助手模式就漏记了。
 * 缓存是显式写入的，比反查可靠。
 *
 * @type {Map<string, string>}
 */
const presetBySession = new Map();

/** 记住一个会话挂的预设（agent/created 时调用）。 */
export function rememberSessionPreset(sessionId, presetId) {
  const sid = String(sessionId || '');
  if (!sid) return;
  const pid = barePresetId(presetId);
  if (pid) presetBySession.set(sid, pid);
  else presetBySession.delete(sid);
}

/** 忘掉一个会话（agent 释放时调用，避免长跑进程里泄漏）。 */
export function forgetSessionPreset(sessionId) {
  presetBySession.delete(String(sessionId || ''));
}

/** 读缓存里的预设 id。 */
export function cachedSessionPreset(sessionId) {
  return presetBySession.get(String(sessionId || ''));
}

/**
 * 把 composedPreset() 的返回值归一成裸名。
 *
 * 它可能返回裸 id（`assistant`），也可能返回带作用域的（`<scope>/assistant`）
 * —— dsh-purge 比对预设 id 时就是用 endsWith 处理的。归一一次，黑名单才好读。
 *
 * @param {string} id
 * @returns {string}
 */
export function barePresetId(id) {
  const raw = String(id || '').trim();
  if (!raw) return '';
  const slash = raw.lastIndexOf('/');
  return (slash >= 0 ? raw.slice(slash + 1) : raw).trim();
}

/**
 * 找 agent-preset registry。
 *
 * 先试 `ctx.agentPresets`，不行再试 `ctx.get('agentPresets')`。
 * 故意**不**把 agentPresets 写进插件的 `inject`：一旦声明，那个服务没就绪
 * 整个插件就挂不上，日记和记忆会一起死。用懒查更安全 —— 查不到就放行。
 *
 * @param {object} ctx
 * @returns {object | undefined}
 */
export function presetRegistry(ctx) {
  try {
    const direct = ctx?.agentPresets;
    if (direct?.composedPreset) return direct;
  } catch {
    // 没 inject 的服务直接点可能抛，忽略
  }
  try {
    const viaGet = ctx?.get?.('agentPresets');
    if (viaGet?.composedPreset) return viaGet;
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * 找 agents 服务。
 *
 * 跟 presetRegistry 一样：先点 `ctx.agents`，不行再 `ctx.get('agents')`。
 * 这一步踩过 —— 日记插件只 `inject = ['llm']`，所以 `ctx.agents` 在它的
 * 上下文里是 undefined，写侧（record.js 只拿到 sessionId）就永远查不到
 * 预设、永远「放行」，助手模式的对话照样落盘。读侧因为有 presetRegistry
 * 的 ctx.get 兜底才没事。两边都得能取到服务。
 *
 * @param {object} ctx
 * @returns {object | undefined}
 */
export function agentRegistry(ctx) {
  try {
    const direct = ctx?.agents;
    if (typeof direct?.get === 'function') return direct;
  } catch {
    // 没 inject 的服务直接点可能抛，忽略
  }
  try {
    const viaGet = ctx?.get?.('agents');
    if (typeof viaGet?.get === 'function') return viaGet;
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * 读某个会话挂在哪个预设上。
 *
 * 拿不到答案时返回 undefined —— 调用方必须把 undefined 当「放行」。
 * 查不到就静默剥离人格，是比漏记更严重的错。
 *
 * @param {object} ctx cordis 上下文（需要 agents + agentPresets）
 * @param {string} sessionId 会话 id
 * @returns {string | undefined}
 */
export function presetOfSession(ctx, sessionId) {
  try {
    if (!sessionId) return undefined;
    const agents = agentRegistry(ctx);
    if (!agents) return undefined;
    const agent = agents.get(sessionId);
    if (!agent) return undefined;
    return presetOfAgent(ctx, agent);
  } catch {
    return undefined;
  }
}

/**
 * 读某个 live agent 挂在哪个预设上（注入侧用，手上已经有 agent 了）。
 *
 * @param {object} ctx
 * @param {object} agent
 * @returns {string | undefined}
 */
export function presetOfAgent(ctx, agent) {
  try {
    const registry = presetRegistry(ctx);
    const agentCtx = agent?.ctx;
    if (!registry || !agentCtx) return undefined;
    const composed = registry.composedPreset(agentCtx);
    if (typeof composed !== 'string') return undefined;
    const id = composed.trim();
    return id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 这个会话该不该记录 / 注入。
 *
 * 顺序很重要：**先实时反查，查不到才退回缓存**。
 *
 * 反过来（先读缓存）踩过坑：会话创建那一刻是 `cordis`，用户之后才在下拉里
 * 切到 `assistant`（会话文件里有 `agent-preset/selected` 事件）。缓存在
 * `agent/created` 时就写死了旧值，结果助手模式的对话照样落盘、照样注入。
 * 实时查 `composedPreset()` 才拿得到切换后的值。
 *
 * 缓存只在反查扑空时兜底 —— 比如 agent 已释放、或写侧事件晚到。
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {boolean}
 */
export function sessionAllowed(ctx, sessionId) {
  const sid = String(sessionId || '');
  const live = presetOfSession(ctx, sid);
  if (live) return !SILENT_PRESETS.has(barePresetId(live));
  const cached = cachedSessionPreset(sid);
  if (cached) return !SILENT_PRESETS.has(cached);
  return true;
}

/**
 * 这个 agent 该不该记录 / 注入。
 *
 * @param {object} ctx
 * @param {object} agent
 * @returns {boolean}
 */
export function agentAllowed(ctx, agent) {
  const id = presetOfAgent(ctx, agent);
  if (!id) return true;
  return !SILENT_PRESETS.has(barePresetId(id));
}
