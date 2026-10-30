# 多家 AI 服务商：设计说明（第一期 OpenAI + Google Gemini）

状态：待确认，确认后再动代码。

## 目标

- 用户可以添加多个服务商的 API Key（第一期 OpenAI、Google Gemini），每个 Key 单独保存、验证、删除。
- 每种用途单独选一个模型：商品图、个人形象、上身效果、真人大片（生图）和识别（自动填写、保真检查、镜子照片，视觉）。默认「自动」。
- 可以混用，比如商品图用 Gemini（Nano Banana）、上身效果用 OpenAI。
- 第一期范围：provider 接口、OpenAI 适配（现有代码搬过去）、Gemini 适配（按官方文档 + 单测）、「API 与模型」设置页（多个 Key、按用途选模型）。
- 已有用户升级后无感：原来的 OpenAI Key、模型和同意记录自动迁过来。

## 数据结构

Key 本身只放在 SecureStore（`ai.key.<keyId>`），数据库里只存描述：

```ts
type ProviderId = 'openai' | 'gemini';            // 第二期加 'openrouter' | 'compatible'（带 baseUrl）

interface KeyEntry {                               // settings 表 'ai.keys'：KeyEntry[]
  id: string;                                      // 随机 id，对应 SecureStore 'ai.key.<id>'
  provider: ProviderId;
  label: string;                                   // 默认「OpenAI」「Gemini」，同一服务商多个 Key 时可改名
  last4: string;
  addedAt: string;
  verifiedAt: string | null;
  models: string[];                                // 验证时探测到、能用于本应用的模型
  blocked: string[];                               // 用过后发现不可用的模型（原 ai.blocked，按 Key 记）
}

type Purpose = 'catalog' | 'avatar' | 'tryon' | 'photo' | 'vision';
type Route = 'auto' | { keyId: string; model: string };
type Routes = Record<Purpose, Route>;              // settings 'ai.routes'

interface ModelInfo {                              // 代码里的已知模型表 + 探测到的未知模型
  provider: ProviderId;
  id: string;                                      // 'gpt-image-1-mini'、'gemini-2.5-flash-image' …
  kind: 'image' | 'vision';
  label: string;                                   // 'GPT Image mini'、'Nano Banana（Gemini 2.5 Flash Image）'
  price: ImagePrice | ChatPrice | null;            // null = 价格未知
  quality: boolean;                                // 是否支持 低 / 中 / 高 画质参数（Gemini 不支持，UI 不显示画质）
  multiImage: boolean;                             // 是否能吃多张参考图（上身效果、大片需要）
}

// 同意按服务商记录：settings 'privacy.consent' = { openai?: string; gemini?: string }（同意时间）
```

「自动」的推荐顺序（只在已添加、已验证的 Key 里挑，且模型在 `models` 里、不在 `blocked` 里）：

| 用途 | 顺序 |
| --- | --- |
| 生图（四种） | gpt-image-1-mini → gemini-2.5-flash-image 系列 → gpt-image-1.5 / gpt-image-1 → 其他探测到的 Gemini 生图模型 |
| 识别 | gpt-5.4-nano → gemini-2.5-flash-lite / flash → 其他 OpenAI 小模型 |

Gemini 模型不写死：`v1beta/models` 里 `supportedGenerationMethods` 含 `generateContent` 的，名字或说明表明能输出图片的（如 `*-image*`）算生图，其余 flash / flash-lite 算识别；以实际列表为准。

## 代码结构

```
ai/providers/types.ts    AiProvider 接口：listModels()、imageEdit(req)、visionJson(req)，统一的 usage 和 AiError
ai/providers/openai.ts   现在的 createOpenAiClient 搬过来，实现 AiProvider
ai/providers/gemini.ts   generateContent：图片用 inline_data，生图 responseModalities 含 IMAGE，
                         识别用 responseMimeType=application/json + responseSchema（把 ['string','null'] 转成 nullable）
ai/catalog.ts            已知模型表（价格、能力）、自动顺序、resolveRoute(purpose) → { provider, model, keyId }
ai/engine.ts             只依赖 resolveRoute 和 AiProvider；按用途取模型；尺寸 / 画质在不支持的模型上不传
```

错误映射到现有 `AiErrorKind`：401/403 或 API_KEY_INVALID → auth；429 RESOURCE_EXHAUSTED（配额）→ quota，其余 429 → rate；连不上 → network；超时 → timeout；5xx → server；模型不存在 / 不支持 → model；`promptFeedback.blockReason` 或 `finishReason` 为 SAFETY / IMAGE_SAFETY / PROHIBITED_CONTENT → rejected；返回里没有图片或 JSON 解析失败 → bad_response。`auth`、`quota` 只暂停用到这个 Key 的任务。

## 画面比例与风格一致

- **比例**：商品图、形象、上身效果、大片都要 2:3（现在 OpenAI 用 1024×1536）。Gemini 没有尺寸参数，但有宽高比配置（`generationConfig.imageConfig.aspectRatio`，按官方文档的写法传 `"2:3"`），必须传，否则会出 1:1，衣橱网格和舞台会裁坏。不支持比例的模型，生成后用 #F1F1F2 底色补边到 2:3。
- **商品图风格统一**：不同服务商画出来的风格不同，中途换商品图模型会让衣橱里新旧图不一致。商品图生成时，衣橱里已有标准图的话，额外传一张当风格参考（提示词说明只参考背景、光线、构图，不参考衣服本身）。切换商品图模型时提示：「新录入的衣服会用新模型，风格可能和已有的不同；可以在单品详情里重新生成」。
- **上身效果缓存**：缓存键仍是 衣服组合 + 视角 + 形象版本，换模型不会让已生成的失效（省钱）。设置页切换上身效果模型时提示：「已生成的上身效果不会自动重画，可以点重新生成」。

## 费用

- 每个已知模型有官方单价（实现时按 OpenAI、Google 的价格页核对后写进 `catalog.ts`）。Gemini 生图按输出 token 计价（一张图约 1290 token），用响应里的 `usageMetadata` 计算。
- 按钮上的「约 $x」按该用途实际会用的模型估算。
- 价格未知的模型：显示「价格未知」，不计入每月上限；设置页在上限下面提示「以下模型价格未知，不计入上限」。

## 界面（文字草图）

「我的 → AI 服务」改名「API 与模型」：

```
API 与模型
  本月花费（估算）  $0.14 / 上限 $5          [已有的花费卡片]
  API Key
    OpenAI   ••••8F2A   已验证 · 6 个可用模型      >
    Gemini   ••••k3Qz   已验证 · 3 个可用模型      >
    + 添加 API Key（OpenAI / Google Gemini）
  模型
    商品图     自动（GPT Image mini）               >
    个人形象   自动（GPT Image mini）               >
    上身效果   Nano Banana · Gemini                 >
    真人大片   自动（GPT Image mini）               >
    识别       自动（GPT-5.4 nano）                 >
  画质        标准       （所选生图模型都不支持时不显示）
  每月花费上限  $5
```

- 添加 Key：先选服务商，再粘贴 Key；点「验证并保存」时探测模型并显示「可用于：商品图 / 形象 / 上身效果 / 大片 / 识别」。每个服务商一段简短的申请步骤和链接。
- Key 详情：可用模型列表、重新验证、改名、删除（删除后用到它的用途回到「自动」）。
- 选模型：底部弹出列表，按服务商分组，每行显示模型名、单价（或「价格未知」），不能用于该用途的不显示。第一行是「自动（当前：…）」。

## 隐私

- 同意框、隐私政策（App 内和 PRIVACY.md）、商店数据安全文档里的「发送给 OpenAI」改成「发送给你选择的 AI 服务商（OpenAI / Google）」，并分别链接两家的隐私政策。
- 第一次用某个服务商发照片前单独征得同意（同意框写明是哪一家）。没同意的服务商的任务暂停，横幅引导到同意页。

## 迁移（升级后第一次启动，一次性）

1. SecureStore 里原来的 OpenAI Key → 新建 `KeyEntry { provider: 'openai', label: 'OpenAI' }`，Key 复制到 `ai.key.<id>`，验证后删除旧键名。
2. 原 `ai.models`（已探测的模型和选择）→ 这个 Key 的 `models`；`ai.blocked` → 它的 `blocked`。
3. `ai.routes` 全部设为 `auto`。原来用的就是推荐顺序第一位的 OpenAI 模型，所以行为不变。
4. `privacy.photoConsent` → `privacy.consent.openai`。
5. 迁移写一个标记，失败时下次启动重试，不丢旧数据。完整备份仍然不含任何 Key。

## 测试与验证

- 单元测试：Gemini 请求体（多图 inline_data、responseModalities、responseSchema 转换）、响应解析（图片、JSON、usageMetadata）、错误分类，全部用 fake fetch；`resolveRoute` 的自动顺序和混用；迁移；engine 用 fake provider 跑通全部任务。
- 真实 API：OpenAI 照常跑现有真实测试，确认拆分后行为不变。Gemini 这一期只把接口留好：按官方文档写请求和解析，用 fake fetch 单测覆盖；不做真实调用（用户确认不需要）。交付说明里会写明 Gemini 适配未经真实 API 验证。

## 不在第一期

OpenRouter / OpenAI 兼容接口（第二期，`KeyEntry` 加 `baseUrl`）、按 Key 单独设上限、同一用途失败后自动换服务商。
