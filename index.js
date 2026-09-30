/**
 * 派发闸门（Dispatch Gate）v10
 *
 * v9 → v10 修正（修的是用户纪律：举证式 SELF-DO）：
 *
 *   G（核心缺陷）SELF-DO: 是「声明式」的 —— 放行条件②只要求关键参数本体里有
 *      `SELF-DO: <理由>` 字样就放行，**不检查是否真的试过派发**。
 *      模型可以随手写一句 `SELF-DO: 我自己来` 就绕过整个闸门，与用户纪律
 *      「必须派发再自做，你得确实收到其他模型全部无法完成或权限必须由你亲自
 *      执行的信息，你才能做」不符。
 *      【修 G】放行条件②升级为「举证式」，三通道证据，任一命中才放行：
 *        ②-a perm 通道（权限豁免，无需先派发）：理由含 `perm=<值>`（perm= 后必须
 *             跟随非空 token）或裸词 `privilege` → 放行。判据 = 用户明确认可的
 *             合法豁免 ① 跑本机命令（沙箱禁脚本 spawn，只有主模型能用 pwsh）与
 *             ② 高风险写操作（改配置/删文件/动 git）—— 这两类是「权限必须由我
 *             亲自执行」，不是能力降级，设计上不要求先派发失败。
 *         ②-b tried 通道（结构化格式 · 轻量证据）：理由同时含 `tried=<派给谁>` 与
 *             `reason=<对方为何干不了/为何必须你亲自来>`（缺任一 → 拒绝）→ 放行。
 *             这是「声明式」里唯一被接受的形态：理由必须自带证据标记，而不是
 *             一句随便的理由。
 *         ②-c 记账通道（行为证据 · 最硬）：本会话存在「派发尝试」—— 成功
 *             （stats.dispatch>0）或失败（stats.dispatchFailed>0，tools/result 里
 *             isError===true 的委派调用/真派发命令已入账 kind:"dispatch-failed"）
 *             —— → 放行。这条对应方向 1：闸门真的观察到「派过（无论成败）」，
 *             之后写 SELF-DO: <任意一句话理由> 即被接受。
 *         三者都不满足 → fail-closed 拒绝，拒因 = 'selfdo-no-evidence'，且拒绝话术
 *         必须包含可操作指引（先派一次 / 补 tried= 与 reason= / 写 perm=）。
 *
 *   H（入账）失败尝试也要入账（放 3）：tools/result 观察到委派类工具（workflow /
 *      subagent / subagent_fork / task_board_run）或解析式真派发命令以失败结束
 *      （isError===true）时，追加一条 { kind:"dispatch-failed", at, agent, tool,
 *      reason:<错误摘要> } 到 dispatch-stats.jsonl ——「试过了但没成」从此可被
 *      统计（node tools/model-hub.mjs gate 聚合后，未被现有 GATE_KINDS 认领的会
 *      落 other 兜底，需主模型同步，见 项目文档 第三节）。
 *      语义铁律：失败 ≠ 成功派发 —— 不 bump dispatch、不记 dispatchRoots、不更新
 *      兜底戳（失败后自办仍必须写 SELF-DO 显式声称降级，不能免费解锁）。
 *
 *   I（拒因分层，放 4）blocked 记录的 reason 区分：
 *      'no-dispatch-record' = 关键参数里根本没有 SELF-DO:（v9 语义保留，纯声明都
 *          没有）—— 对应「没试派发也不声称」；
 *      'selfdo-no-evidence' = 写了 SELF-DO: 但证据不足（无 perm / 无 tried=+reason= /
 *          本会话也无派发尝试记录）—— 对应「声称了但拿不出证据」；
 *      'guard-error' = fail-closed 异常（v9 语义保留）。
 *      对账口径：被拦量 = no-dispatch-record + selfdo-no-evidence + guard-error。
 *
 *   J（子代理豁免前移）v9 顺序是 ①派发 → ②marker → ③子代理。v10 必须把
 *      ③子代理豁免提到 SELF-DO 举证检查之前 —— 子代理没有派发能力（workflow
 *      不可嵌套），若让举证检查拦在豁免前面，子代理写一句 `SELF-DO: 随便理由`
 *      会被误拦（违反遗留点②「豁免口径一致」原则）。前置后：子代理会话的
 *      SELF-DO 是否写、写什么都由豁免兜底，不进入举证路径。
 *
 * v8 → v9 修正（保留，详见 gate-v9 头部注释）：
 *   E（遗留点①）拦截不入账 → guard 拒绝时追加 kind:"blocked" 记录
 *   F（遗留点②）子代理被误判"违规" → idle 汇报时 exemptAgents 内不判违规
 *
 * v7 → v8 修正（保留，详见 gate-v8 头部注释）：A/B/C/D 四绕过 + 运维陷阱。
 *
 * 守则（继承）：
 *   拦  自己动手 pwsh/write/edit ＋ ego_* 执行族 ｜ 自己查资料 web_search ／ argo 系 ／ read_page 等
 *       ＋ ego_* 取数族
 *   不拦 翻文件 read/grep/glob（用户明确要求）｜ 派发本身（解析式判据）
 *   放行 派发本身 ／ 举证式 SELF-DO（perm / tried=+reason= / 本会话有派发尝试）
 *        ／ 子代理会话（权威 id）／ 派发根调用 ／ per-agent 兜底窗（10s）／ 本会话已成功派发
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const inject = ['tools'];

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'local-dispatch-gate',
    validate: (value) => ({ value: value && typeof value === 'object' ? value : {} }),
  },
};

// 【运维3】日志目录可由 config.logDir 覆盖。
// 默认写入**系统临时目录**（跨平台），不写死绝对路径 —— 否则插件只能在本机跑，且会暴露作者目录结构。
const DEFAULT_LOG_DIR = join(tmpdir(), 'dispatch-gate');

function makeLoggers(dir) {
  const log = (msg) => {
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'dispatch-gate.log'), `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
    } catch { /* noop：沙箱写不进也不影响守卫逻辑（运维3） */ }
  };
  const statsAppend = (row) => {
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'dispatch-stats.jsonl'), JSON.stringify(row) + '\n', 'utf8');
    } catch { /* noop */ }
  };
  return { log, statsAppend };
}

// 【v7 缺陷① 语义保留】只取 pwsh 参数里的命令文本本体，绝不做 JSON 全文匹配
function pwshCommandText(args) {
  if (args && typeof args === 'object' && typeof args.command === 'string') return args.command;
  if (typeof args === 'string') return args; // 防御：个别调用路径直接传字符串
  return '';
}

// 双保险：echo 系开头 = 纯字符串输出场景，永远不算派发（v8 解析式判据本身已排除，
// 保留它是 defense-in-depth，与 v7 行为一致）。
const ECHO_LIKE_RE = /^\s*(&\s*)?(Write-Output|echo|Write-Host)\b/i;

// ════════════════════════════════════════════════════════════════════════
// 【修 A/C】解析式派发判据 —— 四步全为纯函数，selftest 可直接驱动单测
// ════════════════════════════════════════════════════════════════════════

// 第 1 步：按行去 PowerShell 注释 —— 引号外的 #（行首，或前一个字符是空白）之后丢弃。
function stripPsComments(cmd) {
  return String(cmd).split(/\r?\n/).map((line) => {
    let inS = false;
    let inD = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inS) { if (ch === "'") inS = false; continue; }
      if (inD) { if (ch === '"') inD = false; continue; }
      if (ch === "'") { inS = true; continue; }
      if (ch === '"') { inD = true; continue; }
      if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

// 第 2 步：把命令切成独立语句。PowerShell 的语句分隔符 = 换行 / ; / | / && / ||；
//   单个 & 是调用符不是分隔符（不进切分表，只在第 4 步容忍一个前导 &）。
function splitStatements(cmd) {
  return String(cmd).split(/\r?\n|;|\|\||&&|\|/);
}

// 第 3 步：shell-like 分词 —— 单/双引号内是一个 token；含引号成分的 token 标 quoted=true。
function tokenizeSegment(seg) {
  const tokens = [];
  let cur = '';
  let hasCur = false;
  let quoted = false;
  let inS = false;
  let inD = false;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (inS) { if (ch === "'") inS = false; else cur += ch; continue; }
    if (inD) { if (ch === '"') inD = false; else cur += ch; continue; }
    if (ch === "'") { inS = true; hasCur = true; quoted = true; continue; }
    if (ch === '"') { inD = true; hasCur = true; quoted = true; continue; }
    if (/\s/.test(ch)) {
      if (hasCur) { tokens.push({ text: cur, quoted }); cur = ''; hasCur = false; quoted = false; }
      continue;
    }
    cur += ch;
    hasCur = true;
  }
  if (hasCur) tokens.push({ text: cur, quoted });
  return tokens;
}

const NODE_RE = /^node(\.exe)?$/i;
// 附加硬化：node 的终止型旗标 —— 出现即打印/求值后退出，后面的 .mjs 参数不会被执行（零副作用）
const NODE_TERMINAL_FLAGS = new Set(['-v', '--version', '-e', '--eval', '-p', '--print', '-h', '--help']);

// 第 4 步：单段判据工厂。某段算「真派发」当且仅当：
//   · 第一个非引号 token 是 node / node.exe（容忍一个前导 & 调用符），且
//   · 后续某个【非引号】token 以 <关键词>.mjs 结尾（大小写不敏感，Windows 路径）；
//   · 或「脚本位」token 以 <关键词>.mjs 结尾 —— 兜底 node "F:\dir with space\model-hub.mjs"；
//   · 但若参数里出现终止型旗标 → 一票否决。
function makeSegmentChecker(suffixes) {
  return (segment) => {
    const tokens = tokenizeSegment(segment);
    let i = 0;
    if (tokens[i] && !tokens[i].quoted && tokens[i].text === '&') i++; // 沿用 v7：容忍前导 &
    const first = tokens[i];
    if (!first || first.quoted || !NODE_RE.test(first.text)) return false;

    let scriptToken = null;
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (!scriptToken && !t.text.startsWith('-')) scriptToken = t;
      if (t.quoted) continue; // 【修 A/C】引号内 token 不参与匹配
      const low = t.text.toLowerCase();
      if (NODE_TERMINAL_FLAGS.has(low)) return false; // 附加硬化：终止旗标 → 零副作用，不算派发
      for (const suf of suffixes) {
        if (low.endsWith(suf)) return true;
      }
    }
    if (scriptToken && scriptToken.quoted) {
      const low = scriptToken.text.toLowerCase();
      for (const suf of suffixes) {
        if (low.endsWith(suf)) return true; // 引号脚本位兜底（路径含空格的合法派发）
      }
    }
    return false;
  };
}

// 【修 D】SELF-DO: 只查关键参数本体，绝不做 JSON 全文匹配。
const BODY_FIELDS = ['content', 'old_string', 'new_string', 'text', 'body', 'code', 'html', 'markdown', 'data', 'prompt'];

function keyArgsText(name, args) {
  if (args == null) return '';
  if (typeof args === 'string') return args;
  if (typeof args !== 'object') return '';
  if (name === 'pwsh') return typeof args.command === 'string' ? args.command : '';
  if (name === 'write' || name === 'edit') {
    // 【修 D】只看关键参数 file_path；正文类字段（content/old_string/new_string）一概不查
    return typeof args.file_path === 'string' ? args.file_path : '';
  }
  const clone = { ...args };
  for (const k of BODY_FIELDS) delete clone[k];
  let s = '';
  try { s = JSON.stringify(clone) ?? ''; } catch { s = ''; }
  return s.slice(0, 200); // 摘要截断：豁免标记是短前缀，200 字符足够覆盖
}

// ════════════════════════════════════════════════════════════════════════
// 【修的是用户纪律：举证式 SELF-DO】结构化证据解析 —— 纯函数，selftest 可单测
// ════════════════════════════════════════════════════════════════════════

// 从 SELF-DO 理由（关键参数本体 keyText）里提取结构化证据字段：
//   perm=   权限型豁免标记：perm 后必须跟随非空 token（perm=pwsh / perm=high-risk），
//           空值 perm= 不算（防「SELF-DO: perm= 」这种后缀式滥写）。
//   tried=  方向 2 的证据标记：声明「派给过谁」，值取到空白/分隔符前（zhipu,modelscope 可逗号连写）。
//   reason= 方向 2 的第二个证据标记：声明「对方为何干不了/为何必须由你亲自来」，
//           值取到分号/换行/竖线前（允许中文，不含空格截断 —— 中文理由常见无空格）。
function parseSelfDoEvidence(keyText) {
  const text = String(keyText ?? '');
  const permMatch = /(?:^|[\s;|&,])(?:perm=)([^\s;|&]+)/i.exec(text); // perm= 后必须跟非空 token
  const triedMatch = /(?:^|[\s;|&,])(?:tried=)([^\s;|&]+)/i.exec(text);
  const reasonMatch = /(?:^|[\s;|&,])(?:reason=)([^;\n|&]*)/i.exec(text);
  const reason = reasonMatch && reasonMatch[1] && reasonMatch[1].trim() ? reasonMatch[1].trim() : null;
  return {
    perm: permMatch && permMatch[1] && permMatch[1].length > 0 ? permMatch[1].toLowerCase() : null,
    tried: triedMatch && triedMatch[1] && triedMatch[1].length > 0 ? triedMatch[1] : null,
    reason,
  };
}

// 提错误摘要（入账 kind:"dispatch-failed" 时用，最多 120 字符）
function errBrief(result) {
  const e = result?.error;
  if (e == null) return 'no-error-detail';
  if (typeof e === 'string') return e.slice(0, 120);
  if (typeof e === 'object' && e != null && typeof e.message === 'string') return e.message.slice(0, 120);
  try { return JSON.stringify(e).slice(0, 120); } catch { return 'unknown-error'; }
}

// ════════════════════════════════════════════════════════════════════════

export function apply(ctx, config) {
  const cfg = {
    enforce: true,
    exemptMarker: 'SELF-DO:',
    workTools: ['pwsh', 'write', 'edit'],
    // 【修 B】ego_* 取数据类显式归 researchTools（显式名单优先于前缀默认）：
    researchTools: [
      'web_search', 'web_fetch', 'argo_search', 'argo_fetch',
      'read_page', 'x_search', 'wide_research',
      'ego_http', 'ego_navigate', 'ego_snapshot', 'ego_read_element', 'ego_page_info',
    ],
    // 【修 B】前缀默认归类：ego_ 开头的其余工具默认按执行类（workTools）监控。
    workToolPrefixes: ['ego_'],
    delegationTools: ['workflow', 'subagent', 'subagent_fork', 'task_board_run'],
    // 【修 A/C】v8 语义 = .mjs 后缀关键词
    dispatchPatterns: ['model-hub'],
    subagentGraceMs: 10000,   // v7 缺陷⑤语义保留：per-agent 兜底窗
    guardFailClosed: true,
    logDir: DEFAULT_LOG_DIR,  // 【运维3】selftest 传临时目录覆盖，不依赖真实日志
    // 【修的是用户纪律：举证式 SELF-DO】v10 新增配置（放 4 引用的调参入口）：
    requireDispatchEvidence: true, // true=SELF-DO 举证式（v10 默认）；false=退回 v9 声明式（任何理由都放行）
    permKeywords: ['perm=', 'privilege'], // ②-a 权限豁免通道的关键词（跑本机命令/高风险写操作专用）
    ...(config ?? {}),
  };

  const { log, statsAppend } = makeLoggers(cfg.logDir ?? DEFAULT_LOG_DIR);

  // 【修 A/C】把 dispatchPatterns 预编译成小写 .mjs 后缀（Windows 路径大小写不敏感）。
  const DISPATCH_SUFFIXES = (cfg.dispatchPatterns ?? []).map((k) => `${String(k).toLowerCase()}.mjs`);
  const segmentIsDispatch = makeSegmentChecker(DISPATCH_SUFFIXES);

  const WORK = new Set(cfg.workTools);
  const RESEARCH = new Set(cfg.researchTools);
  const PREFIXES = (cfg.workToolPrefixes ?? []).map((p) => String(p).toLowerCase());
  const DELEGATION = new Set(cfg.delegationTools);
  // 【修的是用户纪律：举证式 SELF-DO】权限豁免关键词集合（②-a 通道；默认 perm= 与 privilege）
  const PERM_KEYWORDS = (cfg.permKeywords ?? ['perm=', 'privilege']).map((k) => String(k).toLowerCase());

  // 【修 B】工具归类：research 显式名单 > work 显式名单 > workToolPrefixes 前缀默认（work）。
  const classifyTool = (name) => {
    const n = String(name ?? '');
    if (RESEARCH.has(n)) return 'research';
    if (WORK.has(n)) return 'work';
    const low = n.toLowerCase();
    if (PREFIXES.some((p) => low.startsWith(p))) return 'work'; // 前缀默认 → 执行类（保守）
    return null;
  };
  const isGuarded = (name) => classifyTool(name) !== null;

  // 【修 A/C】派发命令判据：pwsh 命令本体 → 去注释 → 分段 → 任一段命中解析式判据。
  const isDispatchCommand = (name, args) => {
    if (name !== 'pwsh') return false;
    const cmd = pwshCommandText(args);
    if (!cmd) return false;
    if (ECHO_LIKE_RE.test(cmd)) return false; // 双保险（v7 语义保留）
    return splitStatements(stripPsComments(cmd)).some(segmentIsDispatch);
  };

  // guard 放行判据（① 派发本身）：委派工具直接算；pwsh 走解析式命令判据
  const isDispatchByTool = (name, args) => DELEGATION.has(name) || isDispatchCommand(name, args);

  log(
    `apply() v10 · work显式=[${[...WORK].join(',')}] + 前缀=[${[...PREFIXES].join(',')}]（修B）` +
    ` · research=[${[...RESEARCH].join(',')}] · 委派=[${[...DELEGATION].join(',')}]` +
    ` · 派发后缀=${DISPATCH_SUFFIXES.join(' | ')}（修A/C解析式）` +
    ` · 兜底窗(per-agent)=${cfg.subagentGraceMs}ms` +
    ` · 举证式SELF-DO=${cfg.requireDispatchEvidence ? 'ON（perm/tried/记账三通道）' : 'OFF（v9 声明式回退）'}` +
    ` · perm关键词=[${PERM_KEYWORDS.join(',')}]`,
  );

  const stats = new Map();        // agentId(string) -> {dispatch, selfdo, research, dispatchFailed}
  const exemptAgents = new Set(); // v7 缺陷④语义保留：只由权威事件填充
  const dispatchRoots = [];       // FIFO，见 ROOTS_CAP
  const lastDispatchAtByAgent = new Map(); // v7 缺陷⑤语义保留：per-agent 兜底时间戳

  const ROOTS_CAP = 200; // dispatchRoots 上限，防内存泄漏

  const bump = (id, key) => {
    const s = stats.get(id) ?? { dispatch: 0, selfdo: 0, research: 0, dispatchFailed: 0 };
    s[key] += 1;
    stats.set(id, s);
    return s;
  };

  const addRoot = (callId) => {
    if (!callId) return;
    dispatchRoots.push(callId);
    while (dispatchRoots.length > ROOTS_CAP) dispatchRoots.shift();
  };

  // ── 【修的是遗留点①】被拦记录（kind:"blocked"）──────────────
  //   v10 扩展：extra 对象可并入账本行（举证式拒绝时附 tried/reason 提取值等证据）。
  //   语义铁律保持：blocked 永远不 bump selfdo/research —— 虚高计数问题不回退。
  const recordBlocked = (toolName, agentId, reason, extra = null) => {
    try {
      statsAppend({
        at: new Date().toISOString(),
        agent: agentId ?? 'unknown',
        tool: toolName ?? 'unknown',
        kind: 'blocked',             // 【修的是遗留点①】被拦这一类
        reason,                       // 【放 4】拒因分层：no-dispatch-record / selfdo-no-evidence / guard-error
        ...(extra ?? {}),             // 【举证式】可附 evidence 字段（v10 新增，可选）
      });
    } catch { /* noop：落盘失败不影响守卫本身 */ }
  };

  ctx.effect(() => {
    const disposers = [];

    // ── 0) 委派类工具开跑 → 记日志 + 给「当前会话」发 per-agent 兜底戳 ─────────
    disposers.push(
      ctx.on('tools/pre-execute', (exec, next) => {
        try {
          if (DELEGATION.has(String(exec?.name ?? ''))) {
            const aid = exec?.agent?.id != null ? String(exec.agent.id) : '';
            if (aid) lastDispatchAtByAgent.set(aid, Date.now());
            log(`委派开跑：${exec?.name}（会话 ${aid}；子代理豁免等待权威事件 subagent/start）`);
          }
        } catch (e) {
          log(`pre-execute 异常: ${e?.message ?? e}`);
        }
        return next();
      }),
    );

    // ── 0b) 权威子代理事件：subagent/start 直接给出子会话 SessionId ────────────
    disposers.push(
      ctx.on('subagent/start', (info) => {
        try {
          const id = info?.id;
          if (!id) return;
          exemptAgents.add(String(id));
          log(`subagent/start → 精确豁免子代理会话 ${id}（provider=${info?.provider ?? '?'}）`);
        } catch (e) {
          log(`subagent/start 异常: ${e?.message ?? e}`);
        }
      }),
    );

    // ── 0c) workflow 的 agent() 建立子运行时也直接给出 childId ─────────────────
    disposers.push(
      ctx.on('workflow/agent-start', (info, agentInfo) => {
        try {
          const childId = agentInfo?.childId;
          if (!childId) return;
          exemptAgents.add(String(childId));
          log(`workflow/agent-start → 精确豁免 workflow 子会话 ${childId}（label=${agentInfo?.label ?? '?'}）`);
        } catch (e) {
          log(`workflow/agent-start 异常: ${e?.message ?? e}`);
        }
      }),
    );

    // ── 1) 观察 + 统计（isError === false 才计数成功；被拒调用不计）───────────────
    disposers.push(
      ctx.on('tools/result', (exec, result) => {
        try {
          const id = exec?.agent?.id != null ? String(exec.agent.id) : 'unknown';
          const name = String(exec?.name ?? '');
          const args = exec?.arguments;
          const at = new Date().toISOString();

          const ok = result?.isError === false;
          if (!ok) {
            // 【修的是用户纪律：举证式 SELF-DO（放 3）】失败尝试也要入账 ——
            //   委派工具（workflow/subagent/subagent_fork/task_board_run）或解析式真派发命令
            //   以失败结束（isError===true）→ 追加 kind:"dispatch-failed" 行 + 内存计数
            //   dispatchFailed。「试过了但没成」从此可被统计；语义铁律：失败 ≠ 成功派发 ——
            //   不 bump dispatch、不记 dispatchRoots（失败后自办仍必须写 SELF-DO 显式声称）。
            if (isDispatchByTool(name, args)) {
              bump(id, 'dispatchFailed');
              statsAppend({
                at,
                agent: id,
                tool: name,
                kind: 'dispatch-failed',   // 【放 3】失败尝试类别
                reason: errBrief(result),   // 错误摘要，便于审计「为什么失败了」
              });
              log(`派发失败 +1（尝试已入账，不视为成功派发）· ${name} · 会话 ${id} · ${errBrief(result)}`);
            }
            return;
          }

          if (isDispatchByTool(name, args)) {
            // 【修 A/C】计数与放行解耦（v7 语义保留）：只有「解析式判据命中 + 真正执行成功」
            //   才 dispatch += 1 → 假派发（注释带词 / 引号搜索词）在这里也进不了计数。
            bump(id, 'dispatch');
            lastDispatchAtByAgent.set(id, Date.now());
            addRoot(exec?.callId);
            log(`派发 +1 · ${name} · 会话 ${id}`);
            statsAppend({ at, agent: id, tool: name, kind: 'dispatch' });
            return;
          }
          const cls = classifyTool(name); // 【修 B】按归类函数计数（含 ego_ 前缀默认）
          if (cls === 'research') {
            bump(id, 'research');
            statsAppend({ at, agent: id, tool: name, kind: 'research' });
            return;
          }
          if (cls === 'work') {
            bump(id, 'selfdo');
            statsAppend({ at, agent: id, tool: name, kind: 'selfdo' });
          }
        } catch (e) {
          log(`tools/result 异常: ${e?.message ?? e}`);
        }
      }),
    );

    // ── 2) 守卫 ──────────────────────────────────────────────────────────────
    disposers.push(
      ctx.tools.guard((exec) => {
        let name = 'unknown';
        try {
          if (!cfg.enforce) return undefined;
          name = String(exec?.name ?? '');
          if (!isGuarded(name)) return undefined; // 【修 B】归类函数判定（含 ego_ 前缀默认）

          const args = exec?.arguments;
          const keyText = keyArgsText(name, args); // 【修 D】关键参数本体，非 JSON 全文
          const agentId = exec?.agent?.id != null ? String(exec.agent.id) : undefined;

          if (isDispatchByTool(name, args)) return undefined;            // ① 派发本身（【修 A/C】解析式判据）

          // 【修 J（举证式前置）】子代理会话豁免提到 SELF-DO 举证检查【之前】 ——
          //   子代理没有派发能力（workflow 不可嵌套），若让举证检查拦在豁免前面，
          //   子代理写一句 `SELF-DO: 随便理由` 会被误拦，破坏遗留点②「豁免口径一致」。
          if (agentId && exemptAgents.has(agentId)) return undefined;    // ③ 子代理会话（权威 id 精确豁免）

          // 【修的是用户纪律：举证式 SELF-DO】条件②升级：
          //   v9 只要 keyText 含 marker 就放行（声明式）；v10 必须举证（三通道）——
          //   证据不满足 → 拒绝，拒因 selfdo-no-evidence，拒绝话术含可操作指引。
          const hasMarker = keyText.includes(cfg.exemptMarker);
          // 【回滚通道 · 修 T55】requireDispatchEvidence=false → 回到 v9 声明式语义：
          //   写了 SELF-DO: 即放行，不要求任何证据 —— 给运维留的紧急回退通道
          //   （迁移期/误伤锁死时，config 一键退回 v9 语义，无需重新部署旧版）。
          if (hasMarker && !cfg.requireDispatchEvidence) return undefined;
          if (hasMarker && cfg.requireDispatchEvidence) {
            const ev = parseSelfDoEvidence(keyText);
            const stat = agentId ? stats.get(agentId) : undefined;
            const sOk = stat?.dispatch ?? 0;
            const sFailed = stat?.dispatchFailed ?? 0;
            // ②-a 权限豁免通道：perm=<非空值> 或裸词 privilege → 「权限必须由我亲自执行」
            //   （跑本机命令 / 高风险写操作），无需先派发 —— 用户明确认可的三类合法豁免前两类。
            const byPerm = ev.perm !== null || keyText.toLowerCase().includes('privilege');
            // ②-b 结构化格式通道：tried= 与 reason= 缺任一 → 拒绝（方向 2，轻量证据）
            const byFormat = ev.tried !== null && ev.reason !== null;
            // ②-c 记账通道：本会话存在派发尝试（成功或失败）→ 任意一句话理由即放行（方向 1，行为证据）
            const byAttempt = sOk > 0 || sFailed > 0;

            if (byPerm || byFormat || byAttempt) {
              // 命中举证：记一条豁免使用账（perm/tried 通道是「凭格式放行」，留痕便于审计）
              const via = byPerm ? 'perm' : byFormat ? 'tried' : 'attempt';
              statsAppend({
                at: new Date().toISOString(),
                agent: agentId ?? 'unknown',
                tool: name,
                kind: 'selfdo-permit',     // v10 新增：举证式放行的审计行
                via,                        // perm | tried | attempt
                evidence: byPerm
                  ? `perm=${ev.perm ?? 'privilege'}`
                  : byFormat
                    ? `tried=${ev.tried}; reason=${ev.reason}`
                    : `attempts(ok=${sOk},failed=${sFailed})`,
              });
              log(`SELF-DO 举证放行（via=${via}）· ${name} · 会话 ${agentId ?? 'unknown'} · evidence=${JSON.stringify(ev)}`);
              return undefined;
            }

            // 证据不足 → fail-closed 拒绝（放 4：拒因 selfdo-no-evidence，区别于没写 marker 的
            //   no-dispatch-record）。被拦调用仍不计入 selfdo/research（虚高计数不回退）。
            recordBlocked(name, agentId, 'selfdo-no-evidence', {
              evidence: {
                perm: ev.perm,
                tried: ev.tried,
                reason: ev.reason ?? undefined,
                attempts: { ok: sOk, failed: sFailed },
              },
            });
            const isResearch = classifyTool(name) === 'research'; // 【修 B】按归类给提示
            return [
              `【派发闸门】SELF-DO: 举证不足，拒绝执行 ${name}。（本会话派发尝试：成功 ${sOk} · 失败 ${sFailed}）`,
              '',
              `你写了 ${cfg.exemptMarker}，但闸门未发现「确实试过派发」或「权限必须由你亲自执行」的证据 —— 这是 v10 的举证式纪律。`,
              '',
              '合格写法（三选一）：',
              isResearch
                ? '  A) 先真的派一次：workflow + agent("用 web_search 查 <问题> 并汇总", {provider, model})，成功或失败都算尝试，之后写 SELF-DO: <一句话理由> 即放行'
                : '  A) 先真的派一次：workflow + agent(prompt, {provider, model})，或直接用你的多模型调度脚本扇出（例如 `node <你的脚本>.mjs fanout --in <材料> --task <类型>`）。成功或失败都算尝试，之后写 SELF-DO: <一句话理由> 即放行',
              '  B) 理由里写明结构化证据（tried= 与 reason= 缺一不可）：',
              `     ${cfg.exemptMarker} tried=<派给了谁，如 zhipu,modelscope>; reason=<对方为何干不了/为何必须你来>`,
              '  C) 这是权限型自办（跑本机命令/高风险写操作/改配置/删文件/动 git）→ 写明权限通道：',
              `     ${cfg.exemptMarker} perm=<pwsh|high-risk|privilege>; reason=<为何权限只在你手里>`,
              '',
              '请把活派出去、补全举证字段，或写明权限原因后再重试（不要原文重复试）。',
            ].join('\n');
          }

          const root = exec?.rootCallId;
          if (root && dispatchRoots.includes(root)) return undefined;    // ④ 派发根调用
          const lastAt = agentId ? (lastDispatchAtByAgent.get(agentId) ?? 0) : 0;
          if (Date.now() - lastAt < cfg.subagentGraceMs) return undefined; // ⑤ 短兜底窗（per-agent）
          const s = agentId ? stats.get(agentId) : undefined;
          if (s && s.dispatch > 0) return undefined;                     // ⑥ 本会话已成功派发（【修 A】假派发不再解锁）

          log(`拦截 ${name}（会话 ${agentId ?? 'unknown'} 无派发记录）`);
          // 【修的是遗留点①】拦截入账：每次 guard 拒绝都追加一条 kind:"blocked" 记录。
          recordBlocked(name, agentId, 'no-dispatch-record');
          const isResearch = classifyTool(name) === 'research'; // 【修 B】按归类给提示
          return [
            `【派发闸门】本会话还没有任何派发记录，拒绝执行 ${name}。`,
            '',
            isResearch ? '查资料也要派 —— 别的模型一样能查，让它们查完汇总给你：' : '先派发，再动手：',
            '  A) 文本类任务：用你的多模型调度脚本扇出（例如 `node <你的脚本>.mjs fanout --in <材料> --task <类型>`）',
            isResearch
              ? '  B) 查资料：workflow + agent("用 web_search 查 <问题> 并汇总", {provider, model})'
              : '  B) 动手类任务：workflow + agent(prompt, {provider, model})',
            '     （provider/model 白名单见 tools/QUOTA-LIMITS.md；ego_* 工具族已全部纳入监控）',
            '',
            `确实必须由你亲自执行时，在关键参数里写明： ${cfg.exemptMarker} <举证理由>` +
            '（v10 要求举证：先派过一次，或写 perm=，或写 tried= 与 reason=）',
          ].join('\n');
        } catch (e) {
          log(`guard 异常（${name}）: ${e?.message ?? e}`);
          // fail-closed：异常不得成为绕过通道 —— 同样记 blocked（拒因=guard-error）
          recordBlocked(name, exec?.agent?.id != null ? String(exec.agent.id) : undefined, 'guard-error');
          return cfg.guardFailClosed
            ? `【派发闸门】守卫内部异常，按保守策略拒绝执行 ${name}。详见 tools/archive/dispatch-gate.log`
            : undefined;
        }
      }),
    );

    // ── 3) 会话转 idle 时的强制汇报（v7 缺陷②语义保留：真实总线事件 agent/status）──
    disposers.push(
      ctx.on('agent/status', (payload) => {
        try {
          if (payload?.status !== 'idle') return;
          const id = payload?.agent?.id;
          if (!id) return;
          const key = String(id);
          const s = stats.get(key) ?? { dispatch: 0, selfdo: 0, research: 0, dispatchFailed: 0 };
          // 【修的是遗留点②】子代理会话（exemptAgents 内）不做「零派发却自己动手」的违规判定。
          const isExemptSubagent = exemptAgents.has(key);
          // 【举证式】idle 汇报追加第四段「派发失败 N」（仅计数展示，账本/统计口径不变；
          //   沿用 v9 的三段前缀格式，追加尾巴不破坏既有断言的部分匹配）。
          const verdict =
            isExemptSubagent
              ? (s.dispatch === 0 && (s.selfdo > 0 || s.research > 0)
                  ? '子代理会话（已豁免，不适用违规判定）'
                  : '子代理会话（已豁免）')
              : s.dispatch === 0 && (s.selfdo > 0 || s.research > 0)
                ? '⚠️ 零派发却自己动手/自己查 —— 违规'
                : s.dispatch > 0 ? '✅ 有派发' : '（本回合无动作）';
          log(`[派发闸门][idle 汇报] 会话 ${key} 累计：派发 ${s.dispatch} · 自办 ${s.selfdo} · 直查资料 ${s.research} · 派发失败 ${s.dispatchFailed} —— ${verdict}`);
        } catch (e) {
          log(`agent/status 异常: ${e?.message ?? e}`);
        }
      }),
    );

    log(`已注册 ${disposers.length} 个注册项`);
    return () => {
      for (const d of disposers) { try { d?.(); } catch { /* noop */ } }
      log('已卸载');
    };
  });

  ctx.effect(() =>
    ctx.on('agent/disposed', (payload) => {
      try {
        const id = payload?.agent?.id;
        if (id) {
          const key = String(id);
          stats.delete(key);
          exemptAgents.delete(key);
          lastDispatchAtByAgent.delete(key);
        }
      } catch { /* noop */ }
    }),
  );

  log('apply() 完成');
}