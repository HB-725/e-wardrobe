import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { estimateFor } from '@/ai/catalog';
import { AiError, type AiErrorKind, blockedRoute, describeAiError } from '@/ai/client';
import { catalogQuality, getAiSettings } from '@/ai/config';
import { formatEstimate } from '@/ai/models';
import { SLOT_LABEL } from '@/domain/catalog';
import type { Item } from '@/domain/types';
import { confirmItem, confirmPicks, keepCurrent, keepOriginal, needsReview, regenerateWith, removeItem, retryItem, setDetections } from '@/state/actions';
import { useApp, useData } from '@/state/app';
import { loadSnapshot, type Snapshot } from '@/state/snapshot';
import { confirmAsync, notify } from '@/ui/dialogs';
import { type Form, formOf, formProblems, ItemForm, patchOf } from '@/ui/ItemForm';
import { Btn, Checkbox, Loading, NavHeader, Screen, T, Tap } from '@/ui/kit';
import { PickMarks } from '@/ui/PhotoBoxes';
import { RegenerateSheet } from '@/ui/RegenerateSheet';
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
  const settings = useData(getAiSettings);
  const [curId, setCurId] = useState<string | null>(params.id ?? null);
  // Chosen candidate per item + candidate set, so a regenerated set starts again at the first one.
  const [picks, setPicks] = useState<Record<string, number>>({});
  // Only the fields the user touched, per item; everything else follows the latest AI-filled values.
  const [edits, setEdits] = useState<Record<string, Partial<Form>>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [regenOpen, setRegenOpen] = useState(false);

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
  const isPick = cur.status === 'pick';
  const isRegen = ready && (cur.status === 'active' || cur.status === 'archived');
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

  const picked = cur.detections.filter((d) => d.selected).length;
  const one = settings ? estimateFor(s.routing, 'catalog', { inputImages: 1, quality: catalogQuality(settings), n: Math.max(1, Math.min(3, settings.candidates)) }) : null;
  const toggle = (i: number) => run(() => setDetections(app, cur.id, cur.detections.map((d, j) => (j === i ? { ...d, selected: !d.selected } : d))), false);
  const dropPhoto = async () => {
    if (!(await confirmAsync('这张照片一件都不录？', '照片会删除。'))) return;
    await run(() => removeItem(app, cur.id), false);
    next();
  };

  const footer = isPick ? (
    <>
      <Btn label="全不要" kind="outline" style={{ flex: 1 }} disabled={busy} onPress={dropPhoto} />
      <Btn
        label={picked ? `录入 ${picked} 件 · ${formatEstimate(one === null ? null : one * picked)}` : '先选要录入的衣服'}
        style={{ flex: 2 }}
        loading={busy}
        disabled={!picked}
        onPress={() => run(async () => void (await confirmPicks(app, cur.id)))}
      />
    </>
  ) : isRegen ? (
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
        title={isPick ? '选择要录入的衣服' : isRegen ? '选择新的标准图' : '确认新单品'}
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
      {isPick && cur.originalUri ? (
        <View style={{ paddingTop: 16, paddingHorizontal: PAD, gap: 10 }}>
          <PickMarks uri={cur.originalUri} detections={cur.detections} onToggle={toggle} maxHeight={420} />
          <T v="caption">照片里有 {cur.detections.length} 件，点圆点或下面的名字选要录入的，可以多选。</T>
          <View>
            {cur.detections.map((d, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: 1, borderBottomColor: C.lineSoft }}>
                <Tap accessibilityRole="checkbox" accessibilityState={{ checked: d.selected }} onPress={() => toggle(i)} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52 }}>
                  <Checkbox on={d.selected} />
                  <T style={{ flex: 1, fontSize: 14 }} numberOfLines={1}>
                    {d.manual ? '自己框的一件' : `${d.name} · ${SLOT_LABEL[d.slot]}`}
                  </T>
                </Tap>
                <Btn label="调整框" kind="outline" height={36} disabled={busy} onPress={() => router.push(`/crop?id=${cur.id}&det=${i}`)} />
              </View>
            ))}
          </View>
          <Btn label="自己框一件" icon="plus" kind="ghost" height={44} disabled={busy} onPress={() => router.push(`/crop?id=${cur.id}&det=new`)} />
        </View>
      ) : null}
      {isPick ? null : (
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
                {s.blocked ? <Btn label="去处理" kind="outline" onCard height={36} onPress={() => router.push(blockedRoute(s.blocked))} /> : null}
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
      )}
      {ready && !isPick ? (
        <View style={{ flexDirection: 'row', gap: 8, paddingTop: 10, paddingHorizontal: PAD, alignItems: 'center' }}>
          <T v="caption" style={{ marginRight: 4 }}>
            候选
          </T>
          {cur.candidates.map((c, i) => (
            <Pressable key={c} accessibilityRole="button" accessibilityLabel={`方案 ${i + 1}`} accessibilityState={{ selected: i === pick }} onPress={() => setPick(i)} style={{ width: 44, height: 66, borderRadius: R.small, overflow: 'hidden', backgroundColor: C.card, borderWidth: 2, borderColor: i === pick ? C.ink : 'transparent' }}>
              <Image source={{ uri: c }} style={{ flex: 1 }} contentFit="cover" />
            </Pressable>
          ))}
          <Btn label="重新生成" kind="outline" height={44} style={{ marginLeft: 'auto' }} disabled={busy || !settings} onPress={() => setRegenOpen(true)} />
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
      {isPick ? null : <ItemForm item={cur} form={f} onChange={set} style={{ paddingTop: 12, paddingHorizontal: PAD }} />}
      {settings ? (
        <RegenerateSheet
          key={cur.id}
          visible={regenOpen}
          onClose={() => setRegenOpen(false)}
          item={cur}
          routing={s.routing}
          settings={settings}
          onCrop={() => {
            setRegenOpen(false);
            router.push(`/crop?id=${cur.id}&mode=item`);
          }}
          onSubmit={(opts) => {
            // Category, name and colour typed here are saved first, so the new picture follows them.
            const problems = formProblems(f);
            if (problems.length) return notify('请先改一下', problems.join('\n'));
            setRegenOpen(false);
            void run(() => regenerateWith(app, cur.id, patchOf(cur, f), opts), false);
          }}
        />
      ) : null}
    </Screen>
  );
}
