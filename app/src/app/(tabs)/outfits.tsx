import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { OCCASION_LABEL, OCCASIONS } from '@/domain/catalog';
import { selectionFromItems } from '@/domain/outfit';
import { monthGrid, parseDateKey } from '@/domain/stats';
import type { Outfit } from '@/domain/types';
import { recordWear, removeOutfit, undoWear } from '@/state/actions';
import { useApp, useData } from '@/state/app';
import { useRecordToday } from '@/state/recordToday';
import { itemsOf, loadSnapshot, type Snapshot, tryonFor } from '@/state/snapshot';
import { Icon } from '@/ui/Icon';
import { Btn, IconBtn, Loading, PageHeader, Screen, Segmented, Sheet, T, Tap } from '@/ui/kit';
import { C, PAD } from '@/ui/theme';
import { confirmAsync } from '@/ui/dialogs';
import { OutfitBoard } from '@/ui/visuals';

const MONTHS = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
const DOWS = ['一', '二', '三', '四', '五', '六', '日'];

function wearCount(s: Snapshot, o: Outfit): number {
  return s.logs.filter((l) => l.outfitId === o.id).length;
}

function OutfitSheet({ s, outfit, onClose }: { s: Snapshot; outfit: Outfit | null; onClose: () => void }) {
  const app = useApp();
  const recordToday = useRecordToday();
  if (!outfit) return null;
  const items = itemsOf(s, outfit.itemIds);
  const missing = outfit.itemIds.length - items.filter((i) => i.status === 'active').length;
  return (
    <Sheet visible onClose={onClose} title={outfit.name}>
      <View style={{ flexDirection: 'row', gap: 14 }}>
        <OutfitBoard items={items} tryonUri={tryonFor(s, outfit.itemIds)} compact style={{ width: 90, height: 120 }} />
        <View style={{ flex: 1, gap: 4 }}>
          <T v="small" style={{ color: C.sub }}>
            {items.map((i) => i.name).join('、')}
          </T>
          <T v="caption">
            {outfit.occasions.map((o) => OCCASION_LABEL[o] ?? o).join(' · ') || '未设置场合'} · 穿过 {wearCount(s, outfit)} 次
          </T>
          {missing > 0 ? <T style={{ fontSize: 12, color: C.warn }}>有 {missing} 件已删除或收起</T> : null}
        </View>
      </View>
      <View style={{ gap: 8 }}>
        <Btn
          label="今天穿这套"
          disabled={missing > 0}
          onPress={async () => {
            if (!(await recordToday({ itemIds: outfit.itemIds, outfitId: outfit.id, source: 'outfit' }))) return;
            app.toast('已记录今天的穿搭');
            onClose();
          }}
        />
        <Btn
          label="在试衣间打开"
          kind="outline"
          onPress={() => {
            app.setFitting(selectionFromItems(items.filter((i) => i.status === 'active')));
            onClose();
            router.navigate('/fitting');
          }}
        />
        <Btn
          label="删除这套穿搭"
          kind="ghost"
          onPress={async () => {
            if (!(await confirmAsync('删除穿搭', `删除「${outfit.name}」？衣服本身和穿着记录不受影响。`))) return;
            await removeOutfit(app, outfit.id);
            app.refresh();
            onClose();
          }}
          style={{ height: 44 }}
        />
      </View>
    </Sheet>
  );
}

function Library({ s, onOpen }: { s: Snapshot; onOpen: (o: Outfit) => void }) {
  const [tag, setTag] = useState('all');
  const used = new Set(s.outfits.flatMap((o) => o.occasions));
  const tags = [{ id: 'all', label: '全部' }, ...OCCASIONS.filter((o) => used.has(o.id))];
  const list = s.outfits.filter((o) => tag === 'all' || o.occasions.includes(tag));
  if (s.outfits.length === 0) {
    return (
      <View style={{ padding: PAD, paddingTop: 40, gap: 12, alignItems: 'flex-start' }}>
        <T v="title">还没有保存的穿搭</T>
        <T v="body" style={{ color: C.sub }}>
          在试衣间挑好衣服，点「保存穿搭」，就会出现在这里，也会出现在「今天」的推荐里。
        </T>
        <Btn label="去试衣间" onPress={() => router.navigate('/fitting')} style={{ paddingHorizontal: 24 }} />
      </View>
    );
  }
  return (
    <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, borderBottomWidth: 1, borderBottomColor: C.line, marginTop: 14 }} contentContainerStyle={{ paddingHorizontal: PAD, gap: 22 }}>
        {tags.map((t) => {
          const on = t.id === tag;
          return (
            <Pressable key={t.id} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => setTag(t.id)} style={{ minHeight: 44, justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: on ? C.ink : 'transparent', marginBottom: -1 }}>
              <T style={{ fontSize: 14, fontWeight: on ? '700' : '400', color: on ? C.ink : C.sub }}>{t.label}</T>
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: PAD, paddingTop: 18, columnGap: 12, rowGap: 22 }}>
        {list.map((o) => {
          const items = itemsOf(s, o.itemIds);
          return (
            <Tap key={o.id} accessibilityLabel={o.name} onPress={() => onOpen(o)} style={{ width: '47.5%', gap: 8 }}>
              <OutfitBoard items={items} tryonUri={tryonFor(s, o.itemIds)} style={{ aspectRatio: 0.8 }} />
              <View style={{ gap: 2 }}>
                <T style={{ fontSize: 14, fontWeight: '500' }} numberOfLines={1}>
                  {o.name}
                </T>
                <T v="caption" numberOfLines={1}>
                  {[o.occasions.map((x) => OCCASION_LABEL[x] ?? x).join('、'), `穿过 ${wearCount(s, o)} 次`].filter(Boolean).join(' · ')}
                </T>
              </View>
            </Tap>
          );
        })}
      </View>
    </>
  );
}

function Calendar({ s }: { s: Snapshot }) {
  const app = useApp();
  const [ym, setYm] = useState({ y: s.today.getFullYear(), m: s.today.getMonth() });
  const [day, setDay] = useState(s.todayKey);
  const [pick, setPick] = useState(false);
  const cells = monthGrid(ym.y, ym.m);
  const logByDate = new Map(s.logs.map((l) => [l.date, l]));
  const monthPrefix = `${ym.y}-${String(ym.m + 1).padStart(2, '0')}`;
  const loggedDays = s.logs.filter((l) => l.date.startsWith(monthPrefix)).length;
  const isCurrentMonth = ym.y === s.today.getFullYear() && ym.m === s.today.getMonth();
  const selLog = logByDate.get(day) ?? null;
  const selDate = parseDateKey(day);
  const selLabel = `${selDate.getMonth() + 1} 月 ${selDate.getDate()} 日 · 星期${'日一二三四五六'[selDate.getDay()]}`;
  const future = day > s.todayKey;
  const shift = (d: number) => setYm(({ y, m }) => ({ y: m + d < 0 ? y - 1 : m + d > 11 ? y + 1 : y, m: (m + d + 12) % 12 }));
  const selOutfit = selLog?.outfitId ? s.outfits.find((o) => o.id === selLog.outfitId) : null;
  const candidates = s.outfits.filter((o) => o.itemIds.every((id) => s.byId.get(id)?.status === 'active'));

  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 18, paddingLeft: PAD, paddingRight: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
          <T v="h2">{MONTHS[ym.m]}</T>
          <T v="caption">
            {ym.y} · 记录了 {loggedDays} 天
          </T>
        </View>
        <View style={{ flexDirection: 'row' }}>
          <IconBtn name="back" label="上个月" size={16} onPress={() => shift(-1)} />
          <IconBtn name="forward" label="下个月" size={16} color={isCurrentMonth ? '#B5B5B8' : C.ink} onPress={() => !isCurrentMonth && shift(1)} />
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 4, paddingHorizontal: PAD, paddingTop: 10, paddingBottom: 6 }}>
        {DOWS.map((w) => (
          <T key={w} style={{ flex: 1, fontSize: 11, color: C.sub, textAlign: 'center' }}>
            {w}
          </T>
        ))}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: PAD, gap: 4 }}>
        {cells.map((c, i) => {
          if (!c.dateKey) return <View key={`b${i}`} style={{ width: '13.6%', height: 62 }} />;
          const log = logByDate.get(c.dateKey);
          const isFuture = c.dateKey > s.todayKey;
          const ring = c.dateKey === day ? C.ink : c.dateKey === s.todayKey ? C.muted : 'transparent';
          return (
            <Pressable
              key={c.dateKey}
              accessibilityRole="button"
              accessibilityLabel={`${ym.m + 1} 月 ${c.day} 日${log ? '，有记录' : ''}`}
              onPress={() => setDay(c.dateKey!)}
              style={{ width: '13.6%', height: 62, backgroundColor: log ? C.card : C.bg, borderWidth: 2, borderColor: ring }}
            >
              <T style={{ position: 'absolute', left: 3, top: 1, fontSize: 10, color: isFuture ? C.muted : C.ink, fontWeight: c.dateKey === s.todayKey ? '700' : '400', zIndex: 1 }}>{c.day}</T>
              {log ? <OutfitBoard items={itemsOf(s, log.itemIds)} tryonUri={tryonFor(s, log.itemIds)} compact style={{ position: 'absolute', left: 6, right: 6, top: 14, bottom: 2, backgroundColor: 'transparent' }} /> : null}
            </Pressable>
          );
        })}
      </View>
      <View style={{ marginTop: 18, marginHorizontal: PAD, padding: 16, backgroundColor: C.card, minHeight: 124, flexDirection: 'row', gap: 16, alignItems: 'center' }}>
        {selLog ? (
          <>
            <OutfitBoard items={itemsOf(s, selLog.itemIds)} tryonUri={tryonFor(s, selLog.itemIds)} compact style={{ width: 64, height: 92, backgroundColor: '#FFFFFF' }} />
            <View style={{ flex: 1, gap: 4 }}>
              <T v="caption">{selLabel}{selLog.source === 'mirror' ? ' · 镜子照片' : ''}</T>
              <T style={{ fontSize: 17, fontWeight: '700' }}>{selOutfit?.name ?? '当天的穿搭'}</T>
              <T v="caption" numberOfLines={2}>
                {itemsOf(s, selLog.itemIds).map((i) => i.name).join('、')}
              </T>
              <Tap
                onPress={async () => {
                  if (!(await confirmAsync('删除记录', `删除${selLabel}的穿着记录？穿着次数会相应减少。`))) return;
                  await undoWear(app, day);
                  app.refresh();
                }}
                style={{ alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' }}
              >
                <T style={{ fontSize: 12, color: C.sub, textDecorationLine: 'underline' }}>删除这条记录</T>
              </Tap>
            </View>
          </>
        ) : (
          <View style={{ flex: 1, gap: 10 }}>
            <T style={{ fontSize: 13, color: C.sub }}>{selLabel} · 这天没有记录</T>
            {!future && candidates.length > 0 ? <Btn label="补记这天穿了什么" kind="outline" height={40} style={{ alignSelf: 'flex-start' }} onPress={() => setPick(true)} /> : null}
          </View>
        )}
      </View>
      <Sheet visible={pick} onClose={() => setPick(false)} title={`${selLabel}穿了哪套？`}>
        <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 8 }}>
          {candidates.map((o) => (
            <Tap
              key={o.id}
              onPress={async () => {
                await recordWear(app, { date: day, itemIds: o.itemIds, outfitId: o.id, source: 'manual' });
                setPick(false);
                app.refresh();
              }}
              style={{ flexDirection: 'row', gap: 12, alignItems: 'center', minHeight: 64 }}
            >
              <OutfitBoard items={itemsOf(s, o.itemIds)} tryonUri={tryonFor(s, o.itemIds)} compact style={{ width: 46, height: 60 }} />
              <View style={{ flex: 1 }}>
                <T style={{ fontSize: 14, fontWeight: '500' }}>{o.name}</T>
                <T v="caption" numberOfLines={1}>
                  {itemsOf(s, o.itemIds).map((i) => i.name).join('、')}
                </T>
              </View>
              <Icon name="forward" size={16} color={C.sub} />
            </Tap>
          ))}
        </ScrollView>
      </Sheet>
    </>
  );
}

export default function OutfitsPage() {
  const s = useData(loadSnapshot);
  const [view, setView] = useState<'lib' | 'cal'>('lib');
  const [open, setOpen] = useState<Outfit | null>(null);
  if (!s) return <Loading />;
  return (
    <Screen>
      <PageHeader
        eyebrow="OUTFITS"
        title="穿搭"
        right={
          <Segmented
            options={[
              { id: 'lib', label: '搭配' },
              { id: 'cal', label: '日历' },
            ]}
            value={view}
            onChange={setView}
          />
        }
      />
      {view === 'lib' ? <Library s={s} onOpen={setOpen} /> : <Calendar s={s} />}
      <OutfitSheet s={s} outfit={open} onClose={() => setOpen(null)} />
    </Screen>
  );
}
