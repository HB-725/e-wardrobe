import { TextInput, View, type ViewStyle } from 'react-native';
import { SEASONS, SLOTS } from '@/domain/catalog';
import type { Item, Season, Slot } from '@/domain/types';
import { Chip, SourceBadge, T } from './kit';
import { C } from './theme';

export interface Form {
  name: string;
  slot: Slot;
  subcategory: string;
  colorName: string;
  seasons: Season[];
  size: string;
  material: string;
  brand: string;
  price: string;
  location: string;
  purchasedOn: string;
  fitNotes: string;
}

export function formOf(it: Item): Form {
  return {
    name: it.name,
    slot: it.slot,
    subcategory: it.subcategory ?? '',
    colorName: it.colorName ?? '',
    seasons: it.seasons,
    size: it.size ?? '',
    material: it.material ?? '',
    brand: it.brand ?? '',
    price: it.priceCents != null ? String(it.priceCents / 100) : '',
    location: it.location ?? '',
    purchasedOn: it.purchasedOn ?? '',
    fitNotes: it.fitNotes ?? '',
  };
}

/** Accepts 2025-9, 2025-09-14, 2025/9/14, 2025年9月; returns YYYY-MM-DD or null. */
export function normalizeDate(v: string): string | null {
  const m = v.trim().match(/^(\d{4})[-/.年](\d{1,2})(?:[-/.月](\d{1,2}))?/);
  if (!m) return null;
  const mo = Number(m[2]);
  const d = m[3] ? Number(m[3]) : 1;
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Number(m[1]), mo, 0).getDate()) return null;
  return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function priceOf(v: string): number | null | undefined {
  const t = v.trim().replace(/[¥￥,\s元]/g, '');
  if (!t) return null;
  return /^\d+(\.\d{1,2})?$/.test(t) && Number(t) > 0 ? Math.round(Number(t) * 100) : undefined;
}

/** What is wrong with the form, for the user to fix before saving (empty list when it can be saved). */
export function formProblems(f: Form): string[] {
  const out: string[] = [];
  if (priceOf(f.price) === undefined) out.push(`价格「${f.price.trim()}」不是有效的金额`);
  if (f.purchasedOn.trim() && !normalizeDate(f.purchasedOn)) out.push(`购买日期「${f.purchasedOn.trim()}」无法识别，可以写 2025-09 或 2025-09-14`);
  return out;
}

/** Turns the form into an item patch; every field that differs from what the AI filled is marked as typed by the user. */
export function patchOf(it: Item, f: Form): Partial<Item> {
  const next: Partial<Item> = {
    name: f.name.trim() || it.name,
    slot: f.slot,
    subcategory: f.subcategory.trim() || null,
    colorName: f.colorName.trim() || null,
    seasons: f.seasons,
    size: f.size.trim() || null,
    material: f.material.trim() || null,
    brand: f.brand.trim() || null,
    // An unreadable value keeps what was stored (callers check formProblems first).
    priceCents: priceOf(f.price) === undefined ? it.priceCents : priceOf(f.price)!,
    location: f.location.trim() || null,
    purchasedOn: !f.purchasedOn.trim() ? null : (normalizeDate(f.purchasedOn) ?? it.purchasedOn),
    fitNotes: f.fitNotes.trim() || null,
  };
  const sources = { ...it.fieldSources };
  for (const k of Object.keys(next) as (keyof Item)[]) {
    if (JSON.stringify(next[k]) !== JSON.stringify(it[k])) sources[k] = 'user';
  }
  next.fieldSources = sources;
  return next;
}


function Field({ label, value, onChange, source, placeholder, numeric }: { label: string; value: string; onChange: (v: string) => void; source?: Item['fieldSources'][keyof Item]; placeholder?: string; numeric?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, borderBottomWidth: 1, borderBottomColor: C.lineSoft }}>
      <T style={{ width: 64, fontSize: 13, color: C.sub }}>{label}</T>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder ?? '选填'}
        placeholderTextColor={C.faint}
        keyboardType={numeric ? 'decimal-pad' : 'default'}
        accessibilityLabel={label}
        style={{ flex: 1, height: 44, fontSize: 14, color: C.ink }}
      />
      <SourceBadge source={source} />
    </View>
  );
}


/** Editable garment attributes with AI / 吊牌 source badges; shared by the review and detail pages. */
export function ItemForm({ item, form, onChange, style, notes }: { item: Item; form: Form; onChange: (patch: Partial<Form>) => void; style?: ViewStyle; notes?: boolean }) {
  return (
    <View style={style}>
      <Field label="名称" value={form.name} onChange={(v) => onChange({ name: v })} source={item.fieldSources.name} placeholder="例如 牛仔夹克" />
      <View style={{ minHeight: 52, borderBottomWidth: 1, borderBottomColor: C.lineSoft, paddingVertical: 8, flexDirection: 'row', gap: 12, alignItems: 'center' }}>
        <T style={{ width: 64, fontSize: 13, color: C.sub }}>品类</T>
        <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {SLOTS.map((x) => (
            <Chip key={x.id} label={x.label} on={form.slot === x.id} onPress={() => onChange({ slot: x.id })} />
          ))}
        </View>
      </View>
      <Field label="细类" value={form.subcategory} onChange={(v) => onChange({ subcategory: v })} source={item.fieldSources.subcategory} placeholder="例如 夹克" />
      <Field label="颜色" value={form.colorName} onChange={(v) => onChange({ colorName: v })} source={item.fieldSources.colorName} />
      <View style={{ minHeight: 52, borderBottomWidth: 1, borderBottomColor: C.lineSoft, paddingVertical: 8, flexDirection: 'row', gap: 12, alignItems: 'center' }}>
        <T style={{ width: 64, fontSize: 13, color: C.sub }}>季节</T>
        <View style={{ flex: 1, flexDirection: 'row', gap: 6 }}>
          {SEASONS.map((x) => (
            <Chip key={x.id} label={x.label} on={form.seasons.includes(x.id)} onPress={() => onChange({ seasons: form.seasons.includes(x.id) ? form.seasons.filter((y) => y !== x.id) : [...form.seasons, x.id] })} />
          ))}
        </View>
        <SourceBadge source={item.fieldSources.seasons} />
      </View>
      <Field label="尺码" value={form.size} onChange={(v) => onChange({ size: v })} source={item.fieldSources.size} />
      <Field label="材质" value={form.material} onChange={(v) => onChange({ material: v })} source={item.fieldSources.material} />
      <Field label="品牌" value={form.brand} onChange={(v) => onChange({ brand: v })} source={item.fieldSources.brand} />
      <Field label="价格" value={form.price} onChange={(v) => onChange({ price: v.replace(/[^\d.]/g, '') })} placeholder="选填，单位元" numeric />
      <Field label="存放位置" value={form.location} onChange={(v) => onChange({ location: v })} placeholder="选填，例如卧室衣柜左二层" />
      {notes ? <Field label="购买日期" value={form.purchasedOn} onChange={(v) => onChange({ purchasedOn: v })} placeholder="选填，例如 2025-09" /> : null}
      {notes ? (
        <View style={{ paddingVertical: 10, gap: 6 }}>
          <T style={{ fontSize: 13, color: C.sub }}>合身笔记</T>
          <TextInput
            value={form.fitNotes}
            onChangeText={(v) => onChange({ fitNotes: v })}
            placeholder="例如：略宽松，袖长刚好盖住手腕"
            placeholderTextColor={C.faint}
            multiline
            accessibilityLabel="合身笔记"
            style={{ minHeight: 80, padding: 10, borderWidth: 1, borderColor: C.muted, fontSize: 14, color: C.ink, textAlignVertical: 'top' }}
          />
        </View>
      ) : null}
    </View>
  );
}
