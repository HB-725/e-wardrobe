import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
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
import { itemsOf, loadSnapshot, type Snapshot } from '@/state/snapshot';
import { Icon } from '@/ui/Icon';
import { Btn, Chip, IconBtn, Loading, PageHeader, PrivacyNote, Screen, Sheet, T, Tap } from '@/ui/kit';
import { C, PAD } from '@/ui/theme';
import { ItemImage, OutfitBoard, Silhouette, Stage } from '@/ui/visuals';

const VIEWS: { id: TryonView; label: string }[] = [
  { id: 'front', label: '正面' },
  { id: 'back', label: '背面' },
];

function NoAvatar({ onSkip }: { onSkip: () => void }) {
  return (
    <Screen>
      <PageHeader eyebrow="FITTING ROOM" title="试衣间" />
      <View style={{ marginTop: 20, marginHorizontal: PAD, height: 300, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ position: 'absolute', top: 20, bottom: 20, width: 120, opacity: 0.5 }}>
          <Silhouette color="#C9C9CC" />
        </View>
        <View style={{ position: 'absolute', top: 20, bottom: 20, width: 120, borderWidth: 1, borderStyle: 'dashed', borderColor: '#A0A0A5' }} />
        <View style={{ paddingHorizontal: 12, paddingVertical: 6, backgroundColor: C.bg }}>
          <T style={{ fontSize: 13, fontWeight: '500' }}>这里会是你</T>
        </View>
      </View>
      <View style={{ paddingTop: 24, paddingHorizontal: PAD, gap: 8 }}>
        <T v="h2">先建立你的形象</T>
        <T v="body" style={{ color: C.sub, lineHeight: 24 }}>
          建立之后，衣橱里的每件衣服都能穿在你身上看效果，还能转身看背面。
        </T>
      </View>
      <View style={{ marginTop: 18, marginHorizontal: PAD }}>
        {['拍 3 张全身照：正面、侧面、背面', '填身高、体重，体型选填', 'AI 生成正面和背面形象，大约 1 分钟'].map((t, i) => (
          <View key={t} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44, borderBottomWidth: i < 2 ? 1 : 0, borderBottomColor: C.lineSoft }}>
            <T style={{ width: 22, fontSize: 12, color: C.sub }}>0{i + 1}</T>
            <T v="body">{t}</T>
          </View>
        ))}
      </View>
      <View style={{ paddingTop: 20, paddingHorizontal: PAD, gap: 10 }}>
        <Btn label="开始建立形象" height={52} onPress={() => router.push('/avatar')} />
        <Btn label="先不建，直接搭配" kind="ghost" height={44} onPress={onSkip} />
        <PrivacyNote text="全身照生成时发送给 OpenAI，只保存在这台手机上" />
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
          {items.length} 件 · {items.map((i) => i.name).join('、')}
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
          style={{ height: 46, paddingHorizontal: 12, borderWidth: 1, borderColor: C.muted, fontSize: 15, color: C.ink }}
        />
      </View>
      <View style={{ gap: 8 }}>
        <T v="caption">适合的场合（可多选）</T>
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

function Tray({ s, slot, worn, onPick }: { s: Snapshot; slot: Slot; worn: string | undefined; onPick: (it: Item) => void }) {
  const list = s.active.filter((i) => i.slot === slot);
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 6, gap: 6 }}>
      {list.map((it) => {
        const on = worn === it.id;
        return (
          <Pressable
            key={it.id}
            accessibilityRole="button"
            accessibilityLabel={it.name}
            accessibilityState={{ selected: on }}
            onPress={() => onPick(it)}
            style={{ backgroundColor: C.card, borderWidth: 2, borderColor: on ? C.ink : C.card }}
          >
            <ItemImage item={it} style={{ aspectRatio: 0.75 }} />
            <T style={{ fontSize: 11, textAlign: 'center', paddingVertical: 4, paddingHorizontal: 2 }} numberOfLines={1}>
              {it.name}
            </T>
            {on ? (
              <View style={{ position: 'absolute', left: 0, top: 0, paddingHorizontal: 6, paddingVertical: 1, backgroundColor: C.ink }}>
                <T style={{ color: '#FFFFFF', fontSize: 10 }}>穿着</T>
              </View>
            ) : null}
          </Pressable>
        );
      })}
      {list.length === 0 ? (
        <Tap onPress={() => router.push('/capture')} style={{ height: 104, borderWidth: 1, borderStyle: 'dashed', borderColor: C.muted, alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <Icon name="plus" size={18} color={C.faint} />
          <T style={{ fontSize: 11, color: C.sub }}>还没有这类衣服</T>
        </Tap>
      ) : null}
    </ScrollView>
  );
}

export default function FittingPage() {
  const app = useApp();
  const consent = usePhotoConsent();
  const recordToday = useRecordToday();
  const s = useData(loadSnapshot);
  const settings = useData(getAiSettings);
  const [catChoice, setCat] = useState<Slot | null>(null);
  const [view, setView] = useState<TryonView>('front');
  const [skipIntro, setSkipIntro] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const sel = app.fitting;
  // Drop garments that were deleted or archived since they were put on; lookups and requests use the same list.
  const worn = s ? itemsOf(s, selectionIds(sel)).filter((i) => i.status === 'active') : [];
  const wornIds = worn.map((i) => i.id);
  const drawable = worn.filter((i) => i.catalogUri || i.originalUri);
  const drawableIds = drawable.map((i) => i.id);
  const key = drawableIds.join(',');
  const tryon = useData((db) => tryonState(db, drawableIds, view), [key, view]);

  if (!s) return <Loading />;
  // Someone arriving with garments already chosen ("去试穿") goes straight to the room, and stays there.
  if (worn.length > 0 && !skipIntro) setSkipIntro(true);
  if (s.avatar.status === 'none' && !skipIntro && worn.length === 0) return <NoAvatar onSkip={() => setSkipIntro(true)} />;

  const avatarReady = avatarUsable(s.avatar);
  const avatarUri = view === 'back' ? s.avatar.backUri : s.avatar.frontUri;
  const busy = tryon?.status === 'queued';
  const cost = estimateImageCost(null, { inputImages: drawable.length + 1, quality: qualityFor(settings?.quality ?? 'standard', 'tryon') });
  const usedSlots = new Set(s.active.map((i) => i.slot));
  const cats = SLOTS.filter((x) => x.id !== 'accessory' || usedSlots.has('accessory'));
  // Open on the category of what was just put on, else the first one that has clothes.
  const cat: Slot = catChoice ?? worn[worn.length - 1]?.slot ?? cats.find((c) => usedSlots.has(c.id))?.id ?? 'outer';

  const turn = () => setView((v) => (v === 'front' ? 'back' : 'front'));

  const wearToday = async () => {
    if (!(await recordToday({ itemIds: wornIds, source: 'manual' }))) return;
    app.toast('已记录今天的穿搭，穿着次数 +1');
    router.navigate('/');
  };

  return (
    <Screen scroll={false}>
      <PageHeader eyebrow="FITTING ROOM" title="试衣间" right={<T style={{ fontSize: 13, color: C.sub }}>已穿 {worn.length} 件</T>} />
      <View style={{ flex: 1, flexDirection: 'row', gap: 8, marginTop: 20, marginHorizontal: PAD, marginBottom: 16 }}>
        <View style={{ flex: 194, gap: 8 }}>
          <View style={{ flex: 1, backgroundColor: C.card }}>
            <Stage avatarUri={avatarReady ? avatarUri : null} items={worn} tryonUri={tryon?.uri ?? null} busy={busy} style={{ flex: 1 }} />
            {s.avatar.status === 'processing' ? (
              <View style={{ position: 'absolute', left: 8, right: 8, top: 8, backgroundColor: C.scrim, padding: 6 }}>
                <Text style={{ color: '#FFFFFF', fontSize: 11 }}>形象生成中，完成后这里会换成你</Text>
              </View>
            ) : null}
            <View style={{ alignItems: 'center', paddingVertical: 8, gap: 6 }}>
              <View style={{ flexDirection: 'row', gap: 5 }}>
                {VIEWS.map((v) => (
                  <View key={v.id} style={{ width: 5, height: 5, backgroundColor: v.id === view ? C.ink : C.muted }} />
                ))}
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <IconBtn name="back" label="向左转" bg={C.bg} size={18} onPress={turn} />
                <T style={{ width: 40, textAlign: 'center', fontSize: 12, color: C.sub }}>{VIEWS.find((v) => v.id === view)!.label}</T>
                <IconBtn name="forward" label="向右转" bg={C.bg} size={18} onPress={turn} />
              </View>
            </View>
          </View>
          {avatarReady && busy && s.blocked ? (
            <Btn label="AI 已暂停 · 去处理" kind="outline" height={40} onPress={() => router.push(blockedRoute(s.blocked))} />
          ) : avatarReady && drawable.length > 0 && !tryon?.uri ? (
            <Btn
              label={busy ? '生成中…' : tryon?.status === 'failed' ? '重新生成上身效果' : `生成上身效果 · 约 ${formatUsd(cost)}`}
              kind="outline"
              height={40}
              disabled={busy}
              onPress={async () => {
                if (!(await consent())) return;
                await requestTryon(app, drawableIds, view);
                app.refresh();
              }}
            />
          ) : null}
          {tryon?.status === 'failed' && tryon.error ? (
            <T style={{ fontSize: 11, color: C.danger }} numberOfLines={2}>
              {tryon.error}
            </T>
          ) : null}
          <Btn label="今天穿这套" height={44} disabled={worn.length === 0} onPress={wearToday} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn label="保存穿搭" kind="outline" height={44} style={{ flex: 1, paddingHorizontal: 4 }} disabled={worn.length === 0} onPress={() => setSaveOpen(true)} />
            <Btn
              label="生成大片"
              kind="outline"
              height={44}
              style={{ flex: 1, paddingHorizontal: 4 }}
              disabled={drawable.length === 0 || !avatarReady}
              onPress={() => router.push(`/photo?items=${drawableIds.join(',')}`)}
            />
          </View>
        </View>
        <View style={{ flex: 148, borderWidth: 1, borderColor: C.ink, flexDirection: 'row' }}>
          <View style={{ width: 44, borderRightWidth: 1, borderRightColor: C.line }}>
            {cats.map((c) => {
              const on = c.id === cat;
              const has = !!sel[c.id];
              return (
                <Pressable
                  key={c.id}
                  accessibilityRole="tab"
                  accessibilityLabel={c.label}
                  accessibilityState={{ selected: on }}
                  onPress={() => setCat(c.id)}
                  style={{ height: 56, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 1, borderBottomColor: C.line, backgroundColor: on ? C.ink : C.bg }}
                >
                  {c.label.split('').map((ch, i) => (
                    <Text key={i} style={{ fontSize: 12, lineHeight: 15, color: on ? '#FFFFFF' : C.sub, fontWeight: on ? '700' : '400' }}>
                      {ch}
                    </Text>
                  ))}
                  {has ? <View style={{ position: 'absolute', right: 4, top: 4, width: 5, height: 5, backgroundColor: on ? '#FFFFFF' : C.ink }} /> : null}
                </Pressable>
              );
            })}
          </View>
          <Tray s={s} slot={cat} worn={sel[cat]} onPick={(it) => app.setFitting(toggleInSelection(sel, it))} />
        </View>
      </View>
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
    </Screen>
  );
}
