import { Image } from 'expo-image';
import { router, useLocalSearchParams, useNavigation, usePreventRemove } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { AiError, blockedRoute, describeAiError } from '@/ai/client';
import { getAiSettings, qualityFor } from '@/ai/config';
import { generatePhoto } from '@/ai/engine';
import { estimateImageCost, formatUsd } from '@/ai/models';
import { SCENES } from '@/ai/prompts';
import { avatarUsable } from '@/db/misc';
import { saveImageToLibrary, shareImage } from '@/platform/files';
import { useApp, useData } from '@/state/app';
import { useSafe } from '@/state/useSafe';
import { confirmAsync } from '@/ui/dialogs';
import { usePhotoConsent } from '@/state/consent';
import { itemsOf, loadSnapshot } from '@/state/snapshot';
import { Btn, Chip, Loading, NavHeader, Screen, T } from '@/ui/kit';
import { C, PAD } from '@/ui/theme';
import { OutfitBoard } from '@/ui/visuals';

export default function PhotoPage() {
  const app = useApp();
  const consent = usePhotoConsent();
  const safe = useSafe();
  const { items: param } = useLocalSearchParams<{ items?: string }>();
  const s = useData(loadSnapshot);
  const settings = useData(getAiSettings);
  const [scene, setScene] = useState(SCENES[0].id);
  const [shots, setShots] = useState<string[]>([]);
  const [pick, setPick] = useState(0);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; kind: string | null } | null>(null);
  // Generated photos are only kept until the user leaves; saving copies them into the photo library.
  const shotsRef = useRef<string[]>([]);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    shotsRef.current = shots;
  }, [shots]);
  useEffect(() => () => void Promise.all(shotsRef.current.map((u) => app.images.remove(u))), [app.images]);
  // Paid photos are deleted on leaving: ask first if some were never saved or one is still being made.
  const navigation = useNavigation();
  const unsaved = shots.filter((u) => !saved.has(u)).length;
  usePreventRemove(unsaved > 0 || busy, ({ data }) => {
    const msg = busy ? '正在生成的这张已经计费，离开后会丢弃。' : `还有 ${unsaved} 张没有保存到相册，离开后会删除。`;
    void confirmAsync('离开真人大片？', msg, '离开').then((ok) => ok && navigation.dispatch(data.action));
  });

  if (!s || !settings) return <Loading />;
  const ids = (param ?? '').split(',').filter(Boolean);
  const items = itemsOf(s, ids);
  const current = shots[Math.min(pick, shots.length - 1)] ?? null;
  // A new avatar is being made: a photo now would show the old one.
  const remaking = s.avatar.status === 'processing';
  const cost = estimateImageCost(null, { inputImages: items.length + 1, quality: qualityFor(settings.quality, 'photo') });

  const run = async () => {
    if (!(await consent())) return;
    setBusy(true);
    setError(null);
    try {
      const uri = await generatePhoto(app.ai, ids, scene);
      if (!mounted.current) return void app.images.remove(uri);
      setShots((x) => {
        setPick(x.length);
        return [...x, uri];
      });
    } catch (e) {
      setError({ text: describeAiError(e, true), kind: e instanceof AiError && e.needsUser ? e.kind : null });
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
            <Btn label="再生成一张" kind="outline" style={{ flex: 1, paddingHorizontal: 4 }} loading={busy} disabled={remaking} onPress={run} />
            <Btn label="分享" kind="outline" style={{ flex: 1 }} onPress={safe(() => shareImage(current))} />
            <Btn
              label="保存到相册"
              style={{ flex: 1, paddingHorizontal: 4 }}
              onPress={safe(async () => {
                if (await saveImageToLibrary(current)) {
                  setSaved((x) => new Set(x).add(current));
                  app.toast('已保存到相册');
                } else app.toast('没有相册权限，可以用「分享」保存');
              })}
            />
          </>
        ) : (
          <Btn label={`生成 · 约 ${formatUsd(cost)}`} style={{ flex: 1 }} loading={busy} disabled={items.length === 0 || !avatarUsable(s.avatar) || remaking} onPress={run} />
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
            <Pressable
              key={u}
              accessibilityRole="button"
              accessibilityLabel={`第 ${i + 1} 张${saved.has(u) ? '，已保存' : ''}`}
              accessibilityState={{ selected: u === current }}
              onPress={() => setPick(i)}
              style={{ width: 44, height: 66, borderWidth: 2, borderColor: u === current ? C.ink : 'transparent' }}
            >
              <Image source={{ uri: u }} style={{ flex: 1 }} contentFit="cover" />
              {saved.has(u) ? <View style={{ position: 'absolute', right: 2, bottom: 2, width: 8, height: 8, backgroundColor: C.ok }} /> : null}
            </Pressable>
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
      {remaking ? (
        <T v="small" style={{ margin: PAD, color: C.sub }}>
          新的个人形象正在生成，完成后就可以拍大片了。
        </T>
      ) : null}
      {!avatarUsable(s.avatar) ? (
        <View style={{ margin: PAD, gap: 8 }}>
          <T v="small">需要先建立个人形象。</T>
          <Btn label="建立形象" kind="outline" onPress={() => router.push('/avatar')} />
        </View>
      ) : null}
      {error ? (
        <View style={{ margin: PAD, padding: 12, backgroundColor: '#FBF1E3', gap: 8 }}>
          <T style={{ fontSize: 13 }}>{error.text}</T>
          {error.kind ? <Btn label="去处理" kind="outline" height={36} style={{ alignSelf: 'flex-start' }} onPress={() => router.push(blockedRoute(error.kind))} /> : null}
        </View>
      ) : null}
    </Screen>
  );
}
