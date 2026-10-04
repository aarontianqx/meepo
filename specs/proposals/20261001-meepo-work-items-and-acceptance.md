# Meepo 工作项与验收

更新：2026-10-01。本文是工作状态、验收证据、已知缺口的唯一汇总；设计取舍见[规划与决策](20260930-meepo-planning-and-decisions.md)，具体契约见 architecture/features。

## 1. 已实现范围

W 编号保留用于关联[设计讨论](20260928-meepo-v2-design-brainstorm.md)，不表示产品版本。下表记录已实现能力；不替代第 5 节列出的缺口及真实验收空缺。

| 工作项               | 已实现内容                                                                               | 验收依据                                                    |
| -------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| W0 执行与协议基础    | Run/Turn、ACK/重放、事务队列、日志恢复、context.append、协议版本校验、测试替身及 CI 配置 | 跨模块故障回归、真实 server 重启与执行恢复                  |
| W0b 渠道             | ChannelRegistry、逐渠道连接、私聊/群路由、凭证加密、enrollment 与 worker ID 绑定         | 注册表/鉴权/多渠道隔离自动化；ClawFox 实测；真实双 bot 未测 |
| W1 可靠性            | 租约、迟到事件围栏、安全重试/manual_review、原子 schedule fire、main 换绑与 `/new`       | 故障回归、双 worker 换绑实测、pending 超时回归              |
| W2 记忆              | 条目/修订/tombstone、中文检索、五工具、Memory Map、console 编辑与冲突                    | 真实读写检索、revision 冲突、ticket 读取                    |
| W3 提示词            | 两级组装、coding preset、身份冻结、本地规则/skills 冷刷新、快照、每轮时间                | prompt/history 回归及冷恢复实测；无人值守歧义规则仍待补     |
| W4 控制台            | 会话/任务轨迹、Schedules、Memory、Models、Channels、成员、token、usage、mailbox          | HTTP 权限回归与浏览器功能验收                               |
| W5 输入与卡片        | 文本/引用/图片、流式思考和正文、tool pills、长卡片、发起人 Stop 权限、发送恢复           | 图片和长卡片实测、自动化取消/卡片回归；真实 Stop 点击未测   |
| W6 Ticket 可观测性   | 按 attempt 保存执行事件，结果回执进入 origin session，console 查看轨迹                   | ticket/MCP 实测、回执去重及状态围栏回归                     |
| W7 Worker 配置与 MCP | 文件配置/env 覆盖、stdio/HTTP MCP、热重载、slots、清理与正常退出保留                     | 配置/slot/媒体回归；stdio 真实模型调用，HTTP 本地协议服务   |
| W9 PostgreSQL        | **明确延期，当前 SQLite**                                                                | 未安装数据库服务或 Docker 镜像                              |
| W10 Webhook          | 成员或 space bearer secret 创建 ticket，凭证轮换/撤销                                    | HTTP 鉴权回归、真实 webhook ticket                          |

## 2. 最新质量门禁

以下来自 **2026-10-03 第四轮评审修复后的执行**。

| 检查               | 结果                                                                |
| ------------------ | ------------------------------------------------------------------- |
| `pnpm check`       | 20 项任务通过；server 194 + worker 71 = **265 项测试**              |
| `pnpm build`       | 6 项任务通过                                                        |
| `git diff --check` | 通过                                                                |
| 数据库             | schema 18；新增索引、webhook 请求去重与摘要缓存表                   |
| 本机运行检查       | 常驻 server/worker 保持停止；本轮以隔离组合测试验证，不冒充部署验收 |

自动化覆盖入口：

- [SQLite 跨模块故障测试](../../apps/meepo-server/src/store/sqlite/__tests__/v2-acceptance.test.ts)：去重/重启、队列合并、租约/副作用、fire 原子性、换绑/reset、记忆/回执、历史恢复、手动与自动重试计时、完成/取消竞争及幂等回执。
- [HTTP 组合测试](../../apps/meepo-server/src/transport/http/__tests__/authorization.test.ts)：空间/角色边界、webhook token、claimed/running 取消、权限及重复请求、abort 下发及终态拒绝、delivery 只允许 wait。
- [ticket 存储测试](../../apps/meepo-server/src/store/sqlite/__tests__/ticket-sqlite.test.ts)：迁移与持久化；worker `agent/__tests__` 覆盖工具/slot/取消/模型/媒体/MCP。
- Feishu transport 测试覆盖路由、回调授权、卡片序列/分页、输入去重与重试。CI 工作流已配置，未声称远端 CI 已运行。

最近门禁日志：`/tmp/meepo-r4-check.log`、`/tmp/meepo-r4-build.log`。临时日志不属于持久交付物。

## 3. 真实场景验收

主要执行于 2026-09-30，2026-10-01 补过一次真实群消息 smoke。测试主体 ClawFox，群为 ClawFox打工群，模型 `kimi-k3-0829-highspeed`。没有使用飞书网页登录态，没有替换 lark-cli 登录。这些是历史执行证据，不代表每轮代码/文档修改后重测。

| 场景                       | 结果与定位证据                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 群 @bot → 回复             | 通过；run `2c29ffd0-db60-4187-9817-99e2b7ad096d`                                                                           |
| 中文记忆读写检索           | 通过；run `a6625041-379a-4d63-bec0-d3f237d270d5` 命中“重试”                                                                |
| Console 修改 → ticket 读取 | 通过；ticket `9002446a-6415-4a71-84ef-e783092a38d6` 读取 revision 2，并验证幂等键/回执/轨迹                                |
| 忙时三条消息               | 合并到 run `e54a2256-22cb-411c-a5ee-1e58afb8801b`，另外两条 run 为 merged                                                  |
| 图像                       | 消息 `om_x100b64e579d1c0acddaad9c8d5852df`，正确识别红方块和蓝圆                                                           |
| Mailbox                    | 原窗口收到测试回复                                                                                                         |
| 冷恢复                     | 消息 `om_x100b64e534f554a4c29e75eb70d7ebd`，恢复图像、工具历史及当前记忆                                                   |
| 定时唤醒                   | schedule `9a8ab65e-5dd1-4338-8deb-67beef6d4ffa` 完成                                                                       |
| Webhook                    | 成员鉴权 ticket `a90b0ec5-6a69-4bbc-898a-6b5097add3b6`；bearer ticket 见 MCP 行                                            |
| 长卡片                     | 脚本生成超过 30,000 字符内容，产生两张卡片，序列单调，无 API 错误                                                          |
| 执行中 server SIGKILL      | run `143ab36d-61f1-45c4-87d8-0f407f69aac2` 的 worker 保持任务，重连后继续；随后 `/new` 中断                                |
| `/new`                     | 消息 `om_x100b64e5f88e98a0c42102517021da0`，旧会话关闭、日程取消、新 main 与确认 outbox 正常                               |
| MCP                        | session 和 ticket 真实调用 stdio `mcp__qa__echo`；bearer ticket `de709a02-28b9-4d3f-a492-d55238816efc` 同时调用 MemoryRead |
| 双 worker 换绑与绑回       | main 两次中断并迁移输入；thread 保持原 worker 并完成。两 worker 不等于两 bot                                               |
| Console 修订冲突           | revision 2 草稿与服务器 revision 3 冲突时保存被拒，保留草稿；Reload 后显示 revision 3                                      |
| 引用消息                   | run `ea458c8b-29ee-47ba-9dde-c44ee0477648` 的输入包含 quoted_message sender/body，读取 revision 3                          |
| 用量                       | API/页面显示 provider 报告的 input/output tokens 和报告覆盖；没有 cost 数据时不推算费用                                    |
| 10 月 1 日 smoke           | run `e42cc81e-9de5-4a18-a31c-448f2ccc1441` 完成，MemoryRead 后回复 `REVIEW_1001_OK`，card replied=true、pending=0          |

截图与辅助证据曾保存在本机 `/tmp/meepo-v2-evidence/`（vision、ticket-trace、memory-conflict、card-rotation、rebind 等）；路径是实际历史文件名，不是产品版本划分。临时材料可能被清理，保留上述消息、run、ticket ID 便于定位。

先前 smoke 使用的空间 effort 为 low；用户此后指定真实模型测试用 high。F11 真实验收已将测试空间设置为 high，并使用新 ticket 执行；没有将此前 low 测试改记成 high 验收。

## 4. 已闭环的审查问题

| 范围            | 已完成修复 / 验证                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 调度与并发      | queue/receipt/schedule 逐项失败隔离；ticket 首个 worker 预留失败后继续候选；session expected status/binding 防止旧写覆盖                                              |
| 取消与资源      | 等待真实执行退出后释放 runner/tools；slot 等待可取消；冷启动/图片/压缩期间取消不会继续 prompt                                                                         |
| 卡片与恢复      | canonical 文本边界修复增量重复；无内容终态清理；runId + toolCallId 配对历史；合并作者稳定归因                                                                         |
| 媒体与配置入口  | 共享原图缓存不随任务目录清理；移除失效的无 channel 群绑定 API；HTTP 空体及管理字段验证                                                                                |
| 重试时钟        | `pendingSince` 覆盖创建、定时创建、手动/自动重试与旧库迁移；满本轮 24h 才 unclaimed                                                                                   |
| Delivery 与规范 | HTTP 只允许 wait；图片可选元数据、中文降级文案与缓存规范统一；过时注释清理                                                                                            |
| 取消评审误报    | 已证实 SQLite save 设置 run 的 cancelled 原因，随后 abort 按原因筛选；新增生产组合测试。没有采用“仅向非终态 run 发 abort”的错误改法                                   |
| 文档整合        | 已检查全部 architecture/features；补跨实体事务、模型 effort、生效时机等契约；修正不存在的 SSO/mark-completed/HTTP memory proxy 等表述。移除废弃方案并将状态集中在本文 |

### F11：running ticket 取消（已完成，2026-10-01）

- 用户确认本次补齐 Console + API。现有 cancel 接受 running；重复请求保持原状态/时间并可重发 abort。已完成/失败的 ticket 不会被覆盖，取消不触发自动重试。
- 自动化：新增 running HTTP 组合场景、并发重复取消与迟到完成、完成抢先提交三项回归；权限与幂等回执受检查。worker 中断回归确认无 completed 事件并释放 slot。
- 真实验收：`kimi-k3-0829-highspeed`、effort **high**，ticket `72f9e391-b4e6-4acb-bc38-57f873b41d3a`，run `7afc3dcf-4319-46ec-9d88-ec907f6a253c`。模型调用 bash 启动 120 秒长命令，agent-browser 点击 Console 的 Cancel ticket；ticket=cancelled，run=failed(cancelled)，子进程实际退出，末尾完成标记未生成，worker activeSlots 回到 0。取消按钮在终态消失，重复 API 取消保持原时间。
- 本机证据：`/tmp/meepo-ticket-cancel-evidence.json`、`/tmp/meepo-ticket-cancel-console.png`。没有添加飞书 ticket 管理卡片，飞书真实会话 Stop 点击仍未验证。

## 5. 未完成、待定和延期项

### 验收边界

| 项目                      | 状态与原因                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| 飞书真实 Stop 点击        | **未验证**。请求人工协助后有界等待未发生点击；自动回调/abort 回归和真实 `/new`/换绑中断不替代按钮点击验收 |
| 真实双 bot                | **未验证**。CLI 同样属于 ClawFox，缺第二 app 凭据；自动多 channel 隔离通过                                |
| 容量压测                  | **未执行**。不能外推大规模事件历史、并发和长期运行性能                                                    |
| PostgreSQL / 多副本 / SSO | **明确延期**；当前 SQLite 单实例与开发身份 adapter                                                        |
| 生产远端 MCP              | 未提供目标；HTTP transport 用本地协议服务验证，stdio 已用真实模型验证                                     |

### 后续工作清单

| ID  | 工作项                      | 完成条件 / 当前状态                                                                                                                   |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | 明确 ticket 跨实体事务 port | 保存 ticket、run fencing、receipt 原子性可从接口看出；新 adapter 通过同一组合回归。文档已补，接口收敛未做                             |
| F2  | 统一 worker ready 门控      | 消除 register/reconcile 前后由周期 sweep 提前 flush/派发的路径；保留 worker 本地执行检查，并验证重连 ACK/派发次序                     |
| F3  | 收敛非事务兼容路径          | 将 StreamProcessor、DispatchService、SchedulerService 依赖旧路径的测试迁到生产事务语义，删除兼容分支及 bootstrap 非原子 fire fallback |
| F4  | 历史查询规模治理            | 已补租约/卡片周期查询、worker 对账筛选、SQL usage 聚合、增量事件分页和相关索引；容量目标/压测及更全面列表分页仍待做                   |
| F5  | 无人值守调度歧义提示        | 将“默认自包含 ticket，注明假设”明确写入提示词/工具指导；当前只有 context continuity 说明                                              |
| F6  | 空间主窗口                  | 决策保留但未实现，待明确入口、配置和用途；现有 kind=main 不等价                                                                       |
| F7  | 离线提示、channel 显示名    | 待产品选择；当前静默排队，提示身份固定 Meepo。详见规划文档                                                                            |
| F8  | SSO 与 webhook 凭证分流     | 接入 SSO 时明确认证入口，避免 JWT 被当作 webhook secret 校验                                                                          |
| F9  | 模型默认与摘要 effort       | 摘要已传递配置 effort；未知模型能力表兜底仍待明确                                                                                     |
| F10 | Memory Map 版本             | 当前是生成时间；若用于内容缓存/一致性比较，需改为 revision 或内容标识                                                                 |

可选/需求驱动：embedding 字段与向量检索（尚无存储实现）、usage 超额告警、附件与富文本输入、第二 IM、身份感知 worker 选择、更广开放 API、卡片 TODO 面板和 worker 预置镜像。没有将这些项目算作本次已交付。

文档整理验证：检查 14 份文档、56 个本地链接及锚点；原 brainstorm 决策编号保留，无旧文件引用，常青规范不引用 proposals；Prettier 与 `git diff --check` 通过。

## 6. 最终整体审查（2026-10-01）

- 结论：在当前 SQLite 单实例交付范围内，未发现阻断提交的主体逻辑或架构问题。此次聚焦状态归属、执行主链路、依赖边界和冗余代码，没有扩大到延期功能或逐个边界场景。
- server 持有持久状态与事务，worker 持有 agent、工具、工作目录及共享 slot；会话亲和、ticket 独立执行和显式换绑职责一致。生产组合统一注入 SQLite journal、dispatch/fire committer 与 lifecycle adapter，取消、迟到事件围栏及回执没有形成第二套状态源。
- domain 未发现反向依赖具体 store 或 transport；core/protocol 保持共享契约职责。HTTP/RPC 在入口校验身份和资源归属，Console 通过 API 操作。当前 header 身份适配器的边界仍按既有开发环境约定。
- 明显冗余集中在为旧测试保留的非事务分支，F3 已补全范围；跨实体 ticket save 的隐式接口约定仍归 F1。后续收敛应保留当前原子性和组合回归，不能直接删掉级联或用逐实体写入替换事务。ready 门控和历史查询规模仍分别归 F2/F4。
- 本轮未修改运行时代码，沿用当时已通过的 build/check（232 项测试）；F11 已做真实模型/worker/Console 验收。没有重新执行飞书群或容量测试。用户已授权整体审查通过后提交。

## 7. 第四轮评审修复（2026-10-03，已提交于 f7b53af）

本轮发现并修复了 10 月 1 日整体审查遗漏的多来源 space 鉴权漏洞；此前“无阻断问题”是当次审查结论，不能替代这次发现。原三项 P0 中，越权属实、header auth 缺少部署保护属实、租约卡片永久不关闭是漏看 outbox 恢复的误报。

| 评审项 | 本轮处理                                                                                                                                             |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1    | 修复 query/body/path 空间混用；三类创建接口及冲突来源回归。                                                                                          |
| 3.2    | 默认 loopback；生产 header auth 拒绝启动，显式隔离环境 opt-in 有警告。                                                                               |
| 3.3    | 保留正确的 outbox 对账链路；新增租约过期→失败提示→关闭 streaming/Stop 组合测试。                                                                     |
| 3.4    | worker 无渠道密钥/token；受会话归属和已记录引用约束的图片代理，校验实际字节上限。                                                                    |
| 3.5    | canonical 前缀摘要缓存、冷恢复分页、摘要分块和显式截断提示；工具输出本地留全量、模型/日志有界；MCP 同样覆盖。Warm Pi 摘要不冒充 canonical 事件缓存。 |
| 3.6    | 索引及条件查询覆盖 sweep/reconcile/usage/事件增量/外部消息去重；卡片对账首次重建、随后按终态水位与 pending 查询。                                    |
| 3.7    | webhook 原子幂等键/载荷冲突、字段和 128 KiB 体量限制、每 space 每分钟 60 次限制；原 Fastify 默认限制并非不存在。                                     |
| 3.8    | 明确保守入口范围，未开放 agent/schedule/Console 的 idempotent 声明。                                                                                 |
| 3.9    | bash 环境变量与 MCP `_meta` 均有准确说明；新增真实本地 stdio 协议传递回归。                                                                          |
| 3.10   | 补模型接口权限、关键配置语义、Memory Map 稳定排序；Console 缺少 CI 自动化界面测试如实记录。                                                          |

验证使用内存/临时 SQLite、Fastify inject、模拟飞书客户端及本地 stdio/HTTP MCP；没有重启常驻 server/worker，未重新执行真实飞书群交互。独立摘要 smoke 使用 `kimi-k3-0829-highspeed`、effort `high`，成功生成摘要并保留测试事实；日志 `/tmp/meepo-r4-model-smoke.log`。此前真实场景证据不视为本轮新协议的实测。协议 3 与 schema 18 需要双方重建后再运行。

本轮门禁：`pnpm check` 20 项任务通过，server 194 + worker 71 = **265 项测试**；`pnpm build` 6 项任务通过。新增回归入口为 server `store/sqlite/__tests__/review-r4.test.ts`、HTTP authorization 测试、media downloader 测试，以及 worker durable-history/tool-output/MCP 测试。Console 仍无自动化 UI 测试，本轮也没有重跑浏览器验收。已提交于 f7b53af。

补强验收：媒体 token 缓存覆盖到期提前刷新、并发合并、渠道隔离、凭证轮换与旧请求交错、鉴权失败重试及 401 失效；卡片集成回归验证中文展示与内部 `lease_lost` 保留；历史恢复覆盖跨页工具配对、未闭合工具导致的字节/条数上限以及单事件超限。D13-54 已补用户确认的代理修订注记。仍不增加即时卡片钩子，未重新做真实飞书交互。
