# Provider → Model 分级配置方案（已实现，2026-11-14）

本文记录当时的设计取舍，S1–S3 已实现，结论已并入 `specs/architecture/domain-model.md`、`control-plane-api.md` 与 `specs/features/console.md`；以常青文档和代码为准，本文不再维护。后来取消了「加载时把存量扁平 blob 升级并写回」这一步（系统未上线，旧库直接刷数据），扁平格式只保留给环境变量种子（`model-seed.ts`）。后续项 2（模型能力下沉）已由 `20261114-model-capabilities.md` 实现，其余仍未做。

## 1. 背景与问题

当前 `ModelRegistry` 是一个扁平目录：

```text
ModelRegistry { defaultModelId?, entries: ModelEntry[] }
ModelEntry    { id, provider, model, baseUrl, apiKey, imageInput? }
Space.model   { modelId, thinkingLevel? }      // 引用 ModelEntry.id
```

一个服务商（同一个 `baseUrl` + 同一把 key）下通常有多个模型，扁平结构带来：

- **凭据重复**：N 个模型要填 N 次 `baseUrl` 和 `apiKey`；轮换 key 要改 N 条，漏一条就会让引用它的 Space 在运行时才失败。
- **`provider` 字段语义不清**：协议永远是 OpenAI Chat Completions（`createModel` 里 `api: 'openai-completions'`），但这个字符串会原样成为 pi-ai 的 `Model.provider`，而 pi-ai 的客户端会按它启用厂商特例（`moonshotai`、`zai`、`together`、`openrouter` 等的兼容探测，`openai` 的 tool call id 截断）。所以它**不是展示标签，改动会改变请求行为**；管理员却把它当成自由文本填写。
- **管理页没有层次**：Models 页是一张平铺列表，看不出哪些模型同属一个服务商、哪个 key 在用。
- **选择器没有分组**：Space 的模型下拉（`/api/model-options`）也是平铺。

相邻的两个已知缺口（不在本方案范围内，但落地时要一并考虑）：

- 删除一个被 Space 引用的模型是允许的（只拒绝删除默认模型），引用它的 Space 在派发时才抛 `Unknown model in registry`；Console 只有一句确认文案提醒。
- 模型能力（上下文窗口、最大输出、可选推理强度、默认强度）来自 worker 里写死的表 `MODEL_CAPABILITIES`，未识别的模型 id 一律回落到 K3 档案。接入非 Kimi/GPT 的服务商时，这会给出错误的窗口大小，进而影响压缩触发点。

## 2. 目标与非目标

目标：

1. 凭据只在服务商一级维护一次；一个服务商下可挂多个模型。
2. 现有 `Space.model.modelId` 引用在迁移后继续有效，不需要改 Space 数据。
3. Console 的 Models 页按服务商分组，Space 选择器按服务商分组。
4. 服务器内部仍向 worker 下发同样的 `ModelConfig`，**worker 与 `/ws/worker` 协议不变**。

非目标：

- 不引入非 OpenAI 兼容协议（Anthropic 原生、Gemini 原生等）；协议字段先固定为 `openai-completions`，留作将来扩展点。
- 不做按 Space 的服务商级凭据（凭据是平台级，仅全局 admin 可管）。
- 不做用量计费或配额。
- 不在本方案内迁移模型能力表（见 §6 后续项）。

## 3. 方案

### 3.1 数据模型

```text
ModelRegistry {
  providers: Provider[]
  entries:   ModelEntry[]
  defaultModelId?: string
}
Provider   { id, name /* 展示名 */, kind /* 客户端兼容标识，原 provider 字段 */, baseUrl, apiKey /* 加密 */ }
ModelEntry { id, providerId, model /* 上游模型名 */, imageInput? }
```

- `ModelEntry.id` 保持为 Space 引用用的稳定主键，语义不变；`providerId` 外键指向 `Provider.id`。
- `Provider.name` 只是展示名（如 `Moonshot`、`Internal gateway`）；`Provider.kind` 才是下发给 worker 的 `ModelConfig.provider`，取值与今天的 `provider` 字段完全相同（默认 `openai-completions`）。两者分开，是因为 `kind` 会改变请求行为（§1），不能被改名牵连。
- `apiKey` 沿用现有的静态加密（整个 registry 序列化后经 `SecretCodec` 存进 `server_settings['models']`），HTTP 不回显，只返回 `hasApiKey`。
- `defaultModelId` 仍在模型一级，不引入"服务商默认模型"。`thinkingLevel` 仍在 Space 一级。
- 解析：`resolveModel(registry, modelId, thinkingLevel)` 取 entry 再取其 provider，拼出和今天完全一致的 `ModelConfig { provider: provider.kind, baseUrl, apiKey, model, imageInput, thinkingLevel }`。

_理由：凭据与模型是两个独立变化的维度。把凭据上提到服务商，轮换只发生一次，模型增删不触碰密钥；而保留 `ModelEntry.id` 作为 Space 的引用键，让这次重构对租户数据零影响。_

### 3.2 备选方案

| 方案          | 做法                                                    | 优点                                   | 缺点                                           |
| ------------- | ------------------------------------------------------- | -------------------------------------- | ---------------------------------------------- |
| **A（推荐）** | 新增 `Provider` 实体，模型引用它                        | 凭据一处维护；结构清晰；可扩展协议字段 | 需要一次存储迁移和 API/Console 改动            |
| B             | 保持扁平，只在 Console 里加"基于已有条目快速新增模型"   | 零数据迁移，改动最小                   | 不解决 key 重复与轮换；分组仍靠 `baseUrl` 推断 |
| C             | 扁平条目加 `credentialId`，凭据存独立表，不建服务商概念 | 解决轮换                               | 没有"服务商"这一用户心智；分组无依据           |

选 A：用户的心智模型就是"一个服务商，多个模型"，数据结构应与之对齐。

### 3.3 存储迁移

registry 目前是一个加密 JSON 整体（`server_settings['models']`），没有表结构，原方案的迁移是**加载时升级**（后来取消，旧库直接刷数据，见头部说明）：

1. 读到旧形状（只有 `entries`、条目带 `baseUrl`/`apiKey`/`provider`）时，按三元组 `(baseUrl, apiKey, provider)` 分组生成 `Provider`，同组共用一个。
2. `Provider.kind` 取旧 `provider` 值；`Provider.name` 取 `hostOf(baseUrl)`，重名追加序号；`id` 由 `name` 规范化并去重（冲突追加序号）。
3. 每个旧条目的 `id`、`model`、`imageInput` 原样保留，补上 `providerId`；`defaultModelId` 不变。
4. 升级后立即以新形状回写；对每个已有 `modelId`，`resolveModel` 升级前后的输出必须逐字节相同（测试断言）。

_理由：`provider` 会改变请求行为，所以不能在迁移时因为 `(baseUrl, apiKey)` 相同就合并不同标识的条目；用三元组分组才能保证无损。同一服务商若历史上填了不同标识，会得到两个 Provider，管理员之后可在 Console 手动归并。_

环境变量启动种子（`MEEPO_MODELS` JSON 数组与旧单模型 `MEEPO_MODEL_*`）仍只在存储为空时生效，按同样的分组规则转换成新形状。

### 3.4 HTTP API

| 路由                        | 变化                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET /api/providers`        | 新增（admin）：`{ id, name, kind, baseUrl, hasApiKey, modelCount }[]`                               |
| `PUT /api/providers`        | 新增（admin）：upsert `{ id, name, kind, baseUrl, apiKey? }`；`apiKey` 留空表示保留原值             |
| `DELETE /api/providers/:id` | 新增（admin）：仍有模型时 `409`                                                                     |
| `GET /api/models`           | 返回每个模型及其 `providerId`、`providerName`、`isDefault`，不含任何密钥                            |
| `PUT /api/models`           | 入参由 `{provider, baseUrl, apiKey, ...}` 改为 `{ id, providerId, model, imageInput?, isDefault? }` |
| `DELETE /api/models/:id`    | 默认模型仍 `409`；**新增**：被任何 Space 引用时 `409` 并带引用数（修掉 §1 的已知缺口）              |
| `GET /api/model-options`    | 保持登录用户可读且不含 `baseUrl`/`apiKey`；增加 `providerName` 供分组展示                           |

**鉴权**：全局 admin 门控目前不在路由里，而是 `authorization.ts` 里的前缀判断（`/api/channels`、`/api/models`）。新增的 `/api/providers` 必须同时加入该前缀判断，否则普通登录用户可以读写服务商凭据配置；非 admin 访问得到的是 `401`（领域错误里只有 `unauthorized`，映射为 `401`，没有 `403`）。

**引用保护的分层**：`ModelService` 目前是同步的、不依赖其他聚合，而 `SpaceRepository.list()` 是异步的。按 `backend-layering.md`，路由不能直接查 Space；做法是在 `domain/models/` 定义一个窄的消费方端口（例如 `countSpacesUsing(modelId): Promise<number>`），在 `bootstrap.ts` 注入，SQLite 实现直接 `SELECT COUNT(*) FROM spaces WHERE model_id = ?`，`ModelService.delete` 随之改为异步，路由 `await`。测试用内存替身实现同一端口。

### 3.5 Console

- **Models 页**：按服务商分组的卡片。卡片头显示名称、主机名（`hostOf(baseUrl)`）、"Key stored" 状态、`Edit provider`；卡片内是该服务商下的模型行（`id`、上游模型名、`Default` / `Images` 徽标、`Make default`）；每张卡片有 `Add model`。页头操作是 `Add provider`。
- **空态**：无服务商时先引导 `Add provider`；有服务商无模型时在卡片内给出 `Add model`。
- **Space 设置的模型选择器**：按服务商分组，直接用原生 `<select>` 的 `<optgroup label={providerName}>`（现有 `Select` 基元透传子元素，无需新组件）；选项文案是模型 `id` 与上游名；仍保留推理强度分段控件。
- 复用现有 `ui/` 基元与 token，不引入新依赖（遵守 `apps/meepo-console/AGENTS.md` 的视觉一致性规则）。

### 3.6 影响范围

| 区域                 | 变化                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/meepo-server`  | `model-registry.ts`、`model-service.ts`（引用保护，改为异步）、`model-sqlite.ts`（原方案为加载时升级，已取消）、`routes/models.ts`、`authorization.ts`（`/api/providers` 加入 admin 前缀）、`bootstrap.ts`（注入引用端口）、`config.ts`（种子转换）、内存测试替身；`dispatch-service.ts` 仅调用 `resolveModel`，无需改 |
| `apps/meepo-worker`  | 无；`ModelConfig` 形状不变                                                                                                                                                                                                                                                                                             |
| `packages/protocol`  | 无                                                                                                                                                                                                                                                                                                                     |
| `apps/meepo-console` | `ModelsPage.tsx`、`AgentSettings.tsx`、`api/types.ts`、`api/endpoints.ts`、`api/keys.ts`、样式复用                                                                                                                                                                                                                     |
| 文档                 | `domain-model.md`（ModelRegistry）、`control-plane-api.md`（路由）、`console.md` §4.9、`README.md`（环境变量说明）、`space-and-chat.md` 配置表                                                                                                                                                                         |

## 4. 测试计划

- **迁移**：旧形状按 `(baseUrl, apiKey, provider)` 分组；同 key 但 `provider` 不同、或同 key 不同 `baseUrl` 都不合并；`resolveModel` 对每个旧 `modelId` 前后输出一致；重复加载幂等。
- **服务**：服务商 upsert 保留空 `apiKey`；删除仍有模型的服务商 `409`；删除被 Space 引用的模型 `409`（引用端口的 SQLite 实现与内存替身各一例）；默认模型规则不变。
- **接口**：`model-options` 与 `models` 响应中不出现 `apiKey`（含加密串）；非 admin 对 `/api/providers` 与 `/api/models` 的读写均为 `401`（回归：只加路由、漏改 `authorization.ts` 会让该用例失败）。
- **派发**：Space 引用的模型经服务商解析后，`ModelConfig` 与迁移前一致。
- **Console**：纯逻辑（按服务商分组、选项排序）抽到 `lib/` 并配单测；界面按 `AGENTS.md` 视觉检查清单人工核对两种主题。

## 5. 切片

1. **S1 服务端（已实现）**：数据模型、服务与路由（加载时迁移已取消）、引用保护、测试、`domain-model.md` / `control-plane-api.md` / README 已更新。
2. **S2 Console（已实现）**：Models 页按服务商分组、Space 选择器用 `<optgroup>`、分组与 id 生成逻辑在 `lib/models.ts` 并有单测；两种主题与窄屏已人工核对；`console.md` 已更新。
3. **S3 收尾（已完成）**：README 种子说明；结论回收到常青文档；本文标注为已实现。

S1 完成后即可用 API 验证迁移无损；S2 可在 S1 之后独立交付。

## 6. 开放问题与后续项

1. **服务商是否需要额外请求头**（部分网关要求自定义 header）？本方案不做；若需要，应作为 `Provider.headers`（加密）单独评审。
2. **模型能力下沉**：把 `contextWindow`、`maxTokens`、`supportedEfforts`、`defaultEffort` 作为 `ModelEntry` 的可选覆盖项，使非 Kimi/GPT 服务商不再回落到 K3 档案。这是接入新服务商的真实正确性风险，建议紧接本方案立项，但它改变 `ModelConfig` 与 worker 契约，不应混入 S1。
3. **从服务商拉取模型列表**（`GET {baseUrl}/models`）预填 `Add model`：体验上很顺，但依赖服务商实现且需要在服务端代发请求，暂不做。
4. **删除服务商的级联策略**：本方案选择"有模型则拒绝"；是否提供"连同模型一起删除并要求先解除所有引用"的快捷路径，留待使用后再定。
