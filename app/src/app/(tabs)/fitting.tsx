import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, type LayoutChangeEvent, Pressable, SectionList, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { FlatList, GestureDetector, ScrollView, usePanGesture } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { blockedRoute } from '@/ai/client';
import { estimateFor } from '@/ai/catalog';
import { DEFAULT_AI_SETTINGS, getAiSettings, tryonQuality } from '@/ai/config';
import { addCosts, formatEstimate } from '@/ai/models';
import { LAYER_ORDER, OCCASIONS, SLOT_LABEL, SLOTS } from '@/domain/catalog';
import { isUpper, layersOf, type Look, MAX_ACCESSORIES, MAX_LAYERS, moveLayer, replaceWith, setStyling, type Styling, takeOff, wear } from '@/domain/look';
import { customMakeup, isCustomMakeup, makeupLabel, MAKEUPS } from '@/domain/makeup';
import { defaultOutfitName } from '@/domain/outfit';
import type { Item, Slot, TryonView } from '@/domain/types';
import { avatarUsable, avatarVersion, listLayers } from '@/db/misc';
import { ensureLayers, requestTryon, saveOutfit, type TryonOptions, tryonState } from '@/state/actions';
import { useApp, useData } from '@/state/app';
import { usePhotoConsent } from '@/state/consent';
import { useRecordToday } from '@/state/recordToday';
import { loadSnapshot, tryonFor } from '@/state/snapshot';
import { Icon, type IconName } from '@/ui/Icon';
import { Btn, Chip, Loading, Sheet, T, Tap } from '@/ui/kit';
import { TryonSheet } from '@/ui/RegenerateSheet';
import { C, PAD, R } from '@/ui/theme';
import { layersFor } from '@/domain/layers';
import { ItemImage, OutfitBoard, Stage } from '@/ui/visuals';

/** Collapsed drawer: handle, one row of tabs, one row of garments. */
const DRAWER_CLOSED = 188;
const ROW_W = 72;
const ROW_H = 92;
const BTN = 44;
const BTN_RIGHT = 14;
const GRID_GAP = 10;
/** Height of one row in the layer-order list, for dragging rows. */
const LAYER_ROW = 68;

type Tab = 'worn' | Slot;

function SaveSheet({ visible, onClose, look, items, onSaved }: { visible: boolean; onClose: () => void; look: Look; items: Item[]; onSaved: (name: string) => void }) {
  const app = useApp();
  const [name, setName] = useState('');
  const [occ, setOcc] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const placeholder = defaultOutfitName(items);
  return (
    <Sheet visible={visible} onClose={onClose} title="保存这套穿搭">
      <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
        <OutfitBoard items={[...items].sort((a, b) => LAYER_ORDER.indexOf(b.slot) - LAYER_ORDER.indexOf(a.slot))} compact style={{ width: 72, height: 100 }} />
        <T v="small" style={{ flex: 1, color: C.sub }}>
          {items.length} 件{look.makeup ? ` · ${makeupLabel(look.makeup)}` : ''}
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
              const o = await saveOutfit(app, { name: name.trim() || placeholder, occasions: occ, itemIds: look.ids, styling: look.styling, makeup: look.makeup });
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

/** Makeup for the figure: a preset, the user's own words, or none. It is drawn when the try-on is generated. */
function MakeupSheet({ visible, onClose, value, onChange }: { visible: boolean; onClose: () => void; value: string | undefined; onChange: (m: string | undefined) => void }) {
  const [words, setWords] = useState(value && isCustomMakeup(value) ? makeupLabel(value) : '');
  const choose = (m: string | undefined) => {
    onChange(m);
    onClose();
  };
  const tile = (key: string, label: string, on: boolean, swatch: string | null, onPress: () => void) => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={{ flexBasis: '31%', height: 64, borderRadius: R.tile, borderWidth: 2, borderColor: on ? C.ink : 'transparent', backgroundColor: C.card, alignItems: 'center', justifyContent: 'center', gap: 6 }}
    >
      <View style={{ width: 18, height: 18, borderRadius: R.pill, backgroundColor: swatch ?? 'transparent', borderWidth: swatch ? 0 : 1.5, borderStyle: 'dashed', borderColor: C.faint }} />
      <Text style={{ fontSize: 13, color: C.ink, fontWeight: on ? '600' : '400' }}>{label}</Text>
    </Pressable>
  );
  return (
    <Sheet visible={visible} onClose={onClose} title="妆容">
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {tile('none', '不化妆', !value, null, () => choose(undefined))}
        {MAKEUPS.map((m) => tile(m.id, m.label, value === m.id, m.swatch, () => choose(m.id)))}
      </View>
      <View style={{ gap: 8 }}>
        <T v="caption">或者自己描述</T>
        <TextInput
          value={words}
          onChangeText={setWords}
          placeholder="例如：橘色腮红、棕色眼线、裸色唇"
          placeholderTextColor={C.faint}
          maxLength={80}
          style={{ height: 46, paddingHorizontal: 14, borderRadius: R.input, backgroundColor: C.card, fontSize: 15, color: C.ink }}
        />
        <Btn label="用这个妆容" kind="outline" disabled={!words.trim()} onPress={() => choose(customMakeup(words))} />
      </View>
      <T v="small" style={{ color: C.sub }}>
        选好后点右侧的生成按钮。妆容只画在正面；画完会检查还像不像你，不像会自动重画一次（再收一次费）。
      </T>
    </Sheet>
  );
}

/** Drag and snap for the garment drawer: closed (one row) or open (grid / layer order). */
class DrawerDrag {
  /** 0 = open, travel = closed. */
  readonly y = new Animated.Value(10000);
  private open = false;
  private travel = 0;
  private from = 0;

  constructor(private readonly onOpenChange: (open: boolean) => void) {}

  /** travel = open height − closed height, known once the screen is measured. */
  layout(travel: number) {
    this.travel = travel;
    this.y.setValue(this.open ? 0 : travel);
  }

  begin() {
    this.from = this.open ? 0 : this.travel;
  }

  move(dy: number) {
    this.y.setValue(Math.min(this.travel, Math.max(0, this.from + dy)));
  }

  end(dy: number, vy: number) {
    const at = Math.min(this.travel, Math.max(0, this.from + dy));
    this.snap(vy < -500 ? true : vy > 500 ? false : at < this.travel / 2);
  }

  snap(open: boolean) {
    this.open = open;
    this.onOpenChange(open);
    Animated.spring(this.y, { toValue: open ? 0 : this.travel, useNativeDriver: true, bounciness: 0, speed: 18 }).start();
  }
}

/** A round control floating over the figure. */
function RoundBtn({ icon, label, onPress, disabled, busy, active }: { icon: IconName; label: string; onPress: () => void; disabled?: boolean; busy?: boolean; active?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy, selected: !!active }}
      disabled={disabled || busy}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        width: BTN,
        height: BTN,
        borderRadius: R.pill,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: active ? C.ink : 'rgba(255,255,255,0.94)',
        boxShadow: '0 2px 8px rgba(17,17,17,0.10)',
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={C.ink} /> : <Icon name={icon} size={20} strokeWidth={1.8} color={active ? '#FFFFFF' : C.ink} />}
    </Pressable>
  );
}

function Badge({ text, spinner, danger, onPress }: { text: string; spinner?: boolean; danger?: boolean; onPress?: () => void }) {
  const inner = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: R.pill, backgroundColor: danger ? 'rgba(255,255,255,0.96)' : C.scrim }}>
      {spinner ? <ActivityIndicator size="small" color="#FFFFFF" /> : null}
      <Text style={{ fontSize: 12, color: danger ? C.danger : '#FFFFFF', flexShrink: 1 }} numberOfLines={2}>
        {text}
      </Text>
      {onPress ? <Icon name="forward" size={14} color="#FFFFFF" strokeWidth={2} /> : null}
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

/** Upper-body layer number (1 = innermost) or a check, on a garment that is on. */
function Mark({ n }: { n: number | null }) {
  return (
    <View style={{ position: 'absolute', left: 5, top: 5, width: 20, height: 20, borderRadius: R.pill, backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center' }}>
      {n ? <Text style={{ color: '#FFFFFF', fontSize: 11, fontWeight: '700' }}>{n}</Text> : <Icon name="check" size={12} color="#FFFFFF" strokeWidth={2.4} />}
    </View>
  );
}

/** A garment to pick: black outline and its layer number or a check when it is on. */
function GarmentTile({ item, on, layer, width, height, showName, onPress }: { item: Item; on: boolean; layer: number | null; width: number; height: number; showName?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={on && layer ? `${item.name}，第 ${layer} 层` : item.name}
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={{ width, gap: 5 }}
    >
      <View style={{ width, height, borderRadius: R.tile, borderWidth: 2, borderColor: on ? C.ink : 'transparent' }}>
        <ItemImage item={item} style={{ flex: 1, borderRadius: R.tile - 2 }} />
        {on ? <Mark n={layer} /> : null}
      </View>
      {showName ? (
        <T style={{ fontSize: 11, textAlign: 'center', color: on ? C.ink : C.sub }} numberOfLines={1}>
          {item.name}
        </T>
      ) : null}
    </Pressable>
  );
}

/** Something that is on, in the 已穿 row: its layer number and a × to take it off. */
function WornTile({ item, layer, onRemove }: { item: Item; layer: number | null; onRemove: () => void }) {
  return (
    <View style={{ width: ROW_W, height: ROW_H }}>
      <ItemImage item={item} style={{ flex: 1, borderRadius: R.tile }} />
      {layer ? <Mark n={layer} /> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`脱下${item.name}`}
        onPress={onRemove}
        hitSlop={8}
        style={{ position: 'absolute', right: -5, top: -5, width: 22, height: 22, borderRadius: R.pill, backgroundColor: '#FFFFFF', boxShadow: '0 1px 4px rgba(17,17,17,0.25)', alignItems: 'center', justifyContent: 'center' }}
      >
        <Icon name="close" size={11} strokeWidth={2.6} />
      </Pressable>
    </View>
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

/** Two choices for how a layer is worn; tapping the chosen one again leaves it to the picture. */
function HowSwitch({ value, labels, onChange }: { value: boolean | undefined; labels: [string, string]; onChange: (v: boolean | undefined) => void }) {
  return (
    <View style={{ flexDirection: 'row', padding: 2, borderRadius: R.pill, backgroundColor: C.card }}>
      {labels.map((l, i) => {
        const v = i === 0;
        const on = value === v;
        return (
          <Pressable
            key={l}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(on ? undefined : v)}
            style={{ height: 26, paddingHorizontal: 10, borderRadius: R.pill, justifyContent: 'center', backgroundColor: on ? '#FFFFFF' : 'transparent', boxShadow: on ? '0 1px 2px rgba(17,17,17,0.10)' : undefined }}
          >
            <Text style={{ fontSize: 11, color: on ? C.ink : C.sub, fontWeight: on ? '500' : '400' }}>{l}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** One upper-body layer in the order list: drag the grip up (outward) or down (inward). */
function LayerRow({
  item,
  n,
  total,
  styling,
  onMove,
  onStyle,
  onRemove,
}: {
  item: Item;
  /** 1 = innermost. */
  n: number;
  total: number;
  styling: Styling | undefined;
  /** `to` is the new position among the layers, 0 = innermost. */
  onMove: (to: number) => void;
  onStyle: (patch: Styling) => void;
  onRemove: () => void;
}) {
  const [dy] = useState(() => new Animated.Value(0));
  const [dragging, setDragging] = useState(false);
  // The list runs outermost first, so dragging down moves a layer inward.
  const pan = usePanGesture({
    runOnJS: true,
    minDistance: 4,
    onActivate: () => setDragging(true),
    onUpdate: (e) => dy.setValue(e.translationY),
    onDeactivate: (e) => {
      const steps = Math.round(e.translationY / LAYER_ROW);
      if (steps) onMove(Math.max(0, Math.min(total - 1, n - 1 - steps)));
    },
    onFinalize: () => {
      dy.setValue(0);
      setDragging(false);
    },
  });
  return (
    <Animated.View
      accessible
      accessibilityLabel={`第 ${n} 层，${item.name}`}
      accessibilityActions={[
        { name: 'increment', label: '往外移' },
        { name: 'decrement', label: '往里移' },
      ]}
      onAccessibilityAction={(e) => onMove(Math.max(0, Math.min(total - 1, n - 1 + (e.nativeEvent.actionName === 'increment' ? 1 : -1))))}
      style={{
        height: LAYER_ROW,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        borderBottomWidth: 1,
        borderBottomColor: C.lineSoft,
        backgroundColor: C.bg,
        zIndex: dragging ? 2 : 0,
        boxShadow: dragging ? '0 6px 16px rgba(17,17,17,0.14)' : undefined,
        transform: [{ translateY: dy }],
      }}
    >
      <GestureDetector gesture={pan}>
        <View collapsable={false} style={{ width: 28, height: 52, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="grip" size={18} color={C.faint} strokeWidth={2} />
        </View>
      </GestureDetector>
      <View style={{ width: 38, height: 50 }}>
        <ItemImage item={item} style={{ flex: 1, borderRadius: R.small }} />
        <View style={{ position: 'absolute', left: -6, top: -6, width: 18, height: 18, borderRadius: R.pill, backgroundColor: C.ink, borderWidth: 2, borderColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: '#FFFFFF', fontSize: 10, fontWeight: '700' }}>{n}</Text>
        </View>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <T style={{ fontSize: 13, fontWeight: '500' }} numberOfLines={1}>
          {item.name}
        </T>
        {/* Open / closed only matters with something under it; tucked only for tops. */}
        {n > 1 || item.slot === 'top' ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {n > 1 ? <HowSwitch value={styling?.open} labels={['敞开', '扣好']} onChange={(open) => onStyle({ open })} /> : null}
            {item.slot === 'top' ? (
              <HowSwitch value={styling?.tucked === undefined ? undefined : !styling.tucked} labels={['放外面', '塞进']} onChange={(v) => onStyle({ tucked: v === undefined ? undefined : !v })} />
            ) : null}
          </View>
        ) : total > 1 ? (
          <T style={{ fontSize: 11, color: C.sub }}>最里层</T>
        ) : null}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={`脱下${item.name}`} onPress={onRemove} hitSlop={4} style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="close" size={14} color={C.sub} strokeWidth={2.4} />
      </Pressable>
    </Animated.View>
  );
}

/** Garments of one category, grouped by subcategory (most first); `其他` for none. */
function bySubcategory(list: Item[]): { title: string; items: Item[] }[] {
  const groups = new Map<string, Item[]>();
  for (const it of list) {
    const k = it.subcategory?.trim() || '其他';
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  return [...groups.entries()]
    .sort(([a, x], [b, y]) => (a === '其他' ? 1 : b === '其他' ? -1 : y.length - x.length))
    .map(([title, items]) => ({ title, items }));
}

export default function FittingPage() {
  const app = useApp();
  const consent = usePhotoConsent();
  const recordToday = useRecordToday();
  const insets = useSafeAreaInsets();
  const { width: W } = useWindowDimensions();
  const s = useData(loadSnapshot);
  const settings = useData(getAiSettings);
  const look = app.fitting;
  const [tabChoice, setTab] = useState<Tab | null>(null);
  const [view, setView] = useState<TryonView>('front');
  const [skipIntro, setSkipIntro] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [height, setHeight] = useState(0);
  const [open, setOpen] = useState(false);
  /** The garment just put on next to (or over) another of its category; `n` is its layer, 0 for an accessory. */
  const [stacked, setStacked] = useState<{ id: string; over: string; n: number } | null>(null);
  const [makeupOpen, setMakeupOpen] = useState(false);
  // A fresh try-on sheet each time, so its notes are for this time only.
  const [sheetN, setSheetN] = useState(0);
  const [tryonOpen, setTryonOpen] = useState(false);
  // A look put on from elsewhere (an outfit, 去试穿) opens on 已穿; changes made here keep the tab.
  const idsNow = look.ids.join(',');
  const [seenIds, setSeenIds] = useState(idsNow);
  if (idsNow !== seenIds) {
    setSeenIds(idsNow);
    setTab('worn');
    setStacked(null);
  }
  const setLook = (next: Look) => {
    setSeenIds(next.ids.join(','));
    app.setFitting(next);
  };

  const slotOf = (id: string) => s?.byId.get(id)?.slot;
  // Garments deleted or put away since they were put on drop out; the order (layers) is kept.
  const worn = s ? look.ids.map((id) => s.byId.get(id)).filter((i): i is Item => !!i && i.status === 'active') : [];
  const wornIds = worn.map((i) => i.id);
  const current: Look = { ...look, ids: wornIds };
  const layers = layersOf(current, slotOf);
  const layerNo = (id: string) => (layers.includes(id) ? layers.indexOf(id) + 1 : null);
  const drawable = worn.filter((i) => i.catalogUri || i.originalUri);
  const drawableLook: Look = { ...look, ids: drawable.map((i) => i.id) };
  const key = `${drawableLook.ids.join(',')}|${JSON.stringify(look.styling)}|${look.makeup ?? ''}`;
  const tryon = useData((db) => tryonState(db, drawableLook, view), [key, view]);
  // The garments as layers over the avatar (painted once each at intake); missing ones are painted in the background.
  const version = s ? avatarVersion(s.avatar) : '';
  const layerRows = useData((db) => listLayers(db, wornIds, version), [wornIds.join(','), version]);
  const stack = layersFor(worn, look.styling, view, layerRows ?? []);
  const preparing = stack.missing.length;
  const canLayer = !!s && avatarUsable(s.avatar) && !!s.avatar.greenFrontUri && !s.blocked;
  useEffect(() => {
    if (!canLayer || preparing === 0) return;
    const t = setTimeout(() => void ensureLayers(app, wornIds).then((n) => n && app.runner.kick()), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the worn ids are the look; `app` is stable.
  }, [canLayer, preparing, wornIds.join(',')]);
  // Garments catalogued before the avatar (or before layers existed) get theirs now, in the background.
  useEffect(() => {
    if (canLayer) void ensureLayers(app).then((n) => n && app.runner.kick());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per avatar
  }, [canLayer, version]);

  // The drawer is as tall as when open and slides down so only its collapsed part shows.
  const openHeight = Math.max(DRAWER_CLOSED + 160, Math.round(height * 0.6));
  const travel = openHeight - DRAWER_CLOSED;
  const [drawer] = useState(() => new DrawerDrag(setOpen));
  useEffect(() => {
    if (height > 0) drawer.layout(travel);
  }, [drawer, height, travel]);

  useEffect(() => {
    if (!stacked) return;
    const t = setTimeout(() => setStacked(null), 5000);
    return () => clearTimeout(t);
  }, [stacked]);
  // Only clearly vertical drags move the drawer, so the tabs and the garment row still scroll sideways.
  const pan = usePanGesture({
    runOnJS: true,
    activeOffsetY: [-10, 10],
    failOffsetX: [-14, 14],
    onActivate: () => drawer.begin(),
    onUpdate: (e) => drawer.move(e.translationY),
    onDeactivate: (e) => drawer.end(e.translationY, e.velocityY),
  });

  const generate = async (opts: TryonOptions) => {
    setTryonOpen(false);
    if (!(await consent())) return;
    await requestTryon(app, drawableLook, view, opts);
    app.refresh();
  };

  if (!s) return <Loading />;

  const avatarReady = avatarUsable(s.avatar);
  const remaking = s.avatar.status === 'processing';
  const noAvatar = s.avatar.status === 'none' && !skipIntro;
  const avatarUri = view === 'back' ? s.avatar.backUri : s.avatar.frontUri;
  const busy = tryon?.status === 'queued';
  const made = !!tryon?.uri && !tryon.missingMakeup;
  const makeup = view === 'front' ? look.makeup : undefined;
  // Pictures sent per image call. The back view and the makeup are drawn from the front view without makeup,
  // which is generated first if it does not exist yet; makeup with nothing worn goes on the avatar itself.
  const front = drawable.length + 1;
  const needFront = drawable.length > 0 && !tryonFor(s, drawableLook.ids, look.styling);
  const calls = view === 'back' ? [...(needFront ? [front] : []), 2] : makeup ? [...(needFront ? [front] : []), drawable.length ? 2 : 1] : [front];
  const tq = settings ? tryonQuality(settings) : 'low';
  const cost = addCosts(...calls.map((inputImages) => estimateFor(s.routing, 'tryon', { inputImages, quality: tq })));
  const canTryon = avatarReady && !remaking && (drawable.length > 0 || !!makeup);
  const usedSlots = new Set(s.active.map((i) => i.slot));
  const cats = SLOTS.filter((x) => x.id !== 'accessory' || usedSlots.has('accessory'));
  const tab: Tab = tabChoice ?? (worn.length ? 'worn' : (cats.find((c) => usedSlots.has(c.id))?.id ?? 'outer'));
  const groups = tab === 'worn' ? [] : bySubcategory(s.active.filter((i) => i.slot === tab));
  const tileW = Math.floor((W - 2 * PAD - 2 * GRID_GAP) / 3);
  const top = insets.top + 14;
  const controlsTop = top + 52;
  const fade = travel > 0 ? drawer.y.interpolate({ inputRange: [0, travel], outputRange: [0, 1], extrapolate: 'clamp' }) : 1;

  const pick = (it: Item) => {
    const r = wear(current, it, slotOf);
    if (r.full) return app.toast(it.slot === 'accessory' ? `配饰最多戴 ${MAX_ACCESSORIES} 件` : `上身最多叠 ${MAX_LAYERS} 层`);
    setLook(r.look);
    setStacked(r.stackedOver ? { id: it.id, over: r.stackedOver, n: layersOf(r.look, slotOf).indexOf(it.id) + 1 } : null);
  };
  const remove = (id: string) => {
    setLook(takeOff(current, id));
    if (stacked?.id === id || stacked?.over === id) setStacked(null);
  };
  const wearToday = async () => {
    if (!(await recordToday({ itemIds: wornIds, source: 'manual' }))) return;
    app.toast('已记录今天的穿搭，穿着次数 +1');
    router.navigate('/');
  };
  const openTryon = () => {
    setSheetN((n) => n + 1);
    setTryonOpen(true);
  };
  const names = drawable.map((i) => i.name).join('、');
  const summary = [
    names ? `${names} 穿在你的形象上` : '就用你的形象',
    makeup ? `，化${makeupLabel(makeup)}` : '',
    view === 'back' ? '，背面' : '',
    '。',
  ].join('');

  const wornOn = tab === 'worn';
  const tabsRow = (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: PAD, gap: 8, alignItems: 'center' }}>
      {/* 已穿 is not a category: its own shape and icon, set apart by a line. */}
      <Pressable
        accessibilityRole="tab"
        accessibilityLabel={`已穿 ${worn.length} 件`}
        accessibilityState={{ selected: wornOn }}
        onPress={() => setTab('worn')}
        style={{ height: 36, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1.5, borderColor: C.ink, backgroundColor: wornOn ? C.ink : C.bg, flexDirection: 'row', alignItems: 'center', gap: 5 }}
      >
        <Icon name="person" size={16} strokeWidth={2} color={wornOn ? '#FFFFFF' : C.ink} />
        <Text style={{ fontSize: 13, fontWeight: '600', color: wornOn ? '#FFFFFF' : C.ink }}>已穿</Text>
        <View style={{ minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: R.pill, backgroundColor: wornOn ? '#FFFFFF' : C.ink, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 11, color: wornOn ? C.ink : '#FFFFFF' }}>{worn.length}</Text>
        </View>
      </Pressable>
      <View style={{ width: 1, height: 22, backgroundColor: C.muted }} />
      {cats.map((c) => {
        const on = c.id === tab;
        const has = worn.some((i) => i.slot === c.id);
        return (
          <Pressable
            key={c.id}
            accessibilityRole="tab"
            accessibilityLabel={has ? `${c.label}，有穿` : c.label}
            accessibilityState={{ selected: on }}
            onPress={() => setTab(c.id)}
            hitSlop={{ top: 4, bottom: 4 }}
            style={{ height: 36, paddingHorizontal: 14, borderRadius: R.pill, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: on ? C.ink : C.card }}
          >
            <Text style={{ fontSize: 13, color: on ? '#FFFFFF' : C.sub, fontWeight: on ? '500' : '400' }}>{c.label}</Text>
            {has ? <View style={{ width: 5, height: 5, borderRadius: R.pill, backgroundColor: on ? '#FFFFFF' : C.ink }} /> : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );

  // Collapsed: one row. 已穿 lists the upper body outermost first, then the rest; a category lists its garments.
  const wornRest = worn.filter((i) => !isUpper(i.slot));
  const upperOuterFirst = [...layers]
    .reverse()
    .map((id) => s.byId.get(id))
    .filter((i): i is Item => !!i);
  const emptyCategory = tab === 'worn' ? null : (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      <AddTile width={ROW_W} height={ROW_H} />
      <View style={{ gap: 4 }}>
        <T style={{ fontSize: 14, fontWeight: '500' }}>还没有{SLOT_LABEL[tab]}</T>
        <T style={{ fontSize: 12, color: C.sub }}>拍一张就能放进来，穿上试试</T>
      </View>
    </View>
  );
  const closedRow =
    tab === 'worn' ? (
      worn.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }} contentContainerStyle={{ paddingHorizontal: PAD, paddingTop: 6, gap: 12 }}>
          {upperOuterFirst.map((it) => (
            <WornTile key={it.id} item={it} layer={layers.length > 1 ? layerNo(it.id) : null} onRemove={() => remove(it.id)} />
          ))}
          {upperOuterFirst.length && wornRest.length ? <View style={{ width: 1, marginVertical: 6, backgroundColor: C.line }} /> : null}
          {wornRest.map((it) => (
            <WornTile key={it.id} item={it} layer={null} onRemove={() => remove(it.id)} />
          ))}
        </ScrollView>
      ) : (
        <View style={{ height: ROW_H + 14, marginHorizontal: PAD, justifyContent: 'center' }}>
          <T v="small" style={{ color: C.sub }}>
            还没穿衣服，点后面的分类挑一件
          </T>
        </View>
      )
    ) : (
      <FlatList
        horizontal
        style={{ marginTop: 8 }}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: PAD, paddingTop: 6, gap: GRID_GAP }}
        data={groups.flatMap((g) => g.items)}
        keyExtractor={(it) => it.id}
        initialNumToRender={6}
        windowSize={5}
        renderItem={({ item: it }) => <GarmentTile item={it} on={wornIds.includes(it.id)} layer={layers.length > 1 ? layerNo(it.id) : null} width={ROW_W} height={ROW_H} onPress={() => pick(it)} />}
        ListEmptyComponent={emptyCategory ?? undefined}
      />
    );

  // Open: 已穿 becomes the wearing order (drag layers, choose how each is worn); a category becomes a grid.
  const openContent =
    tab === 'worn' ? (
      <ScrollView style={{ flex: 1, marginTop: 6 }} contentContainerStyle={{ paddingHorizontal: PAD, paddingBottom: 20 }}>
        {worn.length === 0 ? (
          <T v="small" style={{ color: C.sub, paddingTop: 12 }}>
            还没穿衣服，点上面的分类挑一件
          </T>
        ) : null}
        {layers.length ? (
          <T style={{ fontSize: 12, color: C.sub, paddingTop: 8 }}>
            上身 · {layers.length} 层 <Text style={{ color: C.ink }}>外 → 里</Text>
            {layers.length > 1 ? '，按住左边拖动换里外' : ''}
          </T>
        ) : null}
        {upperOuterFirst.map((it) => (
          <LayerRow
            key={it.id}
            item={it}
            n={layerNo(it.id)!}
            total={layers.length}
            styling={look.styling[it.id]}
            onMove={(to) => setLook(moveLayer(current, it.id, to, slotOf))}
            onStyle={(patch) => setLook(setStyling(current, it.id, patch))}
            onRemove={() => remove(it.id)}
          />
        ))}
        {wornRest.length ? <T style={{ fontSize: 12, color: C.sub, paddingTop: 12 }}>下身和其他</T> : null}
        {wornRest.map((it) => (
          <View key={it.id} style={{ height: 64, flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 38, borderBottomWidth: 1, borderBottomColor: C.lineSoft }}>
            <ItemImage item={it} style={{ width: 38, height: 50, borderRadius: R.small }} />
            <View style={{ flex: 1, gap: 2 }}>
              <T style={{ fontSize: 13, fontWeight: '500' }} numberOfLines={1}>
                {it.name}
              </T>
              <T style={{ fontSize: 11, color: C.sub }}>{SLOT_LABEL[it.slot]}</T>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={`脱下${it.name}`} onPress={() => remove(it.id)} hitSlop={4} style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="close" size={14} color={C.sub} strokeWidth={2.4} />
            </Pressable>
          </View>
        ))}
      </ScrollView>
    ) : (
      <SectionList
        style={{ flex: 1, marginTop: 4 }}
        contentContainerStyle={{ paddingHorizontal: PAD, paddingBottom: 16 }}
        sections={groups.map((g) => ({ title: g.title, data: Array.from({ length: Math.ceil(g.items.length / 3) }, (_, i) => g.items.slice(i * 3, i * 3 + 3)) }))}
        keyExtractor={(row) => row[0].id}
        stickySectionHeadersEnabled={false}
        initialNumToRender={4}
        renderSectionHeader={({ section }) => <T style={{ fontSize: 12, color: C.sub, paddingTop: 12, paddingBottom: 8 }}>{section.title}</T>}
        renderItem={({ item: row }) => (
          <View style={{ flexDirection: 'row', gap: GRID_GAP, marginBottom: GRID_GAP }}>
            {row.map((it) => (
              <GarmentTile key={it.id} item={it} on={wornIds.includes(it.id)} layer={layers.length > 1 ? layerNo(it.id) : null} width={tileW} height={Math.round((tileW * 4) / 3)} showName onPress={() => pick(it)} />
            ))}
          </View>
        )}
        ListEmptyComponent={<View style={{ paddingTop: 16 }}>{emptyCategory}</View>}
      />
    );

  const over = stacked ? s.byId.get(stacked.over) : null;
  const added = stacked ? s.byId.get(stacked.id) : null;

  return (
    <View style={{ flex: 1, backgroundColor: C.card }} onLayout={(e: LayoutChangeEvent) => setHeight(e.nativeEvent.layout.height)}>
      <Stage
        avatarUri={avatarReady ? avatarUri : null}
        tryonUri={tryon?.uri ?? null}
        layers={stack.map((l) => l.uri)}
        busy={busy && !s.blocked}
        style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: DRAWER_CLOSED - 20, borderRadius: 0 }}
      />
      {noAvatar ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: '26%', alignItems: 'center' }}>
          <View style={{ paddingHorizontal: 14, paddingVertical: 6, borderRadius: R.pill, backgroundColor: C.bg }}>
            <T style={{ fontSize: 13, fontWeight: '500' }}>这里会是你</T>
          </View>
        </View>
      ) : null}

      <View style={{ position: 'absolute', left: PAD, right: PAD, top, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T v="h1" accessibilityRole="header">
          试衣间
        </T>
        {view === 'back' ? (
          <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: R.pill, backgroundColor: 'rgba(255,255,255,0.9)' }}>
            <T style={{ fontSize: 12, color: C.sub }}>背面</T>
          </View>
        ) : null}
      </View>

      {/* Status under the title, left of the button column. */}
      <View style={{ position: 'absolute', left: PAD, top: controlsTop, right: BTN_RIGHT + BTN + 16, gap: 6, alignItems: 'flex-start' }}>
        {remaking ? (
          <Badge text="形象生成中…" spinner />
        ) : busy && s.blocked ? (
          <Badge text="AI 已暂停 · 去处理" onPress={() => router.push(blockedRoute(s.blocked))} />
        ) : busy ? (
          <Badge text="正在生成上身效果" spinner />
        ) : tryon?.status === 'failed' && tryon.error ? (
          <Badge text={tryon.error} danger />
        ) : null}
        {makeup ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`妆容：${makeupLabel(makeup)}，点一下更换`}
            onPress={() => setMakeupOpen(true)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingHorizontal: 12, borderRadius: R.pill, backgroundColor: 'rgba(255,255,255,0.94)' }}
          >
            <Icon name="lipstick" size={14} strokeWidth={2} />
            <Text style={{ fontSize: 12, color: C.ink }} numberOfLines={1}>
              {makeupLabel(makeup)}
              {tryon?.missingMakeup && !busy ? <Text style={{ color: C.sub }}> · 还没生成</Text> : null}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {!noAvatar ? (
        <Animated.View pointerEvents={open ? 'none' : 'box-none'} style={{ position: 'absolute', right: BTN_RIGHT, top: controlsTop, gap: 10, opacity: fade }}>
          <RoundBtn icon="turn" label={view === 'front' ? '转到背面' : '转到正面'} active={view === 'back'} disabled={!avatarReady} onPress={() => setView((v) => (v === 'front' ? 'back' : 'front'))} />
          <RoundBtn icon="lipstick" label={look.makeup ? `妆容：${makeupLabel(look.makeup)}` : '妆容'} active={!!look.makeup} disabled={!avatarReady} onPress={() => setMakeupOpen(true)} />
          <RoundBtn
            icon={made ? 'refresh' : 'sparkle'}
            label={`${made ? '重新生成上身效果' : '生成上身效果'} · ${formatEstimate(cost)}`}
            disabled={!canTryon}
            busy={busy && canTryon}
            onPress={openTryon}
          />
          <RoundBtn icon="bookmark" label="保存穿搭" disabled={worn.length === 0} onPress={() => setSaveOpen(true)} />
          <RoundBtn icon="camera" label="生成大片" disabled={drawable.length === 0 || !avatarReady} onPress={() => router.push(`/photo?items=${drawableLook.ids.join(',')}`)} />
        </Animated.View>
      ) : null}

      {/* Above the drawer: the layering note just after stacking, else the no-avatar card, else 今天穿这套 / a first hint. */}
      <Animated.View pointerEvents={open ? 'none' : 'box-none'} style={{ position: 'absolute', left: PAD, right: PAD, bottom: DRAWER_CLOSED + 14, alignItems: 'center', opacity: fade }}>
        {stacked && added && over ? (
          <View accessibilityRole="alert" style={{ alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingLeft: 16, paddingRight: 8, borderRadius: 16, backgroundColor: C.ink, boxShadow: '0 6px 20px rgba(17,17,17,0.18)' }}>
            <Text style={{ flex: 1, fontSize: 13, lineHeight: 18, color: '#FFFFFF' }}>
              {stacked.n ? `${added.name}叠在${over.name}外面，是第 ${stacked.n} 层` : `${added.name}和${over.name}一起戴`}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setLook(replaceWith(current, over.id, added.id));
                setStacked(null);
              }}
              style={{ height: 36, paddingHorizontal: 12, borderRadius: R.pill, backgroundColor: 'rgba(255,255,255,0.14)', justifyContent: 'center' }}
            >
              <Text style={{ fontSize: 13, color: '#FFFFFF' }} numberOfLines={1}>
                改成换掉{over.name}
              </Text>
            </Pressable>
          </View>
        ) : noAvatar ? (
          <View style={{ alignSelf: 'stretch', padding: 18, borderRadius: R.sheet, backgroundColor: C.bg, boxShadow: '0 6px 24px rgba(17,17,17,0.10)', gap: 12 }}>
            <View style={{ gap: 4 }}>
              <T style={{ fontSize: 18, fontWeight: '700' }}>先建立你的形象</T>
              <T style={{ fontSize: 13, color: C.sub }}>3 张全身照，约 1 分钟，就能看衣服穿在你身上的样子</T>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Btn label="开始建立形象" height={44} style={{ paddingHorizontal: 18 }} onPress={() => router.push('/avatar')} />
              <Btn label="先不建，直接搭配" kind="ghost" height={44} onPress={() => setSkipIntro(true)} />
            </View>
          </View>
        ) : worn.length ? (
          <Btn label="今天穿这套" icon="check" height={44} style={{ paddingHorizontal: 18 }} onPress={wearToday} />
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 14, borderRadius: R.pill, backgroundColor: 'rgba(255,255,255,0.92)' }}>
            <T style={{ fontSize: 13, color: C.sub }}>从下面挑衣服，点一下就穿上</T>
          </View>
        )}
      </Animated.View>

      {/* Tapping the figure while the drawer is open puts it back down. */}
      {open ? <Pressable accessibilityLabel="收起衣服列表" onPress={() => drawer.snap(false)} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: openHeight }} /> : null}

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
          <GestureDetector gesture={pan}>
            <View collapsable={false}>
              <Pressable accessibilityRole="button" accessibilityLabel={open ? '收起衣服列表' : '展开衣服列表'} onPress={() => drawer.snap(!open)} style={{ height: 22, alignItems: 'center', justifyContent: 'center' }}>
                <View style={{ width: 40, height: 4, borderRadius: R.pill, backgroundColor: '#D4D4D7' }} />
              </Pressable>
              {tabsRow}
              {open ? null : closedRow}
            </View>
          </GestureDetector>
          {open ? openContent : null}
        </Animated.View>
      ) : null}

      <MakeupSheet key={look.makeup ?? 'none'} visible={makeupOpen} onClose={() => setMakeupOpen(false)} value={look.makeup} onChange={(m) => setLook(m ? { ...current, makeup: m } : { ids: current.ids, styling: current.styling })} />
      <TryonSheet
        key={sheetN}
        visible={tryonOpen}
        onClose={() => setTryonOpen(false)}
        title={made ? '重新生成上身效果' : '生成上身效果'}
        summary={summary}
        routing={s.routing}
        settings={settings ?? DEFAULT_AI_SETTINGS}
        calls={canTryon ? calls : []}
        note={makeup ? '长相有变化会自动重画一次，最多多收一次费。' : undefined}
        onSubmit={generate}
      />
      <SaveSheet
        visible={saveOpen}
        onClose={() => setSaveOpen(false)}
        look={current}
        items={worn}
        onSaved={(name) => {
          setSaveOpen(false);
          app.refresh();
          app.toast(`已保存穿搭「${name}」`);
        }}
      />
    </View>
  );
}
