import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { AiError, type AiErrorKind, describeAiError } from '@/ai/client';
import type { Item } from '@/domain/types';
import { confirmItem, keepOriginal, regenerateItem, removeItem, retryItem } from '@/state/actions';
import { useApp, useData } from '@/state/app';
import { loadSnapshot, type Snapshot } from '@/state/snapshot';
import { confirmAsync } from '@/ui/dialogs';
import { type Form, formOf, ItemForm, patchOf } from '@/ui/ItemForm';
import { Btn, Loading, NavHeader, Screen, T, Tap } from '@/ui/kit';
import { C, PAD } from '@/ui/theme';

function queueOf(s: Snapshot): Item[] {
  const order = { review: 0, failed: 1, processing: 2 } as Record<string, number>;
  return s.items
    .filter((i) => i.status === 'review' || i.status === 'processing' || i.status === 'failed')
    .sort((a, b) => order[a.status] - order[b.status] || a.createdAt.localeCompare(b.createdAt));
}

export default function ReviewPage() {
  const app = useApp();
  const params = useLocalSearchParams<{ id?: string }>();
  const s = useData(loadSnapshot);
  const [curId, setCurId] = useState<string | null>(params.id ?? null);
  const [pick, setPick] = useState(0);
  // Edits per item; untouched items always show the latest AI-filled values.
  const [forms, setForms] = useState<Record<string, Form>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);

  const queue = s ? queueOf(s) : [];
  const cur = queue.find((i) => i.id === curId) ?? queue.find((i) => i.status === 'review') ?? queue[0] ?? null;

  if (!s) return <Loading />;

  if (!cur) {
    return (
      <Screen>
        <NavHeader title="确认新单品" />
        <View style={{ padding: PAD, paddingTop: 60, gap: 16, alignItems: 'center' }}>
          <T v="h2">{done ? `已确认 ${done} 件` : '没有待确认的衣服'}</T>
          <T v="body" style={{ color: C.sub, textAlign: 'center' }}>
            {done ? '它们已经在衣橱里了。' : '新录入的衣服生成好标准图后会出现在这里。'}
          </T>
          <Btn label="去衣橱" onPress={() => router.replace('/wardrobe')} style={{ paddingHorizontal: 32 }} />
          <Btn label="继续录入" kind="outline" onPress={() => router.replace('/capture')} style={{ paddingHorizontal: 32 }} />
        </View>
      </Screen>
    );
  }

  const index = queue.findIndex((i) => i.id === cur.id);
  const next = () => {
    const rest = queue.filter((i) => i.id !== cur.id);
    const n = rest.find((i) => i.status === 'review') ?? rest[0] ?? null;
    setCurId(n?.id ?? null);
    setPick(0);
  };
  const f = forms[cur.id] ?? formOf(cur);
  const set = (patch: Partial<Form>) => setForms((x) => ({ ...x, [cur.id]: { ...f, ...patch } }));
  const chosen = cur.candidates[pick] ?? null;
  const checks = cur.checks[pick] ?? [];
  const otherReady = queue.some((i) => i.id !== cur.id && i.status === 'review');

  const run = async (fn: () => Promise<void>, advance = true) => {
    setBusy(true);
    try {
      await fn();
      app.refresh();
      if (advance) {
        setDone((d) => d + 1);
        next();
      }
    } finally {
      setBusy(false);
    }
  };

  const footer =
    cur.status === 'review' ? (
      <>
        <Btn label="只存原图" kind="outline" style={{ flex: 1 }} disabled={busy} onPress={() => run(() => confirmItem(app, cur.id, null, patchOf(cur, f)))} />
        <Btn label={queue.length > 1 ? '保存，下一件' : '保存'} style={{ flex: 2 }} loading={busy} onPress={() => run(() => confirmItem(app, cur.id, pick, patchOf(cur, f)))} />
      </>
    ) : cur.status === 'failed' ? (
      <>
        <Btn label="只存原图" kind="outline" style={{ flex: 1 }} disabled={busy} onPress={() => run(() => keepOriginal(app, cur.id, patchOf(cur, f)))} />
        <Btn label="重新生成" style={{ flex: 2 }} loading={busy} onPress={() => run(() => retryItem(app, cur.id), false)} />
      </>
    ) : (
      <>
        <Btn label="只存原图" kind="outline" style={{ flex: 1 }} disabled={busy} onPress={() => run(() => keepOriginal(app, cur.id, patchOf(cur, f)))} />
        <Btn label={otherReady ? '先看下一件' : '等待生成…'} style={{ flex: 2 }} disabled={!otherReady} onPress={next} />
      </>
    );

  return (
    <Screen footer={footer}>
      <NavHeader
        title="确认新单品"
        subtitle={`第 ${index + 1} 件 / 共 ${queue.length} 件`}
        right={
          <Tap
            accessibilityLabel="删除这件"
            onPress={async () => {
              if (!(await confirmAsync('删除这件衣服？', '照片和生成的图片都会删除。'))) return;
              await run(() => removeItem(app, cur.id), false);
              next();
            }}
            style={{ minWidth: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            <T style={{ fontSize: 14, color: C.danger }}>删除</T>
          </Tap>
        }
      />
      <View style={{ flexDirection: 'row', gap: 8, paddingTop: 16, paddingHorizontal: PAD }}>
        <View style={{ flex: 1, gap: 6 }}>
          <View style={{ height: 210, backgroundColor: C.card }}>{cur.originalUri ? <Image source={{ uri: cur.originalUri }} style={{ flex: 1 }} contentFit="cover" /> : null}</View>
          <T v="caption">原图</T>
        </View>
        <View style={{ flex: 1, gap: 6 }}>
          <View style={{ height: 210, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }}>
            {chosen ? (
              <Image source={{ uri: chosen }} style={{ width: '100%', height: '100%' }} contentFit="contain" />
            ) : cur.status === 'processing' ? (
              <View style={{ alignItems: 'center', gap: 10, padding: 12 }}>
                {s.blocked ? null : <ActivityIndicator color={C.ink} />}
                <T v="caption" style={{ textAlign: 'center' }}>
                  {s.blocked ? describeAiError(new AiError(s.blocked as AiErrorKind, '')) : '正在生成标准图\n大约 20 秒'}
                </T>
                {s.blocked ? <Btn label="去处理" kind="outline" height={36} onPress={() => router.push('/apikey')} /> : null}
              </View>
            ) : (
              <T v="caption" style={{ textAlign: 'center', padding: 12, color: cur.status === 'failed' ? C.danger : C.sub }}>
                {cur.error ?? '没有生成图'}
              </T>
            )}
          </View>
          <T style={{ fontSize: 12, fontWeight: '500' }}>{chosen ? `标准图 · 方案 ${pick + 1}` : '标准图'}</T>
        </View>
      </View>
      {cur.status === 'review' ? (
        <View style={{ flexDirection: 'row', gap: 8, paddingTop: 10, paddingHorizontal: PAD, alignItems: 'center' }}>
          <T v="caption" style={{ marginRight: 4 }}>
            候选
          </T>
          {cur.candidates.map((c, i) => (
            <Pressable key={c} accessibilityRole="button" accessibilityLabel={`方案 ${i + 1}`} accessibilityState={{ selected: i === pick }} onPress={() => setPick(i)} style={{ width: 52, height: 58, backgroundColor: C.card, borderWidth: 2, borderColor: i === pick ? C.ink : 'transparent' }}>
              <Image source={{ uri: c }} style={{ flex: 1 }} contentFit="contain" />
            </Pressable>
          ))}
          <Btn label="重新生成" kind="outline" height={44} style={{ marginLeft: 'auto' }} disabled={busy} onPress={() => run(() => regenerateItem(app, cur.id), false)} />
        </View>
      ) : null}
      {checks.length > 0 ? (
        <View style={{ marginTop: 16, marginHorizontal: PAD, paddingVertical: 14, paddingHorizontal: 16, backgroundColor: C.card, gap: 8 }}>
          <T style={{ fontSize: 12, fontWeight: '700', letterSpacing: 1 }}>保真检查</T>
          {checks.map((k, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ width: 18, height: 18, backgroundColor: k.ok ? C.ok : C.warn, alignItems: 'center', justifyContent: 'center' }}>
                <T style={{ color: '#FFFFFF', fontSize: 11, fontWeight: '700' }}>{k.ok ? '✓' : '!'}</T>
              </View>
              <T style={{ flex: 1, fontSize: 13 }}>{k.label}</T>
              <T style={{ fontSize: 12, color: C.sub, maxWidth: 110 }} numberOfLines={2}>
                {k.note}
              </T>
            </View>
          ))}
          {checks.some((k) => !k.ok) ? <T style={{ fontSize: 11, color: C.sub }}>有差别可以换一个方案、重新生成，或只存原图。</T> : null}
        </View>
      ) : null}
      <ItemForm item={cur} form={f} onChange={set} style={{ paddingTop: 12, paddingHorizontal: PAD }} />
    </Screen>
  );
}
