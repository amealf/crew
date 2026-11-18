# crew 里程碑 5a：会审命令 crew ask

日期：2026-11-18
状态：待实现的增量规格
适用项目：D:\Codex project\co-work\crew（v1.0 基线之上）

本文是 `SPEC.md` 第 10 节「里程碑 5：并入开会」的前半部分。里程碑 5 拆成三步：

| 步骤 | 内容 | 本文 |
| --- | --- | --- |
| 5a | 命令行会审：`crew ask`、追问、总结、写入决议本 | ✅ 本文 |
| 5b | 本地网页：`crew ui`，照 `SPEC.md` 第 11 节的设计稿做会审页和接力页 | 之后另写 |
| 5c | 任务单的 design 步骤可以先开会 | 之后另写 |

5a 只做命令行，但所有数据都存成结构化文件并提供 `--json` 输出，5b 的网页直接读这些文件，不需要再改后端。

本文没写到的地方，沿用 `SPEC.md` 和 README 里已有的规则（UTF-8、提示词走标准输入、路径限定在项目内、不改全局配置、测试不调用真实模型等）。

## 1 会审是什么

一次「会审」（meeting）就是：同一个问题，同时问几个模型，各自读项目后独立回答；你可以只追问其中一个；每轮结束后由一个模型写总结；你决定后，把决定写进项目的 `DECISIONS.md`。之后 `crew run` 的设计者、实现者、审阅者都会读到这条决议（现有提示词已经带 `decisions`）。

所有参会者都用**只读模式**，不能改项目文件。会审不需要 git 分支，也不要求工作区干净。

## 2 命令

所有命令在目标项目的 git 仓库根目录执行。省略会审编号时，使用最近一次会审。

| 命令 | 作用 |
| --- | --- |
| `crew ask "问题"` | 新开一次会审，问所有默认参会者 |
| `crew ask "问题" --with claude:claude-opus-5-5,codex,agy:gemini-4-argon-medium` | 新开会审并指定参会者和型号 |
| `crew ask "问题" --file question.md` | 问题从项目内文件读取（长问题、多行问题用这个） |
| `crew ask "追问" --meeting <编号>` | 在已有会审里再问一轮，发给所有参会者 |
| `crew ask "追问" --meeting <编号> --to codex` | 只追问某一个参会者 |
| `crew ask --retry [编号]` | 只重跑上一轮里失败、超时或中断的参会者 |
| `crew ask ... --no-summary` | 本轮不自动写总结 |
| `crew summarize [编号] [--by claude:claude-opus-5-5]` | 为最近一轮重新写总结，可换总结模型 |
| `crew decide [编号] --adopt <参会者>` | 采纳某位参会者的最近回答，生成决议草稿 |
| `crew decide [编号] --text "决定内容"` | 直接写决议内容 |
| `crew decide ... --title "标题"` | 决议标题，省略时取总结里的推荐标题或内容第一行 |
| `crew meetings` | 列出会审：编号、第一个问题、轮数、最后更新时间、已写决议数 |
| `crew meeting [编号]` | 按轮次打印完整问答、总结、决议 |
| `crew meeting [编号] --json` | 输出 `meeting.json` 的内容，给网页和脚本用 |

`--adopt` 和 `--text` 二选一。`--adopt` 时决议内容是该参会者最近一轮的完整回答，前面加一行「采纳自 <参会者>（第 N 轮）」。命令先把决议全文打印出来，并提示用 `--yes` 确认；带 `--yes` 才真正写入。这样命令行里也有「采纳 → 可改写 → 写入」的步骤：不满意就改用 `--text` 写自己改过的版本。

## 3 参会者

参会者写法：`工具` 或 `工具:型号`，工具只能是 `claude`、`codex`、`agy`、`mock`。

参会者编号（`--to`、`--adopt` 用）：
- 同一工具只出现一次时，编号就是工具名，例如 `codex`。
- 同一工具出现多次（例如两个不同型号的 claude），编号是 `工具-型号`，型号中除字母数字和 `-` `.` 以外的字符换成 `-`。重复的编号报错。

默认参会者按顺序决定：
1. 命令行 `--with`。
2. 项目里的 `.crew/meeting.yaml`（可选，见下）。
3. 都没有时：`claude`、`codex`、`agy`，各用工具自己的默认型号。

```yaml
# .crew/meeting.yaml（可选）
participants:
  - { tool: claude, model: claude-opus-5-5 }
  - { tool: codex }
  - { tool: agy, model: gemini-4-argon-medium }
summarizer: { tool: claude, model: claude-opus-5-5 }   # 省略时用第一个参会者
timeout_minutes: 15                                    # 每位参会者每轮的超时
```

校验规则沿用任务单的风格：未知字段给警告，工具名错误、参会者为空、编号重复报错，错误信息指出字段。`crew init` 生成一份带注释的示例 `.crew/meeting.yaml`，并把 `.crew/meetings/` 加进 `.gitignore`。

已有会审追加轮次时，参会者固定为开会时的名单，`--with` 只用于新开会审，追问时出现 `--with` 报错。

## 4 每一轮怎么跑

1. 生成本轮问题记录，写入 `meeting.json`（先写状态再调用工具，保证中断后能恢复）。
2. **并行**调用本轮所有收件人（全部参会者，或 `--to` 指定的一位），模式 `read`，超时取 `timeout_minutes`。每位参会者有自己的步骤目录，适配器原样使用。
3. 某位失败、超时、额度用完，不影响其他人；各自记录状态。额度用完不重试，其他失败按引擎规则等 30 秒重试一次。
4. 全部收件人结束后：
   - 至少一位成功且没有 `--no-summary`：调用总结模型（只读），写总结。
   - 全部失败：本轮状态 `failed`，不写总结，退出码 2。
5. 终端里按参会者依次打印回答，最后打印总结和提示（例如「采纳请用 crew decide --adopt codex」）。
6. 发一条桌面通知「会审第 N 轮完成」。通知失败只记日志。

`Ctrl+C`：终止所有正在运行的工人进程树，已经拿到的回答保留，本轮状态记为 `interrupted`，退出码 2。之后 `crew ask --retry` 只补跑没有成功的参会者，再写总结。

同一个会审同一时间只能有一个命令在写。用和运行锁相同的本地 IPC 方式加一把**会审级**的锁（名字里带会审编号），不要占用 `crew run` 的项目运行锁：会审只读，可以和 `crew run` 同时进行。

## 5 追问时模型怎么记得前面的内容

三个适配器都是一次性调用（`--no-session-persistence`、`--ephemeral`），不保留会话。所以追问时由 crew 把**这位参会者自己**之前每一轮的问题和回答写进提示词里（不包含别的参会者的回答，保持独立判断）。

参会者如果某轮不是收件人（别人被单独追问），那一轮不进入他的历史。

历史超过 60,000 个字符时，只保留第一轮和最近几轮的完整内容，中间的轮次只保留问题，并在提示词里注明「中间第 X–Y 轮的回答已省略，完整记录见 <路径>」，给出路径让模型需要时自己读。

## 6 文件结构

```text
.crew/meetings/<会审编号>/
  meeting.json
  events.log
  rounds/
    r1/
      question.md
      claude/            # 适配器步骤目录：prompt.md output.md raw.log stderr.log meta.json
      codex/
      agy/
      summary/           # 总结那一棒的步骤目录
      summary.md         # 总结正文（从 summary/output.md 复制）
    r2/
      ...
```

会审编号：`ask-<年月日-时分秒>`，冲突时加 `-2`、`-3`，规则和运行编号一样。

`meeting.json` 通过已有的 `atomicJson` 写入，结构如下：

```json
{
  "meetingId": "ask-20261118-153000",
  "title": "第一个问题的前 40 个字",
  "createdAt": "2026-11-18T15:30:00+09:00",
  "updatedAt": "2026-11-18T15:41:12+09:00",
  "participants": [
    { "id": "claude", "tool": "claude", "model": "claude-opus-5-5" },
    { "id": "codex", "tool": "codex", "model": null },
    { "id": "agy", "tool": "agy", "model": "gemini-4-argon-medium" }
  ],
  "summarizer": { "tool": "claude", "model": "claude-opus-5-5" },
  "rounds": [
    {
      "n": 1,
      "question": "rounds/r1/question.md",
      "to": ["claude", "codex", "agy"],
      "status": "done",
      "answers": {
        "claude": { "status": "ok", "output": "rounds/r1/claude/output.md", "durationMs": 81234, "error": null },
        "codex":  { "status": "timeout", "output": null, "durationMs": 900000, "error": "这一棒超时。" },
        "agy":    { "status": "ok", "output": "rounds/r1/agy/output.md", "durationMs": 64002, "error": null }
      },
      "summary": { "status": "ok", "output": "rounds/r1/summary.md", "by": { "tool": "claude", "model": "claude-opus-5-5" } }
    }
  ],
  "decisions": [
    { "id": "D-004", "title": "前端用纯 HTML 单文件", "round": 1, "adoptedFrom": "agy", "writtenAt": "2026-11-18T15:45:00+09:00" }
  ]
}
```

- 轮次状态：`running`、`done`（至少一位成功）、`failed`（全部失败）、`interrupted`。
- 回答状态：`pending`、`ok`、`failed`、`timeout`、`quota`、`interrupted`。
- 文件路径一律相对会审目录，用 `/` 分隔，方便网页使用。

## 7 提示词

新增两个默认模板，项目可以在 `.crew/prompts/` 下覆盖，规则和现有模板一样（未知占位符报错、空值连同小节删除）。`prompts.js` 的角色白名单加入 `participant` 和 `summarizer`，占位符白名单加入下面用到的名字。

**`prompts/participant.md`**

```markdown
你是一次多模型会审的参会者。你只读不写，不要修改任何文件。其他模型也在独立回答同一个问题，请给出你自己的判断。

## 已有决议
必须遵守状态为 Active 的条目。
{{decisions}}

## 你之前在这次会审中的问答
{{history}}

## 现在的问题
{{question}}

## 要求
需要时先阅读项目代码和文档，回答里引用你看过的文件位置。给出明确的建议和理由；有不确定的地方，说明不确定在哪里、怎样能确认。直接输出正文。
```

**`prompts/summarizer.md`**

```markdown
你是一次多模型会审的记录员。你只读不写，不要修改任何文件。下面是几位参会者对同一个问题的回答，请逐份读完再写总结。

## 问题
{{question}}

## 各参会者的回答
{{answer_paths}}

## 已有决议
{{decisions}}

## 输出格式
依次写这四节：
### 一致
大家都同意的结论，每条注明哪些参会者支持。
### 分歧
每个分歧点写清各方观点和理由，注明参会者。
### 推荐
你建议采用的做法和理由。
### 决议草稿
第一行是 `标题：<不超过 30 个字>`，后面是可以直接写进决议本的内容。
```

`answer_paths` 的每一行格式为 `- <参会者编号>（<工具> <型号或默认>）：<output.md 的项目内路径>`，失败的参会者写 `- <编号>：本轮没有回答（<状态>）`。总结模型自己读文件，避免把很长的回答塞进提示词。

## 8 决议本 DECISIONS.md

格式固定，`crew decide` 只追加，不修改已有内容：

```markdown
## D-004 前端用纯 HTML 单文件
- 状态：Active
- 日期：2026-11-18
- 来源：会审 ask-20261118-153000 第 1 轮，采纳自 agy

（决议内容）
```

- 编号：扫描文件里所有 `## D-<数字>` 标题，取最大值加 1，三位补零；文件不存在时新建，从 `D-001` 开始。
- 文件末尾没有换行时先补一个空行再追加。
- 写入后同时更新 `meeting.json` 的 `decisions`。两步都完成才算成功；写决议本成功但更新 `meeting.json` 失败时，下次 `crew decide` 前检测到「决议本里有本会审的编号但 json 没有记录」，补记，不重复写入。
- 提醒用户：写入后项目工作区会多一处改动，`crew run` 前需要提交。命令结束时打印一行 `git add DECISIONS.md && git commit -m "Add decision D-004"` 供复制。
- 状态只写 `Active`。作废、替换决议本次不做，人直接编辑文件即可（把状态改成 `Superseded`）。

## 9 适配器和 mock 的改动

- 三个真实适配器不需要改。
- mock 需要支持并行：`CREW_MOCK_SCRIPT` 的 JSON 可以是数组（现有行为），也可以是对象 `{ "<键>": [回答...] }`。对象形式时按 `model` 取对应数组，每个键有独立游标（游标文件里按键记录）。测试里用 `--with mock:a,mock:b,mock:c`，参会者编号为 `mock-a`、`mock-b`、`mock-c`。
- 并行调用 mock 时，游标文件的读写要排队，不能两次调用读到同一个索引。

## 10 不做的

- 网页界面（5b）、design 步骤先开会（5c）。
- 参会者之间互相看到对方的回答、多轮辩论。
- 会审过程中改项目文件。
- 修改或删除已有决议。
- 流式显示回答（回答完成后整段打印即可）。

## 11 必须有的测试（全部用 mock）

1. 新开会审：三位 mock 参会者并行回答，`meeting.json`、问题、回答、总结文件齐全，轮次 `done`。用 `delayMs` 证明是并行（三位各 1 秒，总耗时明显小于 3 秒）。
2. 一位超时、一位额度用完、一位成功：成功的回答保留，总结只引用成功的回答，失败的写明状态；额度用完的没有重试。
3. 全部失败：轮次 `failed`，没有总结，退出码 2。
4. `--to` 单独追问：只有这一位被调用；他的提示词里带上第 1 轮自己的问答，不带其他人的回答；其他参会者的历史里没有这一轮。
5. 历史超过上限时按第 5 节省略中间轮次，提示词里有完整记录路径。
6. 中断：在本轮进行中触发中断，已完成的回答保留，状态 `interrupted`；`crew ask --retry` 只调用没完成的参会者，然后写总结。
7. `--with` 校验：未知工具、重复编号、追问时带 `--with` 都报错；`.crew/meeting.yaml` 未知字段给警告。
8. `crew decide`：不带 `--yes` 不写文件；带 `--yes` 追加到 `DECISIONS.md`，编号从已有最大值加 1；文件不存在时新建为 `D-001`；`--adopt` 的内容等于该参会者最近一次成功回答；`meeting.json` 记录了决议。
9. 写决议本后模拟 `meeting.json` 更新失败，再次执行时补记，不重复追加。
10. 同一会审两个命令同时写时，第二个报「这个会审正在进行」；会审运行中 `crew run` 的项目锁不受影响。
11. `crew meeting --json` 输出可被 `JSON.parse` 解析且和文件内容一致；`crew meetings` 按更新时间倒序。
12. 现有 66 项测试全部继续通过。

## 12 验收标准

- `npm test` 全部通过，且不调用真实模型。
- 真机（用户自己在 PowerShell 里跑，会消耗额度）：
  1. 在番茄钟试点项目里运行 `crew ask "这个项目下一步最值得加的功能是什么？说明理由"`，三个工具都拿回回答，并生成总结，总结里有「一致 / 分歧 / 推荐 / 决议草稿」四节。
  2. `crew ask "你的方案具体要改哪些文件？" --to codex`，只有 Codex 被调用，回答能接上它第 1 轮说的内容。
  3. `crew decide --adopt codex --yes`，`DECISIONS.md` 多出一条格式正确的决议。
  4. 提交后运行 `crew run pomodoro --dry-run`，打印出的设计者提示词里能看到这条决议。
  5. 中文问题、多行问题（用 `--file`）都没有乱码。
- README 增加「会审」一节：命令、参会者写法、文件结构、决议本格式，和真机验证记录。

## 13 交给实现者的开场提示词

```text
请阅读仓库根目录的 SPEC.md（crew 调度器规格说明）和 docs/specs/milestone-5a-ask.zh.md（本次增量规格）。
你的任务是实现增量规格里的「里程碑 5a：会审命令 crew ask」，不要做 5b 网页和 5c 设计步骤开会。

要求：
1. 先读完两份规格和现有代码，再动手。尽量复用现有的适配器、runlog.js 的 atomicJson 和锁、prompts.js、notify.js，不要复制一份。
2. 严格遵守 SPEC.md 第 10 节「写代码时要遵守的规则」。
3. 做完后逐条对照增量规格第 11 节「必须有的测试」和第 12 节「验收标准」自查，运行 npm test。真机验收的命令列出来交给我自己跑，你不要调用真实模型。
4. 最后输出：做了什么、每条测试和验收标准是否满足及依据、规格里不清楚或和实际不符的地方。
```
