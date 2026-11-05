import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { callCost, estimateCost, type KeyEntry, type ModelInfo, modelInfo, modelsFor, type Purpose, PURPOSES, resolveRoute, type Route, type Routing } from '@/ai/catalog';
import { describeAiError } from '@/ai/client';
import { type AiSettings, catalogQuality, getAiSettings, type ImageTask, qualityFor, tryonQuality } from '@/ai/config';
import { createClient, getKeySecret, loadRouting, markVerified, probeModels, PROVIDER_LABEL, removeKey, renameKey, saveRoutes } from '@/ai/keys';
import { formatEstimate } from '@/ai/models';
import type { Db } from '@/db/db';
import { secureSecrets } from '@/platform/secrets';
import { useApp, useData } from '@/state/app';
import { confirmAsync, notify } from '@/ui/dialogs';
import { Btn, Loading, NavHeader, PrivacyNote, Row, Screen, SectionTitle, Sheet, T } from '@/ui/kit';
import { C, PAD, R } from '@/ui/theme';

async function load(db: Db) {
  const [routing, settings] = await Promise.all([loadRouting(db), getAiSettings(db)]);
  return { routing, settings };
}

const label = (r: { provider: KeyEntry['provider']; model: string }) => modelInfo(r.provider, r.model)?.label ?? r.model;

/** What one use of the model costs: an image at the user's quality, or a recognition call. */
function priceText(m: ModelInfo, purpose: Purpose, settings: AiSettings): string {
  if (m.kind === 'vision') {
    const usd = callCost(m.provider, m.id, { in: 1500, out: 200 });
    return usd === null ? '价格未知' : `${formatEstimate(usd)} / 次`;
  }
  const quality = purpose === 'catalog' ? catalogQuality(settings) : purpose === 'tryon' ? tryonQuality(settings) : qualityFor(settings.quality, purpose as ImageTask);
  const usd = estimateCost(m.provider, m.id, { inputImages: purpose === 'catalog' ? 1 : 3, quality });
  return usd === null ? '价格未知' : `${formatEstimate(usd)} / 张`;
}

/** 「我的 → API 与模型」: the keys, and which model each purpose uses. */
export default function ApiPage() {
  const data = useData(load);
  if (!data) return <Loading />;
  return <Api routing={data.routing} settings={data.settings} />;
}

function Api({ routing, settings }: { routing: Routing; settings: AiSettings }) {
  const app = useApp();
  const { keys, routes } = routing;
  const [keyId, setKeyId] = useState<string | null>(null);
  const [purpose, setPurpose] = useState<Purpose | null>(null);

  const routeText = (p: Purpose) => {
    const r = resolveRoute(p, routes, keys);
    if (!r) return keys.length ? '没有可用的模型' : '自动（需要添加 Key）';
    if (routes[p] === 'auto' || r.fellBack) return `自动（${label(r)}）`;
    return `${label(r)} · ${keys.find((k) => k.id === r.keyId)?.label ?? ''}`;
  };

  const choose = async (p: Purpose, route: Route) => {
    const before = resolveRoute(p, routes, keys);
    const next = { ...routes, [p]: route };
    await saveRoutes(app.db, next);
    const after = resolveRoute(p, next, keys);
    setPurpose(null);
    await app.reloadKey(); // a queue paused for want of a model can continue
    if (!before || !after || before.model === after.model) return;
    if (p === 'catalog') notify('换了商品图模型', '新录入的衣服会用新模型，风格可能和已有的不同；可以在单品详情里重新生成。');
    if (p === 'tryon') notify('换了上身效果模型', '已生成的上身效果不会自动重画，可以点重新生成。');
  };

  const kind = purpose ? PURPOSES.find((x) => x.id === purpose)!.kind : 'image';
  const auto = purpose ? resolveRoute(purpose, { ...routes, [purpose]: 'auto' }, keys) : null;
  const key = keys.find((k) => k.id === keyId) ?? null;

  return (
    <Screen>
      <NavHeader title="API 与模型" />
      <View style={{ padding: PAD, gap: 24 }}>
        <View>
          <SectionTitle>API Key</SectionTitle>
          {keys.map((k) => (
            <Row key={k.id} label={k.label} sub={`••••${k.last4}`} value={k.verifiedAt ? `已验证 · ${k.models.length} 个可用模型` : '未验证'} onPress={() => setKeyId(k.id)} />
          ))}
          <Row label="＋ 添加 API Key" sub="OpenAI / Google Gemini" onPress={() => router.push('/addkey')} last />
        </View>
        <View>
          <SectionTitle>模型</SectionTitle>
          {PURPOSES.map((p, i) => (
            <Row key={p.id} label={p.label} value={routeText(p.id)} onPress={() => setPurpose(p.id)} last={i === PURPOSES.length - 1} />
          ))}
          <T v="caption" style={{ marginTop: 8 }}>
            「自动」在你添加的 Key 里按推荐顺序选可用的模型。
          </T>
        </View>
        <PrivacyNote text="Key 加密保存在本机，只用来请求对应的服务商" />
      </View>

      <Sheet visible={!!purpose} onClose={() => setPurpose(null)} title={purpose ? PURPOSES.find((x) => x.id === purpose)!.label : ''}>
        {purpose ? (
          <ScrollView style={{ flexGrow: 0 }}>
            <Row label="自动" sub={auto ? `当前：${label(auto)} · ${priceText(modelInfo(auto.provider, auto.model)!, purpose, settings)}` : '需要先添加 Key'} value={routes[purpose] === 'auto' ? '✓' : ''} onPress={() => choose(purpose, 'auto')} />
            {keys.flatMap((k) =>
              modelsFor(k, kind).map((m) => {
                const r = routes[purpose];
                const on = r !== 'auto' && r.keyId === k.id && r.model === m.id;
                return <Row key={`${k.id}:${m.id}`} label={m.label} sub={`${k.label} · ${priceText(m, purpose, settings)}`} value={on ? '✓' : ''} onPress={() => choose(purpose, { keyId: k.id, model: m.id })} />;
              }),
            )}
          </ScrollView>
        ) : null}
      </Sheet>

      <Sheet visible={!!key} onClose={() => setKeyId(null)} title={key?.label}>
        {key ? <KeyDetail entry={key} onDone={() => setKeyId(null)} /> : null}
      </Sheet>
    </Screen>
  );
}

function KeyDetail({ entry, onDone }: { entry: KeyEntry; onDone: () => void }) {
  const app = useApp();
  const [name, setName] = useState(entry.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uses = PURPOSES.filter((p) => modelsFor(entry, p.kind).length > 0).map((p) => p.label);
  const models = [...modelsFor(entry, 'image'), ...modelsFor(entry, 'vision')].map((m) => m.label);

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      const secret = await getKeySecret(secureSecrets, entry.id);
      if (!secret) throw new Error('这台手机上找不到这个 Key 了，请删除后重新添加');
      await markVerified(app.db, entry.id, await probeModels(entry.provider, createClient(entry.provider, secret, 20_000)));
      await app.reloadKey();
      app.toast('已重新验证');
    } catch (e) {
      setError(describeAiError(e, true));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!(await confirmAsync('删除这个 Key', '用到它的功能会改回「自动」；没有其他 Key 时 AI 功能会暂停。衣橱里已有的内容不受影响。', '删除'))) return;
    await removeKey(app.db, secureSecrets, entry.id);
    onDone();
    await app.reloadKey();
  };

  return (
    <View style={{ gap: 14 }}>
      <T v="small" style={{ color: C.sub }}>
        {PROVIDER_LABEL[entry.provider]} · ••••{entry.last4} · {entry.verifiedAt ? `验证于 ${entry.verifiedAt.slice(0, 10)}` : '未验证'}
      </T>
      <T v="small">可用于：{uses.length ? uses.join(' / ') : '无'}</T>
      {models.length ? (
        <T v="caption" numberOfLines={4}>
          {models.join('、')}
        </T>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <TextInput
          value={name}
          onChangeText={setName}
          maxLength={20}
          accessibilityLabel="Key 名称"
          style={{ flex: 1, height: 46, paddingHorizontal: 14, borderRadius: R.input, backgroundColor: C.card, fontSize: 15, color: C.ink }}
        />
        <Btn
          label="改名"
          kind="outline"
          disabled={!name.trim() || name.trim() === entry.label}
          onPress={async () => {
            await renameKey(app.db, entry.id, name);
            app.refresh();
          }}
        />
      </View>
      {error ? <T style={{ fontSize: 13, color: C.danger, lineHeight: 20 }}>{error}</T> : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Btn label="删除" kind="dangerGhost" style={{ flex: 1 }} onPress={remove} />
        <Btn label="重新验证" kind="outline" style={{ flex: 2 }} loading={busy} onPress={verify} />
      </View>
    </View>
  );
}
