import { router } from 'expo-router';
import { View } from 'react-native';
import { listKeys, pendingConsent, setConsentFor } from '@/ai/keys';
import type { Db } from '@/db/db';
import { useApp, useData } from '@/state/app';
import { consentTitle, photoNotice } from '@/state/consent';
import { Btn, Loading, NavHeader, Screen, T } from '@/ui/kit';
import { C, PAD } from '@/ui/theme';

/** The providers waiting for consent; if none is (the notice was stale), every provider a key is added for. */
async function loadProviders(db: Db) {
  const pending = await pendingConsent(db);
  return pending.length ? pending : [...new Set((await listKeys(db)).map((k) => k.provider))];
}

/** Where the "AI paused" notice leads when photos may not be sent yet. */
export default function ConsentPage() {
  const app = useApp();
  const providers = useData(loadProviders);
  if (!providers) return <Loading />;
  const agree = async () => {
    for (const p of providers) await setConsentFor(app.db, p);
    await app.reloadKey(); // resumes the paused queue
    app.toast('已同意，AI 会继续处理');
    router.back();
  };
  return (
    <Screen
      footer={
        <>
          <Btn label="暂不" kind="outline" style={{ flex: 1 }} onPress={() => router.back()} />
          <Btn label="同意并继续" style={{ flex: 2 }} disabled={providers.length === 0} onPress={agree} />
        </>
      }
    >
      <NavHeader title={providers.length ? consentTitle(providers) : '照片会发送给 AI 服务商'} />
      <View style={{ padding: PAD, gap: 16 }}>
        <T v="body" style={{ lineHeight: 24 }}>
          {providers.length ? photoNotice(providers) : '还没有添加 API Key。添加后，第一次发送照片前会先征得你的同意。'}
        </T>
        <T v="small" style={{ color: C.sub, lineHeight: 20 }}>
          不同意也可以继续用衣橱记录衣服和穿搭，只是商品图、形象和上身效果不会生成。可以随时在「我的 · 永久删除我的全部数据」清除一切。
        </T>
      </View>
    </Screen>
  );
}
