import { router } from 'expo-router';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import { type NativeScrollEvent, type NativeSyntheticEvent, ScrollView, type ScrollViewInstance, View } from 'react-native';
import { AiError, type AiErrorKind, blockedRoute, describeAiError } from '@/ai/client';
import { todaySuggestions } from '@/domain/outfit';
import { currentDateKey, dateParts, idleItems, weekOf } from '@/domain/stats';
import type { Item } from '@/domain/types';
import { undoWear } from '@/state/actions';
import { useRecordToday } from '@/state/recordToday';
import { confirmAsync } from '@/ui/dialogs';
import { useApp, useData } from '@/state/app';
import { itemsOf, loadSnapshot, type Snapshot, tryonFor } from '@/state/snapshot';
import { Icon } from '@/ui/Icon';
import { Banner, Btn, Loading, Screen, T, Tap } from '@/ui/kit';
import { C, PAD, R } from '@/ui/theme';
import { ItemImage, OutfitBoard } from '@/ui/visuals';

const CARD_W = 250;
const CARD_GAP = 12;

interface Card {
  key: string;
  outfitId: string | null;
  name: string;
  items: Item[];
  badge: string | null;
}

const MAX_CARDS = 10;

function buildCards(s: Snapshot): Card[] {
  const activeIds = new Set(s.active.map((i) => i.id));
  const cards: Card[] = todaySuggestions(s.outfits, s.logs, activeIds, s.today).map((sg) => ({
    key: sg.outfit.id,
    outfitId: sg.outfit.id,
    name: sg.outfit.name,
    items: itemsOf(s, sg.outfit.itemIds),
    badge: sg.badge,
  }));
  // Whatever was logged today goes first, even if it was not a saved outfit.
  if (s.todayLog) {
    const i = cards.findIndex((c) => c.outfitId && c.outfitId === s.todayLog!.outfitId);
    if (i > 0) cards.unshift(...cards.splice(i, 1));
    if (i < 0) cards.unshift({ key: 'today', outfitId: null, name: '今天的穿搭', items: itemsOf(s, s.todayLog.itemIds), badge: null });
  }
  // The longest-unworn few are suggestion enough; the full library is on the Outfits tab.
  return cards.slice(0, MAX_CARDS);
}

function DateHeader({ s }: { s: Snapshot }) {
  const d = dateParts(s.today);
  const week = weekOf(s.today, new Set(s.logs.map((l) => l.date)));
  return (
    <>
      <View style={{ paddingTop: 30, paddingHorizontal: PAD, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 12 }}>
          <T v="display">{d.day}</T>
          <View style={{ gap: 4, paddingBottom: 4 }}>
            <T style={{ fontSize: 11, letterSpacing: 2.6, color: C.sub }}>{d.monthEn}</T>
            <T style={{ fontSize: 16, fontWeight: '500' }}>
              {d.monthCn} · {d.weekdayCn}
            </T>
          </View>
        </View>
        <T v="caption" style={{ paddingBottom: 4 }}>
          本周 {week.filter((w) => w.logged).length} / 7
        </T>
      </View>
      <View style={{ flexDirection: 'row', gap: 4, paddingTop: 18, paddingHorizontal: PAD }} accessibilityLabel={`本周已记录 ${week.filter((w) => w.logged).length} 天`}>
        {week.map((w) => (
          <View key={w.dateKey} style={{ flex: 1, gap: 6 }}>
            <View style={{ height: 4, borderRadius: R.pill, backgroundColor: w.logged ? C.ink : w.isToday ? C.faint : C.line }} />
            <T style={{ fontSize: 11, color: w.isToday ? C.ink : C.sub, fontWeight: w.isToday ? '700' : '400' }}>{w.label}</T>
          </View>
        ))}
      </View>
    </>
  );
}

function StatusBanners({ s }: { s: Snapshot }) {
  const banners = [];
  if (s.blocked) {
    banners.push(
      <Banner key="blocked" tone="warn" title="AI 已暂停" sub={describeAiError(new AiError(s.blocked as AiErrorKind, ''))} onPress={() => router.push(blockedRoute(s.blocked))} />,
    );
  }
  if (s.review.length > 0) {
    banners.push(
      <Banner
        key="review"
        title={`${s.review.length} 件新衣服待确认`}
        onPress={() => router.push('/review')}
        left={
          <View style={{ flexDirection: 'row' }}>
            {s.review.slice(0, 3).map((it, i) => (
              <ItemImage key={it.id} item={it} style={{ width: 39, height: 52, borderRadius: R.small, backgroundColor: '#FFFFFF', marginLeft: i ? -10 : 0, borderWidth: i ? 2 : 0, borderColor: C.card }} />
            ))}
          </View>
        }
      />,
    );
  }
  if (s.processing.length > 0 && !s.blocked) {
    banners.push(<Banner key="proc" title={`${s.processing.length} 件衣服正在生成标准图`} onPress={() => router.push('/review')} />);
  }
  if (s.failed.length > 0) {
    banners.push(<Banner key="failed" tone="warn" title={`${s.failed.length} 件衣服生成失败`} sub="去衣橱里重试" onPress={() => router.push('/wardrobe')} />);
  }
  if (banners.length === 0) return null;
  return <View style={{ gap: 8, marginTop: 20 }}>{banners}</View>;
}

function Step({ n, title, sub, onPress, dim, children }: { n: string; title: string; sub: string; onPress?: () => void; dim?: boolean; children?: ReactNode }) {
  const body = (
    <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
      <T style={{ fontSize: 12, fontWeight: '700', color: dim ? C.faint : C.ink }}>{n}</T>
      <View style={{ flex: 1, gap: 2 }}>
        <T style={{ fontSize: 17, fontWeight: '600', color: dim ? C.faint : C.ink }}>{title}</T>
        <T v="small" style={{ color: dim ? C.faint : C.sub }}>
          {sub}
        </T>
      </View>
      {onPress ? <Icon name="forward" size={18} color={dim ? C.faint : C.ink} /> : null}
    </View>
  );
  return (
    <View style={{ paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: C.line, gap: 14 }}>
      {onPress ? <Tap onPress={onPress}>{body}</Tap> : body}
      {children}
    </View>
  );
}

function Onboarding({ s }: { s: Snapshot }) {
  const hasItems = s.items.length > 0;
  const avatarDone = s.avatar.status === 'ready';
  return (
    <>
      <View style={{ paddingTop: 28, paddingHorizontal: PAD }}>
        <T v="h2" style={{ fontSize: 24, lineHeight: 34 }}>
          {hasItems ? '衣服正在进衣橱。\n再搭一套就能开始了。' : '欢迎。\n先把衣柜搬进来吧。'}
        </T>
      </View>
      <View style={{ marginTop: 18, marginHorizontal: PAD }}>
        {!s.hasKey ? <Step n="00" title="填写 OpenAI API Key" sub="录入一件约 $0.01" onPress={() => router.push('/apikey')} /> : null}
        <Step n="01" title={`录入衣服${hasItems ? ` · 已录入 ${s.items.length} 件` : ''}`} sub="可从相册批量导入">
          <View style={{ paddingLeft: 30, gap: 8 }}>
            <Btn label="从相册批量导入" onPress={() => router.push('/capture?mode=batch')} />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Btn label="一件一件拍" kind="outline" height={44} style={{ flex: 1 }} onPress={() => router.push('/capture')} />
              <Btn label="从 Excel 导入" kind="outline" height={44} style={{ flex: 1 }} onPress={() => router.push('/me')} />
            </View>
          </View>
        </Step>
        <Step
          n="02"
          title={avatarDone ? '形象已建立' : s.avatar.status === 'processing' ? '形象生成中…' : '建立你的形象'}
          sub="3 张全身照"
          onPress={() => router.push('/avatar')}
        />
        <Step n="03" title="搭第一套" sub="在试衣间挑好衣服保存" dim={!hasItems} onPress={() => router.push('/fitting')} />
      </View>
    </>
  );
}

export default function TodayPage() {
  const app = useApp();
  const recordToday = useRecordToday();
  const s = useData(loadSnapshot);
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const scroller = useRef<ScrollViewInstance>(null);
  const cards = useMemo(() => (s ? buildCards(s) : []), [s]);

  if (!s) return <Loading />;

  const onboarding = cards.length === 0;
  const cur = cards[Math.min(idx, cards.length - 1)];
  const loggedThis = !!s.todayLog && !!cur && (cur.key === 'today' || (cur.outfitId !== null && cur.outfitId === s.todayLog.outfitId));
  const idle = idleItems(s.active, s.stats, s.prefs.idleDays, 3);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / (CARD_W + CARD_GAP));
    if (i !== idx) setIdx(Math.max(0, Math.min(cards.length - 1, i)));
  };

  const primary = async () => {
    if (!cur) return;
    setBusy(true);
    try {
      if (loggedThis) {
        if (s.todayLog?.photoUri && !(await confirmAsync('撤销今天的记录？', '这条记录带有镜子照片，撤销后照片会删除。', '撤销'))) return;
        await undoWear(app, currentDateKey());
        app.toast('已撤销今天的记录');
      } else {
        if (!(await recordToday({ itemIds: cur.items.map((i) => i.id), outfitId: cur.outfitId, source: 'outfit' }))) return;
        app.toast(`已记录：${cur.name}，穿着次数 +1`);
      }
      // The logged card moves to the front; follow it so the button state matches what is on screen.
      setIdx(0);
      scroller.current?.scrollTo({ x: 0, animated: true });
      app.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <DateHeader s={s} />
      <StatusBanners s={s} />
      {onboarding ? (
        <Onboarding s={s} />
      ) : (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingTop: 26, paddingBottom: 12, paddingHorizontal: PAD }}>
            <T v="h2" style={{ fontSize: 20 }} accessibilityRole="header">
              {s.todayLog ? '今天穿了这套' : '今天穿哪套？'}
            </T>
            <T v="caption">
              {Math.min(idx, cards.length - 1) + 1} / {cards.length}
            </T>
          </View>
          <ScrollView
            ref={scroller}
            horizontal
            showsHorizontalScrollIndicator={false}
            snapToInterval={CARD_W + CARD_GAP}
            decelerationRate="fast"
            onScroll={onScroll}
            scrollEventThrottle={32}
            contentContainerStyle={{ paddingHorizontal: PAD, gap: CARD_GAP }}
          >
            {cards.map((c, i) => {
              const isLogged = !!s.todayLog && (c.key === 'today' || (c.outfitId !== null && c.outfitId === s.todayLog.outfitId));
              return (
                <Tap
                  key={c.key}
                  accessibilityLabel={c.name}
                  onPress={() => {
                    setIdx(i);
                    scroller.current?.scrollTo({ x: i * (CARD_W + CARD_GAP), animated: true });
                  }}
                  style={{ width: CARD_W, height: 316, borderRadius: R.card, overflow: 'hidden', backgroundColor: C.card, opacity: i === idx ? 1 : 0.55 }}
                >
                  <OutfitBoard items={c.items} tryonUri={tryonFor(s, c.items.map((x) => x.id))} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 64, borderRadius: 0 }} />
                  {c.badge ? (
                    <T style={{ position: 'absolute', left: 12, top: 12, fontSize: 11, color: C.sub, backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: R.pill, overflow: 'hidden', paddingHorizontal: 8, paddingVertical: 2 }}>{c.badge}</T>
                  ) : null}
                  {isLogged ? (
                    <View style={{ position: 'absolute', right: 12, top: 12, paddingHorizontal: 10, paddingVertical: 3, borderRadius: R.pill, backgroundColor: C.ink }}>
                      <T style={{ color: '#FFFFFF', fontSize: 11 }}>今天 ✓</T>
                    </View>
                  ) : null}
                  <View style={{ position: 'absolute', left: 14, right: 14, bottom: 14, gap: 3 }}>
                    <T style={{ fontSize: 16, fontWeight: '700' }} numberOfLines={1}>
                      {c.name}
                    </T>
                    <T v="caption" numberOfLines={1}>
                      {c.items.length} 件
                    </T>
                  </View>
                </Tap>
              );
            })}
          </ScrollView>
          <View style={{ flexDirection: 'row', gap: 10, paddingTop: 14, paddingHorizontal: PAD }}>
            <Tap
              accessibilityLabel="拍镜子照记录"
              onPress={() => router.push('/mirror')}
              style={{ width: 52, height: 52, borderRadius: R.card, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name="camera" size={22} strokeWidth={1.6} />
            </Tap>
            <Btn label={loggedThis ? '已记录 · 撤销' : '就穿这套'} kind={loggedThis ? 'outline' : 'primary'} height={52} style={{ flex: 1 }} loading={busy} onPress={primary} />
          </View>
          <Tap onPress={() => router.push('/fitting')} style={{ marginTop: 6, marginHorizontal: PAD, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <T style={{ fontSize: 13, color: C.sub }}>去试衣间搭一套</T>
            <Icon name="forward" size={14} color={C.sub} strokeWidth={1.8} />
          </Tap>
        </>
      )}
      {idle.length > 0 ? (
        <View style={{ paddingTop: 22, paddingHorizontal: PAD, gap: 12 }}>
          <T v="title">好久没穿了</T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {idle.map(({ item, days }) => (
              <Tap key={item.id} onPress={() => router.push(`/item/${item.id}`)} style={{ flex: 1, gap: 6 }}>
                <ItemImage item={item} style={{ aspectRatio: 0.75 }} />
                <T style={{ fontSize: 13, fontWeight: '500' }} numberOfLines={1}>
                  {item.name}
                </T>
                <T style={{ fontSize: 11, color: C.sub }}>{days} 天没穿</T>
              </Tap>
            ))}
            {Array.from({ length: 3 - idle.length }, (_, i) => (
              <View key={`pad${i}`} style={{ flex: 1 }} />
            ))}
          </View>
        </View>
      ) : null}
    </Screen>
  );
}
