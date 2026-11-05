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
- `cd app && npx jest`（139 个测试，1 个默认跳过）、`npx tsc --noEmit`、`npx expo lint`
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
- [x] 第九轮（0.5.1）：0.5.0 模拟器上完整备份 → 永久删除 → 恢复跑通；表格读写去掉 SheetJS（见上）；真人大片可选任意一张保存 / 分享、离开前提醒未保存或生成中；拍照保存中不能返回 / 关闭；
  试衣间换了品类的衣服不会重复出现；形象重新生成期间不能生成上身效果和大片，生成中的上身效果结果作废；形象页所有出口都确认未用的照片、身材数据随时可「只保存数据」；
  单品编辑的价格 / 日期无法识别时提示而不是清空；备份 / 恢复 / 删除时全屏遮罩
- [x] 视觉风格 S1（用户选定）：按钮 / 分类标签 / 徽标 / 提示条改为胶囊，卡片和图片圆角，统一用 `ui/theme.ts` 的 `R` 圆角值；标题去掉英文小字，各页说明文字精简。改前 / 改后截图（390、360 宽）已发给用户
- 0.5.1 模拟器验证（x86，覆盖安装在 0.5.0 数据上）：数据保留、S1 圆角在 Android 上正确裁切、Excel 导出（openpyxl 能读三张表）、从 Downloads 导入 openpyxl 做的表格（价格保留）；
  发现并修复：品类留空的行被拒绝（「品类「空」无法识别」），现在按细类 → 名称的关键词自动归类，品类写了但认不出时按名称归类并提示用的是哪一列
- [x] 灰色 / 米色面板里的次要按钮和分段控件用白底（`Btn` / `Segmented` 的 `onCard`）；真人大片页去掉角标提示和多余的价格行
- [x] 0.5.1 已发给用户（versionCode 7，arm64，正式签名，APK SHA-256 8c9ea317…a923508f9f，可覆盖 0.5.0 / 0.4.x）
- 0.5.1 x86 包（含白底按钮和品类归类修复）模拟器复验：日历「补记」、单品详情「添加照片」白底可见；空品类表格导入 4 件、跳过 1 行并说明原因、「冬季」按名称归为外套
- [x] 第十轮审视（0.5.1 之后，未发包）：表格标题行上方有空行 / 大标题时在前 10 行里找「名称」列，找不到时给出说明而不是「新增 0 件」；自闭合 `<si/>` / `<t/>` 不再错位后面的共享字符串；
  试衣间分类小圆点按实际穿着计算；形象重新生成时不再和「正在生成上身效果」角标重叠。已在 0.5.2 里
- [x] 0.5.2 已发给用户（versionCode 8，APK SHA-256 7a3a738e…6f021a1cd0；另发 Play 用 AAB，arm64 + armeabi-v7a，SHA-256 2acd06ce…a722374f1，以及 512 图标和 1024×500 置顶大图）
- 0.5.2 模拟器验证（x86，覆盖安装在 0.5.1 数据上）：关于显示 v0.5.2 (8)、数据保留；表格第 1 行是大标题、第 2 行空、第 3 行才是列名，导入 2 件（切尔西靴按名称归到鞋）
- 窄屏检查（0.5.2）：网页 320 宽全部页面无 console 错误；模拟器 `wm density 560`（约 308dp）今天、试衣间可用。试衣间托盘每列 2 件、名字截断，留给改版解决
- Play 上架资料在 `docs/store/README.md`（商品详情文字、数据安全答案、分级、受众、App access 说明、发布步骤）；`BUNDLE=1 scripts/build-apk.sh` 出 AAB；
  商店截图 `VW=360 VH=640 DPR=3 node scripts/web-shots/shoot.js <目录>`（1080×1920）。隐私政策网址要等 PR 合并到 main（或放到别的公开网址）；新个人开发者账号需要 12 人 14 天封闭测试
- [x] 试衣间重构：已按用户定稿做完（见下面「试衣间 F2 + 叠穿」）
## 待决事项和下一步（2026-10-30 收尾，用户改为在自己电脑上本地继续）

最新正式签名的安装包仍是 **0.5.2**（versionCode 8；0.6.0 只有测试签名的包）：APK SHA-256 `7a3a738eeba0bb9d1d5579ace82d47579d43c1e4917198503960646f021a1cd0`，Play 用 AAB SHA-256 `2acd06ce66d91d281877959fd60e9ba0fbfaaca943fa01521d7ff44a722374f1`。b19e5b9 之后的提交只新增了还没接入的文件，App 行为没变。

- [x] **试衣间 F2 + 叠穿**（2026-11-02；计划 `docs/superpowers/plans/2026-11-02-fitting-room-f2-layers.md`；定稿在画布 https://claude.ai/artifact/3zpeTSFattB9rStC2iq7aq 的「精简版 · 做法 B」和「F2 整套」）：
  - 全屏人物 + 右侧圆形按钮（转身 / 生成或重新生成上身效果，先确认价格 / 保存穿搭 / 生成大片）+ 底部抽屉。抽屉收起是一排「已穿 | 分类」+ 一排衣服，上拉 60% 高：分类按细类分组成 3 列网格，「已穿」变成穿着顺序（拖动换里外、敞开 / 扣好、塞进 / 放外面、× 脱下）。人物旁不再贴衣服小卡（`Stage` 只画人，生成中有一道扫光）。
  - 叠穿：`domain/look.ts` 的 `Look { ids, styling }` 取代 `Selection`；上衣和外套合称上身，最多 5 层，从里到外存放。同类再点一件叠到最外面，底部提示「改成换掉」；下装 / 鞋 / 包 / 配饰直接换。衣橱、单品详情的「去试穿」换掉同类最外面那件；穿搭「在试衣间打开」按保存的顺序和穿法，默认打开「已穿」。
  - 存储：迁移 4 给 `outfit_items` 加 `position`、`styling`；同样衣服但顺序或穿法不同算不同穿搭。上身效果缓存键 `lookKey`：一件上衣在一件外套里面且没设穿法时和以前的 `outfitKey` 一样（旧缓存可用，网页上实测从穿搭打开直接显示旧图），否则后面加 `~顺序:穿法`。试穿任务 payload 带 `itemIds`（顺序）和 `styling`。
  - 提示词：`tryonPrompt` / `photoPrompt` 收到每件的 slot 和穿法，两层以上或有穿法时写明从里到外的层次和每层穿法；一上衣 + 一外套无穿法时保留原来验证过的那句。背面提示词三层以上时说明层次。**叠穿效果没有用真实 API 测过。**
  - 验证：jest 168 个 + 3 个真实 API 跳过，tsc、lint 通过；网页 `?demo=1` 走过空状态、叠加提示和改成换掉、已穿行、穿着顺序（拖动、穿法）、生成确认和生成中、背面、保存、拖抽屉、没有形象、空分类。
- [x] **配饰多条、妆容、试衣间生成面板、详情页暂停提示**（2026-11-02，本地，未提交、未发包）：
  - 配饰：`wear` 里配饰是加上去不是替换，最多 `MAX_ACCESSORIES` = 4 件；同类加第二件时底部提示「X 和 Y 一起戴 · 改成换掉 Y」。「去试穿」（`replace`）也是加，满 4 件才换掉最后一件；已经穿着的衣服再「去试穿」不会被脱下（以前会）。提示词两件以上配饰时写「全部一起戴，各戴在该戴的位置」。
  - 妆容：`domain/makeup.ts` 六个预设 + `custom:用户的话`；`Look.makeup`，穿搭表加 `outfits.makeup`（迁移 5），同样衣服不同妆容算不同穿搭。缓存键末尾 `~mk:预设或哈希`。生成时先要（或先画）没化妆的正面，再对这张图做一次只改妆容的编辑（`makeupPrompt`，第二张图给原本的形象），然后用识别模型比对形象和结果是不是同一个人（`FACE_*`），不像重画一次，两次都不像就失败、不保存（「化妆后看起来不像你了…」）。没穿衣服时直接在形象上化。背面不画妆容（用没化妆的背面）。大片的提示词也带妆容。**没有做遮罩**：OpenAI 的遮罩要带透明通道的 PNG，本机没有能编码的库，而且 gpt-image 的遮罩只是参考；Gemini 不支持遮罩。真实 Key 测过之后如果衣服或背景被改动，再考虑加。
  - 生成面板：试衣间的生成确认弹窗换成 `TryonSheet`（和商品图「重新生成」共用 `GenOptions`）：选模型（每行价格，背面 / 妆容按要几次生图加起来）、画质、补充要求（快捷项 + 输入，放在提示词最后）、「以后上身效果都用这个模型和画质」（存 `routes.tryon` 和 `ai.settings.tryonQuality`，在「我的 → 画质」改档位时清掉）。任务 payload 带 `model` / `quality` / `hint`；失败的任务重试时换成新的选择。
  - 单品详情：任务因 AI 暂停卡住时显示「AI 已暂停」横幅，点了去处理。
  - 修了叠穿那一轮留下的漏洞：删除衣服时 `dropTryonsWithItem` 按 `idsOfKey` 匹配，叠穿（`~a>b`）和妆容（`~mk:`）的上身效果缓存和排队任务也会清掉。
  - 衣橱格子右下角从「×N」改成「已穿 N 次」/「没穿过」（×N 容易看成有 N 件）。
  - 单品详情：「今天穿了它 | 去试穿」固定在屏幕底部（收起的是「放回衣橱」，失败的是「只存原图 | 重新生成标准图」，生成中 / 待确认是「去确认 / 只存原图」）；重新生成、换照片、收起、删除放到页面最后的「管理」列表。
  - 试衣间另外三种思路（G1 装备栏、G2 拼图先行、G3 整套优先）画在设计画布「另外三种思路」一组，等用户选；代码还是精简版 B。
  - 网页演示加了三件配饰（`demo/beanie|scarf|watch.jpg` 是画的插图，不是 AI 图）。
  - 验证：jest 182 个 + 3 个真实 API 跳过，tsc、lint 通过；网页 `?demo=1` 走过配饰三件、妆容面板、选妆容后未生成、生成面板、化妆生成中和完成、详情页暂停横幅，所有试衣间截图重拍。Android 模拟器（测试签名包，测完已卸载）：Excel 导入 7 件、五个圆形按钮、两件配饰一起戴和提示、保存带三件配饰的穿搭（迁移 5）。模拟器上没有形象，所以妆容面板和生成面板只在网页上看过。**妆容和叠穿都没用真实 API 测过。**
- [x] **多家 AI 服务商（OpenAI + Gemini）已接入**（2026-10-30，本地会话；未发包、未上模拟器 / 真机）：
  - engine 按用途 `resolveRoute`（商品图 / 形象 / 上身效果 / 大片 / 识别），`AiDeps.clientFor(key)`；模型 3 天未验证就重新探测（同时清空拉黑）；模型不可用时 `blockModelForKey` 后换下一个；`callCost` 价格未知记 0，不计入上限；只在支持画质的模型上传 quality；Gemini 商品图额外传一张已有标准图当风格参考（`STYLE_REF_NOTE`）。
  - Gemini `imageEdit` n>1 用 `Promise.allSettled`：有一张成功就返回，失败那次的 usage 也计入；全失败才抛第一个错误。
  - `saveBase64` 按内容定扩展名（`imageExt`：png / webp / jpg），备份恢复认 png。
  - 启动先 `migrateLegacyKey`，同意改为按服务商（`hasConsentFor` / `pendingConsent`），同意框、/consent 页写明是哪家。
  - 「我的 → API 与模型」（`app/apikey.tsx`：Key 列表、详情底部弹窗＝重新验证 / 改名 / 删除、按用途选模型）、添加 Key（`app/addkey.tsx`）；按钮上的「约 $x」按实际路由估算，未知显示「价格未知」；画质行在所选生图模型都不支持时隐藏；花费上限说明列出价格未知的模型。
  - 文案：`describeAiError`、runner、隐私页、PRIVACY.md、`docs/store/README.md` 改成「你选择的 AI 服务商（OpenAI / Google）」。`ai.keys` / `ai.routes` / `ai.keysMigrated` 是设备设置：不进备份、恢复不覆盖；「永久删除」先删所有 `ai.key.*` 再清库。
  - 验证：jest 144 个（1 个真实 API 默认跳过），tsc、lint 通过；网页导出 `?demo=1` 看过「我的」「API 与模型」、选模型弹窗、Key 详情、添加 Key（含 Gemini 页签），无 console 错误。
  - **还没做**：Gemini 适配仍未用真实 API 验证；`auth` / `quota` 仍暂停整个队列（设计里是只暂停用到这个 Key 的任务）；不支持宽高比的模型补边到 2:3 没做（Gemini 走 `imageConfig.aspectRatio`）。下次发包前在模拟器上跑一遍 0.5.2 → 新版覆盖安装，确认老 Key 和同意自动迁移。
- [x] **0.6.0 测试包**（versionCode 9，测试签名，本机 Mac 打包，通过 Tailscale 发到用户手机）：本机没有正式签名文件，不能覆盖 0.5.2；用户把 `signing.env` 和 `ewardrobe-release.jks` 放到本机后用 `EW_SIGNING_ENV=... ` 重打。另修了底部导航贴近手势条（`10 + insets.bottom`）、建立形象的「相册」改成按钮。
- [x] **照片里选单品 + 自由裁剪 + 重新生成可调**（2026-10-30，设计 `docs/superpowers/specs/2026-10-30-garment-pick-crop-design.md`，计划 `docs/superpowers/plans/2026-10-30-garment-pick-crop.md`）：
  - 识别改为 `DETECT_*`：一次调用返回每件衣服的 `box_2d`（0–1000）和字段。1 件：框留 6% 边、占照片不到 80% 就自动裁剪后生成；≥2 件：单品进 `pick` 状态（不生图），确认页里点圆点 / 名字选、「调整框」「自己框一件」（全屏 `app/crop.tsx`），`confirmPicks` 每件裁剪成新单品（共用 `source_uri`）。衣橱里的单品换照片、带吊牌的单品不进 `pick`，取同品类那件。
  - `items` 新列 `source_uri` / `crop` / `detections`（迁移 3）；来源照片最后一个引用删掉时才删文件；备份带 `source_uri`。原图长边 1600 → 2048。
  - 「重新生成」面板（`ui/RegenerateSheet.tsx`，确认页和单品详情页共用）：调整框选、这次用的模型（每行价格）、画质、补充要求（快捷项 + 输入框，放在提示词最后）、「以后商品图都用这个」（存路由和 `ai.settings.catalogQuality`；在「我的 → 画质」改档位时清掉）。点之前先保存表单，颜色名改了就清掉颜色值，所以「改成下装再重新生成」现在会按下装画。
  - 验证：jest 160 个 + 3 个真实 API 默认跳过；tsc、lint 通过；网页 `?demo=1` 看过待选择页（4 件、选 2 件、录入后各自裁剪）、重新生成面板、裁剪页。Android 模拟器上（新架构）走过：相册导入 → 只存原图 → 详情页重新生成面板 → 调整框选 → 拖四个角 → 完成后原图换成裁剪图，再打开框还在。
  - 拖框用 react-native-gesture-handler 的 `usePanGesture`（`runOnJS`）：PanResponder 在 Android 新架构下触摸进不来。裁剪页左右留 56pt，角不能落在系统返回手势的边缘区。
  - **还没做**：OpenAI 框的准确度没用真实 Key 测过（`OPENAI_API_KEY=sk-... npx jest src/ai/__tests__/detect.real.test.ts` 会对比 gpt-5.4-nano / mini 并打印花费）；识别出的单品和衣橱已有的比对；接 Gemini 识别。（试衣间生图面板已在 2026-11-02 做了，见上。）
- [x] **内置 Key 的测试包 + 两家真实 API 验证 + 保真修正**（2026-11-04/05，本地，未提交）：
  - 测试包内置用户的 OpenAI 和 Gemini Key：`app/.env.local`（git 忽略，不要提交）里 `EXPO_PUBLIC_OPENAI_API_KEY` / `EXPO_PUBLIC_GEMINI_API_KEY`，启动时 `addBuiltInKey`（`ai/keys.ts`）各加一次：删掉不会再加回，换了新 Key 才再加。Gemini 的 Key 可能是 `AQ.` 开头，添加页的格式检查放宽。拿到 APK 的人能取出 Key，只能自己用，不能上架。0.6.0 测试包（versionCode 9，测试签名，可覆盖手机上的测试包）已通过 Taildrop 发到手机。
  - Google 对新 Key 不再提供 gemini-2.5-flash-lite / 2.5-flash / 2.5-pro（404「no longer available to new users」，模型列表里仍列着）；2.5-flash-image 还能用。「自动」识别顺序改为 3.1-flash-lite → 3.5-flash-lite → 2.5-flash-lite（老 Key）→ 3-flash-preview；价目表补上 3.x（含 3.1 / 3 Pro 生图）。不传 thinkingConfig：lite 默认不思考，`thinkingBudget: 0` 在 3.5-flash-lite 报 400。
  - 识别：提示词写明一双鞋算一件、印花不是衣物；`tidyGarments`（`domain/crop.ts`）合并挨着的两只鞋、丢掉落在衣服里的「配饰」。
  - 商品图：识别多读 `printText`（不存库；选单品路径走任务 payload）喂给生图提示词；核对提示词点名领型 / 袖长 / 裤腿宽、文字逐字对；候选按核对失败数排序，第一张是默认选中的。
  - 试穿正面和大片：生成后用识别模型核对（`OUTFIT_*`：全身完整、每件对得上），不对就带着问题重画一次，两稿里留问题少的那张（第一版留最后一稿，实测重画把长裤画成短裤反而被留下）。大片有试穿正面图时从它出发（`photoPrompt` 的 `dressed`），只换场景。试穿提示词加了「头顶到鞋都在画面里」。
  - `real.test.ts` 可选 `REAL_AI_PROVIDER=openai|gemini` 和 `REAL_AI_KEY`，照片里多件时自动选最大的那件，报告带每次调用的模型、花费和核对的回答。两家各用 4 张 Wikimedia Commons 实拍图跑了两轮（改前、改后，共约 $1.9）：改后两家都不再把鞋拆成两件、印花拆成配饰；T 恤文字 OpenAI 两张候选一对一错，排序把对的放前面；Gemini 不再裁头，识别费用记上了；OpenAI 的牛仔外套、牛仔裤两张候选核对全不过（颜色偏浅，像素取色那条还没做）。**「留较好一稿」的改动还没再用真实 API 验证。**
  - 验证：jest 197 个 + 3 个真实 API 跳过，tsc、lint 通过。
- [x] **用户 9 张实拍当样本：商品图保真对比，商品图改走 gpt-image-1.5 / Gemini**（2026-11-05，提交 89ad962）：
  - 新测试 `catalog.real.test.ts`：只跑录入（识别、裁剪、商品图、核对），目录里每张照片一件，多件时自动取最大的那件；`REAL_AI_QUALITY` / `REAL_AI_MODEL` 可以指定画质和模型做对照。公共部分抽到 `src/test/realApi.ts`（curl 版 fetch、磁盘图片仓；裁剪用 macOS `sips` 真裁，以前电脑上是整张照片冒充裁剪）。样本图只在会话临时目录，没进仓库。
  - 结果（每件 2 张候选）：gpt-image-1-mini 低画质 9 件 8 件核对全不过，中画质也差不多，做旧、水洗、logo 文字、颜色全丢；gpt-image-1.5 低画质（$0.045/件）和 Gemini 2.5 Flash Image（$0.08/件）都保住了褪色、雪花水洗、灯芯绒领、侧拉链。Gemini 把硬壳冲锋衣画成羽绒服、背景不是统一 #F1F1F2；1.5 有一张 T 恤画成 V 领（核对抓到）。两家的 Lacoste 小字都不对。
  - 接着又比了 5 个模型（每件 1 张）：gpt-image-1.5 中画质 $0.60、gpt-image-2 低 $0.14、Gemini 3.1 Flash-Lite Image $0.41、3.1 Flash Image $0.82、3 Pro Image $1.67（9 件含识别和核对）。目测：**Gemini 3.1 Flash-Lite 最还原且背景干净、衣服占满画面**；3.1 Flash 和 3 Pro 质感略好但贵 2–5 倍，还会在 Carhartt 胸口多画字；gpt-image-2 低和 1.5 低差不多（1.5 中画质没有更好，还把 T 恤画成 V 领）；Gemini 2.5 背景不平、衣服偏小；mini 任何画质都不行。所有模型都写不对很小的印花文字。
  - 改动：每件商品图默认只生成 **1 张**（`candidates: 1`；44 件里第二张只赢 3 次），不满意走「重新生成」。商品图单独一个顺序 `CATALOG_ORDER`：Gemini 3.1 Flash-Lite → gpt-image-2 → gpt-image-1.5 → Gemini 3.1 Flash → Gemini 2.5 → mini → gpt-image-1；形象 / 上身 / 大片仍走便宜的 `AUTO_ORDER`。识别再补两条：同类框落在更大的同类框里（袖口 logo 被当成第二件卫衣）丢掉；提示词写明吊牌、洗标、衣架、包装不是衣物。
  - 新测试 `referee.real.test.ts`：同一个视觉模型给多个 run 的商品图打分。用 gpt-5.4-mini 一次看 10 张图时分数挤在 5 分上下、和目测不符（mini 中画质的 drew 卫衣丢了褪色却得 8 分），**结论没有采用它**，以目测和各 run 自己的核对为准；要用的话改成一次只比一张。
  - 没解决：很小的印花文字；穿搭照自动取最大一件的测试逻辑会选错（手机上是用户自己选）。
  - 商品图提示词改为「保真优先」：说明这是用户自己的、可能穿过洗过的衣服，褪色 / 水洗 / 裂纹印花 / 毛边 / 起球原样保留，不要画成新的、不要改色调；藏起来的部分只按这件该有的样子补、不加东西；文字和 logo 逐字照抄，太小看不清就画成同位置同大小的模糊痕迹而不是编字。识别提示词补「搭在椅子、沙发上的毯子、围巾不算」。用 Gemini 3.1 Flash-Lite 和 gpt-image-2 各 9 件新旧对照：drew 卫衣的晒褪和毛边、Kith 毛衣的雪花水洗更接近原图，其他持平，花费不变。
  - 验证：jest 201 个 + 5 个真实 API 跳过，tsc、lint 通过；今天真实 API 共约 $6.5。
- [x] **商品图：能不能用更轻的模型 + 更长的提示词做到 $0.01/件**（2026-11-05 下午，本地，未提交）：
  - 每件开销（识别 + 1 张图 + 核对，实测 token）：gpt-image-1-mini 低画质 $0.008；gpt-image-2 低画质 $0.016（输入图 720–1500 token 随尺寸涨，输出低画质固定 158，中画质 1372 = $0.052/张）；Gemini 3.1 Flash-Lite Image $0.046（每张固定 1120 token）。gpt-image-2 不支持 512 输出和 `input_fidelity`，mini 也不支持 `input_fidelity`；输入图放大到 2048 只涨钱不涨质量。gpt-image-2 的地板约 $0.013，到不了 $0.01。
  - mini 低画质 + 现在这版提示词 $0.008/件：比旧提示词好不少（Nike 藏青回来、Lacoste 笑脸大小对了、Kith 有水洗纹），但大面积晒褪（drew 卫衣）和水洗质感仍画成均匀的洗旧黑，整体偏新；~170 token 的短提示词效果相同还凭空加了灯芯绒领，没采用。
  - 试过让识别模型多写一段英文「照片里看到的」（`look` 字段）喂给画图模型，gpt-image-2 跑 4 轮、mini 跑 2 轮（各 9 件）：颜色命名有帮助（Nike 藏青），但 gpt-5.4-nano 看不出晒褪和水洗，写「solid black / no visible fading / print intact」时画图模型就真把本来能从照片保住的褪色抹平；写错结构（给棉服编出胸袋）mini 就照画。**整段描述净效果为负，已撤掉**，只保留颜色这一课：识别提示词补「深色分清藏青 / 黑 / 深灰 / 墨绿，灰分清麻灰 / 浅灰，褪色黑、水洗黑；取色别被阴影带黑」。验证：Nike 裤子识别从 黑色 #1F2430 变为 深蓝 #0B1A33，gpt-image-2 画出藏青；drew 卫衣的褪色和裂纹印花保持。
  - 结论：mini 靠提示词追不上，差在模型对磨损质感的还原，不是指令；商品图默认顺序 `CATALOG_ORDER` 改为 gpt-image-2 在前（一件 $0.016，和 Gemini 3.1 Flash-Lite 的 $0.046 效果接近，用户定的）。`catalog.real.test.ts` 现在把每次发给画图模型的提示词记到目录里的 `prompts.txt`。
  - 验证：jest 202 个 + 5 个真实 API 跳过，tsc、lint 通过；今天真实 API 共约 $7.8。
- [x] **裁好后先做一次全面分析再生图（`analysis` 用途）**（2026-11-05 傍晚，本地，未提交）：
  - 探了 9 个视觉模型写 drew 卫衣和 Kith 毛衣：**只有 gpt-5.4-nano 看不见晒褪和雪花水洗**，Gemini 3.1 Flash-Lite 起、gpt-5.4-mini 起全都写得准，Lite 一次约 $0.001（和 nano 差不多）。
  - 新增一步：裁剪之后、生图之前，对裁好的图做一次结构化分析（`ANALYSIS_SYSTEM` / `analysisText(slot)` / `ANALYSIS_SCHEMA`，七项英文：colour、material、cut、details、prints、wear、creases，只写看得见的、不写「没有」），整段拼进商品图提示词（`analysisLine`）。新的用途 `analysis`（设置里叫「分析衣服」），自动顺序 `ANALYSIS_ORDER`：Gemini 3.1 Flash-Lite → 3.5 Flash-Lite → gpt-5.4-mini → Gemini 3 Flash → 2.5 Flash → gpt-4o → gpt-5-mini，nano 只在别无选择时。`vision()` 多了 purpose 参数；`catalog.real.test.ts` 的 `REAL_AI_VISION`（可配 `REAL_AI_PROVIDER2` / `REAL_AI_KEY2` 用另一家的 Key）同时指定识别和分析模型，每次发给画图模型的提示词记到目录里的 `prompts.txt`。
  - 9 件对照（低画质）：mini + Gemini Lite 分析 $0.009/件，drew 卫衣的晒褪和裂纹印花、Kith 的雪花水洗都画出来了，接近 gpt-image-2 不带分析（$0.0165）；gpt-image-2 + Gemini Lite 分析 $0.0185，drew 是所有轮里最像的；gpt-5.4-mini 做分析（+$0.007/件）没有比 Lite 更好。分析偶尔也会错（Lite 把藏青 Nike 裤写成 black，mini 仍按色值画成藏青；mini 给飞行员夹克自己加了红里布，分析里没写）。
  - 之前试的「识别时顺带写一段描述」（`look` 字段）已撤掉，被这一步取代。
  - 验证：jest 204 个 + 5 个真实 API 跳过，tsc、lint 通过；今天真实 API 共约 $9.5。
- [ ] 上架：隐私政策网址要等 PR 合并到 main（或把 PRIVACY.md 放到别的公开网址）；新个人开发者账号需要 12 人 14 天封闭测试。

## 本地构建（用户自己的电脑）

- 需要 Node 22、JDK 17、Android SDK（platform 37、build-tools 37、NDK 27.1）。`cd app && npm ci`，然后：
  - 开发：`npx expo start`（Expo Go 不含所有原生模块，建议 `npx expo run:android` 装开发版）。
  - 检查：`npx tsc --noEmit`、`npx expo lint`、`npx jest`（182 个测试，3 个真实 API 测试默认跳过）。
  - 正式包：`EW_SIGNING_ENV=/path/to/signing.env scripts/build-apk.sh`（APK）或加 `BUNDLE=1`（Play 用 AAB）。`signing.env` 和 `ewardrobe-release.jks` 已交给用户保管，**不在仓库里**；脚本里装 SDK、写 Gradle 镜像那几步是给云端 Linux 机器用的，本机已装好 SDK 时可以跳过。
- 每次发新版：`app/app.json` 的 `version` 和 `android.versionCode` 加一。

- [ ] 用户真机验证：AI 生成、相册多选、保存到相册、Excel 导入
- [ ] 下一轮可做：商品图背景和 #F1F1F2 仍可能有轻微色差；8 角度；iOS
- 说明：试过让商品图用透明背景（显示最好），但图像模型把透明像素当黑色，深色衣服在上身效果里会消失，所以保持不透明底色。
