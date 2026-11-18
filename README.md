# crew 调度器

版本：v1.0（1.0.0）

创作者：yilimi（[@amealf](https://github.com/amealf)）与 Codex。

crew 读取 YAML 任务单，按「设计 → 实现 → 检查 → 审阅」接力执行，直到通过或命中停止条件。里程碑 1–4 提供四个工人适配器、循环引擎、检查与截图、人工批准、断点续跑、运行报告和桌面通知。里程碑 5a 提供命令行会审（`crew ask`）。

三个工具的真实调用已验证，强制结束进程后的续跑已在真机验证。Windows 桌面通知已实际显示，用户确认「看到了」。Astra／Claude／Argon 番茄钟试点已完整跑通「首轮退回 → 修改 → 第二轮通过」，记录见文末。

前后端双审阅的增量规格见 [JSON spec](docs/specs/reviewer-split-20261117.spec.json)，状态为待实现。v1.0 基线运行代码使用单审阅者。

## 开始使用

需要 Node.js 20 以上、git。开发环境为 Windows 11 和 PowerShell。

```powershell
Set-Location -LiteralPath 'D:\Codex project\co-work\crew'
npm install
node .\bin\crew.js doctor
node .\bin\crew.js doctor --live
```

`doctor` 检查安装和版本。`doctor --live` 还会依次向三个工具发一条中文测试提示词，会消耗模型额度。工具沿用各自的登录；crew 不修改全局配置。

在当前 PowerShell 窗口定义一个临时命令，就能从其他项目调用 crew。这个函数只对当前窗口有效，无需改 PowerShell 配置文件：

```powershell
function crew { & node 'D:\Codex project\co-work\crew\bin\crew.js' @args }
```

接着切到要处理的项目根目录。新项目先执行 `git init`；已有仓库直接初始化 crew：

```powershell
# 把这里换成目标项目的实际目录。
Set-Location -LiteralPath 'D:\你的项目'
crew init
# 编辑 .crew/tasks/example.yaml，写清目标、分工与检查命令。
git add -A
git commit -m 'Add crew task'
crew validate example
crew run example --dry-run
crew run example
```

开始运行要求项目已有初始提交且工作区干净。任务单、提示词和项目代码应先提交。若 `.crew/runs/` 尚未被忽略，前置检查会补入 `.gitignore` 并单独提交这一项。

## 命令

所有命令都从目标项目的 git 仓库根目录执行。省略运行编号时，使用最近一次任务运行，环境诊断目录不参与选择。

| 命令 | 作用 |
| --- | --- |
| `crew init` | 创建任务和提示词目录、带注释的示例任务单及忽略规则 |
| `crew doctor` | 检查 Node、git、Claude、Codex、agy 与可选的 Playwright |
| `crew doctor --live` | 另发测试提示词，验证三个工人能否返回回答 |
| `crew validate <任务名>` | 校验任务单，显示补齐默认值的结果 |
| `crew run <任务名>` | 创建运行分支并开始接力 |
| `crew run <任务名> --dry-run` | 只显示步骤和首棒提示词，不调用工具，不写运行文件 |
| `crew status [运行编号]` | 显示状态、轮次、下一步、已用时间和各轮结论 |
| `crew approve [运行编号]` | 批准设计或接受当前模型审阅结论并继续 |
| `crew revise [运行编号] --note "修改意见"` | 将等待确认的本轮审阅退回，保存人工意见并进入下一轮 |
| `crew resume [运行编号]` | 从停止或异常中断时的下一步继续 |
| `crew resume [运行编号] --extend-hours 12` | 续跑，同时给原时间上限增加 12 小时 |

## 会审

规格：[JSON](docs/specs/milestone-5a-ask.spec.json) · [原始实现规格](docs/specs/milestone-5a-ask.zh.md)

在目标项目的 Git 仓库根目录先运行 `crew init`，生成可选的 `.crew/meeting.yaml` 和会审记录的忽略规则。会审可以在有未提交改动的工作区进行，参会者和总结者均使用适配器的只读模式。

| 命令 | 用途 |
| --- | --- |
| `crew ask "问题"` | 新开会审，并行询问参会者 |
| `crew ask --file question.md` | 从项目内的 UTF-8 文件读取多行问题 |
| `crew ask "追问" --meeting <编号>` | 在同一会审中追问全体 |
| `crew ask "追问" --to codex` | 在最近会审中只追问 Codex，可另加 `--meeting <编号>` |
| `crew ask --retry [编号]` | 补跑最近一轮中断、超时或失败的回答 |
| `crew summarize [编号] --by codex` | 为最近一轮重新总结，`--by` 可省略 |
| `crew decide [编号] --adopt codex` | 预览采纳 Codex 最近一次成功回答的决议 |
| `crew decide [编号] --text "决定内容" --title "标题" --yes` | 确认写入自拟决议 |
| `crew meetings` | 按更新时间倒序列出会审 |
| `crew meeting [编号] [--json]` | 查看完整问答或读取 JSON |

参会者写成 `工具` 或 `工具:型号`。新会审的 `--with` 接受逗号分隔的名单，例如 `--with claude,codex,agy:gemini-4-argon-medium`。也可在 `.crew/meeting.yaml` 中设置 `participants`、`summarizer`、`timeout_minutes`。默认用 Claude、Codex 和 agy，各用工具自己的默认型号，由第一位参会者总结，每次调用超时 15 分钟。同一个工具有多个型号时，用 `crew meeting --json` 里的参会者 `id` 做 `--to` 或 `--adopt`。用 `--no-summary` 可跳过本轮自动总结。

记录在 `.crew/meetings/<编号>/`。`meeting.json` 记录成员、各轮状态、结果路径和决议，`events.log` 记录每次调用。`rounds/rN/question.md` 保存问题，每位参会者的目录保存提示词、回答、日志和元数据，`rounds/rN/summary.md` 保存总结。重试保存在角色目录的 `attempt-N/` 下。遇到额度限制时，等额度恢复后可在原会审发起新一轮。

`crew decide` 带 `--yes` 才追加 `DECISIONS.md`。条目以 `## D-001 标题` 开始，下面是 `状态：Active`、日期、会审编号和轮次，以及完整决议正文。省略 `--title` 时优先取总结中的推荐标题，再取正文首行。决议提交后，后续 `crew run` 的模型提示词会引用该文件，可用 `--dry-run` 查看。

### 5a 真机验收

状态：待用户在 PowerShell 执行。下面的会审命令会消耗模型额度。先按「开始使用」定义 `crew`，再切到自己的番茄钟试点仓库并运行：

```powershell
crew init
crew ask "这个项目下一步最值得加的功能是什么？说明理由"
crew ask "你的方案具体要改哪些文件？" --to codex --no-summary
crew decide --adopt codex
crew decide --adopt codex --yes
git add -- DECISIONS.md
git commit -m "Add pomodoro meeting decision"
crew run pomodoro --dry-run
@'
计时器暂停后恢复时，哪些行为需要测试？
请分两点回答，并引用相关文件。
'@ | Set-Content -LiteralPath '.crew/meeting-question.md' -Encoding utf8
crew ask --file '.crew/meeting-question.md'
```

看第一轮是否有三位回答和「一致／分歧／推荐／决议草稿」四节总结；第二轮是否只有 Codex 并延续它上一轮的建议；最后核对决议编号、预览中引用的决议正文及多行中文。`crew init` 新生成的配置和忽略规则可按项目需要提交。

单独追问时，`--to` 限定参会者。真机步骤加上 `--no-summary`，只调用 Codex 一次；普通追问仍会另调总结者。

### 5a 实现说明

`--to` 未写 `--meeting` 时使用最近会审，`--file` 与位置参数同时提供时以文件内容为准。`--retry` 补跑未完成、失败、超时或中断的回答，保留本轮 `--no-summary` 的设置。历史优先保留该参会者的首轮和最近完整问答；如果它们和必须保留的中间问题本身超过 60,000 字符，仍保留这些内容。总结失败时保留回答，可用 `crew summarize` 重写。

运行时提示词沿用 `DECISIONS.md` 路径引用。`crew run --dry-run` 会在首棒提示词之后另外打印该文件，方便核对新决议。

## 任务单

任务单保存为 `.crew/tasks/<任务名>.yaml`。下面的例子使用各 CLI 自己的默认型号；需要固定型号时，在角色下加 `model`。

```yaml
goal: |
  按项目现有结构完成一个小功能，并补充必要测试。
roles:
  designer: { tool: claude }
  builder: { tool: codex }
  reviewer: { tool: claude }
flow:
  - design
  # 需要先人工确认时，取消下一行的注释。
  # - approve
  - loop: [build, check, review]
# true 表示每轮模型审阅后等待人工确认；默认 false 为自动循环。
human_review: false
checks:
  commands: ["node --test"]
  # screenshots:
  #   - { url: "index.html", width: 1280 }
  #   - { url: "index.html", width: 390 }
review_checklist:
  - 功能符合目标，必要测试通过
stop_when:
  max_hours: 24
  max_rounds: null
  step_timeout_minutes: 60
  stall_rounds: 2
```

`builder` 和 `reviewer` 必填，只有 builder 使用可写模式。designer 和 reviewer 使用只读模式，回答由引擎保存。`design` 与 `approve` 是独立的可选步骤；安排了设计时先读 `design.md` 再批准，未安排设计时核对任务目标后批准。循环只支持 `[build, review]` 或 `[build, check, review]`，整个任务恰好一个循环。

默认最多累计运行 24 小时，单棒最长 60 分钟，轮数不限，连续两轮没有文件改动便停止。未知字段会警告；同一工具与型号同时担任 builder 和 reviewer 时也会警告。

## 逐轮人工确认

`human_review` 默认是 `false`，模型审阅结论直接驱动自动循环。设为 `true` 后，正常完成本轮审阅判定时进入 `waiting_approval`，状态里的 `approvalStage` 为 `review`。此时可以阅读审阅意见、检查结果和截图，再选择继续或退回：

```powershell
crew status
crew approve
# 或写明需要修改的地方。
crew revise --note '请修复窄屏下按钮重叠，并补上对应检查'
```

`crew approve` 接受模型当前结论：APPROVED 且检查通过时结束，REVISE 时进入下一轮修改。失败的检查仍会阻止最终通过。

`crew revise` 把人工意见保存在 `reviews/human-review-N.md`，原模型审阅保留在 `reviews/review-N.md`。下一轮 builder 会读取人工意见路径，针对意见修改；改完仍会经过检查和模型审阅。

任务单 `flow` 中的 `approve` 继续控制设计或目标的事前确认，与 `human_review` 独立，可以同时使用。

## 审阅与停止

审阅者最后一个非空行必须是 `VERDICT: APPROVED`、`VERDICT: REVISE` 或 `VERDICT: BLOCKED`。引擎接受两端的 Markdown 标记和大小写差异。结论缺失或格式不合规时按 REVISE 处理，下一轮提示词会说明；连续两次格式不合规即停止。检查命令失败时，APPROVED 也会被改为 REVISE。

工人退出失败或回答为空时，等 30 秒重试一次；超时也重试一次。构建重试前先保留半截改动并恢复本轮起点。额度或限流直接停止，待额度恢复后 `crew resume`。

| 最终状态 | 退出码 | 后续操作 |
| --- | --- | --- |
| `approved` | 0 | 阅读 `REPORT.md` 和分支改动，手动决定合并 |
| `waiting_approval` | 0 | 确认设计、目标或当前审阅后运行 `crew approve`；本轮需要修改时用 `crew revise --note "意见"` |
| `stopped` | 2 | 根据 `stopReason` 处理后运行 `crew resume` |
| `error` | 1 | 按中文错误信息修正任务单、仓库或程序错误 |

`stopReason` 包含 `max_hours`、`max_rounds`、`stalled`、`blocked`、`review_malformed`、`step_failed`、`step_timeout`、`quota` 和 `interrupted`。`Ctrl+C` 会终止当前工人进程树，保存 `stopped / interrupted`。

## 检查与截图

`checks.commands` 依次运行，每条最多 10 分钟，记录退出码、耗时及输出最后 200 行。`check-N.json` 的 `passed` 只取决于命令结果，截图失败或跳过会单独记录，供审阅者判断。

截图使用 Playwright，以指定宽度打开页面、等待加载完成并截整页。相对路径按项目内本地文件打开，也支持 HTTP/HTTPS 地址。未安装 Playwright 时会写明跳过原因；已安装包但浏览器不可用时会记录启动失败。

需要截图时，在 crew 目录安装可选依赖和浏览器，把浏览器文件保存在本项目内：

```powershell
Set-Location -LiteralPath 'D:\Codex project\co-work\crew'
npm install
$env:PLAYWRIGHT_BROWSERS_PATH = 'D:\Codex project\co-work\crew\.local\browsers'
npm exec playwright install chromium
```

运行目标项目时沿用同一个 `PLAYWRIGHT_BROWSERS_PATH`。重开 PowerShell 后需要重新设置这个环境变量。

## 运行记录与续跑

每次运行创建 `crew/<任务名>-<日期时间>` 分支。每轮构建有改动时提交一次，审阅 diff 包含从本次任务起点到当前提交的全部改动。报告中给出查看与手动合并命令，crew 只保留本地分支与提交。

```text
.crew/runs/<运行编号>/
  state.json
  task.yaml
  events.log
  design.md
  reviews/review-1.md
  reviews/human-review-1.md
  checks/check-1.json
  checks/diff-1.patch
  shots/r1-index-1280.png
  steps/01-design/
    prompt.md
    output.md
    raw.log
    stderr.log
    meta.json
  recovery/
  REPORT.md
```

`task.yaml` 是本次任务快照，运行中改原任务单不会改变本次任务。`state.json` 通过临时文件再改名写入，每棒完成后保存下一步；初始化、提交和审阅判定也有独立断点，避免恢复时重复提交。

运行时每 2 秒写一次心跳，只累计实际运行时间，等待审批和停止期间不计入上限。强制关终端后，以最后落盘的心跳为准，通常少计最后约 2 秒。`crew resume` 会确认当前分支与记录一致，从 `nextStep` 继续；中断在构建内时先恢复本轮起点。

恢复前，会把将被移除或覆盖的文件移入本次运行的 `recovery/`，保存原 HEAD、暂存区补丁和工作树补丁，再恢复 Git 索引与文件。恢复目录可用于找回半截实现。项目锁使用本地 IPC，由操作系统保证互斥，原进程退出后可重新取得锁。

`REPORT.md` 由代码生成，包含目标、状态、停止原因、累计耗时、每轮结论与必须修改条数、分支名和手动查看、合并命令。`approved`、`waiting_approval`、`stopped` 会尝试发送 Windows 桌面通知，通知失败会记入事件日志，运行状态照常保存。通知使用 Windows Terminal 已注册的 AppID；本机系统调用成功，用户也已确认实际看到了通知。

## 提示词与决议

默认模板在 crew 的 `prompts/`。项目可以用 `.crew/prompts/designer.md`、`builder.md`、`reviewer.md` 覆盖。占位符限定为规格中的名字，未知名字报错；空值连同所在小节一起移除。

目标和验收清单放入提示词；设计、审阅、检查、diff、截图和已有决议以文件路径交给工人读取。项目有 `DECISIONS.md` 时，提示词给出该文件路径，要求遵守状态为 Active 的条目。

## 工具调用方式

以下参数以 2026-11-16 本机验证为准。提示词正文始终写入标准输入并关闭输入流，不拼进命令行参数。`<model>` 未提供时不传型号参数。

### Claude Code

本机版本：`2.1.120 (Claude Code)`。

```text
claude -p --output-format json --no-session-persistence --strict-mcp-config
  --model <model>
  --permission-mode dontAsk --tools Read,Grep,Glob --allowedTools Read,Grep,Glob
```

只读模式只暴露 Read、Grep、Glob，阻止模型通过编辑工具或终端写文件。可写模式使用：

```text
--permission-mode acceptEdits --tools Read,Grep,Glob,Edit,Write,Bash
--allowedTools Read,Grep,Glob,Edit,Write,Bash(node --test*),Bash(npm test*)
```

最终回答取 JSON 的 `result` 字段，并检查 `is_error`。初次调用返回未登录，完成登录后已通过中文、多行输入、只读拒写、可写建文件、图片读取和五秒超时验证。完整记录在 `.local/live-tests/claude-AdWaS2/verification.json`；超时后 `taskkill` 记录两个进程 ID，存活检查为空。另指定 `claude-sonnet-4-6` 成功拿回回答，记录在 `.local/claude-model-retest-1794815872599/`。

### Codex

本机版本：`codex-cli 0.169.0`。指定型号验证使用 `gpt-6.1-sol`。

```text
codex exec -s read-only --ephemeral --color never
  --output-last-message <stepDir>/last-message.txt -m <model> -
```

可写模式把 `read-only` 换成 `workspace-write`。最终回答只读 `--output-last-message` 生成的 UTF-8 文件，不混入终端过程日志。每次启动前清空该文件，防止失败后误用旧回答。

中文、指定型号、只读拒写、可写建文件、图片读取和五秒超时均已在本机验证，完整记录在 `.local/live-tests/codex-F8NFSK/verification.json`。五秒超时后 `taskkill` 返回 0，记录 16 个被终止的进程 ID，存活检查为空。

初次可写调用返回 `Failed to write file`，原始记录保留在 `.local/live-tests/codex-HUZUqa/`。进一步的本机验证定位到独立 CLI 继承了桌面专用的 `CODEX_WINDOWS_REGISTERED_CORE` 标记，沙箱报 `registered Core process has no package identity`。适配器现在只在子进程环境副本中移除这个标记和 `CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY`，使用独立 CLI 的正常沙箱路径；明确的 `-s read-only`／`-s workspace-write`、认证和父进程环境均保留。修复后只读拒写与可写建文件均通过，日志确认可写模式为 `workspace-write`。

注册式运行时要求应用包身份的条件可见 [Codex 官方源代码](https://github.com/openai/codex/blob/main/codex-rs/windows-sandbox-rs/src/app_package.rs)。

### Antigravity CLI

首次探测为 `1.4.0`。验证期间 agy 自行更新到了 `1.5.9`；最终适配器以 **1.5.9 以上版本**为基线，使用其仅本次会话有效的 `--settings` 参数。

```text
agy --print= --input-format stream-json --output-format stream-json
  --model <model> --sandbox --mode plan --settings <会话权限JSON>
```

标准输入是一行 JSON，换行和中文由 JSON 编码保留：

```json
{"event":"user","message":{"content":"第一行\n第二行中文"}}
```

只取唯一一个 `event: result` 事件里的 `result.response`，并检查 `result.status`。普通 `-p --output-format json` 在本机把后面的标志误当提示词，因此采用官方流式输入协议。

`plan` 仅增加计划指令，本身不构成只读权限边界。只读调用通过会话权限 JSON 拒绝 `write_file(*)`、`command(*)`、`mcp(*)`、`execute_url(*)`、`download_url(*)`。适配器不加 `--disable-slash-commands`，因为它会使 `--mode plan` 失效。可写模式使用 `--sandbox --mode auto`，终端命令在沙箱中按正常权限策略执行；这使实现者可以检查项目并运行测试。仅接受编辑的模式会在无交互终端命令被拒绝后返回空回答，最终试点已验证新模式能完成构建与测试。

指定 `gemini-3.8-flash-medium` 的本机验证已完成中文输入、只读拒写、可写建文件和图片读取，记录在 `.local/live-tests/agy-V6ouhg/verification.json`。补充的五秒超时记录在同目录 `.crew/runs/timeout-tree/meta.json`：`taskkill` 返回 0，记录两个被终止的进程 ID，存活检查结果为空。

调用参数参考：[Claude CLI](https://code.claude.com/docs/en/cli-reference)、[Codex CLI](https://developers.openai.com/codex/cli/reference/)、[agy 无界面调用](https://antigravity.google/docs/cli/headless)、[agy 执行模式](https://antigravity.google/docs/cli/modes/)、[agy 权限规则](https://antigravity.google/docs/permissions/)。

## 适配器接口

```js
import { getAdapter } from './src/adapters/index.js';

const worker = getAdapter('mock');
const result = await worker.run({
  prompt: '请按设计实现',
  model: undefined,
  mode: 'write', // read 或 write
  cwd: process.cwd(),
  timeoutMs: 60_000,
  stepDir: '.crew/runs/example/steps/01-build',
});
// { ok, text, exitCode, durationMs, timedOut, quotaHit, error }
```

每一棒保存 `prompt.md`、`output.md`、`raw.log`、`stderr.log`、`meta.json`。真实进程的 PID 和超时终止结果记录在元数据中。调用者可另外传 `signal` 取消进程。Windows 超时和取消使用 `taskkill /T /F`，不由适配器重试。

所有调度器写入路径限定在 `cwd` 内，并校验目录链接及悬空链接。工人本身的文件权限由对应 CLI 的模式和权限设置负责。

## 假工人

把 `CREW_MOCK_SCRIPT` 设成项目内 JSON 文件的路径，内容为回答数组：

```json
[
  {"text":"第一轮实现完成","files":{"src/example.js":"export const value = 1;\n"}},
  {"text":"VERDICT: REVISE"},
  {"text":"这一棒超时","timedOut":true},
  {"text":"额度已用完","quotaHit":true},
  {"text":"工具失败","exitCode":1}
]
```

每次调用消耗一条回答；脚本旁的 `<脚本名>.cursor.json` 保存下一个索引，重开进程后继续读取。只读调用拒绝 `files`。若需要从头重放，给脚本使用一个新文件名。建议将脚本放在 `.local/` 下，运行记录和游标都可保留。

## 验证命令

在 crew 代码目录执行：

```powershell
npm test
node .\scripts\verify-resume.js
```

两者均不调用真实模型。`npm test` 使用 Node 自带测试器、假工人与隔离 git 仓库，覆盖任务单、提示词、审阅结论、循环、重试、停止、审批、检查、分支、运行记录和恢复。`verify-resume.js` 另外启动实际 CLI 进程，在构建中强制终止进程树，再启动 `crew resume`；核对半截文件可找回、完成步骤未重复、原分支未变和进程均退出。

以下命令会调用真实模型并消耗额度，只在明确执行时运行：

```powershell
npm run verify:live -- codex --model gpt-6.1-sol
npm run verify:live -- agy --model gemini-3.8-flash-medium
npm run verify:live -- claude --model claude-sonnet-4-6
node .\scripts\verify-pilot.js
# 本次最终试点通过 agy 调用 Claude Sonnet 5.5：
npm run verify:pilot -- --claude-via-agy
```

`verify:live` 在 `.local/live-tests/` 下建立隔离测试仓库，检查中文输入、只读拒写、可写建文件、图片读取及五秒超时。

`verify-pilot.js` 在 `.local/pilots/` 下建立独立番茄钟试点，按用户指定的分工接力：

| 角色 | 工具 | 型号 |
| --- | --- | --- |
| 规划 | Codex | `gpt-6-astra`（Astra） |
| 执行 | agy（最终试点的 --claude-via-agy 入口） | `claude-sonnet-5-5-medium` |
| 审阅 | agy | `gemini-4-argon-medium`（Argon） |

试点运行 `node --test`，每轮捕获 1280 和 390 两种宽度截图。首轮构建结束后，验收钩子会故意注入窄屏布局故障，用真实模型审阅验证「REVISE → 修改 → APPROVED」的完整循环。页面仅作为调度器的验收样本。验证目录和日志保留，脚本只操作本地仓库，合并和推送仍由人决定。

省略 `--claude-via-agy` 时，执行位使用原生 Claude Code 的 `claude-sonnet-4-6`。最终验收选择 agy 入口，是因为原生接口在完整实现请求中持续出现 `ECONNRESET`；两个入口都调用 Claude 家族模型，工具与型号明确保存在任务单和每棒记录中。

## 实现说明

`bin/crew.js` 只负责入口，`src/cli.js` 分发命令。`tasksheet.js` 处理输入，`prompts.js` 渲染模板，`verdict.js` 解析最后一行，`engine.js` 驱动状态；引擎通过适配器、`gitops.js` 和 `checks.js` 执行外部操作。`runlog.js` 负责原子状态与锁，`notify.js` 负责系统通知。所有文件使用 UTF-8，Windows 命令使用 PowerShell 和 `cross-spawn`。

初始化断点保存原分支、起始提交和目标分支，恢复时完成或核对分支准备。构建成功后先记「待提交」，再提交并推进状态；提交已完成而状态尚未推进时，识别已有的本轮提交，继续后续步骤。读取续跑状态与分支检查在取得项目锁后进行，防止另一个进程完成运行后使用旧状态。

额度识别只匹配实际限流、额度提示及明确错误码，避免把 Codex 遥测事件名误判为额度耗尽；该情况已加入回归测试。

调度器校验项目内路径及目录链接，不永久删除文件，不改全局配置，不自动 push 或 merge。局部测试目录、运行记录和恢复文件保留在忽略目录中。工人 CLI 使用自己的登录、历史和自动更新机制；本次 agy 自动更新的版本变化已记录在上文。

## 当前验收进度

| 验收项 | 当前依据 |
| --- | --- |
| 三工具安装与真实回答 | 已通过，整体诊断记录在 `.crew/runs/doctor-1794815947854/` |
| 三工具读写、中文、多行、指定型号与图片 | 已通过，记录见「工具调用方式」 |
| 三工具五秒超时与进程清理 | 已有 taskkill 成功及无存活进程的真机记录 |
| 输入、循环、重试、停止、审批、人工退回及恢复 | 最终完整离线测试 66 项通过，全部不调用模型；输出保存在 `.local/final-test-run.log` |
| 真实 CLI 强杀后续跑 | 已通过，记录在 `.local/resume-verification-WBAE5O/verification.json` |
| 真实页面的两种宽度截图 | 最终试点两轮均捕获 1280／390 截图，修复后的两张图已人工查看；浏览器验证确认无横向溢出或按钮重叠 |
| Astra／Claude／Argon 真实闭环与视觉退回 | `.local/pilots/pomodoro-n0xRQM/.crew/runs/pilot-result.json` 中 verifiedLoop=true：Argon 首轮指出窄屏重叠并给 REVISE，Claude 修复，Argon 第二轮 APPROVED，两个真实构建提交均留在 crew 分支 |
| 番茄钟的本地使用与交互 | `.local/pilots/pomodoro-n0xRQM/.crew/runs/browser-verification.json` 通过：file: 打开、开始/暂停/恢复/重置、刷新保留次数、跨日重置、阶段切换与标题更新，页面无运行错误 |
| Windows 桌面通知 | 已在真机显示，用户明确确认「看到了」 |
| 独立代码审阅 | 适配器、输入、运行记录、状态机与人工审阅均已独立复查；最终补修并验证了重复判定幂等和 detached HEAD 报告问题 |
