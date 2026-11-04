import { router } from 'expo-router';
import { useState } from 'react';
import { Linking, TextInput, View } from 'react-native';
import { modelKind, type ProviderId, PURPOSES } from '@/ai/catalog';
import { AiError, describeAiError } from '@/ai/client';
import { addKey, createClient, getKeySecret, listKeys, markVerified, probeModels, PROVIDER_LABEL } from '@/ai/keys';
import { secureSecrets } from '@/platform/secrets';
import { useApp } from '@/state/app';
import { notify } from '@/ui/dialogs';
import { Icon } from '@/ui/Icon';
import { Btn, NavHeader, PrivacyNote, Screen, Segmented, T, Tap } from '@/ui/kit';
import { C, PAD, R } from '@/ui/theme';

const SPEC: Record<ProviderId, { steps: string[]; url: string; host: string; pattern: RegExp; badFormat: string; placeholder: string }> = {
  openai: {
    steps: ['打开 platform.openai.com', '充值（$5 起）', '创建 Key，复制 sk- 开头的', '粘贴并保存'],
    url: 'https://platform.openai.com/api-keys',
    host: 'api.openai.com',
    pattern: /^sk-[\w-]{20,}$/,
    badFormat: '格式不对：OpenAI 的 Key 以 sk- 开头，通常有 50 个字符以上',
    placeholder: 'sk-...',
  },
  gemini: {
    steps: ['打开 aistudio.google.com，登录 Google 账号', '点「Get API key」创建 Key 并复制', '粘贴并保存', '生图失败时，在 AI Studio 里开通结算'],
    url: 'https://aistudio.google.com/apikey',
    host: 'generativelanguage.googleapis.com',
    // Google does not document the format; only obvious paste mistakes are caught here, verification does the rest.
    pattern: /^[\w.-]{30,}$/,
    badFormat: '格式不对：Gemini 的 Key 通常以 AIza 或 AQ. 开头，39 个字符以上',
    placeholder: 'AIza...',
  },
};

export default function AddKeyPage() {
  const app = useApp();
  const [provider, setProvider] = useState<ProviderId>('openai');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const spec = SPEC[provider];
  const name = PROVIDER_LABEL[provider];

  const save = async () => {
    const k = key.trim();
    if (!spec.pattern.test(k)) {
      setError(spec.badFormat);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      for (const x of (await listKeys(app.db)).filter((x) => x.provider === provider)) {
        if ((await getKeySecret(secureSecrets, x.id)) === k) throw new Error(`这个 Key 已经添加过了（${x.label}）`);
      }
      const models = await probeModels(provider, createClient(provider, k, 20_000));
      if (models.length === 0) throw new AiError('model', 'no usable models');
      const entry = await addKey(app.db, secureSecrets, provider, k);
      await markVerified(app.db, entry.id, models);
      await app.reloadKey();
      const uses = PURPOSES.filter((p) => models.some((m) => modelKind(provider, m) === p.kind)).map((p) => p.label);
      app.toast(`Key 已保存，可用于：${uses.join(' / ')}`);
      router.back();
    } catch (e) {
      setError(
        e instanceof AiError && e.kind === 'model'
          ? provider === 'openai'
            ? '这个 Key 没有可用的模型。请确认账户已充值，部分模型需要在 OpenAI 后台完成组织验证。'
            : '这个 Key 没有可用的 Gemini 模型，请确认 Key 来自 Google AI Studio。'
          : e instanceof AiError && e.kind === 'network'
            ? `连不上 ${name}，请检查网络后再试一次`
            : describeAiError(e, true),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen footer={<Btn label="验证并保存" style={{ flex: 1 }} loading={busy} disabled={!key.trim()} onPress={save} />}>
      <NavHeader title="添加 API Key" />
      <View style={{ padding: PAD, gap: 16 }}>
        <Segmented
          options={[
            { id: 'openai', label: 'OpenAI' },
            { id: 'gemini', label: 'Google Gemini' },
          ]}
          value={provider}
          onChange={(p) => {
            setProvider(p);
            setError(null);
          }}
        />
        <T v="body" style={{ color: C.sub }}>
          费用由你的 {name} 账户支付，录入一件约 $0.01
        </T>
        <TextInput
          value={key}
          onChangeText={(t) => {
            setKey(t);
            setError(null);
          }}
          placeholder={spec.placeholder}
          placeholderTextColor={C.faint}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          accessibilityLabel="API Key"
          style={{ height: 50, paddingHorizontal: 14, borderRadius: R.input, backgroundColor: C.card, borderWidth: error ? 1 : 0, borderColor: C.danger, fontSize: 15, color: C.ink }}
        />
        {error ? <T style={{ fontSize: 13, color: C.danger, lineHeight: 20 }}>{error}</T> : null}
        <View style={{ backgroundColor: C.card, borderRadius: R.card, padding: 16, gap: 10 }}>
          <T style={{ fontSize: 13, fontWeight: '700' }}>怎么获取 Key</T>
          {spec.steps.map((s, i) => (
            <View key={s} style={{ flexDirection: 'row', gap: 10 }}>
              <T style={{ fontSize: 12, color: C.sub, width: 18 }}>0{i + 1}</T>
              <T v="small" style={{ flex: 1 }}>
                {s}
              </T>
            </View>
          ))}
          <Tap onPress={() => Linking.openURL(spec.url)} style={{ minHeight: 40, justifyContent: 'center' }}>
            <T style={{ fontSize: 13, textDecorationLine: 'underline' }}>打开 {spec.url.replace('https://', '')}</T>
          </Tap>
        </View>
        <Tap
          onPress={() => notify(`连不上 ${name}？`, `手机需要能访问 ${spec.host}。部分地区（例如中国大陆）无法直接连接，AI 功能会提示网络连接失败。`)}
          style={{ minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 6 }}
        >
          <Icon name="info" size={15} color={C.sub} strokeWidth={1.8} />
          <T v="caption">连不上 {name}？</T>
        </Tap>
        <PrivacyNote text={`Key 加密保存在本机，只用来请求 ${name}`} />
      </View>
    </Screen>
  );
}
