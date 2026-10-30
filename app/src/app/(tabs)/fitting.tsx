import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, FlatList, PanResponder, type PanResponderInstance, Pressable, ScrollView, SectionList, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { blockedRoute } from '@/ai/client';
import { getAiSettings, qualityFor } from '@/ai/config';
import { estimateImageCost, formatUsd } from '@/ai/models';
import { LAYER_ORDER, OCCASIONS, SLOTS } from '@/domain/catalog';
import { defaultOutfitName, selectionIds, toggleInSelection } from '@/domain/outfit';
import type { Item, Slot, TryonView } from '@/domain/types';
import { requestTryon, saveOutfit, tryonState } from '@/state/actions';
import { useRecordToday } from '@/state/recordToday';
import { avatarUsable } from '@/db/misc';
import { useApp, useData } from '@/state/app';
import { usePhotoConsent } from '@/state/consent';
import { itemsOf, loadSnapshot, tryonFor } from '@/state/snapshot';
import { Icon, type IconName } from '@/ui/Icon';
import { confirmAsync } from '@/ui/dialogs';
import { Btn, Chip, Loading, PageHeader, Screen, Sheet, T, Tap } from '@/ui/kit';
import { C, PAD, R } from '@/ui/theme';
import { ItemImage, OutfitBoard, Silhouette, Stage } from '@/ui/visuals';

/** Collapsed drawer: handle, one row of category pills, one row of 72×96 garments. */
const DRAWER_CLOSED = 176;
const ITEM_W = 72;
const ITEM_H = 96;
const BTN_RIGHT = 14;
const BTN_SIZE = 44;
const GRID_GAP = 10;

function NoAvatar({ onSkip }: { onSkip: () => void }) {
  return (
    <Screen>
      <PageHeader title="试衣间" />
      <View style={{ marginTop: 20, marginHorizontal: PAD, height: 300, borderRadius: R.card, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ position: 'absolute', top: 20, bottom: 20, width: 120, opacity: 0.5 }}>
          <Silhouette color="#C9C9CC" />
        </View>
        <View style={{ paddingHorizontal: 14, paddingVertical: 6, borderRadius: R.pill, backgroundColor: C.bg }}>
          <T style={{ fontSize: 13, fontWeight: '500' }}>这里会是你</T>
        </View>
      </View>
      <View style={{ paddingTop: 24, paddingHorizontal: PAD, gap: 6 }}>
        <T v="h2">先建立你的形象</T>
        <T v="body" style={{ color: C.sub }}>
          看衣服穿在你身上的样子
        </T>
      </View>
      <View style={{ paddingTop: 20, paddingHorizontal: PAD, gap: 10 }}>
        <Btn label="开始建立形象" height={52} onPress={() => router.push('/avatar')} />
        <Btn label="先不建，直接搭配" kind="ghost" height={44} onPress={onSkip} />
      </View>
    </Screen>
  );
}

function SaveSheet({ visible, onClose, items, onSaved }: { visible: boolean; onClose: () => void; items: Item[]; onSaved: (name: string) => void }) {
  const app = useApp();
  const [name, setName] = useState('');
  const [occ, setOcc] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const placeholder = defaultOutfitName(items);
  return (
    <Sheet visible={visible} onClose={onClose} title="保存这套穿搭">
      <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
        <OutfitBoard items={items} compact style={{ width: 72, height: 100 }} />
        <T v="small" style={{ flex: 1, color: C.sub }}>
          {items.length} 件
        </T>
      </View>
      <View style={{ gap: 6 }}>
        <T v="caption">名称</T>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder={placeholder}
          placeholderTextColor={C.faint}
          maxLength={20}
          style={{ height: 46, paddingHorizontal: 14, borderRadius: R.input, backgroundColor: C.card, fontSize: 15, color: C.ink }}
        />
      </View>
      <View style={{ gap: 8 }}>
        <T v="caption">场合（可多选）</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {OCCASIONS.map((o) => (
            <Chip key={o.id} label={o.label} on={occ.includes(o.id)} onPress={() => setOcc((x) => (x.includes(o.id) ? x.filter((y) => y !== o.id) : [...x, o.id]))} />
          ))}
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Btn label="取消" kind="outline" style={{ flex: 1 }} onPress={onClose} />
        <Btn
          label="保存"
          style={{ flex: 2 }}
          loading={busy}
          onPress={async () => {
            setBusy(true);
            try {
              const o = await saveOutfit(app, { name: name.trim() || placeholder, occasions: occ, itemIds: items.map((i) => i.id) });
              setName('');
              setOcc([]);
              onSaved(o.name);
            } finally {
              setBusy(false);
            }
          }}
        />
      </View>
    </Sheet>
  );
}

/**
 * Drag and snap for the garment drawer: two resting heights, closed (one row of garments) and open (the grid).
 * Only clearly vertical drags move it, so horizontal swipes still scroll the category pills and the garment row.
 */
class DrawerController {
  readonly y = new Animated.Value(10000);
  readonly pan: PanResponderInstance;
  private open = false;
  private travel = 0;

  constructor(private readonly onOpenChange: (open: boolean) => void) {
    const clamp = (dy: number) => Math.min(this.travel, Math.max(0, (this.open ? 0 : this.travel) + dy));
    this.pan = PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, g) => Math.abs(g.dy) > 8 && Math.abs(g.dy) > Math.abs(g.dx) * 1.5,
      onPanResponderMove: (_, g) => this.y.setValue(clamp(g.dy)),
      onPanResponderRelease: (_, g) => this.snap(g.vy < -0.4 ? true : g.vy > 0.4 ? false : clamp(g.dy) < this.travel / 2),
      onPanResponderTerminate: () => this.snap(this.open),
    });
  }

  /** travel = open height − closed height, known once the screen is measured. */
  layout(travel: number) {
    this.travel = travel;
    this.y.setValue(this.open ? 0 : travel);
  }

  snap(open: boolean) {
    this.open = open;
    this.onOpenChange(open);
    Animated.spring(this.y, { toValue: open ? 0 : this.travel, useNativeDriver: true, bounciness: 0, speed: 18 }).start();
  }
}

/** A round control floating over the stage (44pt, white with a soft shadow). */
function RoundBtn({ icon, label, onPress, disabled, busy }: { icon: IconName; label: string; onPress: () => void; disabled?: boolean; busy?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        width: BTN_SIZE,
        height: BTN_SIZE,
        borderRadius: R.pill,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.94)',
        boxShadow: '0 2px 8px rgba(17,17,17,0.10)',
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={C.ink} /> : <Icon name={icon} size={20} strokeWidth={1.8} />}
    </Pressable>
  );
}

/** A garment in the drawer: picture, black outline and a check when it is worn. */
function GarmentTile({ item, on, width, height, showName, onPress }: { item: Item; on: boolean; width: number; height: number; showName?: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={item.name} accessibilityState={{ selected: on }} onPress={onPress} style={{ width, gap: 5 }}>
      <View style={{ width, height, borderRadius: R.tile, borderWidth: 2, borderColor: on ? C.ink : 'transparent' }}>
        <ItemImage item={item} style={{ flex: 1, borderRadius: R.tile - 2 }} />
        {on ? (
          <View style={{ position: 'absolute', left: 4, top: 4, width: 20, height: 20, borderRadius: R.pill, backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="check" size={12} color="#FFFFFF" strokeWidth={2.4} />
          </View>
        ) : null}
      </View>
      {showName ? (
        <T style={{ fontSize: 11, textAlign: 'center', color: on ? C.ink : C.sub }} numberOfLines={1}>
          {item.name}
        </T>
      ) : null}
    </Pressable>
  );
}

function AddTile({ width, height }: { width: number; height: number }) {
  return (
    <Tap
      accessibilityLabel="录入衣服"
      onPress={() => router.push('/capture')}
      style={{ width, height, borderRadius: R.tile, borderWidth: 1, borderStyle: 'dashed', borderColor: C.muted, alignItems: 'center', justifyContent: 'center', gap: 4 }}
    >
      <Icon name="plus" size={18} color={C.faint} />
      <T style={{ fontSize: 11, color: C.sub }}>录入</T>
    </Tap>
  );
}

/** Expanded drawer: a three-column grid with one small heading per subcategory (羽绒服 2, 夹克 1 …). */
function groupBySubcategory(list: Item[]): { title: string; count: number; data: Item[][] }[] {
  const groups = new Map<string, Item[]>();
  for (const it of list) {
    const k = it.subcategory?.trim() || '其他';
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  return [...groups.entries()]
    .sort(([a, x], [b, y]) => (a === '其他' ? 1 : b === '其他' ? -1 : y.length - x.length))
    .map(([title, items]) => ({ title, count: items.length, data: Array.from({ length: Math.ceil(items.length / 3) }, (_, i) => items.slice(i * 3, i * 3 + 3)) }));
}

export default function FittingPage() {
  const app = useApp();
  const consent = usePhotoConsent();
  const recordToday = useRecordToday();
  const insets = useSafeAreaInsets();
  const { width: W } = useWindowDimensions();
  const s = useData(loadSnapshot);
  const settings = useData(getAiSettings);
  const [catChoice, setCat] = useState<Slot | null>(null);
  const [view, setView] = useState<TryonView>('front');
  const [skipIntro, setSkipIntro] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [height, setHeight] = useState(0);
  const [open, setOpen] = useState(false);
  const sel = app.fitting;
  // Drop garments that were deleted, archived or moved to another category since they were put on; lookups and
  // requests use the same list.
  const worn = s ? itemsOf(s, selectionIds(sel)).filter((i) => i.status === 'active' && sel[i.slot] === i.id) : [];
  const wornIds = worn.map((i) => i.id);
  const drawable = worn.filter((i) => i.catalogUri || i.originalUri);
  const drawableIds = drawable.map((i) => i.id);
  const key = drawableIds.join(',');
  const tryon = useData((db) => tryonState(db, drawableIds, view), [key, view]);

  // The drawer is as tall as when open and slides down so only its collapsed part shows.
  const openHeight = Math.max(DRAWER_CLOSED + 120, Math.round(height * 0.7));
  const [drawer] = useState(() => new DrawerController(setOpen));
  useEffect(() => {
    if (height > 0) drawer.layout(openHeight - DRAWER_CLOSED);
  }, [drawer, height, openHeight]);

  if (!s) return <Loading />;
  // Someone arriving with garments already chosen ("去试穿") goes straight to the room, and stays there.
  if (worn.length > 0 && !skipIntro) setSkipIntro(true);
  if (s.avatar.status === 'none' && !skipIntro && worn.length === 0) return <NoAvatar onSkip={() => setSkipIntro(true)} />;

  const avatarReady = avatarUsable(s.avatar);
  const remaking = s.avatar.status === 'processing';
  const avatarUri = view === 'back' ? s.avatar.backUri : s.avatar.frontUri;
  const busy = tryon?.status === 'queued';
  const tq = qualityFor(settings?.quality ?? 'standard', 'tryon');
  const frontCost = estimateImageCost(null, { inputImages: drawable.length + 1, quality: tq });
  // The back view is drawn from the front one, which is generated first if it does not exist yet.
  const cost = view === 'front' ? frontCost : estimateImageCost(null, { inputImages: 2, quality: tq }) + (tryonFor(s, drawableIds) ? 0 : frontCost);
  const usedSlots = new Set(s.active.map((i) => i.slot));
  const cats = SLOTS.filter((x) => x.id !== 'accessory' || usedSlots.has('accessory'));
  // Open on the category of what was just put on, else the first one that has clothes.
  const cat: Slot = catChoice ?? worn[worn.length - 1]?.slot ?? cats.find((c) => usedSlots.has(c.id))?.id ?? 'outer';
  const list = s.active.filter((i) => i.slot === cat);
  const pick = (it: Item) => app.setFitting(toggleInSelection(sel, it));
  const canTryon = avatarReady && !remaking && drawable.length > 0;

  const top = insets.top + 14;
  const controlsTop = top + 52;
  const stageBottom = DRAWER_CLOSED - 20;
  const tileW = Math.floor((W - 2 * PAD - 2 * GRID_GAP) / 3);

  const wearToday = async () => {
    if (!(await recordToday({ itemIds: wornIds, source: 'manual' }))) return;
    app.toast('已记录今天的穿搭，穿着次数 +1');
    router.navigate('/');
  };
  const generate = async () => {
    const again = !!tryon?.uri;
    if (!(await confirmAsync(again ? '重新生成上身效果？' : '生成上身效果？', `约 ${formatUsd(cost)}，由你的 AI 账户按量计费。`, '生成'))) return;
    if (!(await consent())) return;
    await requestTryon(app, drawableIds, view);
    app.refresh();
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.card }} onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
      <Stage
        avatarUri={avatarReady ? avatarUri : null}
        items={worn}
        tryonUri={tryon?.uri ?? null}
        cardArea={{ top: controlsTop, right: BTN_RIGHT + BTN_SIZE + 8, bottom: 84 }}
        style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: stageBottom, borderRadius: 0 }}
      />

      <View style={{ position: 'absolute', left: PAD, right: PAD, top, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T v="h1" accessibilityRole="header">
          试衣间
        </T>
        <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: R.pill, backgroundColor: 'rgba(255,255,255,0.9)' }}>
          <T style={{ fontSize: 12, color: C.sub }}>
            已穿 {worn.length} 件{view === 'back' ? ' · 背面' : ''}
          </T>
        </View>
      </View>

      {/* Status under the title, left of the button column. */}
      <View style={{ position: 'absolute', left: PAD, top: controlsTop, right: BTN_RIGHT + BTN_SIZE + 76, gap: 6, alignItems: 'flex-start' }}>
        {remaking ? <Badge text="形象生成中…" spinner /> : busy && s.blocked ? <Badge text="AI 已暂停 · 去处理" onPress={() => router.push(blockedRoute(s.blocked))} /> : busy ? <Badge text="正在生成上身效果" spinner /> : null}
        {tryon?.status === 'failed' && tryon.error && !busy ? <Badge text={tryon.error} danger /> : null}
      </View>

      <View style={{ position: 'absolute', right: BTN_RIGHT, top: controlsTop, gap: 10 }}>
        <RoundBtn icon="turn" label={view === 'front' ? '转到背面' : '转到正面'} disabled={!avatarReady} onPress={() => setView((v) => (v === 'front' ? 'back' : 'front'))} />
        <RoundBtn
          icon={tryon?.uri ? 'refresh' : 'sparkle'}
          label={`${tryon?.uri ? '重新生成上身效果' : '生成上身效果'} · 约 ${formatUsd(cost)}`}
          disabled={!canTryon}
          busy={busy && canTryon}
          onPress={generate}
        />
        <RoundBtn icon="bookmark" label="保存穿搭" disabled={worn.length === 0} onPress={() => setSaveOpen(true)} />
        <RoundBtn icon="camera" label="生成大片" disabled={drawable.length === 0 || !avatarReady} onPress={() => router.push(`/photo?items=${drawableIds.join(',')}`)} />
      </View>

      {!open && worn.length > 0 ? (
        <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: DRAWER_CLOSED + 14, alignItems: 'center' }}>
          <Btn label="今天穿这套" icon="check" height={44} style={{ paddingHorizontal: 18 }} onPress={wearToday} />
        </View>
      ) : null}

      {/* Tapping the stage while the drawer is open puts it back down. */}
      {open ? <Pressable accessibilityLabel="收起" onPress={() => drawer.snap(false)} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: openHeight }} /> : null}

      {height > 0 ? (
        <Animated.View
          accessibilityLabel="选衣服"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: openHeight,
            transform: [{ translateY: drawer.y }],
            backgroundColor: C.bg,
            borderTopLeftRadius: R.sheet,
            borderTopRightRadius: R.sheet,
            boxShadow: '0 -6px 24px rgba(17,17,17,0.08)',
          }}
        >
          <View {...drawer.pan.panHandlers}>
            <Pressable accessibilityRole="button" accessibilityLabel={open ? '收起衣服列表' : '展开衣服列表'} onPress={() => drawer.snap(!open)} style={{ height: 20, alignItems: 'center', justifyContent: 'center' }}>
              <View style={{ width: 40, height: 4, borderRadius: R.pill, backgroundColor: '#D4D4D7' }} />
            </Pressable>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: PAD, gap: 8 }}>
              {cats.map((c) => {
                const on = c.id === cat;
                // From worn, not sel: a garment moved to another category no longer counts here.
                const has = worn.some((i) => i.slot === c.id);
                return (
                  <Pressable
                    key={c.id}
                    accessibilityRole="tab"
                    accessibilityLabel={has ? `${c.label}，已穿` : c.label}
                    accessibilityState={{ selected: on }}
                    onPress={() => setCat(c.id)}
                    hitSlop={{ top: 4, bottom: 4 }}
                    style={{ height: 36, paddingHorizontal: 14, borderRadius: R.pill, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: on ? C.ink : C.card }}
                  >
                    <Text style={{ fontSize: 13, color: on ? '#FFFFFF' : C.sub, fontWeight: on ? '500' : '400' }}>{c.label}</Text>
                    {has ? <View style={{ width: 5, height: 5, borderRadius: R.pill, backgroundColor: on ? '#FFFFFF' : C.ink }} /> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
          {open ? (
            <SectionList
              style={{ flex: 1, marginTop: 4 }}
              contentContainerStyle={{ paddingHorizontal: PAD, paddingBottom: 16 }}
              sections={groupBySubcategory(list)}
              keyExtractor={(row) => row[0].id}
              stickySectionHeadersEnabled={false}
              initialNumToRender={4}
              renderSectionHeader={({ section }) => (
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, paddingTop: 12, paddingBottom: 8 }}>
                  <T style={{ fontSize: 13, fontWeight: '600' }}>{section.title}</T>
                  <T style={{ fontSize: 12, color: C.sub }}>{section.count}</T>
                </View>
              )}
              renderItem={({ item: row }) => (
                <View style={{ flexDirection: 'row', gap: GRID_GAP, marginBottom: GRID_GAP }}>
                  {row.map((it) => (
                    <GarmentTile key={it.id} item={it} on={sel[cat] === it.id} width={tileW} height={Math.round((tileW * 4) / 3)} showName onPress={() => pick(it)} />
                  ))}
                </View>
              )}
              ListEmptyComponent={
                <View style={{ paddingTop: 16, gap: 12, alignItems: 'flex-start' }}>
                  <T v="small" style={{ color: C.sub }}>
                    还没有这类衣服
                  </T>
                  <AddTile width={tileW} height={Math.round((tileW * 4) / 3)} />
                </View>
              }
            />
          ) : (
            <View {...drawer.pan.panHandlers}>
              <FlatList
                horizontal
                style={{ marginTop: 8 }}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: PAD, gap: GRID_GAP }}
                data={list}
                keyExtractor={(it) => it.id}
                initialNumToRender={6}
                windowSize={5}
                renderItem={({ item: it }) => <GarmentTile item={it} on={sel[cat] === it.id} width={ITEM_W} height={ITEM_H} onPress={() => pick(it)} />}
                ListEmptyComponent={<AddTile width={ITEM_W} height={ITEM_H} />}
              />
            </View>
          )}
        </Animated.View>
      ) : null}

      <SaveSheet
        visible={saveOpen}
        onClose={() => setSaveOpen(false)}
        items={[...worn].sort((a, b) => LAYER_ORDER.indexOf(b.slot) - LAYER_ORDER.indexOf(a.slot))}
        onSaved={(name) => {
          setSaveOpen(false);
          app.refresh();
          app.toast(`已保存穿搭「${name}」`);
        }}
      />
    </View>
  );
}

function Badge({ text, spinner, danger, onPress }: { text: string; spinner?: boolean; danger?: boolean; onPress?: () => void }) {
  const inner = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: R.pill, backgroundColor: danger ? 'rgba(255,255,255,0.94)' : C.scrim }}>
      {spinner ? <ActivityIndicator size="small" color="#FFFFFF" /> : null}
      <Text style={{ fontSize: 11, color: danger ? C.danger : '#FFFFFF', flexShrink: 1 }} numberOfLines={2}>
        {text}
      </Text>
    </View>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {inner}
    </Pressable>
  ) : (
    inner
  );
}
