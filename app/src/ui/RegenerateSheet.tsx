import { useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { estimateCost, modelInfo, modelsFor, type ProviderId, resolveRoute, type Route, type Routing } from '@/ai/catalog';
import { type AiSettings, catalogQuality, tryonQuality } from '@/ai/config';
import { addCosts, formatEstimate } from '@/ai/models';
import type { Item } from '@/domain/types';
import type { RegenerateOptions, TryonOptions } from '@/state/actions';
import { Btn, Checkbox, Row, Segmented, Sheet, T, Tap } from './kit';
import { C, R } from './theme';

type Quality = 'low' | 'medium' | 'high';

const QUALITY = [
  { id: 'low' as const, label: '低' },
  { id: 'medium' as const, label: '中' },
  { id: 'high' as const, label: '高' },
];

interface Choice {
  route: Route;
  quality: Quality;
  hint: string;
  makeDefault: boolean;
}

/**
 * Model (with what it costs), quality, notes for the AI and "from now on", for one generation. `calls` is the
 * number of pictures sent in each image call it takes (a back view first needs the front one).
 */
function GenOptions({
  purpose,
  routing,
  value,
  onChange,
  calls,
  n = 1,
  modelsCaption,
  quick,
  placeholder,
  defaultLabel,
}: {
  purpose: 'catalog' | 'tryon';
  routing: Routing;
  value: Choice;
  onChange: (patch: Partial<Choice>) => void;
  calls: number[];
  n?: number;
  modelsCaption: string;
  quick: string[];
  placeholder: string;
  defaultLabel: string;
}) {
  const { route, quality, hint, makeDefault } = value;
  const resolve = (r: Route) => resolveRoute(purpose, { ...routing.routes, [purpose]: r }, routing.keys);
  const auto = resolve('auto');
  const chosen = resolve(route);
  const isOn = (r: Route) => (r === 'auto' ? route === 'auto' : route !== 'auto' && route.keyId === r.keyId && route.model === r.model);
  return (
    <>
      <View>
        <T v="caption" style={{ marginBottom: 4 }}>
          {modelsCaption}
        </T>
        <Row
          label="自动"
          sub={auto ? `${modelInfo(auto.provider, auto.model)?.label ?? auto.model} · ${genCost(auto.provider, auto.model, calls, quality, n)}` : '没有能生成图片的 Key'}
          value={isOn('auto') ? '✓' : ''}
          onPress={() => onChange({ route: 'auto' })}
        />
        {routing.keys.flatMap((k) =>
          modelsFor(k, 'image').map((m) => {
            const r = { keyId: k.id, model: m.id };
            return <Row key={`${k.id}:${m.id}`} label={m.label} sub={`${k.label} · ${genCost(m.provider, m.id, calls, quality, n)}`} value={isOn(r) ? '✓' : ''} onPress={() => onChange({ route: r })} />;
          }),
        )}
      </View>
      {chosen && modelInfo(chosen.provider, chosen.model)?.quality ? (
        <View style={{ gap: 8 }}>
          <T v="caption">画质：越高细节越多，也越贵</T>
          <Segmented options={QUALITY} value={quality} onChange={(q) => onChange({ quality: q })} />
        </View>
      ) : null}
      <View style={{ gap: 8 }}>
        <T v="caption">补充要求（只用于这一次）</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {quick.map((q) => (
            <Tap key={q} onPress={() => onChange({ hint: hint.trim() ? `${hint.trim()}；${q}` : q })} style={{ height: 34, paddingHorizontal: 12, borderRadius: R.pill, backgroundColor: C.card, justifyContent: 'center' }}>
              <T style={{ fontSize: 13 }}>{q}</T>
            </Tap>
          ))}
        </View>
        <TextInput
          value={hint}
          onChangeText={(h) => onChange({ hint: h })}
          placeholder={placeholder}
          placeholderTextColor={C.faint}
          multiline
          maxLength={300}
          style={{ minHeight: 72, padding: 12, borderRadius: R.tile, backgroundColor: C.card, color: C.ink, fontSize: 14, textAlignVertical: 'top' }}
        />
      </View>
      <Tap accessibilityRole="checkbox" accessibilityState={{ checked: makeDefault }} onPress={() => onChange({ makeDefault: !makeDefault })} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
        <Checkbox on={makeDefault} />
        <T style={{ fontSize: 14 }}>{defaultLabel}</T>
      </Tap>
    </>
  );
}

function genCost(provider: ProviderId, model: string, calls: number[], quality: Quality, n: number): string {
  return formatEstimate(addCosts(...calls.map((inputImages) => estimateCost(provider, model, { inputImages, quality, n }))));
}

function useChoice(routing: Routing, purpose: 'catalog' | 'tryon', quality: Quality) {
  const [choice, setChoice] = useState<Choice>({ route: routing.routes[purpose], quality, hint: '', makeDefault: false });
  const chosen = resolveRoute(purpose, { ...routing.routes, [purpose]: choice.route }, routing.keys);
  return { choice, chosen, update: (patch: Partial<Choice>) => setChoice((c) => ({ ...c, ...patch })) };
}

/** 「重新生成」: crop, model and quality for this time, and notes that tell the AI what was wrong. */
export function RegenerateSheet({
  visible,
  onClose,
  item,
  routing,
  settings,
  onCrop,
  onSubmit,
}: {
  visible: boolean;
  onClose: () => void;
  item: Item;
  routing: Routing;
  settings: AiSettings;
  /** Opens the crop page; the sheet closes first (a modal would stay on top of it). */
  onCrop: () => void;
  onSubmit: (opts: RegenerateOptions) => void;
}) {
  const { choice, chosen, update } = useChoice(routing, 'catalog', catalogQuality(settings));
  const n = Math.max(1, Math.min(3, settings.candidates));

  return (
    <Sheet visible={visible} onClose={onClose} title="重新生成">
      <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 18 }} keyboardShouldPersistTaps="handled">
        <View>
          <Row label="调整框选" sub={item.crop ? '已按框裁剪，可以重新框' : '现在用整张照片'} onPress={onCrop} last />
        </View>
        <GenOptions
          purpose="catalog"
          routing={routing}
          value={choice}
          onChange={update}
          calls={[1]}
          n={n}
          modelsCaption={`模型（每次生成 ${n} 张）`}
          quick={['颜色更浅', '颜色更深', '保留 logo', '保留面料纹理', '拉链、纽扣颜色和原图一致']}
          placeholder="例如：胸前有蓝色小马标；面料是竖条纹针织"
          defaultLabel="以后商品图都用这个模型和画质"
        />
      </ScrollView>
      <Btn
        label={chosen ? `重新生成 · ${genCost(chosen.provider, chosen.model, [1], choice.quality, n)}` : '没有能生成图片的 Key'}
        disabled={!chosen}
        onPress={() => onSubmit({ model: choice.route, quality: choice.quality, hint: choice.hint, makeDefault: choice.makeDefault })}
      />
    </Sheet>
  );
}

/** Before a try-on is generated: what it is and what it costs, with the same choices as 重新生成. */
export function TryonSheet({
  visible,
  onClose,
  title,
  summary,
  routing,
  settings,
  calls,
  note,
  onSubmit,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  summary: string;
  routing: Routing;
  settings: AiSettings;
  calls: number[];
  note?: string;
  onSubmit: (opts: TryonOptions) => void;
}) {
  const { choice, chosen, update } = useChoice(routing, 'tryon', tryonQuality(settings));
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 18 }} keyboardShouldPersistTaps="handled">
        <View style={{ gap: 4 }}>
          <T style={{ fontSize: 14 }}>{summary}</T>
          <T v="small" style={{ color: C.sub }}>
            由你的 AI 账户按量计费。{note ?? ''}
          </T>
        </View>
        <GenOptions
          purpose="tryon"
          routing={routing}
          value={choice}
          onChange={update}
          calls={calls}
          modelsCaption="模型"
          quick={['更合身', '宽松一点', '袖子卷起', '裤脚卷边', '和衣服图颜色一致']}
          placeholder="例如：衬衫领口露在毛衣外面；外套拉链拉到胸口"
          defaultLabel="以后上身效果都用这个模型和画质"
        />
      </ScrollView>
      <Btn
        label={chosen ? `生成 · ${genCost(chosen.provider, chosen.model, calls, choice.quality, 1)}` : '没有能生成图片的 Key'}
        disabled={!chosen || calls.length === 0}
        onPress={() => onSubmit({ model: choice.route, quality: choice.quality, hint: choice.hint, makeDefault: choice.makeDefault })}
      />
    </Sheet>
  );
}
