import { router } from 'expo-router';
import { memo, useState } from 'react';
import { FlatList, Pressable, ScrollView, Text, View } from 'react-native';
import { SLOTS } from '@/domain/catalog';
import { wearRank } from '@/domain/stats';
import type { Item, Slot } from '@/domain/types';
import { retryItem } from '@/state/actions';
import { useApp, useData } from '@/state/app';
import { loadSnapshot, type Snapshot } from '@/state/snapshot';
import { Icon } from '@/ui/Icon';
import { Btn, Loading, PageHeader, Screen, T, Tap } from '@/ui/kit';
import { C, PAD, R } from '@/ui/theme';
import { ItemImage } from '@/ui/visuals';

type Cat = 'all' | Slot | 'archived';

const COLS = 4;

type Cell = { kind: 'item'; key: string; item: Item } | { kind: 'add'; key: string } | { kind: 'pad'; key: string };

/** One garment in the grid; memoised so a refresh re-renders only what changed. */
const Tile = memo(function Tile({ item: it, on, wears, onPress }: { item: Item; on: boolean; wears: number; onPress: (it: Item) => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${it.name}${it.status === 'review' ? '（待确认）' : ''}`}
      accessibilityHint={on ? '再点一次打开' : '选中后再点一次打开'}
      accessibilityState={{ selected: on }}
      onPress={() => onPress(it)}
      style={{ flex: 1, aspectRatio: 0.75, borderRadius: R.tile, overflow: 'hidden', borderWidth: 2, borderColor: on ? C.ink : 'transparent' }}
    >
      <ItemImage item={it} style={{ flex: 1 }} />
      {it.status === 'active' ? (
        <T style={{ position: 'absolute', right: 4, bottom: 4, fontSize: 10, color: C.sub, backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: R.pill, overflow: 'hidden', paddingHorizontal: 6 }}>×{wears}</T>
      ) : null}
      {it.status === 'review' || it.status === 'failed' ? (
        <View style={{ position: 'absolute', left: 4, top: 4, paddingHorizontal: 7, paddingVertical: 1, borderRadius: R.pill, backgroundColor: it.status === 'failed' ? C.danger : C.ink }}>
          <T style={{ color: '#FFFFFF', fontSize: 10 }}>{it.status === 'failed' ? '失败' : '待确认'}</T>
        </View>
      ) : null}
    </Pressable>
  );
});

const STATUS_ORDER: Record<Item['status'], number> = { review: 0, failed: 1, processing: 2, active: 3, archived: 4 };

function visibleItems(s: Snapshot, cat: Cat): Item[] {
  const list = s.items.filter((i) => (cat === 'archived' ? i.status === 'archived' : i.status !== 'archived' && (cat === 'all' || i.slot === cat)));
  return list.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
}

/** Unfinished items open in review (where they can be kept as a plain photo); finished ones open their detail page. */
function pageFor(it: Item): string {
  return it.status === 'review' || it.status === 'processing' || it.status === 'failed' ? `/review?id=${it.id}` : `/item/${it.id}`;
}

function subtitle(s: Snapshot, it: Item): string {
  switch (it.status) {
    case 'review':
      return '待确认';
    case 'processing':
      return s.blocked ? '已暂停' : '正在生成标准图…';
    case 'failed':
      return it.error ?? '生成失败';
    case 'archived':
      return '已收起 · 不出现在试衣间';
    default: {
      const st = s.stats.get(it.id);
      const wears = st?.wears ?? 0;
      return wears ? `穿过 ${wears} 次 · 常穿第 ${wearRank(it.id, s.stats)} 名` : '还没穿过';
    }
  }
}

export default function WardrobePage() {
  const app = useApp();
  const s = useData(loadSnapshot);
  const [cat, setCat] = useState<Cat>('all');
  const [selId, setSelId] = useState<string | null>(null);

  if (!s) return <Loading />;

  const list = visibleItems(s, cat);
  const sel = (selId && s.byId.get(selId)) || list[0] || null;
  const archivedCount = s.items.filter((i) => i.status === 'archived').length;
  const onTile = (it: Item) => (sel?.id === it.id ? router.push(pageFor(it)) : setSelId(it.id));
  const cells: Cell[] = list.map((item) => ({ kind: 'item', key: item.id, item }));
  if (cat !== 'archived') cells.push({ kind: 'add', key: 'add' });
  while (cells.length % COLS) cells.push({ kind: 'pad', key: `pad${cells.length}` });
  const tabs: { id: Cat; label: string }[] = [{ id: 'all', label: '全部' }, ...SLOTS.filter((x) => x.id !== 'accessory' || s.items.some((i) => i.slot === 'accessory'))];

  const cta = () => {
    if (!sel) return;
    if (sel.status === 'review' || sel.status === 'processing') router.push(`/review?id=${sel.id}`);
    else if (sel.status === 'failed') void retryItem(app, sel.id).then(app.refresh, (e) => app.toast(String(e)));
    else if (sel.status === 'active') {
      app.setFitting({ ...app.fitting, [sel.slot]: sel.id });
      router.push('/fitting');
    } else if (sel.status === 'archived') router.push(`/item/${sel.id}`);
  };
  const ctaLabel = sel ? { review: '去确认', failed: '重试', active: '去试穿', processing: '查看', archived: '查看' }[sel.status] : '';

  return (
    <Screen scroll={false}>
      <PageHeader
        title="衣橱"
        right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <T style={{ fontSize: 13, color: C.sub }}>共 {s.active.length} 件</T>
            <Btn label="添加" icon="plus" kind="outline" height={40} onPress={() => router.push('/capture')} />
          </View>
        }
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, marginTop: 16 }} contentContainerStyle={{ paddingHorizontal: PAD, gap: 8 }}>
        {tabs.map((c) => {
          const on = c.id === cat;
          return (
            <Pressable
              key={c.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              onPress={() => {
                setCat(c.id);
                setSelId(null);
              }}
              hitSlop={{ top: 4, bottom: 4 }}
              style={{ height: 36, paddingHorizontal: 16, borderRadius: R.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? C.ink : C.card }}
            >
              <Text style={{ fontSize: 13, color: on ? '#FFFFFF' : C.sub, fontWeight: on ? '600' : '400' }}>{c.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={{ flex: 1, marginTop: 14 }}>
        <FlatList
          style={{ flex: 1 }}
          data={cells}
          keyExtractor={(c) => c.key}
          numColumns={COLS}
          columnWrapperStyle={{ gap: 8 }}
          // Room at the end for the floating card of the selected garment.
          contentContainerStyle={{ gap: 8, paddingHorizontal: PAD, paddingBottom: sel ? 112 : 20 }}
          initialNumToRender={24}
          windowSize={5}
          removeClippedSubviews
          renderItem={({ item: c }) =>
            c.kind === 'item' ? (
              <Tile item={c.item} on={sel?.id === c.item.id} wears={s.stats.get(c.item.id)?.wears ?? 0} onPress={onTile} />
            ) : c.kind === 'add' ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="添加新衣服"
                onPress={() => router.push('/capture')}
                style={{ flex: 1, aspectRatio: 0.75, borderRadius: R.tile, borderWidth: 1, borderStyle: 'dashed', borderColor: C.muted, alignItems: 'center', justifyContent: 'center' }}
              >
                <Icon name="plus" size={20} color={C.faint} strokeWidth={1.6} />
              </Pressable>
            ) : (
              <View style={{ flex: 1 }} />
            )
          }
          ListFooterComponent={
            archivedCount > 0 || cat === 'archived' ? (
              <Tap onPress={() => setCat(cat === 'archived' ? 'all' : 'archived')} style={{ minHeight: 40, justifyContent: 'center' }}>
                <T style={{ fontSize: 12, color: C.sub, textDecorationLine: 'underline' }}>{cat === 'archived' ? '返回全部' : `已收起 ${archivedCount} 件`}</T>
              </Tap>
            ) : undefined
          }
        />
        {sel ? (
          <View
            style={{
              position: 'absolute',
              left: 12,
              right: 12,
              bottom: 12,
              padding: 12,
              borderRadius: R.card,
              backgroundColor: C.bg,
              boxShadow: '0 4px 20px rgba(17,17,17,0.10)',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <ItemImage item={sel} style={{ width: 54, height: 72, borderRadius: R.small }} />
            <Tap onPress={() => router.push(pageFor(sel))} style={{ flex: 1, gap: 2 }}>
              <T style={{ fontSize: 15, fontWeight: '700' }} numberOfLines={1}>
                {sel.name}
              </T>
              <T v="caption" numberOfLines={2} style={{ color: sel.status === 'failed' ? C.danger : C.sub }}>
                {subtitle(s, sel)}
              </T>
            </Tap>
            <Btn label={ctaLabel} height={44} onPress={cta} />
          </View>
        ) : list.length === 0 && cat !== 'archived' ? (
          <View style={{ position: 'absolute', left: PAD, right: PAD, top: '30%', alignItems: 'center', gap: 14 }}>
            <T v="title">{cat === 'all' ? '还没有衣服' : '这一类还没有衣服'}</T>
            <Btn label="添加" icon="plus" onPress={() => router.push('/capture')} style={{ paddingHorizontal: 28 }} />
          </View>
        ) : null}
      </View>
    </Screen>
  );
}
