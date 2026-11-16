crew 调度器：代码规格说明
Nov 16, 2026 · @Nicolas Fan
1. 目标和范围
crew 是一个命令行调度器：它读一份任务单，按任务单里的分工依次叫起 Claude Code、Codex、Antigravity 干活，自动循环「实现 → 检查 → 审阅」，直到审阅者给出通过，或者碰到停止条件。
这份规格是写给「负责写代码的模型」看的。它要足够具体，让模型不用再问问题就能动手，也让审阅的模型有明确的标准可以对照。
第一版要做到的
读任务单，校验，按顺序执行：设计 → 循环（实现 → 检查 → 审阅）→ 总结。
每个角色可以指定工具和型号。只有实现者能写文件，其他角色只读。
审阅结论由代码解析，是否退回由代码决定。
每一棒都留记录，可以中断后接着跑。
跑完或停下时发 Windows 桌面通知。
自带一个「假工人」，测试引擎时不消耗任何额度。
第一版不做的
开会（多模型并排回答）和网页界面，放到后面的版本。
多个任务同时跑。
改动任何全局配置文件（~/.claude、~/.codex 等）。
怎么用这份规格
按第 10 节的顺序，一次交给实现者一个里程碑。每个里程碑做完，由另一个模型对照「验收标准」审阅，通过后再做下一个。也就是说，crew 自己就是用它要实现的那套接力方式做出来的，只是第一次由人手动传棒。
2. 技术栈和目录结构
Node.js 20 以上，ES 模块，纯 JavaScript（不用 TypeScript，不需要编译步骤）。
依赖尽量少：yaml（读任务单）、cross-spawn（在 Windows 上正确启动 .cmd 命令）。截图用 playwright，作为可选依赖，没装时跳过截图并给出提示。
测试用 Node 自带的 node:test，不引入测试框架。
目标平台是 Windows 11 + PowerShell，代码不能依赖 bash。路径一律用 node:path 拼接。
所有文件读写用 UTF-8。给工人的提示词一律通过标准输入传入，不放在命令行参数里（Windows 命令行有长度限制，中文也容易乱码）。
crew/
  package.json            # bin: { crew: ./bin/crew.js }
  bin/crew.js             # 入口，只做参数解析和分发
  src/
    cli.js                # 各个子命令
    tasksheet.js          # 读取、填默认值、校验任务单
    engine.js             # 流程引擎（状态机）
    verdict.js            # 解析审阅结论
    checks.js             # 跑测试命令、截图
    gitops.js             # 分支、提交、diff
    runlog.js             # 运行记录、state.json、断点续跑
    notify.js             # 桌面通知
    prompts.js            # 把模板和上下文拼成提示词
    adapters/
      index.js            # 按 tool 名取适配器
      claude.js
      codex.js
      agy.js
      mock.js             # 假工人，测试用
  prompts/                # 默认提示词模板，项目里可以覆盖
    designer.md
    builder.md
    reviewer.md
  test/                   # 单元测试和端到端测试（全部用 mock）
  README.md
使用 crew 的项目里会出现这些东西：
<项目>/
  DECISIONS.md            # 决议本（可以没有）
  .crew/
    tasks/<名字>.yaml     # 任务单
    prompts/              # 可选：覆盖默认提示词
    runs/<运行编号>/      # 运行记录，写进 .gitignore
3. 任务单
任务单是一个 YAML 文件，放在项目的 .crew/tasks/ 下。完整字段如下：
goal: 一段话说清这次要做什么          # 必填

roles:                                   # 必填，至少有 builder 和 reviewer
  designer: { tool: claude, model: claude-fable-5-2 }
  builder:  { tool: codex }              # model 不写就用该工具自己的默认型号
  reviewer: { tool: claude, model: claude-opus-5-5 }

flow:                                    # 必填
  - design                               # 可选步骤
  - approve                              # 可选：停下等人点头
  - loop: [build, check, review]         # 必须有，且只能有一个

checks:                                  # 可选
  commands: ["node --test"]              # 依次运行，记录退出码和输出
  screenshots:                           # 需要 playwright
    - { url: "index.html", width: 1280 } # 相对路径按本地文件打开
    - { url: "index.html", width: 390 }

review_checklist:                        # 可选，审阅者必须逐条回答
  - 测试全部通过

stop_when:                               # 可选，下面是默认值
  max_hours: 24
  max_rounds: null                       # null 表示不限轮数
  step_timeout_minutes: 60               # 单独一棒的超时
  stall_rounds: 2                        # 连续几轮没有代码改动就停
校验规则（不满足就报错退出，错误信息要指出是哪个字段）：
goal 非空。
tool 只能是 claude、codex、agy、mock。
flow 里用到的步骤，对应的角色必须在 roles 里：design 需要 designer，build 需要 builder，review 需要 reviewer。
loop 里必须包含 build 和 review，顺序是 build 在前。check 可以没有。
builder 和 reviewer 不能是同一个「工具 + 型号」组合。这一条只给警告，不报错。
出现不认识的字段时给警告，防止拼写错误被悄悄忽略。
tasksheet.js 导出一个函数 loadTaskSheet(path)，返回填好默认值的对象，或者抛出带字段名的错误。
4. 适配器
适配器把「给某个工人一段提示词，拿回一段文字」这件事统一起来。引擎只认这个接口，不知道背后是哪家的命令行。
// 每个适配器文件导出这两个函数
export async function run({ prompt, model, mode, cwd, timeoutMs, stepDir }) {}
//   mode: 'read'（只读）或 'write'（可以改 cwd 里的文件）
//   stepDir: 这一棒的记录目录，适配器把原始输出和错误输出存进去
//   返回 { ok, text, exitCode, durationMs, timedOut, quotaHit, error }

export async function probe() {}
//   返回 { installed, version }，给 crew doctor 用
共同要求
提示词从标准输入写入，写完关闭输入流。
用 cross-spawn 启动，工作目录设为项目根目录。
超时后杀掉整个进程树（Windows 上用 taskkill /T /F），返回 timedOut: true。
错误输出里出现额度或限流字样（rate limit、quota、usage limit）时，返回 quotaHit: true。
适配器自己不重试，重试由引擎决定。
text 是工人最终的回答文字，不含过程日志。
三个工人的调用方式
下表是起点。各家命令行更新很快，里程碑 1 的任务就是在真机上逐条实测，把实际可用的参数写回适配器和 README。
工具只读模式可写模式取回答
claudeclaude -p --model <m> --output-format json --allowedTools Read Grep Glob换成 --permission-mode acceptEdits，并放行运行测试命令输出 JSON 里的 result 字段
codexcodex exec -s read-only -m <m> -codex exec -s workspace-write -m <m> ---output-last-message <文件> 写出的文件
agyagy -p --sandbox --model <m> --output-format json去掉 --sandbox（待实测）输出 JSON 里的最终回答字段（待实测）
审阅者需要看截图：截图存成项目里的图片文件，提示词里给出路径，由工人自己用读文件工具打开。里程碑 1 要确认每个工具在只读模式下能读图片。
假工人 mock
mock 不调用任何模型。它从环境变量 CREW_MOCK_SCRIPT 指向的 JSON 文件里按顺序取出预先写好的回答，每条可以带「要写的文件」、「假装超时」、「假装额度用完」。引擎的所有测试都用它。
5. 流程引擎
引擎是一个状态机。它每做完一棒就把进度写进 state.json，所以任何时候中断都能接着跑。
5.1 每一步做什么
步骤谁做模式输入产出下一步
designdesigner只读目标、决议本、验收清单回答文字由引擎存为 design.mdapprove 或 loop
approve人无design.md运行暂停，状态 waiting_approval，发通知人运行 crew approve 后继续
buildbuilder可写目标、design.md、上一轮的审阅和检查结果直接改项目文件；引擎随后提交check 或 review
check引擎自己无checks 配置checks/check-N.json、shots/rN-*.pngreview
reviewreviewer只读目标、design.md、本轮 diff、检查结果、截图路径、验收清单回答文字由引擎存为 reviews/review-N.md判定
判定引擎自己无审阅结论更新 state.json见 5.3
report引擎自己无整个运行记录REPORT.md结束
设计者和审阅者都不写文件：它们只输出文字，由引擎负责存盘。这样只有 builder 一个角色能改项目。
5.2 主循环（伪代码）
run(task):
  前置检查（见 7.3）；建运行目录；建分支；写 state.json
  如果 flow 有 design:   执行 design，存 design.md
  如果 flow 有 approve:  状态置 waiting_approval，发通知，退出进程（退出码 0）
  round = 1
  循环:
    检查停止条件（时间、轮数），命中则 stop(原因)
    build(round)
    提交；如果这一轮没有任何文件改动，stallCount += 1，否则清零
    如果 stallCount >= stall_rounds: stop('stalled')
    如果 loop 有 check: check(round)
    review(round)
    verdict = parseVerdict(审阅文字)
    APPROVED -> 跳出循环
    BLOCKED  -> stop('blocked')
    REVISE   -> round += 1，继续
  写 REPORT.md；状态置 approved；发通知
5.3 审阅结论怎么解析
verdict.js 导出 parseVerdict(text)，规则如下：
从最后一行往上找第一个非空行。
去掉首尾空格和 Markdown 符号（*、`、#）后，必须完全等于 VERDICT: APPROVED、VERDICT: REVISE 或 VERDICT: BLOCKED（不区分大小写）。
匹配不上时返回 REVISE，并带上 malformed: true。引擎把这件事记进事件日志，并在下一轮给 builder 的提示词里说明「上一轮审阅没有给出合规结论」。
连续两轮 malformed 就 stop('review_malformed')，不再继续猜。
额外规则：如果检查步骤里有命令退出码不为 0，即使审阅者写了 APPROVED，引擎也按 REVISE 处理，并记录「审阅通过但检查未通过」。测试不过就不能算通过。
5.4 一棒失败了怎么办
情况处理
退出码非 0 或回答为空等 30 秒重试一次；再失败 stop('step_failed')
超时重试一次；再超时 stop('step_timeout')
额度用完（quotaHit）不重试，直接 stop('quota')，以后用 crew resume 接着跑
build 重试前先把工作区还原到这一轮开始时的提交，避免半截改动叠加
5.5 结束状态
状态含义进程退出码
approved审阅通过，检查也通过0
waiting_approval等人批准设计0
stopped命中停止条件，stopReason 记具体原因：max_hours、max_rounds、stalled、blocked、review_malformed、step_failed、step_timeout、quota、interrupted2
error任务单错误、前置检查不过、程序自身异常1
按 Ctrl+C 时：杀掉正在跑的工人进程，状态写为 stopped / interrupted，然后退出。任何 stopped 状态都能用 crew resume 接着跑。
6. 提示词模板
模板是 Markdown 文件，用 {{名字}} 占位。prompts.js 导出 renderPrompt(role, context)：先找项目的 .crew/prompts/<role>.md，没有就用 crew 自带的默认模板；然后替换占位符。值为空的占位符连同它所在的小节一起去掉。模板里出现未知占位符时报错。
可用的占位符：goal、decisions（决议本全文，没有则为空）、checklist、design_path、round、prev_review_path、prev_check_path、diff_path、check_path、screenshot_paths、malformed_note。
提示词里只给文件路径，不把大段内容贴进去，让工人自己去读。这样提示词短，工人读到的也一定是最新的文件。
designer.md
你是这个项目的设计者。你只输出设计文档，不要修改任何文件。

## 目标
{{goal}}

## 已有决议（必须遵守状态为 Active 的条目）
{{decisions}}

## 验收清单
{{checklist}}

## 你要做的
1. 先阅读项目里现有的代码和文档，了解现状。
2. 输出一份设计文档，包含这几节：
   - 方案概述（三到五句话）
   - 要新增或修改的文件，每个文件负责什么
   - 关键的数据结构和函数，写出名字、参数、返回值
   - 需要写哪些测试
   - 分几步实现，每一步做完能验证什么
   - 不做什么（避免实现者自行扩大范围）
3. 有拿不准的地方，选一个最稳妥的方案并写明理由，不要留问题给别人。

直接输出设计文档正文，不要加开场白或结束语。
builder.md
你是这个项目的实现者。这是第 {{round}} 轮。

## 目标
{{goal}}

## 必读文件
- 设计：{{design_path}}
- 上一轮审阅意见：{{prev_review_path}}
- 上一轮检查结果：{{prev_check_path}}

{{malformed_note}}

## 已有决议（必须遵守状态为 Active 的条目）
{{decisions}}

## 规则
1. 第 1 轮：按设计完整实现。以后的轮次：只解决审阅意见里「必须修改」的问题和检查里失败的项，不要顺手重写无关代码。
2. 改完自己运行测试，确认通过再结束。
3. 不要运行 git commit、不要切换分支，调度器会替你提交。
4. 不要修改 .crew/ 目录和 DECISIONS.md。
5. 不要删除或跳过测试来让测试通过。
6. 如果你认为某条审阅意见是错的，不要照做，在最后的说明里写清理由。

## 结束时输出
用几句话说明：这一轮改了什么、测试结果、有没有没解决的问题。
reviewer.md
你是这个项目的审阅者。这是第 {{round}} 轮审阅。你只读不写，不要修改任何文件。
代码不是你写的。你的任务是判断它是否达到目标，不是把它改成你喜欢的样子。

## 目标
{{goal}}

## 必读文件
- 设计：{{design_path}}
- 本次任务到目前为止的全部改动：{{diff_path}}
- 检查结果（测试命令的退出码和输出）：{{check_path}}
- 页面截图：{{screenshot_paths}}
读完 diff 后，打开相关源文件看完整上下文，不要只看 diff 下结论。

## 验收清单
{{checklist}}

## 判断标准
- 只有这几类问题算「必须修改」：功能不符合目标或设计、有能复现的错误、测试失败或缺少关键测试、验收清单有一条不满足、截图里能看到的明显界面问题。
- 代码风格、命名、「可以更优雅」之类只算建议，不能作为退回理由。
- 不要提出目标和设计里没有的新要求。
- 每一轮都用同样的标准。

## 输出格式（严格按这个结构）
### 验收清单
逐条写：通过 或 不通过，加一句依据。
### 必须修改
编号列出。每条写：哪个文件哪一处、问题是什么、怎样算改好。没有就写「无」。
### 建议（不影响结论）
### 结论
最后一行只写下面三者之一，前后不要有别的字：
VERDICT: APPROVED    （「必须修改」为空，验收清单全部通过）
VERDICT: REVISE      （有「必须修改」的问题）
VERDICT: BLOCKED     （目标或设计本身有问题，继续修改解决不了，需要人来决定）
7. 运行记录、检查、git 和通知
7.1 运行目录
运行编号格式是 <任务名>-<YYYYMMDD-HHmmss>。每次运行一个目录：
.crew/runs/pomodoro-20261116-101500/
  state.json              # 进度，每做完一棒就写一次
  task.yaml               # 任务单快照，运行中改原任务单不影响本次运行
  events.log              # 一行一个事件：时间、步骤、轮次、结果、耗时
  design.md
  reviews/review-1.md
  checks/check-1.json
  checks/diff-1.patch
  shots/r1-index-1280.png
  steps/01-design/        # 每一棒一个目录，编号递增
    prompt.md             # 实际发出去的提示词
    output.md             # 工人的回答
    raw.log               # 原始输出和错误输出
    meta.json             # tool、model、mode、退出码、耗时、是否重试
  REPORT.md               # 结束时生成
state.json 的内容：
{
  "runId": "pomodoro-20261116-101500",
  "task": "pomodoro",
  "status": "running",
  "stopReason": null,
  "startedAt": "2026-11-16T10:15:00+08:00",
  "elapsedMs": 0,
  "branch": "crew/pomodoro-20261116-101500",
  "baseCommit": "<开始时的提交>",
  "round": 1,
  "nextStep": "build",
  "stallCount": 0,
  "malformedCount": 0,
  "rounds": [
    { "n": 1, "commit": "<提交>", "changedFiles": 5, "checksPassed": true, "verdict": "REVISE" }
  ]
}
写 state.json 要先写临时文件再改名，避免写到一半断电留下坏文件。elapsedMs 只累计真正在跑的时间，暂停期间不计入 24 小时上限。
7.2 断点续跑
crew resume 读 state.json，从 nextStep 开始继续，已完成的步骤不重做。如果中断发生在 build 中途，先把工作区还原到这一轮开始时的提交，再重做这一棒。续跑前确认当前分支就是记录里的分支，不是就报错。
7.3 git 规则
开始前的检查（任何一条不满足就报错退出，并告诉用户怎么解决）：
当前目录是 git 仓库。
工作区是干净的，没有未提交的改动。
.crew/runs/ 已经在 .gitignore 里；不在就自动加上并提交这一行。
任务单里用到的工具都已安装（调用各适配器的 probe）。
运行中：
从当前提交建分支 crew/<运行编号>，所有改动都在这个分支上。
每轮 build 结束后 git add -A 并提交，说明写 crew: round N build。没有改动就不提交，记一次停滞。
每轮审阅前生成 checks/diff-N.patch，内容是 git diff <baseCommit>..HEAD，也就是本次任务的全部改动。
crew 绝不执行 push、merge、删除分支、改动其他分支。合并由人来做。
7.4 检查步骤
checks.commands 里的命令依次执行，每条最长 10 分钟。记录退出码和输出的最后 200 行。
checks.screenshots：用 Playwright 打开页面，等页面加载完成，按指定宽度截整页图，存为 shots/r<N>-<名字>-<宽度>.png。没装 Playwright 时跳过，并在结果里写明跳过原因。
结果写成 checks/check-N.json：
{
  "passed": false,
  "commands": [
    { "cmd": "node --test", "exitCode": 1, "durationMs": 2100, "outputTail": "..." }
  ],
  "screenshots": [
    { "path": ".crew/runs/<编号>/shots/r1-index-1280.png", "ok": true }
  ]
}
passed 只看命令的退出码：全部为 0 才是 true。
7.5 总结和通知
REPORT.md 由引擎用模板生成，不调用模型。内容：目标、最终状态和原因、总耗时、每一轮的结论和「必须修改」条数、分支名、怎么查看改动和怎么合并的命令。
状态变成 approved、waiting_approval、stopped 时发一条 Windows 桌面通知，写明任务名和状态。用 PowerShell 调系统自带的通知接口，不装额外软件。通知失败不影响运行结果。
8. 命令行
所有命令都在项目根目录运行。不带运行编号时，默认指最近一次运行。
命令作用
crew init建 .crew/tasks/ 和一份带注释的示例任务单，把 .crew/runs/ 加进 .gitignore
crew doctor检查 Node 版本、git、三个工具是否安装及版本、Playwright 是否可用，逐项打勾或打叉
crew doctor --live额外给每个工具发一句测试提示词，确认能拿回回答（会消耗少量额度）
crew validate <任务名>只校验任务单，打印填好默认值后的结果
crew run <任务名>开始一次运行
crew run <任务名> --dry-run不调用任何工具，只打印将要执行的步骤和第一棒的提示词
crew status显示状态、第几轮、正在做哪一棒、已用时间、每一轮的结论
crew approve批准设计，让 waiting_approval 的运行继续
crew resume接着跑一个 stopped 的运行
crew resume --extend-hours 12接着跑，并把时间上限再加 12 小时
运行时终端要显示的内容
每一棒开始和结束各打印一行，让人扫一眼就知道进度：
[10:15:02] 运行 pomodoro-20261116-101500  分支 crew/pomodoro-20261116-101500
[10:15:02] 设计    designer (claude / claude-fable-5-2) 开始
[10:19:40] 设计    完成  4分38秒
[10:19:41] 第 1 轮 实现  builder (codex) 开始
[10:41:07] 第 1 轮 实现  完成  21分26秒  改动 7 个文件
[10:41:30] 第 1 轮 检查  测试通过  截图 2 张
[10:47:12] 第 1 轮 审阅  REVISE  必须修改 3 条
[10:47:12] 第 2 轮 实现  builder (codex) 开始
工人自己的详细输出不打印到终端，只存进 raw.log。错误信息用中文，并且要说明下一步该怎么做。
9. 试点项目：番茄钟网页
试点用一个全新的小项目，和你现有的项目无关，跑坏了也没有损失。选番茄钟是因为它同时有逻辑（能写测试）和界面（能截图审阅），而且一两轮就能做完。
项目要求：一个不需要安装和编译的静态网页，双击 index.html 就能用。计时逻辑放在单独的模块里，不依赖浏览器，可以用 node --test 测试。
项目初始只有三样东西：一个空的 git 仓库、一份空的 DECISIONS.md、下面这份任务单 .crew/tasks/pomodoro.yaml：
goal: |
  做一个番茄钟网页。
  - 25 分钟专注、5 分钟休息，每完成 4 个专注后休息 15 分钟
  - 有开始、暂停、重置三个按钮，显示剩余时间（分:秒）和当前阶段
  - 显示今天已完成的专注次数，刷新页面后不丢失
  - 一个阶段结束时自动进入下一个阶段，并改变页面标题提醒用户
  - 纯 HTML、CSS、JavaScript，不用任何框架和构建工具
  - 计时逻辑写在 timer.js 里，不碰页面元素，用 node --test 测试

roles:
  designer: { tool: claude, model: claude-fable-5-2 }
  builder:  { tool: codex }
  reviewer: { tool: claude, model: claude-opus-5-5 }

flow:
  - design
  - loop: [build, check, review]

checks:
  commands: ["node --test"]
  screenshots:
    - { url: "index.html", width: 1280 }
    - { url: "index.html", width: 390 }

review_checklist:
  - node --test 全部通过，并且覆盖了阶段切换和「第 4 个专注后长休息」
  - 暂停后再开始，剩余时间从暂停处继续，不会跳变
  - 计时用系统时间计算，标签页切到后台再回来不会变慢
  - 390 像素宽的截图里没有横向滚动，按钮没有重叠或被截断
  - 页面上能一眼看出现在是专注还是休息

stop_when:
  max_hours: 24
这份任务单没有写 approve，所以会从设计一路跑到审阅通过，中间不停。因为没有 Gemini CLI，试点不安排调研角色；agy 先只在里程碑 1 里验证能调通。
10. 构建顺序和验收标准
分 5 个里程碑，按顺序做。每个里程碑单独交给实现者，做完由另一个模型对照验收标准审阅。
里程碑 1：实测三个工人，写出适配器
要做的：
建好第 2 节的目录骨架和 package.json。
在真机上逐个实测 claude、codex、agy：从标准输入传提示词、指定型号、只读和可写两种模式、取回最终回答、超时后能杀干净、只读模式下能读图片。
把实测结果写进 README.md 的「工具调用方式」一节，包括实际用的命令和工具版本。和第 4 节表格不一致的地方，以实测为准。
实现四个适配器（含 mock）和 crew doctor、crew doctor --live。
验收标准：
crew doctor --live 对三个工具都打勾，每个都拿回了回答。
只读模式下让工人「在项目里新建一个文件」，文件没有被建出来。
可写模式下同样的要求，文件建出来了，并且只在项目目录内。
把超时设成 5 秒跑一个长任务，进程被杀掉，没有残留进程。
提示词里带中文和换行，工人收到的内容没有乱码。
里程碑 2：最小循环
要做的：tasksheet.js、prompts.js、verdict.js、gitops.js、runlog.js、engine.js，以及 crew init、validate、run、status。检查步骤先只做「跑命令」。
必须有的测试（全部用 mock，在临时目录里建 git 仓库）：
任务单：缺 goal、未知 tool、loop 里缺 review、步骤缺对应角色，各报出带字段名的错误。
结论解析：三种正常结论、带 Markdown 符号、大小写不同、结论不在最后一行、完全没有结论。
引擎：一轮通过；两次 REVISE 后通过（确认第 2、3 轮的提示词带上了上一轮审阅路径）；BLOCKED 立即停；达到 max_rounds 停；连续两轮无改动停；审阅写 APPROVED 但测试命令失败时按 REVISE 处理。
git：工作区不干净时拒绝运行；每轮有一个提交；运行结束后原分支没有任何变化。
验收标准：
npm test 全部通过，且不调用任何真实模型。
在番茄钟试点项目里运行 crew run pomodoro，不用人插手，最终状态是 approved，node --test 通过，双击 index.html 能正常计时。
运行目录里的文件和第 7.1 节一致。
里程碑 3：能长跑
要做的：crew resume（含 --extend-hours）、失败重试、额度用完时暂停、Ctrl+C 处理、max_hours、桌面通知、REPORT.md。
验收标准：
测试：在 build、check、review 三个位置分别中断，resume 后都能跑完，已完成的步骤没有被重做。
测试：第一次失败、第二次成功时能继续；两次都失败时状态是 stopped / step_failed；额度用完时状态是 stopped / quota 且没有重试。
真机：运行中关掉终端窗口，重新打开后 crew resume 能接着跑完。
真机：运行结束时弹出桌面通知。
里程碑 4：视觉审阅
要做的：检查步骤加上截图；审阅提示词带上截图路径；crew approve 和 approve 步骤。
验收标准：
试点项目每一轮都生成了 1280 和 390 两种宽度的截图。
故意在试点项目里制造一个界面问题（比如窄屏下按钮重叠），审阅意见能指出它，下一轮被改掉。
没装 Playwright 时运行不报错，检查结果里写明截图被跳过。
里程碑 5：并入开会
这一步的规格等前四步用顺以后再写。方向是：复用同一套适配器和运行记录，加一个 crew ask 命令和本地网页，并允许任务单里的 design 步骤先开会。
写代码时要遵守的规则
每个模块只做一件事，引擎不直接调用命令行，只通过适配器、gitops、checks。
不读写项目目录以外的任何文件，不改全局配置，不联网（工人自己联网除外）。
不用「跳过权限检查」一类的危险参数启动任何工具。
没有写测试的逻辑不算完成。测试里不调用真实模型。
规格没写到的地方，选最简单的做法，并在 README 的「实现说明」里记一句。规格和实际情况冲突时，停下来说明，不要自己改规格。
交给实现者的开场提示词
每个里程碑用同一段话，只换编号：
请阅读仓库根目录的 SPEC.md（crew 调度器规格说明）。
你的任务是实现第 10 节的「里程碑 N」，不要做后面里程碑的内容。

要求：
1. 先读完整份规格和现有代码，再动手。
2. 严格遵守「写代码时要遵守的规则」。
3. 做完后逐条对照这个里程碑的「验收标准」自查，运行 npm test。
4. 最后输出：做了什么、每条验收标准是否满足及依据、规格里不清楚或和实际不符的地方。
