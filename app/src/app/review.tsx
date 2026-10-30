import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { AiError, type AiErrorKind, blockedRoute, describeAiError } from '@/ai/client';
import type { Item } from '@/domain/types';
import { confirmItem, keepCurrent, keepOriginal, needsReview, regenerateItem, removeItem, retryItem } from '@/state/actions';
import { useApp, useData } from '@/state/app';
import { loadSnapshot, type Snapshot } from '@/state/snapshot';
import { confirmAsync, notify } from '@/ui/dialogs';
import { type Form, formOf, formProblems, ItemForm, patchOf } from '@/ui/ItemForm';
import { Btn, Loading, NavHeader, Screen, T, Tap } from '@/ui/kit';
import { C, PAD, R } from '@/ui/theme';

/** Ready items first, then failed, then still generating; oldest first within a group. */
function queueOf(s: Snapshot): Item[] {
  const rank = (i: Item) => (needsReview(i) ? 0 : i.status === 'failed' ? 1 : 2);
  return s.items
    .filter((i) => needsReview(i) || i.status === 'processing' || i.status === 'failed')
    .sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt));
}

export default function ReviewPage() {
  const app = useApp();
  const params = useLocalSearchParams<{ id?: string }>();
  const s = useData(loadSnapshot);
  const [curId, setCurId] = useState<string | null>(params.id ?? null);
  // Chosen candidate per item + candidate set, so a regenerated set starts again at the first one.
  const [picks, setPicks] = useState<Record<string, number>>({});
  // Only the fields the user touched, per item; everything else follows the latest AI-filled values.
  const [edits, setEdits] = useState<Record<string, Partial<Form>>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);

  const queue = s ? queueOf(s) : [];
  const cur = queue.find((i) => i.id === curId) ?? queue.find(needsReview) ?? queue[0] ?? null;
  // Stick to the item on screen so it does not jump when another one finishes generating.
  if (cur && cur.id !== curId) setCurId(cur.id);

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
    const n = rest.find(needsReview) ?? rest[0] ?? null;
    setCurId(n?.id ?? null);
  };
  const f: Form = { ...formOf(cur), ...edits[cur.id] };
  const set = (patch: Partial<Form>) => setEdits((x) => ({ ...x, [cur.id]: { ...x[cur.id], ...patch } }));
  const pickKey = `${cur.id}:${cur.candidates[0] ?? ''}`;
  const pick = Math.min(picks[pickKey] ?? 0, Math.max(0, cur.candidates.length - 1));
  const setPick = (i: number) => setPicks((x) => ({ ...x, [pickKey]: i }));
  const chosen = cur.candidates[pick] ?? null;
  const checks = cur.checks[pick] ?? [];
  const ready = needsReview(cur);
  const isRegen = ready && cur.status !== 'review';
  const otherReady = queue.some((i) => i.id !== cur.id && needsReview(i));

  const run = async (fn: () => Promise<void>, advance = true) => {
    setBusy(true);
    try {
      await fn();
      app.refresh();
      if (advance) {
        setDone((d) => d + 1);
        next();
      }
    } catch (e) {
      // e.g. the candidates changed under us after a regeneration; show the fresh state instead.
      app.toast(`没有完成：${describeAiError(e)}`);
      app.refresh();
    } finally {
      setBusy(false);
    }
  };

  // Edited fields must be readable before anything is saved (an unreadable price would otherwise be dropped).
  const saveWith = (fn: (patch: ReturnType<typeof patchOf>) => Promise<void>) => () => {
    const problems = formProblems(f);
    if (problems.length) return notify('请先改一下', problems.join('\n'));
    void run(() => fn(patchOf(cur, f)));
  };

  const footer = isRegen ? (
    <>
      <Btn label="保留现在的" kind="outline" style={{ flex: 1 }} disabled={busy} onPress={saveWith((patch) => keepCurrent(app, cur.id, patch))} />
      <Btn label="换成新的" style={{ flex: 2 }} loading={busy} disabled={!chosen} onPress={saveWith((patch) => confirmItem(app, cur.id, pick, patch))} />
    </>
  ) : cur.status === 'review' ? (
      <>
        <Btn label="只存原图" kind="outline" style={{ flex: 1 }} disabled={busy} onPress={saveWith((patch) => confirmItem(app, cur.id, null, patch))} />
        <Btn label={queue.length > 1 ? '保存，下一件' : '保存'} style={{ flex: 2 }} loading={busy} onPress={saveWith((patch) => confirmItem(app, cur.id, pick, patch))} />
      </>
    ) : cur.status === 'failed' ? (
      <>
        <Btn label="只存原图" kind="outline" style={{ flex: 1 }} disabled={busy} onPress={saveWith((patch) => keepOriginal(app, cur.id, patch))} />
        <Btn label="重新生成" style={{ flex: 2 }} loading={busy} onPress={() => run(() => retryItem(app, cur.id), false)} />
      </>
    ) : (
      <>
        <Btn label="只存原图" kind="outline" style={{ flex: 1 }} disabled={busy} onPress={saveWith((patch) => keepOriginal(app, cur.id, patch))} />
        <Btn label={otherReady ? '先看下一件' : '等待生成…'} style={{ flex: 2 }} disabled={!otherReady} onPress={next} />
      </>
    );

  return (
    <Screen footer={footer}>
      <NavHeader
        title={isRegen ? '选择新的标准图' : '确认新单品'}
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
          <View style={{ aspectRatio: 2 / 3, borderRadius: R.card, overflow: 'hidden', backgroundColor: C.card }}>
            {isRegen && cur.catalogUri ? (
              <Image source={{ uri: cur.catalogUri }} style={{ flex: 1 }} contentFit="cover" />
            ) : cur.originalUri ? (
              <Image source={{ uri: cur.originalUri }} style={{ flex: 1 }} contentFit="cover" />
            ) : null}
          </View>
          <T v="caption">{isRegen && cur.catalogUri ? '现在的标准图' : '原图'}</T>
        </View>
        <View style={{ flex: 1, gap: 6 }}>
          <View style={{ aspectRatio: 2 / 3, borderRadius: R.card, overflow: 'hidden', backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }}>
            {chosen ? (
              <Image source={{ uri: chosen }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
            ) : cur.status === 'processing' ? (
              <View style={{ alignItems: 'center', gap: 10, padding: 12 }}>
                {s.blocked ? null : <ActivityIndicator color={C.ink} />}
                <T v="caption" style={{ textAlign: 'center' }}>
                  {s.blocked ? describeAiError(new AiError(s.blocked as AiErrorKind, '')) : '正在生成标准图\n大约 20 秒'}
                </T>
                {s.blocked ? <Btn label="去处理" kind="outline" height={36} onPress={() => router.push(blockedRoute(s.blocked))} /> : null}
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
      {ready ? (
        <View style={{ flexDirection: 'row', gap: 8, paddingTop: 10, paddingHorizontal: PAD, alignItems: 'center' }}>
          <T v="caption" style={{ marginRight: 4 }}>
            候选
          </T>
          {cur.candidates.map((c, i) => (
            <Pressable key={c} accessibilityRole="button" accessibilityLabel={`方案 ${i + 1}`} accessibilityState={{ selected: i === pick }} onPress={() => setPick(i)} style={{ width: 44, height: 66, borderRadius: R.small, overflow: 'hidden', backgroundColor: C.card, borderWidth: 2, borderColor: i === pick ? C.ink : 'transparent' }}>
              <Image source={{ uri: c }} style={{ flex: 1 }} contentFit="cover" />
            </Pressable>
          ))}
          <Btn label="重新生成" kind="outline" height={44} style={{ marginLeft: 'auto' }} disabled={busy} onPress={() => run(() => regenerateItem(app, cur.id), false)} />
        </View>
      ) : null}
      {checks.length > 0 ? (
        <View style={{ marginTop: 16, marginHorizontal: PAD, paddingVertical: 14, paddingHorizontal: 16, borderRadius: R.card, backgroundColor: C.card, gap: 8 }}>
          <T style={{ fontSize: 12, fontWeight: '700', letterSpacing: 1 }}>保真检查</T>
          {checks.map((k, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ width: 18, height: 18, borderRadius: R.pill, backgroundColor: k.ok ? C.ok : C.warn, alignItems: 'center', justifyContent: 'center' }}>
                <T style={{ color: '#FFFFFF', fontSize: 11, fontWeight: '700' }}>{k.ok ? '✓' : '!'}</T>
              </View>
              <T style={{ flex: 1, fontSize: 13 }}>{k.label}</T>
              <T style={{ fontSize: 12, color: C.sub, maxWidth: 110 }} numberOfLines={2}>
                {k.note}
              </T>
            </View>
          ))}
        </View>
      ) : null}
      <ItemForm item={cur} form={f} onChange={set} style={{ paddingTop: 12, paddingHorizontal: PAD }} />
    </Screen>
  );
}
