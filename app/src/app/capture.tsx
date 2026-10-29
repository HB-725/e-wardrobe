import { CameraView, useCameraPermissions } from 'expo-camera';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Linking, Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { addGarments } from '@/state/actions';
import { useApp } from '@/state/app';
import { confirmAsync } from '@/ui/dialogs';
import { Icon } from '@/ui/Icon';
import { Btn, IconBtn, T } from '@/ui/kit';
import { C } from '@/ui/theme';

type Mode = 'cloth' | 'tag' | 'batch';

const MODES: { id: Mode; label: string }[] = [
  { id: 'cloth', label: '拍衣服' },
  { id: 'tag', label: '拍吊牌' },
  { id: 'batch', label: '相册批量' },
];

interface Pending {
  uri: string;
  tagUri: string | null;
}

const MAX_BATCH = 50;

export default function CapturePage() {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ mode?: string }>();
  const [mode, setMode] = useState<Mode>(params.mode === 'batch' ? 'batch' : 'cloth');
  const [perm, requestPerm] = useCameraPermissions();
  const [pending, setPending] = useState<Pending[]>([]);
  const [torch, setTorch] = useState(false);
  const [shooting, setShooting] = useState(false);
  const [saving, setSaving] = useState(false);
  const cam = useRef<CameraView>(null);
  const openedBatch = useRef(false);
  const last = pending[pending.length - 1];
  const cameraOk = Platform.OS !== 'web' && perm?.granted;

  const pickAlbum = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: MAX_BATCH, quality: 1, orderedSelection: true });
    if (r.canceled) return;
    setPending((p) => [...p, ...r.assets.map((a) => ({ uri: a.uri, tagUri: null }))].slice(0, MAX_BATCH));
  };

  useEffect(() => {
    if (mode === 'batch' && !openedBatch.current) {
      openedBatch.current = true;
      void pickAlbum();
    }
    if (mode !== 'batch' && Platform.OS !== 'web' && perm && !perm.granted && perm.canAskAgain) void requestPerm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, perm?.granted]);

  const shoot = async () => {
    if (mode === 'batch') return pickAlbum();
    if (mode === 'tag' && !last) {
      app.toast('先拍衣服，再拍它的吊牌');
      setMode('cloth');
      return;
    }
    let uri: string | null = null;
    setShooting(true);
    try {
      if (cameraOk && cam.current) {
        const pic = await cam.current.takePictureAsync({ quality: 0.85, skipProcessing: false });
        uri = pic?.uri ?? null;
      } else {
        const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
        uri = r.canceled ? null : r.assets[0].uri;
      }
    } catch (e) {
      app.toast(`拍照失败：${String(e)}`);
    } finally {
      setShooting(false);
    }
    if (!uri) return;
    if (mode === 'tag') {
      setPending((p) => p.map((x, i) => (i === p.length - 1 ? { ...x, tagUri: uri } : x)));
      app.toast('吊牌已关联到上一件');
      setMode('cloth');
    } else {
      setPending((p) => [...p, { uri: uri!, tagUri: null }]);
    }
  };

  // One photo at a time: whatever was saved leaves the pending list, so a retry never duplicates items.
  const finish = async () => {
    if (pending.length === 0) return;
    setSaving(true);
    let left = [...pending];
    try {
      while (left.length) {
        await addGarments(app, [left[0]]);
        left = left.slice(1);
        setPending(left);
      }
      app.refresh();
      router.replace('/review');
    } catch (e) {
      app.refresh();
      app.toast(`有 ${left.length} 张没有保存：${String(e)}`);
      setSaving(false);
    }
  };

  const close = async () => {
    if (pending.length > 0 && !(await confirmAsync('放弃这些照片？', `已拍的 ${pending.length} 张还没有保存。`, '放弃'))) return;
    router.back();
  };

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (pending.length === 0 || saving) return false;
      void close();
      return true;
    });
    return () => sub.remove();
  });

  const hint =
    mode === 'tag'
      ? '对准吊牌或洗标，自动读出品牌、尺码、材质。这一步可以跳过。'
      : last
        ? `已拍 ${pending.length} 件。可以接着拍下一件，或切到「拍吊牌」补拍这件的吊牌。`
        : '平铺、挂起都可以，不用在意背景和褶皱。一张照片拍一件。';

  return (
    <View style={{ flex: 1, backgroundColor: C.ink, paddingTop: insets.top }}>
      <StatusBar style="light" />
      <View style={{ height: 60, paddingHorizontal: 8, paddingTop: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <IconBtn name="close" label="关闭" color="#FFFFFF" onPress={close} />
        <Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '500' }}>录入新衣服</Text>
        {cameraOk && mode !== 'batch' ? <IconBtn name="flash" label={torch ? '关闭补光' : '打开补光'} color={torch ? '#FFD54F' : '#FFFFFF'} size={20} onPress={() => setTorch((t) => !t)} /> : <View style={{ width: 44 }} />}
      </View>

      <View style={{ flex: 1, overflow: 'hidden', backgroundColor: '#222' }}>
        {mode === 'batch' ? (
          <View style={{ flex: 1, padding: 12, flexDirection: 'row', flexWrap: 'wrap', gap: 4, alignContent: 'flex-start' }}>
            {pending.map((p, i) => (
              <Pressable
                key={`${p.uri}${i}`}
                accessibilityLabel={`第 ${i + 1} 张，点按移除`}
                onPress={() => setPending((x) => x.filter((_, j) => j !== i))}
                style={{ width: '32.4%', height: 112 }}
              >
                <Image source={{ uri: p.uri }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
                <View style={{ position: 'absolute', right: 6, top: 6, width: 22, height: 22, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ fontSize: 12, fontWeight: '700' }}>{i + 1}</Text>
                </View>
              </Pressable>
            ))}
            {pending.length === 0 ? (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 120, gap: 16 }}>
                <Text style={{ color: '#FFFFFF', fontSize: 14, textAlign: 'center', lineHeight: 22 }}>一次最多选 {MAX_BATCH} 张，每张照片一件衣服</Text>
                <Btn label="打开相册" kind="outline" onPress={pickAlbum} style={{ paddingHorizontal: 24 }} />
              </View>
            ) : (
              <Text style={{ width: '100%', color: '#9A9A9A', fontSize: 12, paddingTop: 8 }}>点按照片可以移除，点快门继续添加</Text>
            )}
          </View>
        ) : cameraOk ? (
          <>
            <CameraView ref={cam} style={{ flex: 1 }} facing="back" enableTorch={torch} animateShutter />
            {mode === 'tag' ? (
              <View pointerEvents="none" style={{ position: 'absolute', left: '25%', right: '25%', top: '20%', bottom: '25%', borderWidth: 3, borderColor: '#FFFFFF' }} />
            ) : (
              <>
                {[
                  { left: 34, top: 50, borderLeftWidth: 3, borderTopWidth: 3 },
                  { right: 34, top: 50, borderRightWidth: 3, borderTopWidth: 3 },
                  { left: 34, bottom: 80, borderLeftWidth: 3, borderBottomWidth: 3 },
                  { right: 34, bottom: 80, borderRightWidth: 3, borderBottomWidth: 3 },
                ].map((st, i) => (
                  <View key={i} pointerEvents="none" style={[{ position: 'absolute', width: 40, height: 40, borderColor: '#FFFFFF' }, st]} />
                ))}
              </>
            )}
          </>
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 }}>
            <Text style={{ color: '#FFFFFF', fontSize: 14, textAlign: 'center', lineHeight: 22 }}>
              {Platform.OS === 'web' ? '网页版不能用相机，点快门从文件里选照片。' : '需要相机权限才能拍照。也可以点快门从相册选一张。'}
            </Text>
            {Platform.OS !== 'web' && perm && !perm.granted ? (
              <Btn label={perm.canAskAgain ? '允许使用相机' : '去系统设置开启'} kind="outline" onPress={() => (perm.canAskAgain ? requestPerm() : Linking.openSettings())} style={{ paddingHorizontal: 20 }} />
            ) : null}
          </View>
        )}
        {mode !== 'batch' ? (
          <View style={{ position: 'absolute', left: 16, right: 16, bottom: 20, padding: 12, backgroundColor: C.scrim, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <View style={{ width: 8, height: 8, backgroundColor: '#7BD88F' }} />
            <Text style={{ flex: 1, color: '#FFFFFF', fontSize: 13, lineHeight: 20 }}>{hint}</Text>
          </View>
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 28, paddingTop: 16 }}>
        {MODES.map((m) => (
          <Pressable key={m.id} accessibilityRole="tab" accessibilityState={{ selected: m.id === mode }} onPress={() => setMode(m.id)} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 }}>
            <Text style={{ fontSize: 14, color: m.id === mode ? '#FFFFFF' : '#9A9A9A', fontWeight: m.id === mode ? '700' : '400' }}>{m.label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 32, paddingTop: 14, paddingBottom: 18 + insets.bottom }}>
        <View style={{ width: 52, height: 52, backgroundColor: '#333' }}>
          {last ? <Image source={{ uri: last.uri }} style={{ width: '100%', height: '100%' }} contentFit="cover" /> : null}
          {last?.tagUri ? (
            <View style={{ position: 'absolute', right: -4, bottom: -4, backgroundColor: '#FFFFFF', paddingHorizontal: 3 }}>
              <Text style={{ fontSize: 9 }}>吊牌</Text>
            </View>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={mode === 'batch' ? '从相册添加' : mode === 'tag' ? '拍吊牌' : '拍照'}
          onPress={shoot}
          disabled={shooting || saving}
          style={({ pressed }) => ({ width: 76, height: 76, borderRadius: 38, borderWidth: 4, borderColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}
        >
          {shooting ? <ActivityIndicator color="#FFFFFF" /> : mode === 'batch' ? <Icon name="album" color="#FFFFFF" size={28} /> : <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: '#FFFFFF' }} />}
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`下一步，共 ${pending.length} 件`} onPress={finish} disabled={pending.length === 0 || saving} style={{ width: 52, minHeight: 52, alignItems: 'center', justifyContent: 'center', gap: 2, opacity: pending.length ? 1 : 0.4 }}>
          {saving ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <>
              <T style={{ color: '#FFFFFF', fontSize: 18, fontWeight: '700' }}>{pending.length}</T>
              <T style={{ color: '#FFFFFF', fontSize: 11 }}>下一步</T>
            </>
          )}
        </Pressable>
      </View>
    </View>
  );
}
