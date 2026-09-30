# 派发闸门 (Dispatch Gate) · DSH 插件

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.1.7-blue.svg)](https://github.com/deepseek-ai)

> ## ⚠️ 装之前必须知道：**本插件会拦截你的工具调用**
>
> 启用后，只要某个会话「**还没有任何派发记录**」，它就**无法执行**：
> `pwsh` · `write` · `edit` · `ego_*` 执行族 · 以及 `web_search` 等查资料工具。
>
> **这不是 bug，这就是本插件的全部意义** —— 逼 AI 先把活派给别的模型，再自己动手。
>
> | 你的情况 | 怎么办 |
> |---|---|
> | **只是想试试 / 觉得被拦得难受** | 把配置里的 **`enforce` 改成 `false`**，或在 DSH 里**禁用/卸载本插件** → **立刻恢复** |
> | **你是 AI 助手的使用者** | 装对了。你的助手从此会先派活再动手 —— 这正是设计目标 |
> | **不确定要不要装** | ✅ **先读「它解决什么问题」那节**，再决定 |
>
> **一句话**：这是**行为约束插件**，不是能力增强插件。它**故意让你少一些自由**。

---

> **一个 DSH（DeepSeek Harness）插件：在工具调用层强制「先委派给其他模型」。**
>
> 本会话没有派发记录时，**无法执行 `pwsh` / `write` / `edit` 与查资料工具** ——
> 让「把活派出去」从**提示词纪律**变成**物理约束**。

---

## 它解决什么问题

用多模型协作时，AI 助手会**倾向于自己埋头干**，而不是把活派给更便宜/更合适的模型。
写提示词、加规则、做检查表 —— 实测**连续失败 3 次**（规则越写越多，执行照旧）。

**根本原因**：规则是"提醒"，而提醒在长上下文里会被稀释。

**这个插件的思路**：**不在提示词层劝，而是在工具调用层拦** ——
`ctx.tools.guard()` 是同步单调守卫，拦截了就是拦截了，没有"再劝一次"的空间。

---

## 前置要求

| 项 | 要求 |
|---|---|
| **DSH**（DeepSeek Harness） | **>= 0.1.7**（这是 DSH 插件，**离开 DSH 无法运行**） |
| Node.js | >= 20 |

> ⚠️ **重要**：本插件依赖 DSH 的 Cordis 插件体系与 `tools` 注入环境。
> 它不是通用中间件 —— **没有 DSH 请勿安装**。

---

## 它拦什么 / 不拦什么

**拦**（自己动手类）：
- `pwsh` / `write` / `edit`
- `ego_*` 执行族（`ego_script` / `ego_cli` / `ego_js` / `ego_cdp` / …，**前缀匹配**，含未来新增）
- 自己查资料：`web_search` / `web_fetch` / `argo_search` / `argo_fetch` / `read_page` / `x_search` / `wide_research`
- `ego_*` 取数族（`ego_http` / `ego_navigate` / `ego_snapshot` / …）

**不拦**：
- 翻文件：`read` / `grep` / `glob`
- 派发本身：`workflow` / `subagent` / `task_board_run` 等
- 命令本体以 `model-hub.mjs` 之类的**调度脚本**发起的调用（见下方配置）

---

## 放行的 6 个条件（按序短路，命中任一即放行）

| # | 条件 | 说明 |
|---|---|---|
| ① | **派发本身** | 解析式判据：去注释 → 分段 → 引号感知分词 → 首 token 是 `node` 且某非引号 token 以目标脚本结尾 |
| ② | **举证式 SELF-DO** | 见下节（v10 核心） |
| ③ | **子代理会话** | 由 `subagent/start` / `workflow/agent-start` 权威事件精确识别（子代理**没有**派发能力，故豁免） |
| ④ | **同一派发根调用** | 派发动作带出的一系列后续调用 |
| ⑤ | **兜底时间窗** | 距本会话最近一次派发 < `subagentGraceMs`（默认 10s，per-agent） |
| ⑥ | **本会话已成功派发** | 放行与计数**解耦**：假派发不解锁 |

---

## 举证式 SELF-DO（v10 核心机制）

**为什么需要它**：v9 只要求"写上 `SELF-DO: <理由>`"就放行 —— 于是**随手写一句就能绕过整个闸门**。

**v10 改成举证式**：必须拿出**证据**。三种合格写法（**只认关键参数本体**：`pwsh`→`command`，`write`/`edit`→`file_path`）：

```text
# A) 权限型自办 —— 权限只在人手里（跑本机命令 / 高风险写操作 / 改配置 / 删文件 / 动 git）
SELF-DO: perm=<pwsh|high-risk|privilege>; reason=<为何权限只在你手里>

# B) 结构化证据 —— 声明派给过谁 + 对方为何干不了（缺一不可）
SELF-DO: tried=<派给了谁，如 zhipu,modelscope>; reason=<对方为何干不了/为何必须你来>

# C) 本会话真的派过一次（成功或失败都算）
SELF-DO: <一句话理由>      ← 前提：本会话 dispatch>0 或 dispatchFailed>0
```

三者都不满足 → **fail-closed 拒绝**，并给出**可操作指引**（不是"你不能这么干"，而是"你该这么干"）。
拦截原因会分类记录：`no-dispatch-record` / `selfdo-no-evidence` / `guard-error`。

> **写在别处一律无效**：`justification`、`content`、`old_string`、`new_string` 里的 `SELF-DO:` **不算** —— 这是 fail-closed 的正确行为，但**极易误解**，请注意。

**回滚开关**：`requireDispatchEvidence: false` 可退回 v9 的声明式语义（仅应急，勿常开）。

---

## 安装

本插件是 **DSH bundle 插件**，通过 `cordis.patch.yml` 的 `bundle.patch` 挂载：

```yaml
- insert:
    - id: dispatch-gate
      name: '@alankhronos/dsh-dispatch-gate'
      config:
        # 见下方「配置项」
```

然后用 DSH 的插件管理安装（`plugin_manager install_bundle`，target 指向本包）。
> ⚠️ 开发时建议用 **`link:`** 方式安装 —— 这样改源码即时生效（否则 Node 的 ESM 缓存按**绝对路径**为键，原地改代码不会重载）。

---

## 配置项

只改 `cordis.patch.yml` 的 `config:` 段，**无需改源码**：

| 键 | 默认 | 说明 |
|---|---|---|
| `workTools` | `['pwsh','write','edit']` | 自己动手类工具 |
| `workToolPrefixes` | `['ego_']` | 前缀匹配的工具族 |
| `researchTools` | `['web_search', …]` | 自己查资料类工具 |
| `delegationTools` | `['workflow','subagent',…]` | 派发本身（不拦） |
| `dispatchPatterns` | 见源码 | 派发命令的解析规则 |
| `subagentGraceMs` | `10000` | 兜底时间窗（per-agent） |
| `guardFailClosed` | `true` | guard 内部异常时是否拒绝（保守策略） |
| **`requireDispatchEvidence`** | `true` | **v10 举证开关**；`false` 退回声明式 |
| **`permKeywords`** | `['perm','privilege','high-risk']` | 权限型通道的关键词 |
| `logDir` | `<系统临时目录>/dispatch-gate` | 账本与日志目录 |

---

## 行为账本

每次放行/拦截都会追加一行到 `logDir/dispatch-stats.jsonl`：

| kind | 含义 |
|---|---|
| `dispatch` | 成功派发 |
| `selfdo` | 自办放行（走 ②/⑤/⑥） |
| `research` | 直查资料放行 |
| `blocked` | **被拦截**（含 `reason` 与 `evidence` 快照，便于审计） |
| `selfdo-permit` | **带证据放行**（含 `via` 与 `evidence`，可追溯是哪条通道） |
| `dispatch-failed` | 派发尝试失败（**失败也算证据**） |

---

## 测试

```bash
npm test        # 等价于 node selftest.mjs
```

**56 项用例**（55 PASS / 0 FAIL / **1 SKIP**）。

> `SKIP` 的那项是「与 v7/v8 的行为对照测试」—— 它需要**相邻目录存在历史版本**才跑；
> 本仓库只发布 v10，因此该项优雅跳过（**不是失败**）。

---

## 迭代史（v1 → v10）

每一版都是**被真实测试打出来的**（不是设计出来的）：

| 版本 | 修了什么 |
|---|---|
| v1–v5 | 从"能拦 pwsh"到"不误伤自己派出去的子代理"（改用 `tools/pre-execute` 提前开豁免窗） |
| v6 | 跨会话泄漏 · 拦截清单配置化 · guard 异常 fail-closed |
| v7 | 6 个缺陷：echo 绕过 / `turn/end` 死代码 / 计数虚高 / 时间窗误豁免 / 兜底窗残留 / cwd bug |
| v8 | 4 个绕过：**假派发永久解锁** / **`ego_*` 能力级后门** / 误判静默失效 / `SELF-DO` 全文匹配 + 3 个运维陷阱 |
| v9 | 2 个遗留点：**拦截不入账**（新增 `blocked`）/ 子代理被误判违规 |
| **v10** | **`SELF-DO` 从「声明式」升级为「举证式」** + 补回滚开关 |

**教训的核心**：**规则越写越多，执行照旧** —— 因为"提醒"依赖被提醒者自觉。
**结构约束才有效**：把它做成"不派发就干不了活"。

---

## 已知限制（诚实声明）

- **强依赖 DSH** —— 离开 DSH 无法运行（这是设计使然，不是缺陷）
- **只在本会话内生效**：状态按 agent 隔离，新会话从零开始
- **只拦"工具调用"这一层** —— 若模型用别的途径（如直接写文件的其他工具）绕过，需要把该工具加进 `workTools`
- **不做内容判断** —— 它只看"你有没有派发"，不评价派发质量
- **3 项历史对照测试在本仓库会 SKIP**（缺 v7/v8 目录）
- 项目定位是**个人工作流的结构化约束**，不是通用 Agent 治理框架

---

## 许可

[MIT](LICENSE) © 2026 AlanKhronos
