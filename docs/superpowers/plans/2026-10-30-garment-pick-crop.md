# 照片里选单品 + 自由裁剪 + 重新生成可调 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 识别照片里的每件衣服，让用户选一件或多件、自由调整裁剪框，按裁剪图生成商品图；重新生成时可以换模型、换画质、写补充要求。

**Architecture:** 现有「识别」调用改为返回多件衣服和位置框（走现有 `vision` 路由，OpenAI / Gemini 通用）。框的计算是 `domain/crop.ts` 里的纯函数；裁剪是 `ImageStore.crop`；「待选择」是单品的新状态 `pick`，识别结果存在单品的 `detections` 里。界面：确认页内选择，全屏 `/crop` 页调框，`RegenerateSheet` 面板。

**Tech Stack:** Expo SDK 58、expo-router、expo-sqlite、expo-image-manipulator（裁剪）、react-native-gesture-handler（拖框）、Jest。

设计：`docs/superpowers/specs/2026-10-30-garment-pick-crop-design.md`。

每个任务结束跑：`cd app && npx tsc --noEmit && npx expo lint && npx jest`。按用户要求，提交要等用户同意，所以计划里没有 commit 步骤。

---

### Task 1: 框的计算（纯函数）

**Files:**
- Create: `app/src/domain/crop.ts`
- Test: `app/src/domain/__tests__/domain.test.ts`（追加 describe）

- [ ] 写失败的测试：`fromBox2d([100, 200, 600, 700])` → `{x:0.2,y:0.1,w:0.5,h:0.5}`；越界 / 反向的值被夹到 0–1 并排正；`padBox` 四周各加 6% 且不出界；`boxArea`；`overlap`（交并比）两个相同框为 1、不相交为 0；`toPixels(box, 1000, 2000)` 得到整数像素矩形且宽高至少 1。
- [ ] 跑 `npx jest domain` 确认失败。
- [ ] 实现：

```ts
/** A rectangle on a photo, 0–1 relative to its width and height. */
export interface Box { x: number; y: number; w: number; h: number }

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Vision models answer [ymin, xmin, ymax, xmax] on a 0–1000 grid. */
export function fromBox2d(b: number[]): Box | null {
  if (b.length !== 4 || b.some((v) => !Number.isFinite(v))) return null;
  const [y0, x0, y1, x1] = b.map((v) => clamp01(v / 1000));
  const box = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  return box.w > 0 && box.h > 0 ? box : null;
}

export function padBox(b: Box, pad = 0.06): Box {
  const x0 = clamp01(b.x - b.w * pad), y0 = clamp01(b.y - b.h * pad);
  const x1 = clamp01(b.x + b.w * (1 + pad)), y1 = clamp01(b.y + b.h * (1 + pad));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const boxArea = (b: Box) => b.w * b.h;

/** Intersection over union. */
export function overlap(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = w * h;
  return inter / (boxArea(a) + boxArea(b) - inter || 1);
}

export function toPixels(b: Box, width: number, height: number) {
  const originX = Math.round(b.x * width), originY = Math.round(b.y * height);
  return { originX, originY, width: Math.max(1, Math.min(width - originX, Math.round(b.w * width))), height: Math.max(1, Math.min(height - originY, Math.round(b.h * height))) };
}
```

- [ ] 跑测试通过。

### Task 2: 数据：新列、新状态

**Files:**
- Modify: `app/src/db/schema.ts`（追加第 3 个迁移）
- Modify: `app/src/domain/types.ts`（`ItemStatus` 加 `'pick'`；`Item` 加 `sourceUri`、`crop`、`detections`；新类型 `Detection`）
- Modify: `app/src/db/items.ts`（行映射、`COLUMNS`、JSON 列）
- Test: `app/src/db/__tests__/repos.test.ts`

- [ ] 测试：建单品带 `sourceUri`、`crop`、`detections`，读回相同；不带时 `crop` 为 null、`detections` 为 `[]`。
- [ ] 迁移：

```sql
ALTER TABLE items ADD COLUMN source_uri TEXT;
ALTER TABLE items ADD COLUMN crop TEXT;
ALTER TABLE items ADD COLUMN detections TEXT NOT NULL DEFAULT '[]';
```

- [ ] 类型：

```ts
export interface Detection {
  box: Box;
  selected: boolean;
  /** Drawn by the user: no AI fields yet. */
  manual: boolean;
  /** Moved far from the AI box (overlap < 0.7): the AI fields may describe something else. */
  edited: boolean;
  name: string; slot: Slot; subcategory: string | null; colorName: string | null; colorHex: string | null;
  seasons: Season[]; brand: string | null; size: string | null; material: string | null;
}
```

`Item` 加 `sourceUri: string | null; crop: Box | null; detections: Detection[]`。`items.ts`：`crop` 存 JSON 字符串（null 存 null），`detections` 进 `JSON_ARRAYS`。

### Task 3: 裁剪图片

**Files:**
- Modify: `app/src/ai/imageStore.ts`（接口加 `crop(uri, box, folder): Promise<string>`）
- Modify: `app/src/platform/images.ts`（原生实现；`importPhoto` 长边 1600 → 2048）
- Modify: `app/src/platform/images.web.ts`（canvas 实现）
- Modify: 测试里的 `MemoryImages`（`ai.test.ts` 等实现了 `ImageStore` 的地方）：`crop` 存一份新内存图，返回新 uri。

- [ ] 先按 AGENTS.md 查 SDK 58 的 expo-image-manipulator 文档，确认 `ImageManipulator.manipulate(uri).crop({originX, originY, width, height})` 的写法和取原图宽高的方法。
- [ ] 原生：在 `withDecodeSlot` 里 `manipulate(uri).renderAsync()` 取宽高 → `manipulate(uri).crop(toPixels(box, w, h)).renderAsync()` → 存 JPEG 到目标文件夹。
- [ ] 网页：`Image` 加载 → canvas `drawImage` 子区域 → `toDataURL('image/jpeg', 0.9)` 存起来，和网页版 `saveBase64` 一样。

### Task 4: 提示词

**Files:**
- Modify: `app/src/ai/prompts.ts`
- Test: `app/src/ai/__tests__/ai.test.ts`

- [ ] `DETECT_SCHEMA` / `detectText(hasTag)` / `DetectResult = { garments: (AutofillFields & { box_2d: number[] })[] }`：在原有单件字段外加 `box_2d`。提示词：只列人身上穿戴的或照片主体；货架、背景、镜子里重复的不算；外套敞开时里面的上衣单独列；每件给 `[ymin, xmin, ymax, xmax]`（0–1000）。原来的 `AUTOFILL_*` 保留，给单件再识别用。
- [ ] `catalogPrompt(slot, name, color, hint?)`：有 `hint` 时末尾加 `The owner's notes on this garment, follow them: "${hint}"`。
- [ ] 测试：带 hint 的提示词包含 hint；不带时和现在一样。

### Task 5: 引擎

**Files:**
- Modify: `app/src/ai/engine.ts`
- Modify: `app/src/ai/config.ts`（`AiSettings.catalogQuality?`；`catalogQualityFor(settings)`）
- Test: `app/src/ai/__tests__/ai.test.ts`

- [ ] 假客户端加 `schemaName === 'detect'` 的返回（可在每个测试里覆盖件数）。
- [ ] 失败的测试：
  1. 识别 1 件、框占 30%：单品 `crop` 有值、`sourceUri` 是原照片、`originalUri` 换成裁剪图，生成请求用了裁剪图。
  2. 识别 1 件、框占 90%：不裁。
  3. 识别 2 件：状态 `pick`、`detections` 2 项、没有生图调用、花费只有识别那次。
  4. 已在衣橱的单品换照片、识别 2 件：取同品类那件裁剪后生成，状态不变。
  5. 任务带 `{ regenerate: true, model: { keyId, model: 'gpt-image-1' }, quality: 'high', hint: '颜色更浅' }`：生图请求的 model 是 gpt-image-1、quality 是 high、提示词含「颜色更浅」。
  6. 任务带 `{ autofill: 'crop' }`：对裁剪图做单件识别并写入字段，不做多件识别。
- [ ] 实现：
  - `withRoute(deps, purpose, fn, override?: { keyId: string; model: string })`：`routes = override ? { ...routes, [purpose]: override } : routes`。
  - `generate` 的 req 加 `route?`，传给 `withRoute`。
  - `runCatalog`：
    - `payload.autofill`：`'skip'`（选单品确认来的、重新生成）→ 不识别；`'crop'` → 单件识别；默认 → 多件识别。旧的 `regenerate: true` 等同 `'skip'`。
    - 多件识别后：框转 `Box`，丢掉面积 < 0.5% 的。
      - 0 件 → 按整张照片继续（字段不填，和现在 isGarment 不生效时一样）。
      - 单品在衣橱里（active / archived）或有吊牌照片 → 取同品类那件，没有就取最大的；
      - 否则 1 件 → 用它；≥ 2 件 → `updateItem(..., { status: 'pick', detections, error: null })`，返回，不生图。
      - 用上的那件：`applyAutofill` 写字段；`padBox` 后面积 < 0.8 才裁：先 `updateJobPayload(photo: 新 uri)`，再 `updateItem({ sourceUri: 原照片, crop, originalUri: 新 uri })`，`original` 换成裁剪图的 data URL。
    - 生成：`prompt` 带 `payload.hint`；`quality` = `payload.quality ?? catalogQualityFor(settings)`；`route: payload.model`。
  - 「被用户换了照片」的判断现在比较的是 `photo` 和 `originalUri`；自动裁剪会改 `originalUri`，所以必须先更新 payload 再更新单品（上面已写）。

### Task 6: 动作、备份、清理

**Files:**
- Modify: `app/src/state/actions.ts`
- Modify: `app/src/db/misc.ts`（`referencedImages` 加 `source_uri`）
- Modify: `app/src/state/backup.ts`（`URI_COLUMNS.items.source_uri = 'original'`）
- Test: `app/src/state/__tests__/actions.test.ts`、`backup.test.ts`

- [ ] 测试并实现：
  - `needsReview` 把 `pick` 算进去。
  - `confirmPicks(ctx, pickId)`：对每个 `selected` 的识别结果，裁剪 → `createItem`（字段来自识别结果，来源 ai；`sourceUri` = 照片；`crop`；状态 processing）→ 入队 catalog，payload `{ autofill: manual || edited ? 'crop' : 'skip' }`；最后删掉待选择那一行（不删照片文件）。没有选中任何一件时抛错。
  - `updateDetections(ctx, pickId, detections)`：存选择和框（调框后 `edited = overlap(新, 原) < 0.7`，原框不在时视为 manual）。
  - `cropItem(ctx, id, box)`：在 `sourceUri ?? originalUri` 上裁剪，旧的裁剪图（不是来源照片时）删掉，更新 `sourceUri`、`crop`、`originalUri`。不入队。
  - `regenerateWith(ctx, id, opts: { patch?: Partial<Item>; model?; quality?; hint?; makeDefault?: boolean })`：先写表单改动（颜色名改了就清 `colorHex`），`makeDefault` 时保存路由和 `catalogQuality`，然后入队 `{ regenerate: true, autofill: 'skip', model, quality, hint }`。
  - `removeItem`：`sourceUri` 只在没有别的单品引用时才删。
  - 备份：`source_uri` 导出再恢复后指向恢复出的文件。
  - 「我的 → 画质」改档位时清掉 `catalogQuality`（`saveAiSettings` 调用处）。

### Task 7: 界面

**Files:**
- Create: `app/src/ui/CropBox.tsx`（照片 + 一个可拖的框，受控：`box`、`onChange`）
- Create: `app/src/app/crop.tsx`（全屏：`?id=&det=<index|new>` 调待选择里的框；`?id=&mode=item` 调单品的框）
- Create: `app/src/ui/RegenerateSheet.tsx`
- Modify: `app/src/app/review.tsx`（待选择视图；「重新生成」打开面板；表单先保存）
- Modify: `app/src/app/item/[id].tsx`（「重新生成」打开同一面板）
- Modify: 首页 / 衣橱里按状态过滤的地方，确认 `pick` 不进衣橱、计入「待确认」。

- [ ] `CropBox`：照片按 `contain` 铺满容器；四角各一个 44×44 的拖动点，框内拖动整体移动；手势用 react-native-gesture-handler 的 Pan（先看项目里 RNGH 3 的写法，没有现成用法就按 RNGH 3 文档）；最小框 5%。
- [ ] 待选择视图（review.tsx 里 `cur.status === 'pick'`）：照片 + 每件中心的白点（选中的画框）+ 标签列表（名称 · 品类，选中打勾，「调整」）+「＋ 自己框一件」；底部「全不要」/「录入 N 件 · 约 $x」（`estimateFor(routing, 'catalog', { inputImages: 1, quality, n: candidates })` × N）。
- [ ] `RegenerateSheet`：调整框选 → `/crop?mode=item`；模型列表（每个 Key 的 `modelsFor(k, 'image')`，第一行「自动」）每行价格；画质（`modelInfo(...).quality` 时显示）；补充要求输入框 + 快捷项；「以后商品图都用这个」；按钮「重新生成 · 约 $x」→ `regenerateWith`。
- [ ] 网页预览（`?demo=1`）里走一遍：待选择 → 选两件 → 调框 → 录入；重新生成面板。演示数据里加一件待选择的单品。

### Task 8: 真实 API、打包、交接

- [ ] `real.test.ts` 加一条（需要 `OPENAI_API_KEY`，默认跳过）：一张有上衣和裤子的照片，识别出 ≥ 2 件，各自的框和人工标的框交并比 > 0.5。分别跑 gpt-5.4-nano 和 gpt-5.4-mini，把结果和花费写进 HANDOFF。
- [ ] `npx tsc --noEmit`、`npx expo lint`、`npx jest` 全过。
- [ ] 打 APK，模拟器上走一遍导入穿搭照 → 选两件 → 录入；发到用户手机。
- [ ] 更新 `HANDOFF.md`。
