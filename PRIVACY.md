# 衣橱 隐私政策

最后更新：2026 年 10 月 29 日

衣橱（以下称「本应用」）是一个本地优先的电子衣橱。本应用没有自己的服务器，也没有账号系统。

## 本应用保存什么

- 你拍摄或导入的衣服照片、吊牌照片、镜子照片、全身照，以及 AI 生成的商品图、个人形象和上身效果图；
- 你填写的单品信息、穿搭、穿着记录、身高 / 体重 / 体型、合身笔记和偏好设置；
- 你的 OpenAI API Key（加密保存在系统的安全存储里）。

这些数据只保存在你的手机上（应用的私有存储）。卸载应用或在「我的 → 永久删除我的全部数据」里删除后即被清除。本应用关闭了系统的自动云备份；只有你主动导出的 Excel 或「完整备份」文件会离开应用，保存到你选择的位置。

## 发送给第三方的内容

只有在你使用 AI 功能时，本应用才会通过你自己的 API Key 直接把以下内容发送给 OpenAI（api.openai.com）：

| 功能 | 发送的内容 |
| --- | --- |
| 录入衣服 | 衣服照片、吊牌照片 |
| 建立个人形象 | 3 张全身照、身高 / 体重 / 体型 |
| 上身效果、真人大片 | 你的形象图和所选衣服的商品图 |
| 镜子照片识别 | 镜子照片和衣橱里部分衣服的缩略图 |

第一次发送照片前，本应用会询问你是否同意；不同意时不会发送任何照片。OpenAI 对这些数据的处理适用 [OpenAI 的隐私政策](https://openai.com/policies/privacy-policy)：按其说明，通过 API 提交的数据默认不用于训练模型，可能保留最多 30 天用于滥用监测。

除此之外，本应用不收集、不上传、不出售任何数据，不包含广告或统计分析 SDK。

## 权限

- 相机：拍摄衣服、吊牌、镜子照片和全身照。
- 照片：通过系统照片选择器选择你指定的照片；把生成的图片保存到相册（Android 13 及以上不需要读取相册权限）。
- 网络：仅用于请求 OpenAI。

## 儿童

本应用不面向 13 岁以下的儿童。

## 联系与反馈

问题、建议或举报不当的 AI 生成内容：<https://github.com/HB-725/e-wardrobe/issues>

---

**English summary.** 衣橱 has no servers and no accounts. Everything (photos, generated images, wardrobe data, body measurements) stays on your phone. Photos are sent directly to OpenAI with your own API key only when you use an AI feature, after you agree once; OpenAI's privacy policy applies to them. No analytics, ads or other third parties. Contact: https://github.com/HB-725/e-wardrobe/issues
