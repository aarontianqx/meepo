# 飞书真实对话 E2E 测试发现（2026-11-14）

本文是一次真实飞书端到端体验测试的记录与待修清单。§1–§6 保留初始排查现场记录（每项给出现象、证据、根因定位和建议方向），同日修复结论见 §0。设计取舍仍以 `specs/architecture`、`specs/features` 为准；这里的结论可能随代码变化过时，修前先复核。

## 0. 修复状态（同日）

已修复并在真实飞书上复测通过：P1-1（话题内追问不再带根消息引用）、P1-2（`post` 富文本含 `@` 与 markdown 可正常回复；不支持的类型给出提示）、P1-3（bash 与 MCP stdio 子进程不再继承 `MEEPO_*`）、P2-1（发言人解析为显示名，`open_id` 保留）、P2-2（过去的 `at` 被拒绝并带回服务器时间，模型自行修正）、P2-3（提示词说明回复自动送达；唤醒后直接回复，不再调用 `lark-cli`）、P2-4（worker 离线时提示一次，重试不再刷错误日志，worker 回来后正常处理）。各项均有自动化测试；契约已写入 `specs/features` 与 `specs/architecture`，README 增加了联系人读取权限与"每个应用仅一个长连接消费者"。

P2-5（停机补投）已实现：启动时补投最近 24 小时内、已绑定群里错过的 `@bot` 或已接管话题内的消息，不补投 `/new`、不可读类型和私聊；契约见 `interactive-session.md`。P2-6（群成员信任域）决定为文档化：见 `space-and-chat.md` 的"Trust model of group windows"，将来再考虑群内按人授权。

P3 已修：标题与 prompt 不再带 bot 自己的 `@`、引用消息里的 `@` 解析为名字（P3-1/2 类）、分页优先在换行处断开并保持代码围栏闭合、思考面板与工具条只在首张卡片、停止显示"已停止"而非"任务失败"、会话被重置/换绑给出说明、模型错误归类为友好提示（不回显 provider 原文）、失败时仍在转圈的工具条置为失败、读取不存在的记忆返回 `found:false` 而非工具报错、worker 离线期间的重试复用已建的话题而不再每 2s 查找预热消息。

P3 未修（有意）：租约过期造成的约 35s 延迟（设计如此）；预热消息被撤回后的痕迹（需设计）；私聊白名单外静默（规格规定静默）；单独一张图片会触发一轮（设计问题，待定）。

## 1. 环境

- 渠道：ClawFox（飞书自建应用，WS 长连接），绑定群 ClawFox打工群，另有私聊；Space `QA Lab`，模型 `kimi-k2.8-highspeed`。
- 执行面：worker `w1`（标签 linux,dev，2 槽）为主，`w2`（demo box）用于换绑；均在本机，agent 的 bash 直接跑在开发者的 macOS 上。
- 驱动与观察：`lark-cli --as user` 发消息/读消息，Meepo REST API、server/worker 日志、Console（agent-browser）。
- 模型：真实 provider，非 mock。
- 已知混杂因素：同一个 ClawFox 应用另有一个 OpenClaw 消费者在线（卡片页脚 `Agent: main | Model: kimi | Provider: kth`），见 §3.1。

## 2. 结果总览

| 区域       | 场景                                                                                                | 结果                    |
| ---------- | --------------------------------------------------------------------------------------------------- | ----------------------- |
| 路由       | 群内 `@bot` 新话题（prewarm → 话题会话 → 流式卡片）                                                 | 通过                    |
| 路由       | 话题内无需 `@` 续聊；server 重启后话题重新接管                                                      | 通过                    |
| 路由       | 主群无 `@` 忽略；`@` 其它 bot / `@所有人` 忽略                                                      | 通过                    |
| 路由       | 主群引用回复 `@bot` → main 会话（不开话题）                                                         | 通过                    |
| 路由       | 未接管话题中途 `@bot` → 回灌此前话题消息                                                            | 通过                    |
| 命令       | 主群 `/new` 重置；话题内 `/new` 提示不支持；私聊 `/new`                                             | 通过                    |
| 私聊       | 私聊会话；`allowedOpenIds` 不含本人时静默忽略                                                       | 通过（无反馈，见 P3-8） |
| 工具       | bash / read / write / edit、错误与退出码、`seq 200000` 截断（保留末 2000 行并给日志路径）           | 通过                    |
| 记忆       | 写入（署名 agent/session/author）、跨会话检索、非法路径报错后重试                                   | 通过                    |
| 调度       | 一次性 / 循环 CronCreate、CronList、CronDelete；到点唤醒话题会话                                    | 通过，但见 P1-3、P2-2   |
| 工单       | TicketCreate → 执行 → `originSessionId` 关联 → 回执回到原话题                                       | 通过                    |
| 输入       | 图片识别；13.5k 字符长输入；引用消息                                                                | 通过，引用见 P1-1       |
| 并发       | 同话题 4 条快速消息合并为一轮；3 个会话并行（2 槽）                                                 | 通过，合并语义见 P1-1   |
| 输出       | 800 行长答案分两张卡片，序号连续                                                                    | 通过，分页边界见 P3-3   |
| Console    | 流式观察、备注（mailbox）送达后 agent 在群里回复、中断（abort）杀掉子进程、用量                     | 通过                    |
| 故障       | 杀 worker：卡片约 35s 后显示"Worker 连接中断"；worker 离线期间消息，恢复后处理                      | 通过，见 P2-3           |
| 故障       | 错误 API key：卡片显示失败原因                                                                      | 通过，见 P3-6           |
| 换绑       | thread 会话固定在原 worker；main 换绑中断运行轮并冷迁移，历史含"结果未确认"工具结果，agent 如实说明 | 通过                    |
| **丢消息** | **`post` 富文本消息**                                                                               | **失败，见 P1-2**       |
| 未验证     | 飞书里真人点"停止"按钮                                                                              | 未验证，见 §5           |

## 3. 问题清单

严重度：P1 = 用户可见的错误行为或安全问题；P2 = 明显体验缺口或可靠性缺口；P3 = 打磨项。

### 3.1 环境发现：同一应用多个长连接消费者会随机拆分事件

飞书长连接是集群模式：同一应用的多个在线连接，每个事件只投给其中一个。测试中 Meepo 与一个 OpenClaw 网关同时连着 ClawFox。证据：Meepo 停机期间发出的 `@bot ping 8` 被 OpenClaw 回答了；一条话题内无 `@` 的消息 Meepo 从未收到（OpenClaw 只响应 `@`，所以无人应答）。这不是 Meepo 缺陷，但：

- 一个应用只能有一个消费者；测试/生产环境必须保证这一点。
- 建议在 README 的飞书接入段落写明"每个应用只允许一个长连接消费者，否则事件会随机丢失"，并考虑在 Channels 页给出提示。

### P1-1 话题内每条消息都被当作"引用了话题根消息"

- 现象：话题内任何后续消息，prompt 前都带 `<quoted_message>`，内容是话题根消息。例：补充一/二/三（跟在"sleep 25"之后）全都引用了最初的自我介绍问题，模型把补充当作对根问题的追加来回答，而不是对上一条回复的补充。图片消息、话题总结等场景同样带着根消息。
- 根因：飞书会给话题内所有消息设置 `parent_id`（指向话题根），并非真实引用。`executeDispatch` 对任何 `parentId` 都拉取并格式化引用（`feishu-gateway.ts`，`if (msg.parentId)` 段）。kitty 的 CLAUDE.md 记录了同一飞书行为。
- 建议：话题内消息仅当 `parentId !== rootId` 才视为引用；主群（无 `threadId`）的引用回复保持现有逻辑。补回归：话题内普通消息不带引用、引用话题内非根消息仍带引用。

### P1-2 `post`（富文本）消息被静默丢弃

- 现象：`@bot` 的富文本消息（格式化文字、列表、图文混排）事件到达，但没有任何回复或提示。已复现：用 `--markdown` 发 `@ClawFox **...** - 第一项…`，日志显示事件类型 `post`、决策链根本没执行。
- 根因：`normalizeMessage` 只放行 `text` 和 `image`（`feishu-gateway.ts`，`['text','image'].includes(...)`）。飞书客户端在使用格式化、粘贴富文本、文字+图片同发时发出 `post`。
- 建议：解析 `post` 为纯文本 + 图片列表（`at` 节点映射为 mention，`img` 节点进入 images，`md`/`text` 拼接）。对确实不支持的类型（文件、语音、表情包等）至少在话题/私聊内回复一条"暂不支持该类型"，避免静默。

### P1-3 bash 工具继承 worker 进程的全部环境变量

- 现象：让 agent 只列出变量名，返回的 `MEEPO_ENROLLMENT_TOKEN`、`MEEPO_SERVER_URL`、`MEEPO_DATA_DIR` 等都在其中。群里任何成员都可以让 agent 打印这些变量的值。
- 影响：enrollment token 泄露后可冒充 worker 接入同一批 Space（虽然与 workerId 一对一绑定，仍是凭据泄露）。
- 根因：worker 用 `createCodingTools(workDir)`（`session-manager.ts`、`ticket-runner.ts`），bash 子进程默认继承 `process.env`。
- 建议：用 pi 的 `BashToolOptions.spawnHook` 从子进程环境剔除 `MEEPO_*`（至少 token 与 server URL），MCP stdio 子进程（`mcp.ts` 的 `{...process.env, ...c.env}`）同理。是否进一步做白名单由产品决定。

### P2-1 agent 只看到发送者的 open_id

- 现象：prompt 里的发言人是 `ou_xxx`；Console 的会话/私聊标签也显示 open_id。模型无法称呼人，也分不清群里多人。一次测试里 agent 为了知道"我在跟谁说话"，自己用主机上的 `lark-cli` 查通讯录，并把部门信息发到了群里。
- 根因：`normalizeMessage` 中 `senderName: senderOpenId`。
- 建议：用飞书通讯录接口解析显示名（需 `contact:user.base:readonly`），按 open_id 缓存；失败则回退 open_id。话题回灌（`seedThreadHistory`）里的 `authorName` 同样走该解析。

### P2-2 CronCreate 接受过去时间

- 现象：模型心算时间戳，生成了过去的 `at`（`1763093390000` 即 2025-11）。调度立即触发，没有任何错误反馈，Console 里出现"Once, 2025年11月14日"的已完成调度。
- 根因：`scheduler-service.ts` 对 `at` 只校验有限数，不校验未来。
- 建议：agent 工具路径（worker channel 的 cronCreate）对 `at <= now` 返回错误，并在错误文本里带上 server 当前时间，让模型自纠；HTTP API 是否允许"立即触发"另议。

### P2-3 定时/唤醒场景下 agent 不知道普通回复会自动投递

- 现象：调度触发"请在话题里回复提醒"，agent 没有直接回复，而是读 `lark-im` skill、搜 chat_id、翻消息找 thread，最后用主机 `lark-cli` 以 bot 身份自己发了一条，再在卡片里汇报，耗时约 27s 且重复。同类现象：用户说"请回复 X"时（离线恢复测试），agent 也会自己用 `lark-cli` 发一遍。
- 根因：身份 prompt 没有说明"助手的回复文本会自动送达当前窗口，不要通过其它工具发送"；`~/.agents/skills` 里的 `lark-im` 又明确教它用 `lark-cli` 发消息。没有这些 skill 的 worker 上，agent 会更迷茫。
- 建议：`features/prompt-and-context.md` 增加一条渠道交付语义（回复自动投递到本窗口；调度/工单唤醒时同样；需要 @ 某人的写法）。CronCreate 的工具描述里说明唤醒后的回复送达窗口。

### P2-4 worker 离线时用户无任何反馈，且 server 刷错误日志

- 现象：只有 prewarm 文案"正在处理，请稍候…"一直挂着；消息静默排队，worker 回来后才处理。离线期间 server 每 2s 打一条 level-50 `No online worker enrolled for space …`。这是[工作项文档](20261001-meepo-work-items-and-acceptance.md) F7 已记录的缺口，本次复现。
- 建议：离线超过阈值（如 10s）回复一次性提示"worker 离线，已排队"，恢复后无需再提示；离线排队循环不要按 error 逐次打日志（改为状态变化时打一次）。

### P2-5 server 停机期间的飞书事件永久丢失

- 现象：停机期间发的 9 条消息从未被处理，重启后也没有补投。`inbound_inbox` / `processed_messages` 只覆盖已收到的消息。
- 建议：启动时对每个已绑定群/私聊按"最近 N 分钟"拉消息列表，与 `processed_messages` 对账补投（需限制窗口并避免重复回复旧消息）。是否做由产品决定。

### P2-6 群成员等同于 worker 所有者（信任域，需确认是否有意）

- 现象：`allowedOpenIds` 只对私聊生效；绑定群内任何成员的 `@bot` 都能驱动 agent 在 worker 主机上执行 bash、读取任意文件（测试中读到了 `/etc/hosts`，agent 还误称"沙箱允许"），并借用主机上已登录的 CLI 身份（本机 `lark-cli` 的用户令牌）。
- 说明：规格把 worker 视为用户自管的信任域，我们已在添加 worker 的界面标注。但"群成员 ≠ worker 所有者"在群聊场景里更突出，值得在 `space-and-chat` 里明确写出，或提供按发送者的授权开关。这里不预设答案，需要产品决策。

### P3 打磨项

1. 会话标题保留原始 `@ClawFox ` 前缀（Console、会话列表）。
2. 引用内容里 `@_user_1` 占位符没有还原为名字；引用 bot 自己的卡片时，飞书给的扁平文本丢了换行。可改为用 transcript 中同一 `externalMessageId` 的原文。
3. 卡片分页在固定 30,000 字符处硬切，会切进一行、代码块或表格；续卡片重复显示了一遍思考面板。建议按行/段落边界切，并避免重复思考面板。
4. 中断后工具胶囊仍显示 `⏳`；失败文案对不同原因都叫"任务失败"（管理员换绑、server 停机也显示"Worker 连接中断"，实际是 server 在重启）。
5. worker 被杀后卡片仍显示"运行中 + 停止"约 35s，直到租约过期。
6. 模型失败时卡片直接展示 provider 原始响应（`401: {"code":"unauthorized",...}`）；建议归类为"模型调用失败（认证）"并把原文留在日志/Console。
7. 每个话题顶部会留一条"此消息已撤回"（prewarm 撤回的痕迹，真实客户端可见）。可改为编辑 prewarm 消息或接受并写入文档。
8. 私聊 `allowedOpenIds` 拒绝时完全无反馈；可选回复一次"无权限"。
9. 仅图片（无文字）消息会单独触发一轮，然后文字再触发第二轮；常见的"先发图再补一句话"得到两次回答。可考虑对图片做短窗口合并。
10. `MemoryRead` 读不存在的路径在卡片里显示 `⚠️`，看起来像故障；建议返回非错误的 not-found 结果。

## 4. 已验证且无需修改的行为

- prewarm 在卡片出现后被撤回；话题会话固定在首个 worker，换绑后仍留在原 worker。
- main 换绑：运行中的轮次被中断，会话冷迁移到新 worker，历史完整，未确认的工具结果以"Outcome unknown"呈现，agent 如实告知。
- 工单回执回到原话题，`originSessionId` 可追踪。
- 记忆写入署名、修订号、非法路径错误、Console 备注送达均符合 spec。

## 5. 未覆盖与限制

- 上下文压缩（暖/冷）未触发；需要构造超大历史才能覆盖。
- 多发送者归因（群里真人≥2）无法用单一 user 身份模拟；P2-1 修复后需要两个真实账号再测。
- 消息编辑/撤回事件未订阅，按预期无处理，未专门测试。
- 事件重投去重无法在真实飞书上制造，依赖现有单测。

## 6. 建议修复顺序

1. P1-1（引用误判，一处条件，影响所有话题对话质量）、P1-2（post 解析）、P1-3（环境变量清理）。
2. P2-2（`at` 过去时间校验）、P2-3（交付语义 prompt）、P2-1（显示名解析）。
3. P2-4/5 视产品决策；P2-6 需要先决策。
4. P3 按顺序打包处理；顺带更新 `features/space-and-chat.md`（post 支持、引用判定）、`features/prompt-and-context.md`（交付语义）、`architecture/worker-data-plane.md`（bash 环境清理）。
