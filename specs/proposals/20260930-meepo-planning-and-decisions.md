# Meepo 规划与决策

更新：2026-10-01。

本文集中记录现行方案的取舍、实施顺序和待决策问题。具体行为以 [architecture](../architecture/system-overview.md) / features 常青规范为准；完成状态、验收证据和待办统一维护在[工作项与验收](20261001-meepo-work-items-and-acceptance.md)。[设计讨论记录](20260928-meepo-v2-design-brainstorm.md)保留完整讨论及 D 编号，包含已被后续结论取代的选项，不作为当前开发步骤。

## 1. 当前范围

- 单实例 server + SQLite + 多个用户自有 worker；Feishu 是唯一已接入的 IM。
- server 管理空间、渠道、模型凭据、会话事件、任务、调度和记忆；worker 执行 Pi agent、文件工具和 MCP，拥有本机工作目录。
- console 用于管理、观察和受限消息注入，不扩展成完整 Web IM。
- 默认通用助手，coding preset 可选；不建立 Assistant 人格实体，不自动托管仓库，不引入审批/权限模式。
- 使用 SQLite 完成本轮交付；PostgreSQL、多副本、SSO 后续接入。不在本机安装重型服务或下载容器镜像，项目 pnpm 依赖允许安装。

## 2. 现行关键决策

表格解释“为什么这样做”；字段、状态机与执行细节只在对应常青规范维护。

D14-61～65 是此前授权范围内的实施澄清：用户已允许处理文档矛盾、评估换绑时的 thread 行为，并明确指定 SQLite 和测试边界；其余归属、提示词与 webhook 细则沿用已有决策。记录这些依据不代表用户逐条签署了 D14，也不需要为已授权的实现细化补一道审批。

| 主题         | 决策及理由                                                                                                                                                                                        | 常青归属 / 讨论来源                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 状态归属     | server 保存已确认事件与投影，worker 保存执行过程和本地文件；机器离线不能触发隐式状态迁移。未确认事件不承诺抗 worker 进程崩溃。                                                                    | [系统总览](../architecture/system-overview.md)；D1-3、D8-20、D11-34                                                                       |
| 空间与渠道   | 每 channel 是一个 bot app，只属一个 space；space 可有多个 channel。群按 channel/chat 对绑定，私聊按 channel 归属及白名单解析。                                                                    | [空间与聊天](../features/space-and-chat.md)；D11-38、D13-56                                                                               |
| 信任边界     | 服务端按 space 授权；共享 worker 的文件、凭据和工具属于同一信任域。允许对话的人可驱动完整工具集，不要求先成为 console 成员。                                                                      | [系统总览](../architecture/system-overview.md)；D11-36、D12-48、D13-57                                                                    |
| 会话换绑     | main 随明确的 space rebind 迁移，当前执行先中断，排队输入随迁；thread 保留原 worker 与执行。兼顾主会话可恢复和任务文件不丢失。                                                                    | [交互会话](../features/interactive-session.md)；D12-45、D13-51、D14-61                                                                    |
| 重开会话     | `/new` 只作用于 main，关闭旧会话、取消恢复日程、替换窗口映射、生成确认消息原子提交；thread 依靠压缩继续。                                                                                         | [交互会话](../features/interactive-session.md)；D13-51                                                                                    |
| 可靠性       | 事件 ACK、租约和终态围栏保护持久状态；未知副作用不承诺 exactly-once，ticket 根据幂等声明/只读轨迹决定重试或人工处置。                                                                             | [协议](../architecture/worker-protocol.md)、[ticket](../features/ticket-pipeline.md)；D11-33、D13-58                                      |
| 取消事务     | ticket 终态保存级联更新 run 并生成 receipt，随后通知 worker 停止；run 已经终态，因此 abort 按取消原因筛选。该约定是正确性的前提，不能在 adapter 重构中丢失。                                      | [服务端事务](../architecture/server-control-plane.md#transaction-boundaries-and-cancellation-contract)；本轮评审澄清                      |
| pending 时钟 | 用独立 `pendingSince` 计算本次等待期，每次手动/自动重试重置；保留 `createdAt`，普通更新时间不延长排队。                                                                                           | [ticket](../features/ticket-pipeline.md)；本轮修复                                                                                        |
| 输入与回执   | 当前用户、console、日程、ticket receipt 均为 `wait`；HTTP 不开放 urgent/if_idle。执行型输入通过 dispatch，纯历史说明通过 context.append。                                                         | [交互会话](../features/interactive-session.md)、[协议](../architecture/worker-protocol.md)；D13-51、D13-59                                |
| 调度与并发   | Schedule 表达时间与目标类型；fire 与工作项原子创建。worker 对全部 run 控制 slots，交互优先，server 额外感知 ticket 容量。                                                                         | [调度](../features/triggers-and-scheduling.md)；D11-39、D13-60                                                                            |
| 提示词生效   | 身份/preset 冻结；本地规则、skills、工具和 Memory Map 冷启动刷新，warm session 稳定。当前时间随 turn 传入，不改冻结提示词。                                                                       | [worker](../architecture/worker-data-plane.md)；D9-24、D12-50、D14-62                                                                     |
| 模型配置     | 空间指定模型和可选 effort，worker 可提供 effort 默认，最后用模型能力表兜底。普通调用显式发送 reasoningEffort；warm runner 保持创建时配置。后续真实模型测试用 high，属于测试偏好，不修改产品默认。 | [worker](../architecture/worker-data-plane.md#model-selection-and-reasoning-effort)；用户测试约束                                         |
| 记忆         | 条目 + revision + tombstone，检索使用 trigram/短词 LIKE；注入目录而非正文，正文由工具读取。无完整版本历史是已接受边界。                                                                           | [记忆](../features/memory.md)；D12-50、D13-53、D13-59                                                                                     |
| 图片         | server 只存引用，元数据允许缺省；worker 检查真实下载大小，原图放共享缓存，模型使用降采样副本。避免任务目录回收导致历史图像缓存丢失。                                                              | [交互会话](../features/interactive-session.md)、[worker](../architecture/worker-data-plane.md#media-retention)；D13-54、D13-59 及审查修正 |
| MCP          | worker 属主配置并托管连接；重载失败保留旧配置；warm session 保留旧工具连接，最后一个使用者释放后关闭。                                                                                            | [worker](../architecture/worker-data-plane.md)；D12-46                                                                                    |
| 身份与机密   | owner/operator 管空间，admin 只管全局注册表；注册凭据绑定 worker ID，模型/渠道密钥在 server 加密。Webhook secret 只授权对应空间创建 ticket。                                                      | [服务端](../architecture/server-control-plane.md)、[空间](../features/space-and-chat.md)；D13-55、D13-57、D14-65                          |
| 呈现         | 无内容不出卡，工具 pill 不展示参数/结果；Stop 根据 run initiators 授权，合并输入保留全部作者。                                                                                                    | [服务端](../architecture/server-control-plane.md)；D11-41、D13-59、D14-64                                                                 |

## 3. 后续实施顺序

1. **收敛已有契约**：显式化 ticket 跨实体事务 port；统一 worker ready 派发门控；替换并删除非 journal StreamProcessor 路径。先保留/补全真实 SQLite 组合回归，再移除兼容分支。
2. **完成已识别的提示词与产品缺口**：无人值守调度歧义规则、空间主窗口入口；名称策略确认后再增加配置，避免重复引入另一套窗口路由。
3. **按数据量治理查询**：确定规模目标、收集查询计划，再增加针对性索引、分页和容量验收。不能把尚未做的容量压测视为已通过。
4. **外部接入与扩展**：PostgreSQL 先保持事务/检索语义，再讨论多副本的连接归属与共享队列；SSO 同时处理用户 Bearer 与 webhook 凭证分流。其他 IM、附件、向量检索及更广开放 API 按真实需求启动。

不把 worker.ready 待办理解为“取消执行前检查”：当前不足是服务端缺少统一门控，应消除提前 flush/派发的路径；worker 本地执行与租约检查仍保留。

## 4. 待定产品选择

| 问题              | 当前行为                                                                                     | 后续决策边界                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 空间编排主窗口    | 只有 private/group-main/thread 路由，没有 space 级主窗口字段、选择入口或默认主动消息目的地。 | D11-31 的独立编排入口尚未交付。明确其实际触发源与 fallback，再决定字段和 UI；不能把 `kind=main` 当作已实现。 |
| 离线排队提示      | 输入持久化排队，无专门的“worker 离线，已排队”提示。                                          | 是否每个窗口仅提示一次；不改变离线不迁移的规则。                                                             |
| 多 channel 显示名 | channel 有管理名称，系统提示身份仍固定 Meepo，包含 channel ID。                              | 是否让每个 bot 名称进入冻结身份块，以及改名何时生效。                                                        |
| 模型兼容配置      | 未知模型沿用 K3 能力兜底；压缩摘要不显式继承 ordinary agent effort。                         | 扩展模型前确定能力来源和摘要 effort 策略，避免把“可填模型 ID”理解为已支持任意模型。                          |

运行中 ticket 取消已由用户明确授权本次补齐（2026-10-01），扩展 D13-58 的取消状态范围：沿用 cancel API 与 Console 按钮，新增 running→cancelled；run 围栏与 receipt 原子提交，随后通知 worker 中断，不自动重试。重复取消幂等，完成/取消竞争遵循先提交者获胜；不回滚已发生的副作用。飞书会话 Stop 不影响独立 ticket，本次不增加飞书 ticket 管理卡片。验收记录见 F11。

## 5. 工作纪律

- 代码与对应常青规范同步更新；状态和证据只维护在[工作项与验收](20261001-meepo-work-items-and-acceptance.md)。brainstorm 保留历史讨论与 D 编号，后续只修正索引或勘误，不要求每项新决策再追加一份。后续决策及其变更理由仅在本文维护，长期有效契约同步更新常青规范；验收/待办只在工作项文档维护。
- 内部规范矛盾可根据最新用户约定与架构约束自行闭环，并在现行决策中记录；不恢复已废弃的设计，也不为每个修复另建报告。
- 自动化回归与真实飞书验证分开记录；没执行的环节明确标记未验证。测试主体为 ClawFox，保留现有 lark-cli 登录；必要时用用户身份发消息，人工操作有界等待。
- 提交依用户明确指令；用户已于 2026-10-01 授权整体审查通过后提交本轮改动。AGENTS.md 未修改。
