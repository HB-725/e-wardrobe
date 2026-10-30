import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams, useNavigation, usePreventRemove } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Platform, TextInput, View } from 'react-native';
import { AiError, type AiErrorKind, blockedRoute, describeAiError } from '@/ai/client';
import { type AiSettings, getAiBlocked, getAiSettings, qualityFor } from '@/ai/config';
import { estimateImageCost, formatUsd } from '@/ai/models';
import { getAvatar, saveAvatar } from '@/db/misc';
import { getApiKey } from '@/platform/secrets';
import type { Avatar } from '@/domain/types';
import { startAvatar } from '@/state/actions';
import { useApp, useData } from '@/state/app';
import { usePhotoConsent } from '@/state/consent';
import { useSafe } from '@/state/useSafe';
import { confirmAsync } from '@/ui/dialogs';
import { Icon } from '@/ui/Icon';
import { Btn, Chip, Loading, NavHeader, ProgressBar, Screen, T, Tap } from '@/ui/kit';
import { C, PAD, R } from '@/ui/theme';

const SHOTS = ['正面', '侧面', '背面'];
const BUILDS = [
  { id: 'slim', label: '偏瘦' },
  { id: 'avg', label: '匀称' },
  { id: 'ath', label: '健壮' },
  { id: 'full', label: '丰满' },
];

export default function AvatarSetup() {
  const avatar = useData(getAvatar);
  const settings = useData(getAiSettings);
  const blocked = useData(getAiBlocked);
  if (!avatar || !settings || blocked === undefined) return <Loading />;
  return <Setup avatar={avatar} settings={settings} blocked={blocked} />;
}

function Setup({ avatar, settings, blocked }: { avatar: Avatar; settings: AiSettings; blocked: string | null }) {
  const app = useApp();
  const safe = useSafe();
  const consent = usePhotoConsent();
  const params = useLocalSearchParams<{ step?: string }>();
  const processing = avatar.status === 'processing';
  const [step, setStep] = useState(Number(params.step) || (processing ? 3 : 1));
  const [photos, setPhotos] = useState<(string | null)[]>(() => [0, 1, 2].map((i) => avatar.sourceUris[i] ?? null));
  const [height, setHeight] = useState(avatar.heightCm ? String(avatar.heightCm) : '');
  const [weight, setWeight] = useState(avatar.weightKg ? String(avatar.weightKg) : '');
  const [build, setBuild] = useState(avatar.build ?? 'avg');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Photos taken here but never used for a generation are deleted when the page closes.
  const unused = useRef({ photos });
  useEffect(() => {
    unused.current = { photos };
  }, [photos]);
  useEffect(
    () => () => {
      const { photos: p } = unused.current;
      // Re-read: a generation started just before closing already references these photos.
      void getAvatar(app.db).then(async (a) => {
        for (const u of p) if (u && !a.sourceUris.includes(u)) await app.images.remove(u);
      });
    },
    [app.db, app.images],
  );

  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [processing]);
  const elapsed = processing && avatar.updatedAt ? (now - new Date(avatar.updatedAt).getTime()) / 1000 : 0;

  // Opened from Me → 身材数据 to edit the numbers only.
  const bodyOnly = params.step === '2';
  // Android back steps back through the flow instead of closing it.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (step === 2 && !bodyOnly) {
        setStep(1);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [step, bodyOnly]);
  // Every way out (back, close, 稍后再说) asks before deleting photos taken here that were never used.
  const navigation = useNavigation();
  const fresh = photos.some((u) => u && !avatar.sourceUris.includes(u));
  usePreventRemove(fresh && !busy, ({ data }) => {
    void confirmAsync('放弃已拍的照片？', '还没有开始生成，离开后这些照片会被删除。', '放弃').then((ok) => ok && navigation.dispatch(data.action));
  });

  const take = safe(async (i: number, camera: boolean) => {
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.9 };
    let r: ImagePicker.ImagePickerResult;
    if (camera && Platform.OS !== 'web') {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return app.toast('需要相机权限，也可以从相册选');
      r = await ImagePicker.launchCameraAsync(opts);
    } else r = await ImagePicker.launchImageLibraryAsync(opts);
    if (r.canceled) return;
    const uri = await app.images.importPhoto(r.assets[0].uri, 'body');
    const prev = photos[i];
    if (prev && !avatar.sourceUris.includes(prev)) await app.images.remove(prev);
    setPhotos((p) => p.map((x, j) => (j === i ? uri : x)));
  });

  const h = Number(height);
  const w = Number(weight);
  const bodyOk = h >= 100 && h <= 230 && w >= 25 && w <= 250;
  const photosOk = photos.every(Boolean);
  const cost = estimateImageCost(null, { inputImages: 3, quality: qualityFor(settings.quality, 'avatar') }) + estimateImageCost(null, { inputImages: 2, quality: qualityFor(settings.quality, 'avatar') });
  const body = { heightCm: h, weightKg: w, build };

  const generate = safe(async () => {
    if (processing) {
      app.toast('上一次生成还没结束，完成后再试');
      return;
    }
    if (!(await consent())) return;
    if (!(await getApiKey())) {
      app.toast('先填写 OpenAI API Key');
      router.push('/apikey');
      return;
    }
    setBusy(true);
    try {
      await startAvatar(app, { photos: photos as string[], body });
      app.refresh();
      setStep(3);
    } finally {
      setBusy(false);
    }
  });

  const steps = (
    <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: PAD }}>
      {['照片', '身材', '生成'].map((l, i) => (
        <View key={l} style={{ flex: 1, gap: 6 }}>
          <View style={{ height: 4, borderRadius: R.pill, backgroundColor: i + 1 <= step ? C.ink : C.line }} />
          <T style={{ fontSize: 12, color: i + 1 === step ? C.ink : C.sub, fontWeight: i + 1 === step ? '700' : '400' }}>
            {i + 1} · {l}
          </T>
        </View>
      ))}
    </View>
  );

  let content: React.ReactNode;
  let footer: React.ReactNode;

  if (step === 1) {
    content = (
      <View style={{ padding: PAD, paddingTop: 16, gap: 16 }}>
        <View style={{ gap: 6 }}>
          <T v="h2">拍 3 张全身照</T>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {SHOTS.map((label, i) => (
            <View key={label} style={{ flex: 1, gap: 6 }}>
              {photos[i] ? (
                <Tap accessibilityLabel={`重拍${label}`} onPress={() => take(i, true)} style={{ height: 200, borderRadius: R.tile, overflow: 'hidden', backgroundColor: C.card }}>
                  <Image source={{ uri: photos[i]! }} style={{ flex: 1 }} contentFit="cover" />
                </Tap>
              ) : (
                <Tap accessibilityLabel={`拍${label}`} onPress={() => take(i, true)} style={{ height: 200, borderRadius: R.tile, borderWidth: 1.5, borderStyle: 'dashed', borderColor: C.muted, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <Icon name="camera" size={26} strokeWidth={1.5} />
                  <T style={{ fontSize: 12 }}>拍{label}</T>
                </Tap>
              )}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <T style={{ fontSize: 12, color: photos[i] ? C.ink : C.sub }}>
                  {label} · {photos[i] ? '已拍' : '待拍'}
                </T>
                <Tap onPress={() => take(i, false)} hitSlop={8}>
                  <T style={{ fontSize: 12, color: C.sub, textDecorationLine: 'underline' }}>相册</T>
                </Tap>
              </View>
            </View>
          ))}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {['贴身衣服', '全身入镜', '光线均匀'].map((t) => (
            <View key={t} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: R.pill, backgroundColor: C.card }}>
              <T style={{ fontSize: 12, color: C.sub }}>{t}</T>
            </View>
          ))}
        </View>
      </View>
    );
    footer = (
      <>
        <Btn label="稍后再说" kind="outline" style={{ flex: 1 }} onPress={() => router.back()} />
        <Btn label="下一步" style={{ flex: 2 }} disabled={!photosOk} onPress={() => setStep(2)} />
      </>
    );
  } else if (step === 2) {
    const input = (label: string, value: string, set: (v: string) => void) => (
      <View style={{ flex: 1, gap: 6 }}>
        <T v="caption">{label}</T>
        <TextInput
          value={value}
          onChangeText={(v) => set(v.replace(/[^\d.]/g, ''))}
          keyboardType="decimal-pad"
          placeholder="必填"
          placeholderTextColor={C.faint}
          accessibilityLabel={label}
          style={{ height: 46, paddingHorizontal: 14, borderRadius: R.input, backgroundColor: C.card, fontSize: 15, color: C.ink }}
        />
      </View>
    );
    const hasAvatar = avatar.status === 'ready';
    content = (
      <View style={{ padding: PAD, paddingTop: 16, gap: 14 }}>
        <View style={{ gap: 6 }}>
          <T v="h2">身材数据</T>
          <T v="caption">仅保存在本机</T>
        </View>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {input('身高 (cm)', height, setHeight)}
          {input('体重 (kg)', weight, setWeight)}
        </View>
        {height && weight && !bodyOk ? <T style={{ fontSize: 12, color: C.danger }}>请填写合理的身高（100–230 cm）和体重（25–250 kg）</T> : null}
        <View style={{ gap: 8 }}>
          <T v="caption">整体体型</T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {BUILDS.map((b) => (
              <View key={b.id} style={{ flex: 1 }}>
                <Chip label={b.label} on={build === b.id} onPress={() => setBuild(b.id)} />
              </View>
            ))}
          </View>
        </View>
        <T v="caption">生成正面和背面 · 约 {formatUsd(cost)}</T>
      </View>
    );
    footer =
      hasAvatar || bodyOnly ? (
        <>
          <Btn
            label="只保存数据"
            kind="outline"
            style={{ flex: 1 }}
            disabled={!bodyOk}
            onPress={async () => {
              await saveAvatar(app.db, body);
              app.refresh();
              router.back();
            }}
          />
          {/* Without all three photos the button leads to the photo step first. */}
          <Btn label={hasAvatar ? '重新生成形象' : '生成形象'} style={{ flex: 1 }} disabled={!bodyOk || processing} loading={busy} onPress={() => (photosOk ? generate() : setStep(1))} />
        </>
      ) : (
      <>
        <Btn label="上一步" kind="outline" style={{ flex: 1 }} onPress={() => setStep(1)} />
        <Btn label="开始生成" style={{ flex: 2 }} disabled={!bodyOk || !photosOk} loading={busy} onPress={generate} />
      </>
    );
  } else {
    const ready = avatar.status === 'ready';
    const failed = avatar.status === 'failed';
    content = (
      <View style={{ padding: PAD, paddingTop: 16, gap: 14 }}>
        <View style={{ gap: 6 }}>
          <T v="h2">{ready ? '看看像不像你' : failed ? '生成失败' : '正在生成你的形象'}</T>
          <T v="body" style={{ color: failed ? C.danger : C.sub }}>
            {ready && avatar.error ? `重新生成失败：${avatar.error}。下面是之前的形象，仍然可以使用。` : ready ? '不像可以换照片重新生成' : failed ? (avatar.error ?? '请稍后重试') : '生成中，约 1 分钟，可以先离开'}
          </T>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {[
            { uri: ready ? avatar.frontUri : null, label: '正面' },
            { uri: ready ? avatar.backUri : null, label: '背面' },
          ].map((v) => (
            <View key={v.label} style={{ flex: 1, gap: 4 }}>
              <View style={{ aspectRatio: 2 / 3, borderRadius: R.card, overflow: 'hidden', backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }}>
                {v.uri ? <Image source={{ uri: v.uri }} style={{ width: '100%', height: '100%' }} contentFit="cover" /> : processing ? <ActivityIndicator color={C.ink} /> : null}
              </View>
              <T style={{ fontSize: 11, color: C.sub }}>{v.label}</T>
            </View>
          ))}
        </View>
        {processing && blocked ? (
          <View style={{ backgroundColor: '#FBF1E3', borderRadius: R.card, padding: 12, gap: 8 }}>
            <T style={{ fontSize: 13 }}>AI 已暂停：{describeAiError(new AiError(blocked as AiErrorKind, ''))}</T>
            <Btn label="去处理" kind="outline" onCard height={36} style={{ alignSelf: 'flex-start' }} onPress={() => router.push(blockedRoute(blocked))} />
          </View>
        ) : processing ? (
          <ProgressBar value={Math.min(0.95, elapsed / 70)} />
        ) : null}
      </View>
    );
    footer = ready ? (
      <>
        <Btn label="重新生成" kind="outline" style={{ flex: 1 }} onPress={() => setStep(1)} />
        <Btn
          label="看起来像我，完成"
          style={{ flex: 2 }}
          onPress={() => {
            app.toast('形象已建立，去试衣间换装吧');
            router.back();
          }}
        />
      </>
    ) : failed ? (
      <>
        <Btn label="换照片" kind="outline" style={{ flex: 1 }} onPress={() => setStep(1)} />
        <Btn label="重试" style={{ flex: 2 }} loading={busy} onPress={generate} />
      </>
    ) : (
      <Btn label="先去做别的" kind="outline" style={{ flex: 1 }} onPress={() => router.back()} />
    );
  }

  return (
    <Screen footer={footer}>
      <NavHeader title="建立个人形象" border={false} backIcon="close" />
      {steps}
      {content}
    </Screen>
  );
}
