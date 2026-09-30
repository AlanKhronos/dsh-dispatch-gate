/**
 * gate-v10 自测（selftest.mjs）
 *
 * 用 mock ctx 驱动【真实的 index.js】（import './index.js'，非复制逻辑），
 * 覆盖 v9 全部回归点（46 项，逐项保留）+ v10 举证式 SELF-DO 的新增用例。
 *
 * v10 语义变更说明（修的是用户纪律：举证式 SELF-DO）：
 *   v9 的放行条件②「关键参数本体含 SELF-DO: 就放行」是声明式的 —— 模型随手写
 *   `SELF-DO: 我自己来` 就能绕过闸门。v10 要求举证，三通道：
 *     ②-a perm/privilege 权限通道（跑本机命令/高风险写操作，无需先派发）；
 *     ②-b 结构化证据 tried= 与 reason= 缺一不可；
 *     ②-c 本会话存在派发尝试（成功或失败都算，失败以 kind:"dispatch-failed" 入账）。
 *   证据不足 → fail-closed 拒绝，拒因 reason='selfdo-no-evidence'（区别于没写 SELF-DO: 的
 *   'no-dispatch-record'），拒绝话术必须含可操作指引。
 *
 * ⚠️ 对 v9 第 46 项里 T21/T24/T25 的改写（有意为之，非回退）：
 *   v9 原断言「随便写 SELF-DO: 就放行」正是 v10 要废掉的语义；为保留「SELF-DO 位置边界」
 *   这一测点（关键参数本体才认、正文不查），第四组改为：先给 SELFDO 会话注入一次【失败】
 *   派发尝试（dispatchFailed=1，不触发条件⑥成功解锁，故位置边界仍由 marker 决定），
 *   再断言位置边界 —— 语义从「声明式放行」升级为「举证式下的位置边界」。
 *
 * 【运维3】不依赖真实日志文件：日志目录传 临时目录（失败则退到本目录 .selftest-logs/），
 *   日志/账本类断言读不到文件时降级为 SKIPPED —— 核心断言全部内存内判定。
 *
 * 统计落盘时 agent id 一律用 `selftest10-` 前缀（对照组 CMP 沿用 selftest9- 前缀的
 * 既有断言形态），与真实会话数据可辨识、不混淆。
 *
 * 运行：node selftest.mjs   （无 FAIL 则退出码 0；SKIP 不算失败）
 */
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apply } from './index.js';

// ── 【运维3】日志目录解析：临时目录 → 本目录 .selftest-logs → null（全 SKIPPED）──
let LOG_DIR = null;
for (const cand of [join(tmpdir(), `gate-v10-selftest-${process.pid}`), join(dirname(fileURLToPath(import.meta.url)), '.selftest-logs')]) {
  try {
    mkdirSync(cand, { recursive: true });
    LOG_DIR = cand;
    break;
  } catch { /* 下一个候选 */ }
}
const LOG_FILE = LOG_DIR ? join(LOG_DIR, 'dispatch-gate.log') : null;
const STATS_FILE = LOG_DIR ? join(LOG_DIR, 'dispatch-stats.jsonl') : null;

function makeCtx() {
  const listeners = new Map();
  const guards = [];
  return {
    effect: (fn) => {
      const d = fn();
      return typeof d === 'function' ? d : undefined;
    },
    on: (ev, fn) => {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
      return () => {};
    },
    tools: {
      guard: (fn) => {
        guards.push(fn);
        return () => {};
      },
    },
    emit: (ev, ...args) => {
      for (const f of listeners.get(ev) ?? []) f(...args);
    },
    guardFn: () => guards[guards.length - 1],
  };
}

let pass = 0;
let fail = 0;
let skipCnt = 0;
const results = [];

function check(id, desc, cond, detail = '') {
  if (cond) { pass += 1; results.push(`PASS ${id} ${desc}`); }
  else { fail += 1; results.push(`FAIL ${id} ${desc}${detail ? ` —— ${detail}` : ''}`); }
}
function skip(id, desc, reason) {
  skipCnt += 1;
  results.push(`SKIP ${id} ${desc}（${reason}）`);
}

const pwshExec = (id, command, callId = `call-${Math.random().toString(36).slice(2, 8)}`) => ({
  name: 'pwsh',
  callId,
  arguments: { command },
  agent: { id },
});
const allowed = (r) => r === undefined;
const denied = (r) => typeof r === 'string' && r.includes('派发闸门');

const ctx = makeCtx();
apply(ctx, { enforce: true, logDir: LOG_DIR ?? join(tmpdir(), 'gate-selftest-logs') });
const guard = ctx.guardFn();
if (typeof guard !== 'function') {
  console.error('FATAL: guard 未注册');
  process.exit(2);
}

const DENY = 'selftest10-DENY';   // 只验「该拦的都拦」的会话
const FAKE = 'selftest10-FAKE';   // 修A：假派发不解锁（条件⑥污染测试）
const EGO = 'selftest10-EGO';     // 修B：ego_* 未派发全拦
const UNLK = 'selftest10-UNLK';   // 修B：真派发后 ego_* 放行（复用 FAKE 的解锁流）
const SELFDO = 'selftest10-SELFDO'; // 修D：SELF-DO 位置边界（v10 = 举证式下边界）
const BASE = 'selftest10-BASE';   // v7 回归

// ⚠️ v10 第四组前置：给 SELFDO 会话注入一次【失败】派发尝试（dispatchFailed=1）。
//   失败尝试不触发条件⑥（成功解锁），marker 位置仍是放行的唯一变量 —— 位置边界测点得以保留；
//   同时这也让第四组的 T21/T24/T25 落在 v10 举证通道 ②-c（本会话有派发尝试）。
ctx.emit('tools/result', { name: 'workflow', callId: 'sdo-fail', arguments: { prompt: 'x' }, agent: { id: SELFDO } }, { isError: true, error: { message: 'provider unavailable' } });

// ════════════ 第一组【修 A/C】解析式派发判据 ════════════
check('T01', 'A: node --version # model-hub.mjs（注释带词）被拒',
  denied(guard(pwshExec(DENY, 'node --version # model-hub.mjs'))));
check('T02', 'A: node code-search.mjs "model-hub.mjs"（引号搜索词）被拒',
  denied(guard(pwshExec(DENY, 'node code-search.mjs "model-hub.mjs"'))));
check('T03', 'C: node tools\\code-search.mjs "model-hub.mjs"（日常搜索）被拒',
  denied(guard(pwshExec(DENY, 'node tools\\code-search.mjs "model-hub.mjs"'))));
check('T04', 'echo: Write-Output "model-hub.mjs" 被拒',
  denied(guard(pwshExec(DENY, 'Write-Output "model-hub.mjs"'))));
check('T05', 'echo: Write-Host "node model-hub.mjs usage" 被拒',
  denied(guard(pwshExec(DENY, 'Write-Host "node model-hub.mjs usage"'))));
check('T06', '正向: node model-hub.mjs usage --days 1 放行',
  allowed(guard(pwshExec(DENY, 'node model-hub.mjs usage --days 1'))));
check('T07', '正向: "  & node model-hub.mjs fanout --in x" 放行（& 调用符兼容）',
  allowed(guard(pwshExec(DENY, '  & node model-hub.mjs fanout --in x'))));
check('T08', '正向: 分段判据 "Get-Date; node model-hub.mjs usage" 放行（; 后第二段是真派发）',
  allowed(guard(pwshExec(DENY, 'Get-Date; node model-hub.mjs usage'))));
check('T09', '硬化: node --version model-hub.mjs（无注释也拦：终止旗标零副作用）',
  denied(guard(pwshExec(DENY, 'node --version model-hub.mjs'))));
check('T10', '硬化: node -e "console.log(\'model-hub.mjs\')"（-e 求值 + 引号）被拒',
  denied(guard(pwshExec(DENY, `node -e "console.log('model-hub.mjs')"`))));
check('T11', '基线: 无派发时普通 pwsh（Get-Process）被拒',
  denied(guard(pwshExec(DENY, 'Get-Process'))));
check('T12', '大小写: NODE MODEL-HUB.MJS 全大写路径仍判为派发（Windows 不分大小写）',
  allowed(guard(pwshExec(DENY, 'node tools\\MODEL-HUB.MJS usage'))));

// ════════════ 第二组【修 A】假派发不解锁（条件⑥不被污染 · 全内存证明）════════════
// 模拟 v7 时代"假派发被执行成功"（isError:false）→ v10 不得计入 dispatch
ctx.emit('tools/result', pwshExec(FAKE, 'node --version # model-hub.mjs', 'call-fake-ok'), { isError: false, value: {} });
check('T13', 'A: 假派发"成功执行"后，同会话普通 pwsh 仍被拒（假派发≠计数，永久解锁封死）',
  denied(guard(pwshExec(FAKE, 'Get-Process'))));
// 真派发成功 → 计 dispatch → 条件⑥解锁（同会话）
ctx.emit('tools/result', pwshExec(FAKE, 'node model-hub.mjs usage --days 1', 'call-real-ok'), { isError: false, value: {} });
check('T14', 'A: 真派发成功后同会话 pwsh 放行（条件⑥只认真派发，计数与放行解耦正常）',
  allowed(guard(pwshExec(FAKE, 'Get-Process'))));

// ════════════ 第三组【修 B】ego_* 能力级后门 ════════════
const egoCases = [
  ['ego_script', { script: 'console.log(1)' }],
  ['ego_cli', { script: 'await page.content()' }],
  ['ego_js', { expression: 'document.title' }],
  ['ego_cdp', { method: 'Page.navigate' }],
  ['ego_click', { selector: '#x' }],
  ['ego_fill', { selector: '#x', text: 'hi' }],
  ['ego_key', { key: 'Enter' }],
  ['ego_upload', { selector: 'input', path: 'F:/x' }],
  ['ego_download', { triggerScript: 'dl()' }],
  ['ego_drag', { from: '#a', to: '#b' }],
  ['ego_check', { selector: '#c' }],
  ['ego_select', { selector: 'select', value: '1' }],
  ['ego_dialog', { accept: true }],
  ['ego_login_import', { domains: ['x.com'] }],
  ['ego_auth_flush', {}],
  ['ego_space_open', { name: 'default' }],
  ['ego_space_close', { name: 'default' }],
];
let egoDenyOk = 0;
for (const [tool, args] of egoCases) {
  if (denied(guard({ name: tool, callId: `e-${tool}`, arguments: args, agent: { id: EGO } }))) egoDenyOk += 1;
}
check('T15', `B: ego_* 执行族 ${egoDenyOk}/${egoCases.length} 个在未派发会话全部被拒`,
  egoDenyOk === egoCases.length, `实际拒 ${egoDenyOk}`);
const egoResearch = ['ego_http', 'ego_navigate', 'ego_snapshot', 'ego_read_element', 'ego_page_info'];
let egoResOk = 0;
for (const tool of egoResearch) {
  if (denied(guard({ name: tool, callId: `r-${tool}`, arguments: { url: 'https://x' }, agent: { id: EGO } }))) egoResOk += 1;
}
check('T16', `B: ego_* 取数族 ${egoResOk}/${egoResearch.length} 个在未派发会话全部被拒`,
  egoResOk === egoResearch.length, `实际拒 ${egoResOk}`);
const navDenyMsg = guard({ name: 'ego_navigate', callId: 'r-msg', arguments: { url: 'https://x' }, agent: { id: EGO } });
check('T17', 'B: ego_navigate 的拒绝话术按「查资料」分支提示（归类正确）',
  typeof navDenyMsg === 'string' && navDenyMsg.includes('查资料'), String(navDenyMsg).slice(0, 60));
check('T18', 'B: 未来新增的 ego_some_future_tool 也被前缀默认兜住（不再漏网）',
  denied(guard({ name: 'ego_some_future_tool', callId: 'f1', arguments: {}, agent: { id: EGO } })));
check('T19', 'B: 非 ego 的名单外工具（如 novel_export）不受牵连（不拦）',
  allowed(guard({ name: 'novel_export', callId: 'n1', arguments: { book: 'x' }, agent: { id: EGO } })));
// 真派发过的会话（FAKE 已在 T14 真派发解锁）→ ego_* 放行（条件⑥语义不变）
check('T20', 'B: 真派发过的会话 ego_script / ego_navigate 放行（监控但不封死正常工作）',
  allowed(guard({ name: 'ego_script', callId: 'u1', arguments: { script: '1' }, agent: { id: FAKE } }))
  && allowed(guard({ name: 'ego_navigate', callId: 'u2', arguments: { url: 'https://x' }, agent: { id: FAKE } })));

// ════════════ 第四组【修 D + 举证式】SELF-DO 位置边界（v10 改写说明见文件头）════════════
// 前言：SELFDO 会话顶部已注入一次【失败】派发尝试（dispatchFailed=1），
// 故本组 = 「举证式下的关键参数位置边界」：marker 位置对，放行；正文藏 marker，仍拦。
check('T21', 'D: pwsh 命令里含 SELF-DO: 放行（命令本体是关键参数，会话有失败尝试 → 举证 ②-c）',
  allowed(guard(pwshExec(SELFDO, 'Get-Date # SELF-DO: 边界自测'))));
check('T22', 'D: write 的 content 里藏 SELF-DO: → 仍被拦（正文不查）',
  denied(guard({ name: 'write', callId: 'w1', arguments: { file_path: 'F:\\x\\ok.txt', content: 'SELF-DO: 想藏在正文里混过去' }, agent: { id: SELFDO } })));
check('T23', 'D: edit 的 new_string 里藏 SELF-DO: → 仍被拦',
  denied(guard({ name: 'edit', callId: 'e1', arguments: { file_path: 'F:\\x\\ok.txt', old_string: 'a', new_string: 'SELF-DO: 混进来' }, agent: { id: SELFDO } })));
check('T24', 'D: write 的 file_path 含 SELF-DO: → 放行（关键参数本体豁免，与 v7 行为一致）',
  allowed(guard({ name: 'write', callId: 'w2', arguments: { file_path: 'F:\\x\\SELF-DO: 标注.txt', content: 'normal' }, agent: { id: SELFDO } })));
check('T25', 'D: 其他工具（web_search.query）含 SELF-DO: → 放行（摘要类参数仍认）',
  allowed(guard({ name: 'web_search', callId: 's1', arguments: { queries: ['x SELF-DO: 用户明确要求自查'] }, agent: { id: SELFDO } })));

// ════════════ 第五组 v7 回归（继承不回退）════════════
check('T26', '回归: workflow（委派工具）放行', allowed(guard({ name: 'workflow', callId: 'wg1', arguments: { prompt: 'x' }, agent: { id: BASE } })));
check('T27', '回归: read / grep / glob（翻文件）不拦',
  ['read', 'grep', 'glob'].every((t) => allowed(guard({ name: t, callId: `rd-${t}`, arguments: { file_path: 'x' }, agent: { id: BASE } }))));

// v7 缺陷④：权威子代理事件精确豁免
ctx.emit('subagent/start', { runId: 'run-1', provider: 'selftest', id: 'selftest10-CHILD', local: true });
check('T28', '回归: subagent/start 识别的子代理会话放行',
  allowed(guard(pwshExec('selftest10-CHILD', 'Get-Process'))));
ctx.emit('workflow/agent-start', { seq: 1 }, { seq: 1, label: 'worker', childId: 'selftest10-WF-CHILD' });
check('T29', '回归: workflow/agent-start 识别的子会话放行',
  allowed(guard(pwshExec('selftest10-WF-CHILD', 'Get-Process'))));

// v7 缺陷③/①：workflow 失败不计 dispatch；成功才计
ctx.emit('tools/result', { name: 'workflow', callId: 'wf-fail', arguments: {}, agent: { id: 'selftest10-WF' } }, { isError: true, error: { message: 'x' } });
check('T30', '回归: workflow 失败不计 dispatch → 该会话仍拒',
  denied(guard(pwshExec('selftest10-WF', 'Get-Process'))));
ctx.emit('tools/result', { name: 'workflow', callId: 'wf-ok', arguments: {}, agent: { id: 'selftest10-WF' } }, { isError: false, value: {} });
check('T31', '回归: workflow 成功计 dispatch → 该会话解锁',
  allowed(guard(pwshExec('selftest10-WF', 'Get-Process'))));

// v7 缺陷⑤：兜底窗 per-agent，不跨会话外溢
check('T32', '回归: A 会话刚派发，手动新会话不享受兜底窗',
  denied(guard(pwshExec('selftest10-MANUAL', 'Get-Process'))));

// ════════════ 第六组 v7/v8 对照（复现缺陷，证明 v8/v9/v10 修掉了）════════════
let v7 = null;
try {
  const v7mod = await import(new URL('../gate-v7/index.js', import.meta.url).href);
  const ctx7 = makeCtx();
  v7mod.apply(ctx7, { enforce: true });
  const g7 = ctx7.guardFn();
  if (typeof g7 === 'function') {
    v7 = g7;
  }
} catch (e) {
  skip('CMP', 'v7/v8 对照', `无法加载 gate-v7（${String(e?.message ?? e).slice(0, 80)}）`);
}
if (v7) {
  const c1v7 = v7(pwshExec('selftest9-CMP', 'node --version # model-hub.mjs'));
  const c1v8 = guard(pwshExec('selftest9-CMP', 'node --version # model-hub.mjs'));
  check('CMP1', `对照A: node --version # model-hub.mjs → v7=${allowed(c1v7) ? 'ALLOW(缺陷复现)' : 'DENY'} / v10=${denied(c1v8) ? 'DENY' : 'ALLOW!'}`,
    allowed(c1v7) && denied(c1v8), `v7:${typeof c1v7} v10:${typeof c1v8}`);

  const c2v7 = v7(pwshExec('selftest9-CMP', 'node code-search.mjs "model-hub.mjs"'));
  const c2v8 = guard(pwshExec('selftest9-CMP', 'node code-search.mjs "model-hub.mjs"'));
  check('CMP2', `对照A/C: node code-search.mjs "model-hub.mjs" → v7=${allowed(c2v7) ? 'ALLOW(缺陷复现)' : 'DENY'} / v10=${denied(c2v8) ? 'DENY' : 'ALLOW!'}`,
    allowed(c2v7) && denied(c2v8), `v7:${typeof c2v7} v10:${typeof c2v8}`);

  const wargs = { file_path: 'F:\\x\\ok.txt', content: 'SELF-DO: 正文里藏标记' };
  const c3v7 = v7({ name: 'write', callId: 'c3', arguments: wargs, agent: { id: 'selftest9-CMP' } });
  const c3v8 = guard({ name: 'write', callId: 'c3b', arguments: wargs, agent: { id: 'selftest9-CMP' } });
  check('CMP3', `对照D: write.content 藏 SELF-DO: → v7=${allowed(c3v7) ? 'ALLOW(缺陷复现)' : 'DENY'} / v10=${denied(c3v8) ? 'DENY' : 'ALLOW!'}`,
    allowed(c3v7) && denied(c3v8), `v7:${typeof c3v7} v10:${typeof c3v8}`);

  const c4v7 = v7({ name: 'ego_script', callId: 'c4', arguments: { script: '1' }, agent: { id: 'selftest9-CMP' } });
  const c4v8 = guard({ name: 'ego_script', callId: 'c4b', arguments: { script: '1' }, agent: { id: 'selftest9-CMP' } });
  check('CMP4', `对照B: ego_script 未派发 → v7=${allowed(c4v7) ? 'ALLOW(缺陷复现·后门)' : 'DENY'} / v10=${denied(c4v8) ? 'DENY' : 'ALLOW!'}`,
    allowed(c4v7) && denied(c4v8), `v7:${typeof c4v7} v10:${typeof c4v8}`);
}

// ════════════ 第七组 计数与落账（次要 · 【运维3】读不到日志则 SKIP）════════════
const ACC = 'selftest10-ACC';
ctx.emit('tools/result', { name: 'ego_script', callId: 'a1', arguments: { script: '1' }, agent: { id: ACC } }, { isError: false, value: {} });
ctx.emit('tools/result', { name: 'ego_navigate', callId: 'a2', arguments: { url: 'https://x' }, agent: { id: ACC } }, { isError: false, value: {} });
ctx.emit('tools/result', pwshExec(ACC, 'node model-hub.mjs usage --days 1', 'a3'), { isError: false, value: {} });
ctx.emit('agent/status', { agent: { id: ACC }, status: 'idle' });

const logReadable = LOG_FILE && existsSync(LOG_FILE);
if (logReadable) {
  const logText = readFileSync(LOG_FILE, 'utf8');
  const accReport = logText.split('\n').filter((l) => l.includes('selftest10-ACC') && l.includes('idle 汇报')).pop() ?? '';
  check('T33', '计数: idle 汇报 派发1·自办1·直查资料1（ego_script→自办, ego_navigate→直查, 修B归类正确）',
    /派发 1 · 自办 1 · 直查资料 1/.test(accReport), accReport.trim().slice(-120));
} else {
  skip('T33', '计数: idle 汇报行核验', '日志文件不可读（运维3 预案，核心结论不受影响）');
}
const statsReadable = STATS_FILE && existsSync(STATS_FILE);
if (statsReadable) {
  const rows = readFileSync(STATS_FILE, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).filter((r) => r.agent === ACC);
  const kinds = rows.map((r) => r.kind).sort().join(',');
  check('T34', '计数: 账本 kind 全小写且为 dispatch,research,selfdo（可对账）',
    kinds === 'dispatch,research,selfdo', `实际: ${kinds}`);
} else {
  skip('T34', '计数: 账本 kind 核验', '账本文件不可读（运维3 预案）');
}

// ════════════ 第七组半【任务清单 g 固化】单条 usage 派发的组合断言 ════════════
const USAGE = 'selftest10-USAGE';
check('T35', 'g: node ...model-hub.mjs usage --days 1 在干净会话放行（ALLOW 部分）',
  allowed(guard(pwshExec(USAGE, 'node model-hub.mjs usage --days 1'))));
ctx.emit('tools/result',
  pwshExec(USAGE, 'node model-hub.mjs usage --days 1', 'call-usage-ok'),
  { isError: false, value: {} });
check('T36', 'g: usage 真派发成功后该会话解锁（计数→条件⑥，内存级证明 dispatch≥1）',
  allowed(guard(pwshExec(USAGE, 'Get-Process'))));
ctx.emit('agent/status', { agent: { id: USAGE }, status: 'idle' });
if (statsReadable) {
  const usageRows = readFileSync(STATS_FILE, 'utf8').trim().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .filter((r) => r.agent === USAGE);
  const usageKinds = usageRows.map((r) => r.kind).sort().join(',');
  check('T37', 'g: usage 单条派发在账本里恰好 1 行 dispatch（精确 ==1）',
    usageKinds === 'dispatch', `实际: ${usageKinds}`);
} else if (logReadable) {
  const usageReport = readFileSync(LOG_FILE, 'utf8').split('\n')
    .filter((l) => l.includes('selftest10-USAGE') && l.includes('idle 汇报')).pop() ?? '';
  check('T37', 'g: usage 单条派发的 idle 汇报恰好 派发1·自办0·直查资料0（精确 ==1）',
    /派发 1 · 自办 0 · 直查资料 0/.test(usageReport), usageReport.trim().slice(-120));
} else {
  skip('T37', 'g: usage 单条计数核验', '日志与账本均不可读（运维3 预案）');
}

// ════════════ 第八组【修的是遗留点①】拦截入账（kind:"blocked"）════════════
const BLOCKED = 'selftest10-BLOCKED';
check('T38', '遗留点①: 无派发时调用 pwsh 被拦（guard 拒绝）',
  denied(guard(pwshExec(BLOCKED, 'Get-Process'))));
if (statsReadable) {
  const blkRows = readFileSync(STATS_FILE, 'utf8').trim().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .filter((r) => r.agent === BLOCKED);
  const blk = blkRows.filter((r) => r.kind === 'blocked');
  check('T39', '遗留点①: 被拦调用在账本出现一条 kind:"blocked"（含 at/agent/tool/reason 字段）',
    blk.length === 1 && blk[0].tool === 'pwsh'
    && typeof blk[0].at === 'string' && typeof blk[0].reason === 'string' && blk[0].reason.length > 0,
    `实际 rows=${JSON.stringify(blkRows)}`);
  check('T40', '遗留点①: 被拦的调用不产生 selfdo/research 记录（虚高计数不回退）',
    blkRows.every((r) => r.kind === 'blocked'), `实际 kinds=${blkRows.map((r) => r.kind).join(',')}`);
} else {
  skip('T39', '遗留点①: blocked 账本核验', '账本不可读（运维3 预案）');
  skip('T40', '遗留点①: 被拦不入 selfdo 核验', '账本不可读（运维3 预案）');
}

// ════════════ 第九组【修的是遗留点②】子代理 idle 不判违规 ════════════
const CHILDIDLE = 'selftest10-CHILDIDLE';
ctx.emit('subagent/start', { runId: 'run-2', provider: 'selftest', id: CHILDIDLE, local: true });
ctx.emit('tools/result', { name: 'ego_script', callId: 'cid1', arguments: { script: '1' }, agent: { id: CHILDIDLE } }, { isError: false, value: {} });
ctx.emit('agent/status', { agent: { id: CHILDIDLE }, status: 'idle' });
const REALVIO = 'selftest10-REALVIO';
ctx.emit('tools/result', { name: 'ego_script', callId: 'rv1', arguments: { script: '1' }, agent: { id: REALVIO } }, { isError: false, value: {} });
ctx.emit('agent/status', { agent: { id: REALVIO }, status: 'idle' });
if (logReadable) {
  const childLine = readFileSync(LOG_FILE, 'utf8').split('\n')
    .filter((l) => l.includes('selftest10-CHILDIDLE') && l.includes('idle 汇报')).pop() ?? '';
  check('T41', '遗留点②: 子代理会话（已豁免）转 idle 不判「违规」（标注已豁免）',
    childLine.includes('子代理会话') && childLine.includes('已豁免') && !/—— 违规/.test(childLine),
    childLine.trim().slice(-120));
  const vioLine = readFileSync(LOG_FILE, 'utf8').split('\n')
    .filter((l) => l.includes('selftest10-REALVIO') && l.includes('idle 汇报')).pop() ?? '';
  check('T42', '遗留点②: 主会话零派发+自办 转 idle 仍判「违规」（真违规不放行）',
    /—— 违规/.test(vioLine), vioLine.trim().slice(-120));
} else {
  skip('T41', '遗留点②: 子代理 idle 不判违规核验', '日志不可读（运维3 预案）');
  skip('T42', '遗留点②: 主会话仍判违规核验', '日志不可读（运维3 预案）');
}

// ════════════ 第十组【修的是用户纪律：举证式 SELF-DO】（v10 新增）════════════
// 三通道：②-a perm（权限豁免） / ②-b tried=+reason=（结构化格式） / ②-c 记账（本会话有派发尝试）
const NOEVID = 'selftest10-NOEVID';       // 从未派发 + 纯声明 SELF-DO → 拒绝（fail-closed）
const FAILED = 'selftest10-FAILED';       // 有失败派发尝试 + SELF-DO 一句话 → 放行（记账通道）
const PERM = 'selftest10-PERM';           // 从未派发 + perm= → 放行（权限通道，设计决定见 fixes 文档）
const PERMEMPTY = 'selftest10-PERMEMPTY'; // 从未派发 + perm= 空值 → 拒绝（防后缀式滥写）
const FMT = 'selftest10-FMT';             // 从未派发 + tried= 与 reason= → 放行（格式通道）
const FMTMISS = 'selftest10-FMTMISS';     // 从未派发 + 只有 tried= 缺 reason= → 拒绝

check('T43', '举证式: 从未派发时写 SELF-DO: 随便一个理由 → 被拒（声明式→举证式）',
  denied(guard(pwshExec(NOEVID, 'Get-Process # SELF-DO: 随便一个理由'))));
check('T44', '举证式: 从未派发时写 SELF-DO: 我自己来（最典型绕过写法）→ 被拒',
  denied(guard(pwshExec(NOEVID, 'Get-Date # SELF-DO: 我自己来'))));

// 失败派发尝试入账（放 3）：先注入一次 workflow 失败
ctx.emit('tools/result', { name: 'workflow', callId: 'fail-att-1', arguments: { prompt: 'x' }, agent: { id: FAILED } }, { isError: true, error: { message: 'provider timeout' } });
check('T45', '举证式: 有过【失败】派发尝试后写 SELF-DO: 一句话理由 → 放行（记账通道 ②-c）',
  allowed(guard(pwshExec(FAILED, 'Get-Date # SELF-DO: 派过了但对方超时，降级自己来'))));

check('T46', '举证式: 从未派发但理由写 perm=pwsh（权限必须我执行）→ 放行（权限通道 ②-a）',
  allowed(guard(pwshExec(PERM, 'Get-Process # SELF-DO: perm=pwsh; reason=沙箱禁脚本spawn,只有主模型能用pwsh'))));
check('T47', '举证式: perm= 空值（无权限标识）→ 被拒（防后缀式滥写）',
  denied(guard(pwshExec(PERMEMPTY, 'Get-Process # SELF-DO: perm=; reason=x'))));

check('T48', '举证式: 从未派发但理由含 tried= 与 reason= → 放行（格式通道 ②-b）',
  allowed(guard(pwshExec(FMT, 'Get-Process # SELF-DO: tried=zhipu,modelscope; reason=plugin_manager权限仅主模型可用'))));
check('T49', '举证式: 只有 tried= 缺 reason= → 被拒（缺任一字段则拒绝）',
  denied(guard(pwshExec(FMTMISS, 'Get-Date # SELF-DO: tried=zhipu'))));

// 拒绝话术必须含可操作指引（放 2：fail-closed 且「告诉模型该怎么做」）
const noEvidMsg = guard(pwshExec(NOEVID, 'Get-Date # SELF-DO: 又试一次没带证据'));
check('T50', '举证式: 证据不足的拒绝话术含可操作指引（先真的派一次 + tried= + perm=）',
  typeof noEvidMsg === 'string'
  && noEvidMsg.includes('先真的派一次')
  && noEvidMsg.includes('tried=')
  && noEvidMsg.includes('perm=')
  && noEvidMsg.includes('本会话派发尝试：成功 0 · 失败 0'),
  String(noEvidMsg).slice(0, 120));

// 拒因分层（放 4）与失败入账（放 3）的账本断言
if (statsReadable) {
  const statAll = () => readFileSync(STATS_FILE, 'utf8').trim().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  const noevidRows = statAll().filter((r) => r.agent === NOEVID);
  check('T51', '举证式: 证据不足的 blocked 拒因是 selfdo-no-evidence（区别于 no-dispatch-record）',
    noevidRows.every((r) => r.kind === 'blocked' && r.reason === 'selfdo-no-evidence'),
    `实际=${JSON.stringify(noevidRows)}`);

  const failedRows = statAll().filter((r) => r.agent === FAILED);
  check('T52', '举证式: 失败派发尝试入账 kind:"dispatch-failed"（含错误摘要 reason 字段，放 3）',
    failedRows.some((r) => r.kind === 'dispatch-failed' && r.reason && r.reason.length > 0),
    `实际=${JSON.stringify(failedRows)}`);

  const permRows = statAll().filter((r) => r.agent === PERM);
  check('T53', '举证式: perm 通道放行留审计行 kind:"selfdo-permit" via=perm（且无 blocked）',
    permRows.some((r) => r.kind === 'selfdo-permit' && r.via === 'perm')
    && !permRows.some((r) => r.kind === 'blocked'),
    `实际=${JSON.stringify(permRows)}`);

  const fmtRows = statAll().filter((r) => r.agent === FMT);
  check('T54', '举证式: tried 通道放行留审计行 kind:"selfdo-permit" via=tried（格式证据可对账）',
    fmtRows.some((r) => r.kind === 'selfdo-permit' && r.via === 'tried'),
    `实际=${JSON.stringify(fmtRows)}`);
} else {
  skip('T51', '举证式: 拒因分层账本核验', '账本不可读（运维3 预案）');
  skip('T52', '举证式: dispatch-failed 入账核验', '账本不可读（运维3 预案）');
  skip('T53', '举证式: perm 通道审计行核验', '账本不可读（运维3 预案）');
  skip('T54', '举证式: tried 通道审计行核验', '账本不可读（运维3 预案）');
}

// ════════════ 第十一组【v10 可回滚性】requireDispatchEvidence=false 时声明式恢复 ════════════
// 保证 oem 迁移期/误伤时能把 v10 退回 v9 语义（config 开关，不是重新部署旧版）
const ctx2 = makeCtx();
apply(ctx2, { enforce: true, logDir: LOG_DIR ?? join(tmpdir(), 'gate-selftest-logs'), requireDispatchEvidence: false });
const guard2 = ctx2.guardFn();
check('T55', '回滚通道: requireDispatchEvidence=false 时任何 SELF-DO 理由都放行（v9 声明式语义可恢复）',
  typeof guard2 === 'function' && allowed(guard2(pwshExec('selftest10-FALLBACK', 'Get-Date # SELF-DO: 任意理由'))));

// ── 汇总 ──
console.log(results.join('\n'));
console.log(`\nLOGDIR: ${LOG_DIR ?? '（不可用，日志类断言已全 SKIP）'}`);
console.log(`合计：${pass} PASS / ${fail} FAIL / ${skipCnt} SKIP / 共 ${pass + fail + skipCnt} 项`);
console.log(fail === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(fail === 0 ? 0 : 1);