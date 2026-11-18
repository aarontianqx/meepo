# 项目指令与技能来源方案（提案，2026-11-18）

状态：S1–S4 均已实现。实现与本文的差异：带入段只列出项目根目录，不含 git 远程和分支；预算数值由 worker 配置（`projectInstructionFileBytes` / `projectInstructionTotalBytes`），不在服务端。以常青文档和代码为准。起因是在 happy1 部署时发现 worker 把本机 `~/.agents/AGENTS.md` 和 `~/.agents/skills` 无条件拼进所有会话的系统提示词，而 Meepo 是"全局 agent"，没有 pi 那样的启动目录，项目 AGENTS.md 没有可靠的落点。

## 1. 背景与问题

现状（`apps/meepo-worker/src/agent/prompt.ts` 的 `renderPrompt`）：

- 读 `~/.agents/AGENTS.md`，原文作为 `Local operating instructions` 拼进系统提示词。
- 扫 `~/.agents/skills/<name>/SKILL.md`，用手写正则取 `description`，生成索引。
- 目录写死为 `homedir()/.agents`，不可配置；扫描顺序是 `readdir` 的原始顺序，没排序。
- 不读项目里的 AGENTS.md。会话启动时工作目录是空的 `~/.meepo/.../<session>`，项目是 agent 在任务中 clone 或建 worktree 之后才出现的。

具体后果：

1. 一台 worker 上的个人规则和 34 个技能（例如 `glab`、`lark-*`）会进入所有绑定了该 worker 的群的会话，群成员能间接使用它们。
2. 系统提示词里 skills 的顺序取决于文件系统，同一份目录在不同机器上字节不同，影响提示词前缀缓存。
3. agent 先去了项目 A，之后才发现用户要谈项目 B。项目的约定（构建、测试、风格）没有任何通道进入对话。
4. 没有跨 space 的全局规则，也没有 space 级的"要求 agent 怎么做"的自由文本，只有 `description` 和 `promptPreset`。

## 2. 目标与非目标

目标：

1. 指令按权威性分层：全局、space、项目，各自的刷新和丢失语义明确。
2. 项目指令不进入系统提示词，不破坏前缀缓存，也不"定型"在错误的项目上。
3. 压缩后项目指令不丢，内容保持最新。
4. 项目指令的权威始终停留在消息层，不提升为系统级规则，因此不需要"受信任仓库"机制。
5. 服务端不管仓库、不知道 worker 的目录布局。
6. 来源目录可配置，默认不混入个人 `~/.agents`；skills 解析复用 pi，不再自己维护正则。

非目标：

- 不引入 pi 的 `DefaultResourceLoader`、`SettingsManager`、扩展或包管理器；它们面向交互式 CLI，会带来包安装等不需要的行为。
- 只认 `AGENTS.md`，不读 `CLAUDE.md`、`AGENTS.override.md`、`.cursorrules`。
- 不改变 space 的 `description` 和 `promptPreset` 语义。
- 压缩时机的统一（见第 7 节）不在本提案内。

## 3. 调研结果

### 3.1 pi（读源码）

- **全局 AGENTS.md**：`~/.pi/agent/AGENTS.md`（或环境变量指定的 agent 目录），加上沿 cwd 向上各级目录的 AGENTS.md；文件名按 `AGENTS.override.md`、`AGENTS.md`、`CLAUDE.md` 顺序取第一个。拼进系统提示词的 `project_context` 段，没有大小上限。**只在启动时加载一次，没有运行中的懒发现。**
- **skills**：`~/.pi/agent/skills`、`~/.agents/skills`、项目 `.pi/skills`、向上各级 `.agents/skills`；标准校验（name、description）、递归、`.gitignore`、符号链接去重、同名冲突诊断、`disable-model-invocation`。
- **可复用性**：`loadSkillsFromDir`、`loadSkills`、`formatSkillsForPrompt`、`loadProjectContextFiles` 是公开导出的纯函数，不依赖 session。`~/.agents/AGENTS.md` 这个路径不是 pi 的约定，是我们自己定的。
- **Meepo 目前复用的层**：`pi-agent-core` 的 `Agent`、`pi-ai` 的模型流式调用、`pi-coding-agent` 的 `createCodingTools`。系统提示词、compaction 和会话持久化都是自己的。
- **对比实验**：用 pi 的 `loadSkillsFromDir` 解析本机 46 个真实 skills，名字和 description 与我们手写的结果一致，只有尾部 1 个换行的差别，没有诊断警告。所以当前手写实现不是紧迫风险，换成 pi 的收益是校验和后续演进，不是修 bug。

### 3.2 Hermes（读源码）

- `agent/subdirectory_hints.py` 的 `SubdirectoryHintTracker`：每次工具调用后检查路径参数和 bash 命令里的路径，从被触碰目录向上最多 5 级，发现 AGENTS.md、CLAUDE.md、`.cursorrules` 就追加到**该次工具结果文本**后面（`[Subdirectory context discovered: <path>]\n<内容>`）。系统提示词不动，缓存保持。
- 内容摘要去重，每文件 32,000 字符上限（注释说明与 Codex 的 `project_doc_max_bytes` 默认值一致），与启动上下文同一套注入扫描，只允许启动工作目录之内的目录。
- 启动时的上下文文件（`prompt_builder.py`）上限默认 20,000 字符，没有显式配置时按上下文窗口的 6% 动态放大。
- 缺口：tracker 只在 agent 初始化时创建，压缩流程没有重置它。压缩后已注入的子目录指令随历史被压掉，tracker 却认为发过了，不会再发（读代码推断，未在运行中验证）。

### 3.3 其他

Claude Code、Codex、Cursor 的落点（工具结果、用户消息或提醒块）凭记忆不确定，本文不作为依据。共同点是主流做法不改系统提示词，指令通过消息层带入。

## 4. 方案

### 4.1 指令分层

| 层         | 内容                                                   | 位置                         | 刷新                     | 压缩后                       |
| ---------- | ------------------------------------------------------ | ---------------------------- | ------------------------ | ---------------------------- |
| 全局指令   | 服务端数据库中的全局设置，由全局 admin 在 Console 编辑 | 冻结的系统提示词             | 会话创建时冻结           | 不受影响                     |
| space 指令 | space 新增的 `instructions` 字段，由 space 成员编辑    | 冻结的系统提示词             | 会话创建时冻结           | 不受影响                     |
| 技能索引   | worker 配置的技能目录                                  | 系统提示词（冷启动时渲染）   | 冷启动                   | 不受影响                     |
| 项目指令   | 仓库里的 AGENTS.md                                     | 先在工具结果，压缩时带入摘要 | 懒发现；压缩时从磁盘重读 | 带入摘要所在的 `system_note` |

渲染顺序：全局在前，space 在后，不设人为字节上限（载荷受协议边界约束时按协议处理）。修改只影响新会话或 `/new` 之后，Console 里明确标注。`description` 保持"这个 space 是什么"，`instructions` 负责"怎么做"。

原则：不会丢的放系统提示词；会丢但可恢复的放消息层。硬性规则（安全、权限、必须遵守的流程）只能放前几层，项目 AGENTS.md 只放"这个仓库怎么构建、测试、有什么约定"。

_Rationale：工具结果和 `system_note` 都是消息层，权威低于系统提示词。把"不可违反的规则"放在会被压缩、效力较低的位置，等于没有规则；反过来把不可信仓库的文字放进系统提示词，就需要判断信任，而仓库和目录布局不该由服务端管理。_

### 4.2 项目指令的懒发现

1. **触发**：对文件类工具（read、write、edit、grep、find、ls）的 `path` 参数，加上 bash 命令里的路径（绝对路径、以 `./` 或 `../` 开头的词、`cd` 的目标）。路径必须真实存在，并且位于某个 `.git` 根之内才算发现；不存在的路径、`.git` 之外的路径、URL、选项一律忽略。
2. **范围**：从被触碰路径所在目录向上找，到最近的 `.git` 根为止，收集沿途的 `AGENTS.md`（精确文件名，每目录一个）。没有 `.git` 时只认会话工作目录这一层，不读仓库之外的文件（例如 `~/AGENTS.md`）。
3. **追加**：对尚未发过的文件（以"路径 + 内容摘要"判重），把内容追加到该次工具结果后面，并带作用范围标记和机器可读的摘要：

   ```text
   [Project instructions: /w/repo/AGENTS.md sha256:3f2a9c1d — applies to files under /w/repo]
   <内容，单文件上限 16 KiB，超出时截断并注明路径>
   ```

4. **会话和 ticket 共用同一个工具包装**。ticket 每次尝试在全新目录里运行，去重记录只在该次运行内有效。
5. 追加发生在工具包装层、记录工具结果事件之前，所以标记和内容随工具结果一起进入服务端的规范事件。

_Rationale：先去了项目 A、后来才发现要谈 B 时，系统提示词仍是通用的，不存在定型在错误项目上的问题；A 的指令只作为 A 范围内的消息留在历史里。追加发生在对话尾部，前缀不变，缓存不失效。没有启动根，所以用"最近的 `.git` 根"代替 Hermes 的"启动工作目录"作为边界。_

### 4.3 压缩时带入

压缩改写了历史，压缩前追加在工具结果里的项目指令会被压掉。压缩时，worker 把近期项目的指令作为另一个小节，放进压缩摘要所在的同一条 `system_note`，不单独加消息：

```text
<system_note>
[Summary of earlier events]
……
[Project instructions carried over]
<project root="/w/B" branch="main">
/w/B/AGENTS.md sha256:… — applies to files under /w/B
……
</project>
<project root="/w/A" branch="main">
……
</project>
</system_note>
```

规则：

1. **内容从磁盘重读**，不复用之前追加过的文本，保证带入的是此刻的最新版本。目录或文件不存在（例如 worktree 被删、换了 worker）时静默跳过。
2. **预算**：总量上限 32 KiB，单文件上限 16 KiB，超出单文件上限时截断（保留开头，末尾加一行 `[truncated; read <path> for the rest]`）。两个数值由 worker 配置（`worker.toml` 或环境变量），默认值如上。
3. **装入顺序**：
   - 第一轮：各项目的根目录 `AGENTS.md`，项目按最近触碰顺序，从新到旧；
   - 第二轮：各项目的子目录 `AGENTS.md`，按最近触碰顺序，从新到旧；
   - 预算用尽即止。一个项目超了，不整个丢弃：根目录文件优先，其余按最近触碰保留。
4. **去重**：保留的最近消息里如果仍有某个项目的追加文本（摘要相同），带入段跳过该项目。压缩后再触碰某项目，磁盘内容摘要与已带入的相同则不再追加，不同才追加新版本。
5. 没有 AGENTS.md 的仓库也记录根目录、git 远程和分支，几十个 token，让模型知道自己在哪个项目里。
6. 项目指令只作为带来源标记和作用范围的数据进入上下文，与现有的"文件和工具输出视为数据，不得覆盖用户指令"规则同级，不提升为系统级权威。

_Rationale：只靠工具结果，压缩会让项目指令消失而去重记录仍以为发过。合并进摘要所在的 `system_note` 不增加新的消息边界。重新读磁盘避免带入过期内容。_

### 4.4 当前项目标记

项目标记只描述"现在在哪个项目"，走每轮信封，与现有的 `<current-time>` 同层：

```text
<active-project root="/w/repo" branch="main"/>
```

由最近一次触碰的项目根推出，只在变化时带上。它出现在轮次尾部，不影响前缀缓存。

### 4.5 状态与恢复

"碰过哪些项目、哪些指令已发"只是一个运行期缓存，权威是服务端的规范事件：

- **热会话**：worker 在内存里直接使用，不单独持久化。
- **冷启动**（空闲回收、worker 重启、换 worker、space 重新绑定）：从已经读到的事件里扫描注入标记，还原项目列表和已发摘要。冷启动只读最近一次压缩缓存之后的事件，所以缓存之前碰过且之后没有再碰的项目不还原，agent 再触碰时重新注入；这些项目在摘要里仍有文字提及。
- 不新增服务端字段、不新增 worker 协议方法。这是当前阶段的决定；项目列表的持久化位置（例如存进压缩记录）留待后续，如果发现这类丢失频繁再考虑。
- 换 worker 后路径可能不存在，读取失败静默跳过。

_Rationale：同一份信息存两处会不一致。注入的文字本来就在工具结果事件里，标记让它可以被机器重新读出，不需要另存。_

### 4.6 技能与目录配置

1. **skills 解析**：改用 pi 导出的 `loadSkillsFromDir({ dir, source })`，获得标准校验、`disable-model-invocation`、递归和 ignore 规则。**格式化仍由我们拼**，不用 `formatSkillsForPrompt`，避免 pi 升级时改变提示词字节。
2. **排序**：对 skills 按名字排序后再渲染，使同一目录在任何主机上渲染结果相同。
3. **全局 AGENTS.md**：由服务端分发（见 4.1），不再从 worker 本机读 `~/.agents/AGENTS.md`；worker 本地不再有全局指令文件。
4. **技能目录可配置**：worker 配置增加技能目录，默认指向 Meepo 自己的目录（例如数据目录下的 `agent/skills`），而不是个人 `~/.agents`；显式配置时才读个人目录。这样一台既是开发机又是 worker 的主机不会把个人规则带进群。

## 5. 分期建议

1. **S1 技能与目录**：skills 解析换成 `loadSkillsFromDir`、排序、worker 技能目录可配置且默认隔离。改动小，独立于其余部分。
2. **S2 服务端分发的全局和 space 指令**：全局设置存数据库并在 Console 编辑；space 增加 `instructions`；二者进入冻结身份块。
3. **S3 项目指令懒发现**：工具包装层追加、标记、去重；会话和 ticket 共用；冷启动按标记还原。
4. **S4 压缩带入与当前项目标记**：压缩时在摘要的 `system_note` 里带入项目指令，`<active-project>` 信封。

S1 与 S2 可以先做，彼此独立。S4 按现有的两个压缩点（冷启动压缩、轮次前的热压缩）实现；以后统一压缩时机（见 [统一压缩时机](./20261118-compaction-timing.md)）只改调用点，带入逻辑不变。

## 6. 已决事项

1. 全局和 space 指令：数据库存储，Console 编辑；全局由全局 admin 管理，space 由 space 成员管理；会话创建时冻结。
2. 路径提取：文件类工具的 `path` 加 bash 里的受限路径（真实存在、位于 `.git` 根之内）。
3. 预算：总 32 KiB，单文件 16 KiB（超出截断），根目录文件优先，其余与项目之间按最近触碰；数值可配置。
4. 没有"受信任仓库"机制；项目指令不提升，压缩时带入同一条 `system_note`，内容从磁盘重读。
5. 文件名只认 `AGENTS.md`。
6. ticket 也做懒发现，与会话共用工具包装。
7. 冷启动从事件中的标记还原，不加服务端字段。

## 7. 后续（另见 [统一压缩时机](./20261118-compaction-timing.md)，S4 完成后讨论）

- **统一压缩时机**：现在会话的压缩只在每个轮次开始前运行一次（`maybeCompactHistory` 在 `agent.prompt` 之前），不在工具循环里；ticket 整个任务是一个轮次，且明确禁用了压缩器（代码注释写的是"omit to disable (tickets, tests)"，规格里没有对应的设计理由）。单个长轮次因此没有任何压缩机会。pi 的 `Agent` 提供了每次调用模型前改写消息的 `transformContext` 钩子，可以让会话和 ticket 共用同一套压缩。本提案的 S4 在该变化后自动覆盖 ticket 和长轮次。

## 8. 对常青文档的影响（落地时更新）

- `features/prompt-and-context.md`：系统提示词里的全局指令和 space 指令、轮次信封的 `<active-project>`、压缩摘要 `system_note` 里的项目指令小节、项目指令追加到工具结果的格式。
- `architecture/worker-data-plane.md`：工具包装层追加项目指令的规则、预算、冷启动还原、worker 技能目录配置。
- `architecture/domain-model.md`：space 的 `instructions` 字段、全局设置。
- `architecture/control-plane-api.md`：全局指令设置和 space 指令的编辑接口。
- `features/console.md`：全局指令页和 space 指令编辑，标注"仅对新会话生效"。
- `README.md`：worker 技能目录配置项。
