import { router } from 'expo-router';
import { View } from 'react-native';
import { setPhotoConsent } from '@/ai/config';
import { useApp } from '@/state/app';
import { PHOTO_NOTICE } from '@/state/consent';
import { Btn, NavHeader, Screen, T } from '@/ui/kit';
import { C, PAD } from '@/ui/theme';

/** Where the "AI paused" notice leads when photos may not be sent yet. */
export default function ConsentPage() {
  const app = useApp();
  const agree = async () => {
    await setPhotoConsent(app.db);
    await app.reloadKey(); // resumes the paused queue
    app.toast('已同意，AI 会继续处理');
    router.back();
  };
  return (
    <Screen
      footer={
        <>
          <Btn label="暂不" kind="outline" style={{ flex: 1 }} onPress={() => router.back()} />
          <Btn label="同意并继续" style={{ flex: 2 }} onPress={agree} />
        </>
      }
    >
      <NavHeader title="照片会发送给 OpenAI" />
      <View style={{ padding: PAD, gap: 16 }}>
        <T v="body" style={{ lineHeight: 24 }}>
          {PHOTO_NOTICE}
        </T>
        <T v="small" style={{ color: C.sub, lineHeight: 20 }}>
          不同意也可以继续用衣橱记录衣服和穿搭，只是商品图、形象和上身效果不会生成。可以随时在「我的 · 永久删除我的全部数据」清除一切。
        </T>
      </View>
    </Screen>
  );
}
