import { View } from 'react-native';
import { NavHeader, Screen, T } from '@/ui/kit';
import { C, PAD } from '@/ui/theme';

/** Kept in step with PRIVACY.md at the repository root (the store listing links to that copy). */
const SECTIONS: { title: string; body: string[] }[] = [
  {
    title: '本应用保存什么',
    body: [
      '你拍摄或导入的衣服、吊牌、镜子照片和全身照，以及 AI 生成的商品图、个人形象和上身效果图。',
      '你填写的单品信息、穿搭、穿着记录、身高 / 体重 / 体型、合身笔记和偏好设置。',
      '你的 OpenAI API Key（加密保存在系统的安全存储里）。',
      '这些数据只保存在这台手机上（应用的私有存储），卸载应用或在「我的 → 永久删除我的全部数据」里删除后即被清除。系统的自动云备份已关闭；只有你主动导出的 Excel 或完整备份文件会离开应用，保存到你选择的位置。',
    ],
  },
  {
    title: '发送给第三方的内容',
    body: [
      '只有在你使用 AI 功能时，才会通过你自己的 API Key 直接发送给 OpenAI（api.openai.com）：录入衣服时的衣服和吊牌照片；建立形象时的 3 张全身照和身高、体重、体型；上身效果和真人大片用到的形象图与商品图；识别镜子照片时的照片和部分衣服的缩略图。',
      '第一次发送照片前会询问你是否同意，不同意时不会发送任何照片。OpenAI 对这些数据的处理适用 OpenAI 的隐私政策：按其说明，API 数据默认不用于训练模型，可能保留最多 30 天用于滥用监测。',
      '除此之外，本应用不收集、不上传、不出售任何数据，没有广告或统计分析 SDK，也没有自己的服务器和账号系统。',
    ],
  },
  {
    title: '权限',
    body: ['相机：拍摄衣服、吊牌、镜子照片和全身照。', '照片：通过系统照片选择器选择你指定的照片；把生成的图片保存到相册。', '网络：只用于请求 OpenAI。'],
  },
  { title: '儿童', body: ['本应用不面向 13 岁以下的儿童。'] },
  { title: '联系与反馈', body: ['问题、建议或举报不当的 AI 生成内容：github.com/HB-725/e-wardrobe/issues，或在应用商店的本应用页面留言。'] },
];

export default function PrivacyPage() {
  return (
    <Screen>
      <NavHeader title="隐私政策" />
      <View style={{ padding: PAD, gap: 22, paddingBottom: 40 }}>
        <T v="caption">最后更新：2026 年 10 月 29 日</T>
        {SECTIONS.map((sec) => (
          <View key={sec.title} style={{ gap: 8 }}>
            <T style={{ fontSize: 16, fontWeight: '700' }}>{sec.title}</T>
            {sec.body.map((p) => (
              <T key={p} v="small" style={{ color: C.sub, lineHeight: 22 }}>
                {p}
              </T>
            ))}
          </View>
        ))}
      </View>
    </Screen>
  );
}
