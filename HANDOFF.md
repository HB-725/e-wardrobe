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
- `cd app && npx jest`（105 个测试）、`npx tsc --noEmit`、`npx expo lint`
- 真实 AI：`REAL_AI_DIR=<含 jacket/tee/jeans/sneakers/p_front/p_side/p_back.jpg 的目录> npx jest src/ai/__tests__/real.test.ts`（约 $0.20）。环境里 api.openai.com 由代理注入 Key，不需要设置环境变量。
- UI：`npx expo export --platform web`，把 dist 和演示图片目录（/demo/*.jpg）用静态服务器提供，打开 `/?demo=1`（还有 `demo=empty`、`demo=noavatar`），用 Playwright 390×844 截图。

## 构建 APK（这台机器）
- 一条命令：`cd app && scripts/build-apk.sh`。它会装 Android SDK（platform 37 / build-tools 37 / NDK 27.1）、JDK 17，写 Gradle 镜像配置（Maven Central 对这台机器限流 429，改用 Google 的 Central 镜像），然后 `expo prebuild` + `gradlew assembleRelease`（只打 arm64-v8a）。
- 产物：`app/android/app/build/outputs/apk/release/app-release.apk`。
- 签名（0.4.0 起）：`plugins/withReleaseSigning.js` 让 release 包用环境变量 `EW_KEYSTORE` / `EW_KEYSTORE_PASSWORD` / `EW_KEY_ALIAS` 指定的 keystore 签名；
  也可以 `EW_SIGNING_ENV=path/signing.env scripts/build-apk.sh`。正式 keystore（`ewardrobe-release.jks` + `signing.env`）已交给用户保管，**不在仓库里**，丢了就无法再给已安装的用户发更新。
  没有这些变量时退回 debug key 并打印 WARNING——debug 签名的包不能覆盖安装 release 签名的包（反之亦然），只能卸载重装，而卸载会删掉手机上的数据（allowBackup 关闭），所以先在 App 里做完整备份。
- `ARCHS="arm64-v8a,armeabi-v7a"` 可以加 32 位手机支持（包会变大）。

## 真机 / 模拟器验证
- 这台机器没有 KVM，但可以用纯软件模拟器做冒烟测试（很慢：开机约 15 分钟，每步约 1 分钟）：
  `sdkmanager "emulator" "system-images;android-34;default;x86_64"`，`avdmanager create avd -n smoke -k "system-images;android-34;default;x86_64" -d pixel_5`，
  `emulator -avd smoke -no-accel -no-window -no-audio -gpu swiftshader_indirect -no-snapshot`，再用 `-PreactNativeArchitectures=x86_64` 打一个包安装。
  uiautomator 在这么慢的模拟器上取不到界面树，用 `adb shell input tap x y` 按坐标点；系统 UI 会频繁 ANR，点 Wait 即可。
- 已在模拟器上跑通（0.2.0 之前）：启动、五个页签、相机拍照、照片导入、无 Key 时队列暂停提示、只存原图、衣橱、试衣间、保存穿搭、今天穿这套、Excel 导出分享；没有 JS 错误或崩溃。
- 设备上的 AI：用 Android 13 镜像（`system-images;android-33;default;x86_64`，可 root），`emulator ... -writable-system`，
  `adb root && adb remount && adb reboot`，把 `/root/.ccr/agent-proxy-ca.crt` 按 `openssl x509 -subject_hash_old` 命名成 `<hash>.0` 推到 `/system/etc/security/cacerts/`，
  再 `adb shell settings put global http_proxy 10.0.2.2:41613`（不要用模拟器的 -http-proxy，它用 IP 发 CONNECT 会被代理拒绝）。
  Key 页面随便填一个 `sk-` 开头的占位 Key，代理会注入真实 Key。
- 0.3.0 前已在模拟器上用真实 AI 跑通：保存 Key、相册批量导入 4 件 → 自动填 + 2 个候选 + 保真检查 → 确认、建立形象（正 / 背面）、试衣间快速换装、生成上身效果、完整备份到 Documents、永久删除、从备份恢复。

## 进度
- [x] 脚手架、domain、db、repositories + 测试
- [x] AI 层 + 测试；真实 Key 跑通全流程（两轮）
- [x] 全部页面；web 导出截图核对
- [x] 两轮代码审视（共 26 个问题已修复并加测试，73 个测试）
- [x] APK 0.3.0（arm64，versionCode 3）；软件模拟器上完整跑通（含真实 AI、备份恢复）
- [x] 完整备份 / 恢复（含照片），存到用户选的文件夹
- [x] 第五轮：评审修复（审核锁、生成中换照片、Key 读取容错、ErrorBoundary、上身效果失效、孤儿图片清理）、首次发送照片前的隐私提示、关于 / 开源许可、正式签名，0.4.0（versionCode 4）
- [x] 第六轮：照片同意在 AI 引擎里强制（未同意时队列暂停，横幅引导到 /consent）；换照片后的旧任务不再重复付费；上身效果生成中衣服变化则丢弃；商品图铺满 3:4 格子（去掉背景色差方框）；快速预览人物满高、卡片在右边缘
- [x] 0.4.0 已发给用户（正式签名，APK SHA-256 2e43b194…2528b16）
- [x] 第七轮（0.4.1）：去掉 READ_MEDIA_IMAGES / READ_MEDIA_VISUAL_USER_SELECTED（模拟器 API 33 实测：系统照片选择器、保存到相册都不需要）；
  模拟器上完整跑通同意流程（拒绝 → 照片照样保存、队列暂停 → /consent 同意 → 自动继续）、录入、形象、快速预览、保存穿搭、今天穿这套、日历、生成大片；
  修复「生成大片 / 上身效果把纯 T 恤画成外套 + 内搭」（提示词重写，真实 API 正面 6/6 正确）；上身效果可「不满意？重新生成」；Android 上 2 件拼贴换行
- 背面上身效果改为「背面形象 + 正面上身效果」让模型转身（tryonBackPrompt）：用平铺商品图时 gpt-image-1-mini 约一半会把胸前印花画到背后，转身方式实测 7/7 正确、满身花纹延续；没有正面时背面任务先生成正面；背面提示词带上每件衣服测得的 colorHex，否则第二次生成会偏色（米白变米色，模拟器上实测）。重新生成正面会删掉由旧正面转出的背面。账户若未验证组织，gpt-image-1 会 400，只能用 mini
- [x] 0.4.1 已发给用户（APK SHA-256 b8943be4…db775941，可覆盖 0.4.0）
- [x] 第八轮（0.5.0）：大衣橱性能（穿着统计一次遍历、同一版本各页面共享一次快照加载、队列刷新合并、衣橱 / 试衣间 / 镜子手选改为虚拟列表、今天页最多 10 套、穿搭库每次 20 套；`?demo=big` 约 600 件 + 两年记录）；
  离线（连不上网的任务不消耗重试次数，回到前台立即重试；超时单独处理，因为可能已计费；界面上的错误不再承诺「自动重试」，镜子识别失败可原图重试）；
  镜子识别（每个品类都有名额、新衣服也会参与、同品类取置信度最高、可多件配饰、取消「覆盖今天」时不留下合身笔记）；
  Excel / CSV 导入（UTF-8 CSV、品类关键词、非法日期提示、单事务、10 MB 上限）；隐私政策 PRIVACY.md、举报 AI 内容入口、按钮文字自动缩小、触控区域、系统大字体上限 1.35x
- 0.5.0 模拟器验证（API 33，x86 包，覆盖安装在 0.4.1 数据上）：数据和上身效果保留、关于显示 v0.5.0 (6)、App 内隐私政策页、虚拟化衣橱网格和试衣间托盘、镜子照片识别（真实 API：T 恤 + 运动鞋高置信度，短裤列为衣橱里没有）→ 记录今天
- 上架前要做（不是代码）：Play 后台填隐私政策链接（PRIVACY.md 合并到 main 后的 GitHub 地址；App 内「关于 → 隐私政策」是同样内容的本地页面）、Data safety 表单声明「照片会发送给 OpenAI 处理」、内容分级；
  表格读写改为自己的 `src/domain/xlsx.ts`（基于 fflate，MIT）：xlsx（SheetJS 0.18.5，有已知 CVE）只留在 devDependencies 里给测试做双向兼容校验，不进 APK。`npm audit --omit=dev` 剩下的是 Expo CLI / config 的构建期依赖（zod、deepmerge），不打进 App
- [x] 0.5.0 已发给用户（versionCode 6，APK SHA-256 54d62064…7bf4b2c3，可覆盖 0.4.x）
- [ ] 视觉风格：另一个会话说用户觉得 UI「太方」，给了 S1 / S2 两个柔和方案，用户尚未在本会话确认，未改
- [ ] 用户真机验证：AI 生成、相册多选、保存到相册、Excel 导入
- [ ] 下一轮可做：商品图背景和 #F1F1F2 仍可能有轻微色差；8 角度；iOS
- 说明：试过让商品图用透明背景（显示最好），但图像模型把透明像素当黑色，深色衣服在上身效果里会消失，所以保持不透明底色。
