import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SLOTS } from '@/domain/catalog';
import { wearRank } from '@/domain/stats';
import type { Item, Slot } from '@/domain/types';
import { retryItem } from '@/state/actions';
import { useApp, useData } from '@/state/app';
import { loadSnapshot, type Snapshot } from '@/state/snapshot';
import { Icon } from '@/ui/Icon';
import { Btn, Loading, PageHeader, Screen, T, Tap } from '@/ui/kit';
import { C, PAD } from '@/ui/theme';
import { ItemImage } from '@/ui/visuals';

type Cat = 'all' | Slot | 'archived';

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
      return 'AI 已生成 · 等你确认';
    case 'processing':
      return s.blocked ? 'AI 已暂停，处理好后自动继续' : '正在生成标准图…';
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
        eyebrow="MY WARDROBE"
        title="衣橱"
        right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <T style={{ fontSize: 13, color: C.sub }}>共 {s.active.length} 件</T>
            <Tap onPress={() => router.push('/capture')} style={{ height: 36, paddingHorizontal: 12, borderWidth: 1, borderColor: C.ink, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Icon name="plus" size={16} strokeWidth={1.8} />
              <T style={{ fontSize: 13, fontWeight: '500' }}>添加</T>
            </Tap>
          </View>
        }
      />
      <View style={{ flexDirection: 'row', marginTop: 20, marginHorizontal: PAD, zIndex: 2 }}>
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
              style={{
                flex: 1,
                height: 44,
                marginBottom: -1,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: on ? C.bg : C.card,
                borderWidth: 1,
                borderColor: on ? C.ink : C.card,
                borderBottomColor: on ? C.bg : C.ink,
              }}
            >
              <Text style={{ fontSize: 13, color: on ? C.ink : C.sub, fontWeight: on ? '700' : '400' }}>{c.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={{ flex: 1, marginHorizontal: PAD, marginBottom: 16, padding: 12, borderWidth: 1, borderColor: C.ink, gap: 12 }}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {list.map((it) => {
            const on = sel?.id === it.id;
            const wears = s.stats.get(it.id)?.wears ?? 0;
            return (
              <Pressable
                key={it.id}
                accessibilityRole="button"
                accessibilityLabel={`${it.name}${it.status === 'review' ? '（待确认）' : ''}`}
                accessibilityState={{ selected: on }}
                onPress={() => (on ? router.push(pageFor(it)) : setSelId(it.id))}
                style={{ width: '23.6%', aspectRatio: 0.75, borderWidth: 2, borderColor: on ? C.ink : C.card }}
              >
                <ItemImage item={it} style={{ flex: 1 }} />
                {it.status === 'active' ? <T style={{ position: 'absolute', right: 3, bottom: 3, fontSize: 10, color: C.sub, backgroundColor: 'rgba(255,255,255,0.85)', paddingHorizontal: 3 }}>×{wears}</T> : null}
                {it.status === 'review' || it.status === 'failed' ? (
                  <View style={{ position: 'absolute', left: 0, top: 0, paddingHorizontal: 5, paddingVertical: 1, backgroundColor: it.status === 'failed' ? C.danger : C.ink }}>
                    <T style={{ color: '#FFFFFF', fontSize: 10 }}>{it.status === 'failed' ? '失败' : '待确认'}</T>
                  </View>
                ) : null}
              </Pressable>
            );
          })}
          {cat !== 'archived' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="添加新衣服"
              onPress={() => router.push('/capture')}
              style={{ width: '23.6%', height: 80, borderWidth: 1, borderStyle: 'dashed', borderColor: C.muted, alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name="plus" size={20} color={C.faint} strokeWidth={1.6} />
            </Pressable>
          ) : null}
          {archivedCount > 0 || cat === 'archived' ? (
            <Tap onPress={() => setCat(cat === 'archived' ? 'all' : 'archived')} style={{ width: '100%', minHeight: 40, justifyContent: 'center' }}>
              <T style={{ fontSize: 12, color: C.sub, textDecorationLine: 'underline' }}>{cat === 'archived' ? '返回全部' : `已收起 ${archivedCount} 件`}</T>
            </Tap>
          ) : null}
        </ScrollView>
        {sel ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.line }}>
            <ItemImage item={sel} style={{ width: 54, height: 72 }} />
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
        ) : (
          <View style={{ paddingTop: 12, borderTopWidth: 1, borderTopColor: C.line, gap: 4 }}>
            <T style={{ fontSize: 15, fontWeight: '700' }}>{cat === 'all' ? '衣橱还是空的' : '这一类还没有衣服'}</T>
            <T v="caption">点「添加」拍照，或从相册批量导入。</T>
          </View>
        )}
      </View>
    </Screen>
  );
}
