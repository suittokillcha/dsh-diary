// 隔离自测：不依赖 dsh，验证「核心路径」（落盘 + 汇总 + 索引 + 检索）无语法/运行错误。
// 运行：node scripts/test.mjs
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths, readJsonl, readText, readJSON, localParts } from '../lib/storage.js';
import { recordEvent } from '../lib/record.js';
import { rollupDay, compensate } from '../lib/rollup.js';
import { searchDiary } from '../lib/memory.js';

const diaryDir = path.join(os.tmpdir(), 'dsh-diary-test-' + Date.now());
const cfg = { diaryDir, enableMood: false }; // 关闭 AI，纯验证确定性路径
const ctx = { logger: console };

function fakeEvent(type, role, text, sourceKind = 'user') {
  return {
    type,
    data: {
      source: { kind: sourceKind },
      content: [{ type: 'text', text }],
    },
  };
}

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('  [ok]', msg);
  else { console.log('  [FAIL]', msg); failures++; }
}

async function main() {
  const lp = localParts();
  const dk = lp.dateKey;
  const session = { id: 'sess_test_1' };

  // 1) 落盘：用户 + 大肥鱼 各两条
  await recordEvent(ctx, session, fakeEvent('user/message', 'user', '你好'), cfg);
  await recordEvent(ctx, session, fakeEvent('assistant/message', 'assistant', '你有什么事吗'), cfg);
  await recordEvent(ctx, session, fakeEvent('user/message', 'user', '帮我记一下明天开会'), cfg);
  await recordEvent(ctx, session, fakeEvent('assistant/message', 'assistant', '好的，已记下'), cfg);
  // 工具型消息不应被记录（无文本）
  await recordEvent(ctx, session, fakeEvent('assistant/message', 'assistant', '', 'user'), cfg);

  const P = paths(diaryDir);
  const recs = await readJsonl(P.tmp(dk));
  assert(recs.length === 4, `tmp 记录 4 条（实际 ${recs.length}，工具空消息已被跳过）`);
  assert(recs[0].role === 'user' && recs[0].text === '你好', '首条为 user/你好');
  assert(recs[0].sessionId === 'sess_test_1' && /^\d{4}-\d{2}-\d{2}T/.test(recs[0].ts), '带 sessionId + 本地时间戳');

  // 2) 汇总当天（AI 关闭）
  const summary = await rollupDay(ctx, dk, cfg);
  assert(summary.status === 'ok' || summary.status === 'partial', `汇总状态 ok/partial（实际 ${summary.status}）`);
  const dayMd = await readText(P.dayMd(dk));
  assert(dayMd.includes('## 原始对话') && dayMd.includes('你好'), '当日 md 含原文');
  const daily = await readText(P.dailyDiary(lp.ym));
  assert(daily.includes('sess_test_1') || daily.includes('你好'), '当月原始记忆已 append');
  const idx = await readText(P.indexMd(lp.ym));
  const dy = Number(dk.slice(0, 4)), dm = Number(dk.slice(4, 6)), dd = Number(dk.slice(6, 8));
  const idxLabel = `${dy}年${dm}月${dd}日`;
  assert(idx.includes('### ' + idxLabel), '当月索引已 append 当日条目');
  const state = await readJSON(P.state(), {});
  assert(state.latestSummarized === dk, 'state.latestSummarized 已更新');

  // 3) 检索：往「当月」索引写入一个含关键词的旧条目并检索（检索只覆盖当月+上月）
  await fs.mkdir(path.dirname(P.indexMd(lp.ym)), { recursive: true });
  await fs.appendFile(P.indexMd(lp.ym), '\n### 20261001\n- 概览：首「我们去过西湖」→ 末「下次再去」\n- 情绪曲线：你:开心→满足\n', 'utf8');
  const hit = await searchDiary(diaryDir, '西湖');
  assert(hit.includes('西湖'), '检索命中「西湖」旧片段');

  // 4) 补偿：再写一天 tmp 并补偿
  const dk2 = lp.dateKey; // 同一天，验证幂等跳过
  await compensate(ctx, cfg);
  const state2 = await readJSON(P.state(), {});
  assert(state2.summaries[dk] && state2.summaries[dk].status !== 'failed', '补偿后当天未被标 failed（幂等）');

  // 清理
  await fs.rm(diaryDir, { recursive: true, force: true });

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
