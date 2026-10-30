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
- [ ] 试衣间重构：用户觉得右侧竖排分类放不下「毛呢大衣」这类细分名、托盘一列只有两件。另一个会话在设计画布上放了 F1（上下布局）/ F2（全屏舞台 + 底部抽屉）两个方案，等用户选，选定前不要改试衣间布局
## 待决事项和下一步（2026-10-30 收尾，用户改为在自己电脑上本地继续）

最新安装包仍是 **0.5.2**（versionCode 8）：APK SHA-256 `7a3a738eeba0bb9d1d5579ace82d47579d43c1e4917198503960646f021a1cd0`，Play 用 AAB SHA-256 `2acd06ce66d91d281877959fd60e9ba0fbfaaca943fa01521d7ff44a722374f1`。b19e5b9 之后的提交只新增了还没接入的文件，App 行为没变。

- [ ] **试衣间布局待用户选**：画布 https://claude.ai/artifact/3zpeTSFattB9rStC2iq7aq 最上排 F1–F6。「F2 改」（全屏舞台 + 底部抽屉）已实现在 c208718，后来 revert（5f31eed），选 F2 或混搭时可以 `git revert 5f31eed` 再改；它用 RN Animated + PanResponder 做抽屉，web 和 Android 都能用。
- [ ] **多层叠穿**（上衣 / 外套可多件并排序，配饰可多条，建议上限约 8 件）和 **妆容**（只在脸部区域做遮罩局部编辑 + 视觉模型比对是否同一人，不像就重来）：方案待用户决定。
- [ ] **多家 AI 服务商**：用户已确认 `docs/design/multi-provider.md`（会话最后通过提问确认「按这个做」）。
  - 已完成、已测试、**还没接入**：`src/ai/providers/gemini.ts`（Gemini 适配，按公开 REST 写，fake fetch 单测，未用真实 API 验证——用户说不需要；ai.google.dev 在云端环境里访问不了）、
    `src/ai/catalog.ts`（模型表、价格、自动顺序、按用途路由、未知价格返回 null）、`src/ai/keys.ts`（多个 Key 只存 SecureStore、按服务商同意、0.5.x 单 Key 迁移，可中断续跑）、`platform/secrets*.ts` 的 `secureSecrets`。
  - 待办：
    1. Gemini `imageEdit` 在 n>1 时改用 `Promise.allSettled`：至少一张成功就返回成功的（usage 累加成功的，失败那次响应里若有 usageMetadata 也计入），全部失败才抛第一个错误；补一条「2 次里 1 次 SAFETY」的测试。
    2. engine 接入：`AiDeps.getClient` 换成 `clientFor(key)`，每个任务按用途 `resolveRoute`（商品图 / 形象 / 上身效果 / 大片 / 识别）；过期 Key 重新探测模型；模型不可用时 `blockModelForKey` 后重试；`callCost` 未知价格记 0（不计入上限）；只在支持的模型上传画质；Gemini 返回 PNG，保存时按内容选扩展名（`/9j/` jpg、`iVBOR` png、`UklGR` webp），备份恢复也要认 png；Gemini 商品图额外传一张已有标准图当风格参考。
    3. 启动时先跑 `migrateLegacyKey`，**再**把 `hasPhotoConsent` 改成读按服务商的同意（顺序反了老用户会被要求重新同意）。
    4. 「我的 → API 与模型」页面（多个 Key、添加 / 详情 / 重新验证 / 改名 / 删除、按用途选模型、换模型时的提示、画质只在支持时显示）；按钮上的「约 $x」按实际路由估算，未知价格显示「价格未知」。
    5. 同意框按服务商、`describeAiError` 里的「OpenAI」改成通用说法、App 内隐私页、PRIVACY.md、`docs/store/README.md` 改成「发送给你选择的 AI 服务商（OpenAI / Google）」；备份不能带 Key（`ai.keys` 只是描述，恢复后没有密钥的条目要丢掉或标成需要重新填）；「永久删除」要删掉所有 `ai.key.*`。
- [ ] 上架：隐私政策网址要等 PR 合并到 main（或把 PRIVACY.md 放到别的公开网址）；新个人开发者账号需要 12 人 14 天封闭测试。

## 本地构建（用户自己的电脑）

- 需要 Node 22、JDK 17、Android SDK（platform 37、build-tools 37、NDK 27.1）。`cd app && npm ci`，然后：
  - 开发：`npx expo start`（Expo Go 不含所有原生模块，建议 `npx expo run:android` 装开发版）。
  - 检查：`npx tsc --noEmit`、`npx expo lint`、`npx jest`（139 个测试，1 个真实 API 测试默认跳过）。
  - 正式包：`EW_SIGNING_ENV=/path/to/signing.env scripts/build-apk.sh`（APK）或加 `BUNDLE=1`（Play 用 AAB）。`signing.env` 和 `ewardrobe-release.jks` 已交给用户保管，**不在仓库里**；脚本里装 SDK、写 Gradle 镜像那几步是给云端 Linux 机器用的，本机已装好 SDK 时可以跳过。
- 每次发新版：`app/app.json` 的 `version` 和 `android.versionCode` 加一。

- [ ] 用户真机验证：AI 生成、相册多选、保存到相册、Excel 导入
- [ ] 下一轮可做：商品图背景和 #F1F1F2 仍可能有轻微色差；8 角度；iOS
- 说明：试过让商品图用透明背景（显示最好），但图像模型把透明像素当黑色，深色衣服在上身效果里会消失，所以保持不透明底色。
