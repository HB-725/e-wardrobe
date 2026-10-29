# 交接说明（给下一个会话）

## 目标
把电子衣橱 App 开发完成并打成安卓 APK，按"设计 → 计划 → 开发 → 验证 → 测试 → 审视"循环迭代，直到可以公开发布。

## 已定决策
- UI 定稿：`docs/prototype/`（画布 https://claude.ai/artifact/3zpeTSFattB9rStC2iq7aq ），C3 布局 × A 配色；导航 今天 / 衣橱 / 试衣间 / 穿搭 / 我的。
- 设计文档：`docs/superpowers/specs/2026-10-29-e-wardrobe-design.md`（已按本地优先架构更新，第 5 节有实测费用）。
- 本地优先：Expo SDK 58 / RN 0.88 + expo-sqlite + expo-file-system；无后端；用户自带 OpenAI Key（expo-secure-store）。
- 模型：图像 `gpt-image-1-mini`，视觉 `gpt-5.4-nano`（`reasoning_effort: none`）；`/v1/models` 探测，已下线模型（如 `gpt-4.1-nano`）自动拉黑换下一个。
- 转身只有正面 / 背面两个视角；快速换装 = 形象图 + 商品图卡片按身体部位摆放（免费）；"生成上身效果" = AI 合成，按组合 + 视角缓存。

## 代码地图（app/src）
- `domain/` 纯逻辑：类型、品类、统计、穿搭、Excel 导入导出
- `db/` SQLite 仓储层（schema 迁移只追加，不改已发布的）
- `ai/` OpenAI 客户端、模型与价格、提示词、engine（各任务）、runner（持久化队列）
- `state/` app 上下文（db / runner / toast / 试衣间选择）、actions（业务操作）、snapshot（页面数据）
- `app/` 页面（expo-router）；`ui/` 组件；`platform/` 原生 / web 适配；`dev/seedDemo.ts` 网页演示数据

## 验证方式
- `cd app && npx jest`（69 个测试）、`npx tsc --noEmit`、`npx expo lint`
- 真实 AI：`REAL_AI_DIR=<含 jacket/tee/jeans/sneakers/p_front/p_side/p_back.jpg 的目录> npx jest src/ai/__tests__/real.test.ts`（约 $0.20）。环境里 api.openai.com 由代理注入 Key，不需要设置环境变量。
- UI：`npx expo export --platform web`，把 dist 和演示图片目录（/demo/*.jpg）用静态服务器提供，打开 `/?demo=1`（还有 `demo=empty`、`demo=noavatar`），用 Playwright 390×844 截图。

## 构建 APK（这台机器）
- 一条命令：`cd app && scripts/build-apk.sh`。它会装 Android SDK（platform 37 / build-tools 37 / NDK 27.1）、JDK 17，写 Gradle 镜像配置（Maven Central 对这台机器限流 429，改用 Google 的 Central 镜像），然后 `expo prebuild` + `gradlew assembleRelease`（只打 arm64-v8a）。
- 产物：`app/android/app/build/outputs/apk/release/app-release.apk`。目前用模板自带的 debug keystore 签名（每次构建签名一致，可以覆盖安装）；正式发布前要换成自己的 keystore。
- 机器没有 KVM，跑不了模拟器；APK 需要用户真机安装验证。

## 进度
- [x] 脚手架、domain、db、repositories + 测试
- [x] AI 层 + 测试；真实 Key 跑通全流程
- [x] 全部页面；web 导出截图核对
- [x] 第一轮代码审视（13 个问题已修复并加测试）
- [ ] APK 构建（进行中，见上）
- [ ] 用户真机验证：相机、相册多选、分享、保存到相册、Excel 导入导出、后台任务恢复
- [ ] 下一轮：商品图背景和 #F1F1F2 不完全一致（详情页可见色差）；可考虑本机抠图；8 角度；iOS
