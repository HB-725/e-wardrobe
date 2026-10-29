# 交接说明（给下一个会话）

## 目标
把电子衣橱 App 开发完成并打成安卓 APK，按"设计 → 计划 → 开发 → 验证 → 测试 → 审视"循环迭代，直到可以公开发布。

## 已定决策
- UI 定稿：`docs/prototype/`（画布 https://claude.ai/artifact/3zpeTSFattB9rStC2iq7aq ），方向为 C3 布局 × A 配色；导航为 今天（首页）/ 衣橱 / 试衣间 / 穿搭 / 我的。
- 设计文档：`docs/superpowers/specs/2026-10-29-e-wardrobe-design.md`（需要按下面的"本地优先"架构更新）。
- **架构改为本地优先**：Expo（SDK 58 / RN 0.88）+ expo-sqlite + expo-file-system；不需要后端。AI 由 App 直接调用 OpenAI，用户自带 Key（存 expo-secure-store）。
- AI 用最轻量模型：图像用 `gpt-image-1-mini`（images/edits），视觉理解用最便宜的支持图片输入的模型；启动时通过 `/v1/models` 自动探测可用模型。
- 快速换装 = 统一风格商品图在人物旁按身体位置拼贴（即时、免费）；"生成上身效果" = gpt-image 把形象和衣服合成，按衣服组合缓存（`tryon_cache` 表）。

## 环境注意
- 环境变量 `OPENAI_API_KEY`：用于真机效果验证（不要写进代码或提交）。
- Android SDK 从 `dl.google.com` 下载；这台机器没有 KVM，**跑不了模拟器**。UI 用 `expo export --platform web` + Playwright 截图验证，APK 由用户真机安装验证。
- `npx expo install` 需要加 `EXPO_OFFLINE=1`（expo.dev 不可达时）。`.npmrc` 已设置 `legacy-peer-deps=true`。

## 进度
- [x] 项目脚手架、依赖安装
- [x] `src/domain`：types、catalog、stats、outfit
- [x] `src/db`：Db 接口、schema/migrations
- [ ] repositories + 单元测试（sql.js 适配器）
- [ ] AI 层（OpenAI 客户端、模型探测、任务队列）+ 测试
- [ ] 所有页面
- [ ] web 导出截图验证
- [ ] APK 构建（`expo prebuild` + gradle `assembleRelease`）
- [ ] 用真实 Key 验证生图一致性
- [ ] 更新设计文档，进入下一轮
