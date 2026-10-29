import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { AiError, describeAiError } from '@/ai/client';
import { getAiSettings, qualityFor } from '@/ai/config';
import { generatePhoto } from '@/ai/engine';
import { estimateImageCost, formatUsd } from '@/ai/models';
import { SCENES } from '@/ai/prompts';
import { saveImageToLibrary, shareImage } from '@/platform/files';
import { useApp, useData } from '@/state/app';
import { itemsOf, loadSnapshot } from '@/state/snapshot';
import { Btn, Chip, Loading, NavHeader, Screen, T } from '@/ui/kit';
import { C, PAD } from '@/ui/theme';
import { OutfitBoard } from '@/ui/visuals';

export default function PhotoPage() {
  const app = useApp();
  const { items: param } = useLocalSearchParams<{ items?: string }>();
  const s = useData(loadSnapshot);
  const settings = useData(getAiSettings);
  const [scene, setScene] = useState(SCENES[0].id);
  const [shots, setShots] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; needsUser: boolean } | null>(null);

  if (!s || !settings) return <Loading />;
  const ids = (param ?? '').split(',').filter(Boolean);
  const items = itemsOf(s, ids);
  const current = shots[shots.length - 1] ?? null;
  const cost = estimateImageCost(null, { inputImages: items.length + 1, quality: qualityFor(settings.quality, 'photo') });

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const uri = await generatePhoto(app.ai, ids, scene);
      setShots((x) => [...x, uri]);
    } catch (e) {
      setError({ text: describeAiError(e), needsUser: e instanceof AiError && e.needsUser });
    } finally {
      setBusy(false);
      app.refresh();
    }
  };

  return (
    <Screen
      footer={
        current ? (
          <>
            <Btn label="再生成一张" kind="outline" style={{ flex: 1, paddingHorizontal: 4 }} loading={busy} onPress={run} />
            <Btn label="分享" kind="outline" style={{ flex: 1 }} onPress={() => shareImage(current)} />
            <Btn
              label="保存到相册"
              style={{ flex: 1, paddingHorizontal: 4 }}
              onPress={async () => app.toast((await saveImageToLibrary(current)) ? '已保存到相册' : '没有相册权限，可以用「分享」保存')}
            />
          </>
        ) : (
          <Btn label={`生成 · 约 ${formatUsd(cost)}`} style={{ flex: 1 }} loading={busy} disabled={items.length === 0 || s.avatar.status !== 'ready'} onPress={run} />
        )
      }
    >
      <NavHeader title="真人大片" border={false} />
      <View style={{ marginTop: 6, marginHorizontal: PAD, aspectRatio: 2 / 3, maxHeight: 486, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }}>
        {current ? (
          <Image source={{ uri: current }} style={{ width: '100%', height: '100%' }} contentFit="cover" transition={200} />
        ) : (
          <OutfitBoard items={items} style={{ width: '70%', aspectRatio: 0.8, backgroundColor: 'transparent' }} />
        )}
        {busy ? (
          <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(241,241,242,0.7)', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
            <ActivityIndicator color={C.ink} />
            <T v="caption">正在拍大片，大约 30 秒</T>
          </View>
        ) : null}
        {!current && !busy ? (
          <View style={{ position: 'absolute', left: 12, top: 12, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: C.scrim }}>
            <T style={{ color: '#FFFFFF', fontSize: 11 }}>选好场景，点下方「生成」</T>
          </View>
        ) : null}
      </View>
      {shots.length > 1 ? (
        <ScrollView horizontal style={{ marginTop: 10 }} contentContainerStyle={{ paddingHorizontal: PAD, gap: 6 }}>
          {shots.map((u, i) => (
            <View key={u} style={{ width: 44, height: 66, borderWidth: 2, borderColor: i === shots.length - 1 ? C.ink : 'transparent' }}>
              <Image source={{ uri: u }} style={{ flex: 1 }} contentFit="cover" />
            </View>
          ))}
        </ScrollView>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 14 }} contentContainerStyle={{ paddingHorizontal: PAD, gap: 8 }}>
        {SCENES.map((sc) => (
          <Chip key={sc.id} label={sc.label} on={sc.id === scene} onPress={() => setScene(sc.id)} />
        ))}
      </ScrollView>
      <T v="caption" style={{ marginTop: 12, marginHorizontal: PAD }}>
        {items.map((i) => i.name).join(' · ')} — 每张约 {formatUsd(cost)}
      </T>
      {items.length === 0 ? (
        <View style={{ margin: PAD, gap: 8 }}>
          <T v="small">先在试衣间选好要穿的衣服，再来拍大片。</T>
          <Btn label="去试衣间" kind="outline" onPress={() => router.navigate('/fitting')} />
        </View>
      ) : null}
      {s.avatar.status !== 'ready' ? (
        <View style={{ margin: PAD, gap: 8 }}>
          <T v="small">需要先建立个人形象。</T>
          <Btn label="建立形象" kind="outline" onPress={() => router.push('/avatar')} />
        </View>
      ) : null}
      {error ? (
        <View style={{ margin: PAD, padding: 12, backgroundColor: '#FBF1E3', gap: 8 }}>
          <T style={{ fontSize: 13 }}>{error.text}</T>
          {error.needsUser ? <Btn label="去处理" kind="outline" height={36} style={{ alignSelf: 'flex-start' }} onPress={() => router.push('/apikey')} /> : null}
        </View>
      ) : null}
    </Screen>
  );
}
