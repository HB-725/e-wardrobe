import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, View } from 'react-native';
import { AiError, describeAiError } from '@/ai/client';
import { matchMirror, type MirrorMatch } from '@/ai/engine';
import { SLOT_LABEL, SLOTS } from '@/domain/catalog';
import type { Item } from '@/domain/types';
import { addFitNote, recordWear } from '@/state/actions';
import { useApp, useData } from '@/state/app';
import { loadSnapshot } from '@/state/snapshot';
import { Btn, Checkbox, Loading, NavHeader, Screen, Sheet, T, Tap } from '@/ui/kit';
import { C, PAD } from '@/ui/theme';
import { ItemImage } from '@/ui/visuals';

const CONF: Record<MirrorMatch['confidence'], string> = { high: '匹配度高', medium: '匹配度中', low: '匹配度低，请确认' };

type Phase = { k: 'pick' } | { k: 'matching'; photo: string } | { k: 'done'; photo: string; error: string | null; needsKey: boolean };

export default function MirrorPage() {
  const app = useApp();
  const s = useData(loadSnapshot);
  const [phase, setPhase] = useState<Phase>({ k: 'pick' });
  const [matches, setMatches] = useState<MirrorMatch[]>([]);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [on, setOn] = useState<Set<string>>(new Set());
  const [manual, setManual] = useState(false);
  const [saving, setSaving] = useState(false);
  // Delete the imported photo if the user leaves without recording it.
  const pendingPhoto = useRef<string | null>(null);
  useEffect(() => {
    pendingPhoto.current = phase.k === 'pick' ? null : phase.photo;
  }, [phase]);
  useEffect(
    () => () => {
      if (pendingPhoto.current) void app.images.remove(pendingPhoto.current);
    },
    [app.images],
  );

  if (!s) return <Loading />;
  const dateLabel = `${s.today.getMonth() + 1} 月 ${s.today.getDate()} 日`;

  const choose = async (camera: boolean) => {
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.9 };
    if (camera && Platform.OS !== 'web') {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        app.toast('需要相机权限，也可以从相册选');
        return;
      }
    }
    const r = camera && Platform.OS !== 'web' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (r.canceled) return;
    const photo = await app.images.importPhoto(r.assets[0].uri, 'mirror');
    setPhase({ k: 'matching', photo });
    try {
      const res = await matchMirror(app.ai, photo);
      setMatches(res.matches);
      setUnmatched(res.unmatched);
      setOn(new Set(res.matches.filter((m) => m.confidence !== 'low').map((m) => m.itemId)));
      setPhase({ k: 'done', photo, error: null, needsKey: false });
    } catch (e) {
      setPhase({ k: 'done', photo, error: describeAiError(e), needsKey: e instanceof AiError && e.needsUser });
    } finally {
      app.refresh();
    }
  };

  const toggle = (id: string, item?: Item) => {
    setOn((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        // one item per slot
        if (item) for (const x of [...next]) if (s.byId.get(x)?.slot === item.slot) next.delete(x);
        next.add(id);
      }
      return next;
    });
  };

  const save = async () => {
    if (phase.k !== 'done') return;
    setSaving(true);
    try {
      for (const m of matches) if (on.has(m.itemId) && m.note) await addFitNote(app, m.itemId, m.note, dateLabel);
      if (s.prefs.mirrorAutoLog && on.size > 0) {
        await recordWear(app, { date: s.todayKey, itemIds: [...on], source: 'mirror', photoUri: phase.photo });
        pendingPhoto.current = null;
        app.toast(`已记录今天的 ${on.size} 件，穿着次数 +1`);
      } else {
        await app.images.remove(phase.photo);
        app.toast('已保存合身笔记');
      }
      app.refresh();
      router.back();
    } finally {
      setSaving(false);
    }
  };

  const shown: { item: Item; note: string }[] = [
    ...matches.map((m) => ({ item: s.byId.get(m.itemId)!, note: [CONF[m.confidence], m.note].filter(Boolean).join(' · ') })),
    ...[...on].filter((id) => !matches.some((m) => m.itemId === id)).map((id) => ({ item: s.byId.get(id)!, note: '手动添加' })),
  ].filter((x) => x.item);
  const notes = matches.filter((m) => on.has(m.itemId) && m.note);

  if (phase.k === 'pick') {
    return (
      <Screen>
        <NavHeader title="记录今天的穿搭" subtitle={dateLabel} />
        <View style={{ padding: PAD, gap: 16 }}>
          <View style={{ height: 320, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <T v="body" style={{ textAlign: 'center', color: C.sub, lineHeight: 24 }}>
              对着镜子拍一张全身照，AI 会认出你穿的是衣橱里的哪几件，并记下实际的上身效果。
            </T>
          </View>
          <Btn label="拍一张镜子照" icon="camera" height={52} onPress={() => choose(true)} />
          <Btn label="从相册选" kind="outline" onPress={() => choose(false)} />
          <T v="caption" style={{ textAlign: 'center' }}>
            识别一次大约 $0.002。照片只保存在这台手机上。
          </T>
        </View>
      </Screen>
    );
  }

  return (
    <Screen
      footer={
        phase.k === 'done' ? (
          <Btn
            label={s.prefs.mirrorAutoLog ? `记录今天 · 穿着次数 +1` : '保存合身笔记'}
            style={{ flex: 1 }}
            disabled={on.size === 0}
            loading={saving}
            onPress={save}
          />
        ) : undefined
      }
    >
      <NavHeader title="记录今天的穿搭" subtitle={dateLabel} />
      <View style={{ marginTop: 16, marginHorizontal: PAD, height: 380, backgroundColor: C.card }}>
        <Image source={{ uri: phase.photo }} style={{ flex: 1 }} contentFit="contain" />
        {phase.k === 'matching' ? (
          <View style={{ position: 'absolute', left: 10, top: 10, flexDirection: 'row', gap: 8, alignItems: 'center', backgroundColor: C.scrim, paddingHorizontal: 10, paddingVertical: 6 }}>
            <ActivityIndicator size="small" color="#FFFFFF" />
            <T style={{ color: '#FFFFFF', fontSize: 12 }}>正在识别衣橱里的单品…</T>
          </View>
        ) : null}
      </View>
      {phase.k === 'done' ? (
        <View style={{ paddingTop: 18, paddingHorizontal: PAD }}>
          {phase.error ? (
            <View style={{ backgroundColor: '#FBF1E3', padding: 12, gap: 8, marginBottom: 12 }}>
              <T style={{ fontSize: 13 }}>识别失败：{phase.error}</T>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {phase.needsKey ? <Btn label="去处理" kind="outline" height={36} onPress={() => router.push('/apikey')} /> : null}
                <Btn label="手动选择" kind="outline" height={36} onPress={() => setManual(true)} />
              </View>
            </View>
          ) : null}
          <T style={{ fontSize: 15, fontWeight: '700', marginBottom: 4 }}>{shown.length ? `识别到 ${on.size} 件衣橱里的单品` : phase.error ? '' : '没有认出衣橱里的单品'}</T>
          {shown.map(({ item, note }) => (
            <Tap key={item.id} accessibilityState={{ checked: on.has(item.id) }} onPress={() => toggle(item.id, item)} style={{ minHeight: 64, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.lineSoft, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <ItemImage item={item} style={{ width: 46, height: 46 }} />
              <View style={{ flex: 1, gap: 2 }}>
                <T style={{ fontSize: 14, fontWeight: '500' }}>{item.name}</T>
                <T v="caption">{note}</T>
              </View>
              <Checkbox on={on.has(item.id)} />
            </Tap>
          ))}
          {unmatched.length ? <T v="caption" style={{ marginTop: 8 }}>衣橱里没有：{unmatched.join('、')}</T> : null}
          <Tap onPress={() => setManual(true)} style={{ minHeight: 44, justifyContent: 'center' }}>
            <T style={{ fontSize: 13, color: C.sub, textDecorationLine: 'underline' }}>有件衣服没认出来？手动选择</T>
          </Tap>
        </View>
      ) : null}
      {notes.length ? (
        <View style={{ marginTop: 8, marginHorizontal: PAD, padding: 14, backgroundColor: C.card, gap: 6 }}>
          <T style={{ fontSize: 12, fontWeight: '700', letterSpacing: 1 }}>将记到合身笔记</T>
          {notes.map((m) => (
            <T key={m.itemId} v="small">
              {s.byId.get(m.itemId)?.name}：{m.note}
            </T>
          ))}
        </View>
      ) : null}
      <Sheet visible={manual} onClose={() => setManual(false)} title="今天还穿了哪件？">
        <ScrollView style={{ maxHeight: 460 }}>
          {SLOTS.map((slot) => {
            const list = s.active.filter((i) => i.slot === slot.id);
            if (!list.length) return null;
            return (
              <View key={slot.id} style={{ gap: 8, paddingBottom: 14 }}>
                <T v="caption">{SLOT_LABEL[slot.id]}</T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {list.map((it) => (
                    <Tap key={it.id} accessibilityLabel={it.name} accessibilityState={{ selected: on.has(it.id) }} onPress={() => toggle(it.id, it)} style={{ width: 72, gap: 4 }}>
                      <ItemImage item={it} style={{ width: 72, height: 80, borderWidth: 2, borderColor: on.has(it.id) ? C.ink : C.card }} />
                      <T style={{ fontSize: 11 }} numberOfLines={1}>
                        {it.name}
                      </T>
                    </Tap>
                  ))}
                </View>
              </View>
            );
          })}
        </ScrollView>
        <Btn label="完成" onPress={() => setManual(false)} />
      </Sheet>
    </Screen>
  );
}
