import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { BackHandler, ScrollView, View } from 'react-native';
import { SLOT_LABEL, seasonsLabel } from '@/domain/catalog';
import { selectionFromItems } from '@/domain/outfit';
import { computeItemStats, currentDateKey, formatYuan } from '@/domain/stats';
import type { Item } from '@/domain/types';
import { latestJobFor } from '@/db/jobs';
import { needsReview, recordWear, regenerateItem, saveItemEdits, removeItem, retryItem, setArchived, setItemPhoto } from '@/state/actions';
import { useApp, useData } from '@/state/app';
import { useSafe } from '@/state/useSafe';
import { usePhotoConsent } from '@/state/consent';
import { itemsOf, loadSnapshot, tryonFor } from '@/state/snapshot';
import { confirmAsync, notify } from '@/ui/dialogs';
import { formOf, formProblems, ItemForm, patchOf } from '@/ui/ItemForm';
import { Banner, Btn, Loading, NavHeader, Screen, Segmented, SourceBadge, T, Tap } from '@/ui/kit';
import { C, PAD } from '@/ui/theme';
import { ItemImage, OutfitBoard } from '@/ui/visuals';

function ago(days: number | null): string {
  if (days === null) return '还没穿';
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

function Attr({ label, children, source, onEmpty }: { label: string; children?: string | null; source?: Item['fieldSources'][keyof Item]; onEmpty: () => void }) {
  const empty = !children;
  return (
    <Tap onPress={empty ? onEmpty : undefined} disabled={!empty} style={{ minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: C.lineSoft, gap: 12 }}>
      <T style={{ fontSize: 14, color: C.sub }}>{label}</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
        <T style={{ fontSize: 14, color: empty ? C.sub : C.ink, flexShrink: 1, textAlign: 'right' }} numberOfLines={2}>
          {empty ? '点击填写' : children}
        </T>
        {empty ? null : <SourceBadge source={source} />}
      </View>
    </Tap>
  );
}

export default function ItemPage() {
  const app = useApp();
  const consent = usePhotoConsent();
  const { id } = useLocalSearchParams<{ id: string }>();
  const s = useData(loadSnapshot);
  const job = useData((db) => latestJobFor(db, 'catalog', id), [id]);
  const [view, setView] = useState<'std' | 'raw'>('std');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ReturnType<typeof formOf> | null>(null);
  const [busy, setBusy] = useState(false);
  const safe = useSafe();

  // Android back leaves edit mode instead of the page (and the unsaved edits).
  useEffect(() => {
    if (!editing) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setEditing(false);
      return true;
    });
    return () => sub.remove();
  }, [editing]);

  if (!s) return <Loading />;
  const item = s.byId.get(id);
  if (!item) {
    return (
      <Screen>
        <NavHeader title="单品详情" />
        <T style={{ padding: PAD }}>这件衣服已经删除了。</T>
      </Screen>
    );
  }
  const st = computeItemStats(item, s.logs, s.today);
  const outfits = s.outfits.filter((o) => o.itemIds.includes(item.id));
  const hasStd = !!item.catalogUri;
  const showRaw = view === 'raw' || !hasStd;
  const startEdit = () => {
    setForm(formOf(item));
    setEditing(true);
  };

  const save = safe(async () => {
    if (!form) return;
    const problems = formProblems(form);
    if (problems.length) return notify('请先改一下', problems.join('\n'));
    setBusy(true);
    try {
      await saveItemEdits(app, item.id, patchOf(item, form));
      setEditing(false);
      app.refresh();
    } finally {
      setBusy(false);
    }
  });

  const addPhoto = safe(async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    if (r.canceled) return;
    await consent(); // declining keeps the photo; generation waits until the user agrees
    await setItemPhoto(app, item.id, r.assets[0].uri);
    app.refresh();
    app.toast(item.status === 'active' || item.status === 'archived' ? '照片已换好，新的标准图生成后可以选择换不换' : '照片已添加，正在生成标准图');
  });

  if (editing && form) {
    return (
      <Screen
        footer={
          <>
            <Btn label="取消" kind="outline" style={{ flex: 1 }} onPress={() => setEditing(false)} />
            <Btn label="保存" style={{ flex: 2 }} loading={busy} onPress={save} />
          </>
        }
      >
        <NavHeader title="编辑单品" onBack={() => setEditing(false)} />
        <ItemForm item={item} form={form} onChange={(p) => setForm({ ...form, ...p })} notes style={{ paddingHorizontal: PAD, paddingTop: 8 }} />
      </Screen>
    );
  }

  const category = [SLOT_LABEL[item.slot], item.subcategory].filter(Boolean).join(' · ');
  const sizeMat = [item.size, item.material].filter(Boolean).join(' · ');
  const price = [item.priceCents != null ? formatYuan(item.priceCents) : null, item.purchasedOn ? `${item.purchasedOn.slice(0, 4)} 年 ${Number(item.purchasedOn.slice(5, 7))} 月` : null].filter(Boolean).join(' · ');

  return (
    <Screen>
      <NavHeader title="单品详情" right={<Tap onPress={startEdit} style={{ minWidth: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><T>编辑</T></Tap>} />
      <View style={{ height: 380, backgroundColor: C.bg, alignItems: 'center' }}>
        {showRaw && item.originalUri ? (
          <Image source={{ uri: item.originalUri }} style={{ alignSelf: 'stretch', flex: 1 }} contentFit="cover" />
        ) : (
          // The catalog image at its own 2:3 shape: the whole garment, and no box where its background meets ours.
          <ItemImage item={item} style={{ height: '100%', aspectRatio: 2 / 3 }} />
        )}
        {!item.originalUri && !item.catalogUri ? (
          <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
            <T v="caption">这件还没有照片</T>
            <Btn label="添加照片" kind="outline" onPress={addPhoto} style={{ paddingHorizontal: 24 }} />
          </View>
        ) : null}
        {hasStd && item.originalUri ? (
          <View style={{ position: 'absolute', alignSelf: 'center', bottom: 14, backgroundColor: '#FFFFFF', padding: 0 }}>
            <Segmented
              options={[
                { id: 'std', label: '标准图' },
                { id: 'raw', label: '原图' },
              ]}
              value={view}
              onChange={setView}
            />
          </View>
        ) : null}
      </View>
      {needsReview(item) && item.status !== 'review' ? (
        <View style={{ marginTop: 12 }}>
          <Banner title="新的标准图生成好了" sub="去看看要不要换上" onPress={() => router.push(`/review?id=${item.id}`)} />
        </View>
      ) : item.status !== 'processing' && (job?.status === 'queued' || job?.status === 'running') ? (
        <View style={{ marginTop: 12 }}>
          <Banner title="正在重新生成标准图" sub="生成好后可以选择换不换" />
        </View>
      ) : item.status === 'active' && job?.status === 'failed' && job.payload.regenerate ? (
        <View style={{ marginTop: 12 }}>
          <Banner tone="warn" title="重新生成失败" sub={job.lastError ?? undefined} />
        </View>
      ) : null}
      <View style={{ paddingTop: 20, paddingHorizontal: PAD, paddingBottom: 8, gap: 4 }}>
        <T v="caption">{category}{item.status === 'archived' ? ' · 已收起' : ''}</T>
        <T v="h2">{item.name}</T>
      </View>
      <View style={{ flexDirection: 'row', marginTop: 8, marginHorizontal: PAD, borderTopWidth: 1, borderBottomWidth: 1, borderColor: C.line }}>
        {[
          { v: String(st.wears), l: '穿过次数' },
          { v: formatYuan(st.costPerWearCents), l: '每次成本' },
          { v: ago(st.lastWorn ? st.idleDays : null), l: '上次穿' },
        ].map((x) => (
          <View key={x.l} style={{ flex: 1, paddingVertical: 14, gap: 2 }}>
            <T style={{ fontSize: 20, fontWeight: '700' }}>{x.v}</T>
            <T style={{ fontSize: 11, color: C.sub }}>{x.l}</T>
          </View>
        ))}
      </View>
      <View style={{ paddingHorizontal: PAD, paddingVertical: 8 }}>
        <Tap onPress={item.colorName ? undefined : startEdit} disabled={!!item.colorName} style={{ minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: C.lineSoft }}>
          <T style={{ fontSize: 14, color: C.sub }}>颜色</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {item.colorHex ? <View style={{ width: 14, height: 14, backgroundColor: item.colorHex, borderWidth: 1, borderColor: C.line }} /> : null}
            <T style={{ fontSize: 14, color: item.colorName ? C.ink : C.sub }}>{item.colorName ?? '点击填写'}</T>
            {item.colorName ? <SourceBadge source={item.fieldSources.colorName} /> : null}
          </View>
        </Tap>
        <Attr label="季节" source={item.fieldSources.seasons} onEmpty={startEdit}>
          {seasonsLabel(item.seasons)}
        </Attr>
        <Attr label="尺码 / 材质" source={item.fieldSources.size ?? item.fieldSources.material} onEmpty={startEdit}>
          {sizeMat}
        </Attr>
        <Attr label="品牌" source={item.fieldSources.brand} onEmpty={startEdit}>
          {item.brand}
        </Attr>
        <Attr label="价格 / 购买" onEmpty={startEdit}>
          {price}
        </Attr>
        <Attr label="存放位置" onEmpty={startEdit}>
          {item.location}
        </Attr>
      </View>
      {item.fitNotes ? (
        <View style={{ marginTop: 8, marginHorizontal: PAD, padding: 16, backgroundColor: C.card, gap: 6 }}>
          <T style={{ fontSize: 12, fontWeight: '700', letterSpacing: 1 }}>合身笔记</T>
          <T v="body">{item.fitNotes}</T>
        </View>
      ) : null}
      <View style={{ paddingTop: 24, paddingHorizontal: PAD, gap: 12 }}>
        <T style={{ fontSize: 15, fontWeight: '700' }}>{outfits.length ? `出现在 ${outfits.length} 套穿搭里` : '还没有搭配过'}</T>
        {outfits.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12 }}>
            {outfits.map((o) => (
              <Tap
                key={o.id}
                accessibilityLabel={o.name}
                onPress={() => {
                  app.setFitting(selectionFromItems(itemsOf(s, o.itemIds).filter((x) => x.status === 'active')));
                  router.navigate('/fitting');
                }}
                style={{ width: 110, gap: 6 }}
              >
                <OutfitBoard items={itemsOf(s, o.itemIds)} tryonUri={tryonFor(s, o.itemIds)} compact style={{ width: 110, height: 150 }} />
                <T style={{ fontSize: 12 }} numberOfLines={1}>
                  {o.name}
                </T>
              </Tap>
            ))}
          </ScrollView>
        ) : null}
      </View>
      <View style={{ paddingTop: 24, paddingHorizontal: PAD, gap: 10 }}>
        {item.status === 'active' ? (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Btn
              label="去试穿"
              style={{ flex: 1 }}
              onPress={() => {
                app.setFitting({ ...app.fitting, [item.slot]: item.id });
                router.navigate('/fitting');
              }}
            />
            <Btn
              label="今天穿了它"
              kind="outline"
              style={{ flex: 1 }}
              onPress={async () => {
                const ids = new Set(s.todayLog?.itemIds ?? []);
                ids.add(item.id);
                await recordWear(app, { date: currentDateKey(), itemIds: [...ids], source: 'manual' });
                app.refresh();
                app.toast('已加到今天的穿着记录');
              }}
            />
          </View>
        ) : null}
        {item.status === 'failed' ? <Btn label="重新生成标准图" onPress={safe(() => retryItem(app, item.id).then(app.refresh))} /> : null}
        {item.status === 'processing' || item.status === 'failed' || item.status === 'review' ? (
          <Btn label="去确认 / 只存原图" kind="outline" onPress={() => router.push(`/review?id=${item.id}`)} />
        ) : null}
        {item.originalUri && (item.status === 'active' || item.status === 'archived') ? (
          <Btn
            label="重新生成标准图"
            kind="outline"
            onPress={async () => {
              await regenerateItem(app, item.id);
              app.refresh();
              app.toast('生成好后会出现在「确认新单品」里');
            }}
          />
        ) : null}
        {item.originalUri ? <Btn label="换一张照片" kind="ghost" height={44} onPress={addPhoto} /> : null}
        <Btn
          label={item.status === 'archived' ? '放回衣橱' : '收起（不再穿了）'}
          kind="ghost"
          height={44}
          onPress={async () => {
            await setArchived(app, item.id, item.status !== 'archived');
            app.refresh();
          }}
        />
        <Btn
          label="删除这件衣服"
          kind="dangerGhost"
          height={44}
          onPress={async () => {
            if (!(await confirmAsync('删除这件衣服？', '照片、标准图会一起删除；包含它的穿搭和穿着记录里也会去掉它。'))) return;
            await removeItem(app, item.id);
            app.refresh();
            router.back();
          }}
        />
      </View>
    </Screen>
  );
}
