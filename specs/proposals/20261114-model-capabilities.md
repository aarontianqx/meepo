# 模型能力下沉方案（已实现，2026-11-14）

本文记录设计过程，已全部实现（C1 server + worker、C2 Console），结论已并入下列常青文档，不再维护。与下文设计相比的主要差异：`imageInput` 也并入能力字段；Space 设置里只带 `thinkingLevel` 不带 `modelId` 时跟随注册表默认模型；Console 的新建对话框用 _Suggest from name_ / _Set manually_ 两种模式，而不是留空表示建议值。承接 `20261114-provider-model-hierarchy.md` 的后续项 2（该方案已实现）。结论位于 `specs/architecture/domain-model.md`、`worker-protocol.md`、`worker-data-plane.md`、`control-plane-api.md` 与 `specs/features/console.md`。

## 1. 背景与问题

模型的"能力"（上下文窗口、最大输出、可选推理强度、是否推理模型）今天不在注册表里，而是写死在 worker 的 `MODEL_CAPABILITIES` 表中，按上游模型名在**运行时**查找，查不到就回落到 K3 档案：

```text
contextWindow 1,048,576 · maxTokens 128,000 · efforts low/high/max · default max · reasoning on
```

这个运行时回落对非 Kimi/GPT 的模型是错的，错误会在会话中途才暴露。一个具体例子：管理员接入 `qwen3-max`（假设窗口 128k，不是推理模型）。

1. worker 查不到它，用 K3 档案：`contextWindow = 1,048,576`。
2. 压缩阈值是窗口的 80%（`THRESHOLD_RATIO = 0.8`）：约 838k token 才触发压缩，而模型在 128k 就会拒绝请求。会话变长后，请求以"超出上下文长度"失败，压缩没有机会介入。
3. `maxTokens = 128,000` 作为输出上限发给网关；上限更低的网关会直接拒绝。
4. `reasoning = true` 且每次都带 `reasoningEffort`：不支持该参数的网关会报错或忽略，用户在 Space 设置里选的 Low/High/Max 也毫无意义。

相关的已有事实：

- `ModelCapabilities.supportedEfforts` 字段存在，但**没有任何代码读取它**；Console 的 Space 设置对任何模型都展示 Low / High / Max。
- （已并入本方案）图片输入曾有一条独立的启发式：`imageInput ?? model.startsWith('kimi-k')`，只有 `imageInput` 能覆盖。
- 有效推理强度的优先级是：Space `thinkingLevel` → worker 的 `modelDefaults.thinkingLevel` / `MEEPO_THINKING_LEVEL` → 模型默认强度。

根因是"能力是运行时按名字猜出来的隐含值"。管理员看不到、改不了，也没有地方声明。

## 2. 目标与非目标

目标：

1. 能力成为 `ModelEntry` 里**显式、必填、可见、可改**的数据，由服务端持有，worker 只读下发的值。
2. 新建模型时由服务端按模型名给出建议值并写入条目；运行时不再有任何按名字回落。
3. 推理强度只对声明支持推理的模型生效；Space 设置只展示该模型支持的强度。

非目标：

- 不做按 Space 的能力覆盖（能力属于模型，不属于租户）。
- 不从服务商自动探测能力（`GET {baseUrl}/models` 的字段各家不一致，另行评审）。
- 图片输入并入同一机制：`imageInput` 成为必填布尔值（见 3.1），不再有运行时按名字的规则。
- 不做存量数据的兼容迁移：系统尚未上线，缺少能力字段的旧数据直接重建。
- 不递增协议版本，原因同上。

## 3. 方案

### 3.1 数据模型

`ModelEntry` 增加五个字段（含原先可选、现改为必填的 `imageInput`），扁平放置：

```text
ModelEntry {
  ...,
  contextWindow:    number                       // tokens, 正整数
  maxTokens:        number                       // 单次输出上限, 正整数, 小于 contextWindow
  reasoningEfforts: ('low' | 'high' | 'max')[]   // 支持的强度; 空数组 = 非推理模型
  defaultEffort?:   'low' | 'high' | 'max'       // reasoningEfforts 非空时必填, 且属于它
  imageInput:       boolean                      // 是否接受图片; 创建时按名字建议(kimi-k* 为 true)
}
```

_理由：能力随模型变化，与凭据（服务商）无关，所以放在 `ModelEntry` 而不是 `Provider`；扁平字段与现有 `imageInput` 一致，不引入新的嵌套对象；"空数组 = 非推理"让一个字段同时表达支持范围与是否推理，避免两个字段互相矛盾；字段必填，让 worker 没有任何需要猜测的东西。_

### 3.2 建议值（创建时，不是运行时）

服务端提供 `suggestCapabilities(model)`，按上游模型名给出建议值：

| 模型名            | contextWindow | maxTokens | reasoningEfforts | defaultEffort |
| ----------------- | ------------- | --------- | ---------------- | ------------- |
| 以 `kimi-k` 开头  | 1,048,576     | 128,000   | `low, high, max` | `max`         |
| 以 `gpt-5.6` 开头 | 1,050,000     | 128,000   | `low, high, max` | `high`        |
| 其他              | 128,000       | 16,384    | `[]`（非推理）   | —             |

另有 `imageInput`：`kimi-k*` 与 `gpt-5.6*` 为 `true`，其余为 `false`。

使用时机只有两个，且结果都会被**存进条目**：

1. `PUT /api/models` 新建条目时，请求里省略的能力字段逐字段取建议值（更新已有条目时省略则保持原值）。
2. 由环境变量种子（扁平条目）构建 Provider → Model 注册表时（`model-seed.ts`），每个条目按其上游名取建议值，显式的 `imageInput` 优先。

_理由：失败方向必须是"压缩偏早、输出偏短、不发推理参数"，而不是"压缩永不触发、请求被拒"，所以未知模型取保守值；建议值只在写入时用一次，之后以条目里存的显式值为准，管理员改了就是改了，没有隐含层再覆盖它。_

### 3.3 协议

`ModelConfig`（下发给 worker 的 per-dispatch 配置）增加同名字段（`contextWindow`、`maxTokens`、`reasoningEfforts`、`imageInput` 必填，`defaultEffort` 可选），由 `resolveModel` 从 `ModelEntry` 拷入。worker 不需要知道注册表，也不再有自己的能力表。

`thinkingLevel` 的传递规则收紧：`resolveModel` 只在该强度属于模型的 `reasoningEfforts` 时才携带它，否则省略，worker 用 `defaultEffort`。这样把某个 Space 切换到另一个模型时，旧的强度设置不会让调度失败。

协议版本不递增：系统尚未上线，不需要兼容旧 worker。

### 3.4 worker 行为

- 删除 `MODEL_CAPABILITIES`、K3 回落和 `capabilitiesOf`。
- `createModel`：`contextWindow`、`maxTokens` 取下发值；`reasoning` 为 `reasoningEfforts` 非空。
- `createStreamFn`：模型非推理时不传 `reasoningEffort`；否则取 `thinkingLevel`（其中已包含 worker `modelDefaults` 合并后的结果），不在 `reasoningEfforts` 内则用 `defaultEffort`（worker 的 `modelDefaults` 是全局值，可能不被某个模型支持）。
- 压缩（`createCompactor`）按下发的 `contextWindow` 计算 `reserveTokens`、`keepRecentTokens` 和摘要分块大小；摘要调用只在 `thinkingLevel` 被模型支持时才请求推理（与上一条共用同一个判断，避免全局默认强度被不支持它的模型拒绝）。
- `createModel` 的图片输入只看 `imageInput`，不再有 `kimi-k` 名字规则。

### 3.5 服务端校验

`PUT /api/models` 校验（HTTP 请求体是信任边界）：

- `contextWindow`、`maxTokens` 为正整数，且 `maxTokens < contextWindow`。
- `reasoningEfforts` 是 `low` / `high` / `max` 的无重复子集，可为空。
- `defaultEffort`：`reasoningEfforts` 非空时必须给出（省略则取该模型建议值，若建议值不在列表内则取列表最后一项）且属于列表；`reasoningEfforts` 为空时不得给出。

`PUT /api/spaces/:id/model` 不增加跨聚合校验（模型是否支持某强度由 `resolveModel` 在派发时过滤，见 §3.3）。

### 3.6 Console（C2）

- **模型对话框**：新建时用分段控件选 _Suggest from name_（全部由服务端按名字填）或 _Set manually_；手动模式有 Context window、Max output、推理强度复选框（low / high / max）、Default effort（有强度时出现）和 Image input。编辑时总是显示已存值。
- **Models 页**：模型行显示 `1.05M context · 128k output · Thinking low / high / max` 之类的摘要。
- **Space 设置**：`Thinking effort` 分段控件按所选模型（未选则按注册表默认模型）的 `reasoningEfforts` 过滤选项；模型非推理时显示一句说明代替选项。`GET /api/model-options` 为此返回能力字段。
- 复用现有 `ui/` 基元与 token，不引入依赖。

### 3.7 影响范围

| 区域                       | 变化                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/protocol`        | `ModelConfig` 增加能力字段（含必填的 `imageInput`）                                                                                        |
| `apps/meepo-server`        | `model-registry.ts`（`ModelEntry`、`resolveModel`）、新增建议值模块、`model-service.ts`（校验、`ModelInput`/`ModelView`）、`model-seed.ts` |
| `apps/meepo-worker`        | `agent/model-factory.ts`（删除能力表，使用下发值）、`agent/compaction.ts`（无需改，随 `contextWindow` 生效）                               |
| `apps/meepo-console`（C2） | `ModelsPage.tsx`、`AgentSettings.tsx`、`api/types.ts`、`lib/` 纯逻辑                                                                       |
| 文档                       | `domain-model.md`、`worker-protocol.md`、`worker-data-plane.md`、`control-plane-api.md`、`console.md` §4.9                                 |

## 4. 测试计划

- **建议值**：`kimi-k*`、`gpt-5.6*`、其他三类各一例；未知名得到保守且非推理的值。
- **创建与更新**：新建时省略字段取建议值并持久化；更新省略则保持原值；显式值优先。
- **校验**：非整数、非正数、`maxTokens >= contextWindow`、重复或未知强度、`defaultEffort` 不在列表、非推理却给 `defaultEffort` 均 `400`。
- **种子**：扁平种子构建的注册表中每个条目带建议值；`resolveModel` 在端点、密钥、`imageInput` 上与种子声明一致。
- **`resolveModel`**：携带能力字段；`thinkingLevel` 不被支持时省略。
- **worker**：非推理模型不传 `reasoningEffort` 且 `reasoning` 为 false；强度不被支持时退回 `defaultEffort`；`contextWindow`、`maxTokens` 取下发值；压缩阈值按下发窗口计算。
- **Console（C2）**：强度选项过滤抽成 `lib/` 纯函数并配单测；界面按 `AGENTS.md` 视觉检查清单核对两种主题与窄屏。

## 5. 切片

1. **C1 服务端与 worker**：字段、建议值、校验、`resolveModel`、worker 改造、测试、规格更新。完成后 Console 不改也能用：新建模型时不填能力，服务端补建议值。
2. **C2 Console**：模型对话框、Models 页文本、Space 设置强度过滤、文档核对。

## 6. 开放问题

1. （已决定并实现）`imageInput` 也在创建时固化：必填布尔值，由同一条名字建议填充，worker 不再有任何按名字的规则。
2. 是否需要 `Provider` 级默认能力（同一服务商的多个模型常有相同窗口）？目前不做；如果逐模型填写变成负担，再评审。
3. 从服务商拉取模型元数据预填能力：依赖各家实现，暂不做。
