import { router } from 'expo-router';
import { useState } from 'react';
import { Linking, TextInput, View } from 'react-native';
import { AiError, createOpenAiClient, describeAiError } from '@/ai/client';
import { saveModelChoice } from '@/ai/config';
import { verifyKey } from '@/ai/engine';
import { getSetting, setSetting } from '@/db/misc';
import { setApiKey } from '@/platform/secrets';
import { useApp, useData } from '@/state/app';
import { confirmAsync } from '@/ui/dialogs';
import { Btn, NavHeader, PrivacyNote, Screen, T, Tap } from '@/ui/kit';
import { C, PAD } from '@/ui/theme';

const STEPS = [
  '打开 platform.openai.com 并登录（没有账号就注册一个）',
  '在 Billing 里充值，最低 $5 就够用很久',
  '在 API keys 页面点 Create new secret key，复制以 sk- 开头的 Key',
  '回到这里粘贴，点「验证并保存」',
];

export default function ApiKeyPage() {
  const app = useApp();
  const last4 = useData((db) => getSetting(db, 'ai.keyLast4'));
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const k = key.trim();
    if (!/^sk-[\w-]{20,}$/.test(k)) {
      setError('格式不对：OpenAI 的 Key 以 sk- 开头，通常有 50 个字符以上');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await verifyKey(createOpenAiClient({ apiKey: k, timeoutMs: 20_000 }));
      if (!r.image || !r.vision) throw new AiError('model', 'missing models');
      await setApiKey(k);
      await setSetting(app.db, 'ai.keyLast4', k.slice(-4));
      await saveModelChoice(app.db, { image: r.image, vision: r.vision, blocked: [], probedAt: new Date().toISOString() });
      await app.reloadKey();
      app.toast(`Key 已保存，将使用 ${r.image} 和 ${r.vision}`);
      router.back();
    } catch (e) {
      setError(
        e instanceof AiError && e.kind === 'model'
          ? '这个 Key 没有可用的图像模型。请确认账户已充值，部分模型需要在 OpenAI 后台完成组织验证。'
          : e instanceof AiError && e.kind === 'network'
            ? '连不上 OpenAI，请检查网络后再试一次'
            : describeAiError(e, true),
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!(await confirmAsync('删除 API Key', '删除后 AI 功能会暂停，衣橱里已有的内容不受影响。'))) return;
    await setApiKey(null);
    await setSetting(app.db, 'ai.keyLast4', '');
    await app.reloadKey();
    router.back();
  };

  return (
    <Screen
      footer={
        <>
          {last4 ? <Btn label="删除 Key" kind="outline" style={{ flex: 1 }} onPress={remove} /> : null}
          <Btn label="验证并保存" style={{ flex: 2 }} loading={busy} disabled={!key.trim()} onPress={save} />
        </>
      }
    >
      <NavHeader title="OpenAI API Key" />
      <View style={{ padding: PAD, gap: 16 }}>
        <T v="body" style={{ color: C.sub, lineHeight: 24 }}>
          生成商品图、个人形象和上身效果需要你自己的 OpenAI API Key。费用直接由 OpenAI 按用量收取，录入一件衣服大约 $0.01–0.02。
        </T>
        {last4 ? <T style={{ fontSize: 14 }}>当前已绑定 ••••{last4}，粘贴新的 Key 可以替换。</T> : null}
        <TextInput
          value={key}
          onChangeText={(t) => {
            setKey(t);
            setError(null);
          }}
          placeholder="sk-..."
          placeholderTextColor={C.faint}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          accessibilityLabel="API Key"
          style={{ height: 50, paddingHorizontal: 12, borderWidth: 1, borderColor: error ? C.danger : C.muted, fontSize: 15, color: C.ink }}
        />
        {error ? <T style={{ fontSize: 13, color: C.danger, lineHeight: 20 }}>{error}</T> : null}
        <View style={{ backgroundColor: C.card, padding: 16, gap: 10 }}>
          <T style={{ fontSize: 13, fontWeight: '700' }}>怎么获取 Key</T>
          {STEPS.map((s, i) => (
            <View key={s} style={{ flexDirection: 'row', gap: 10 }}>
              <T style={{ fontSize: 12, color: C.sub, width: 18 }}>0{i + 1}</T>
              <T v="small" style={{ flex: 1 }}>
                {s}
              </T>
            </View>
          ))}
          <Tap onPress={() => Linking.openURL('https://platform.openai.com/api-keys')} style={{ minHeight: 40, justifyContent: 'center' }}>
            <T style={{ fontSize: 13, textDecorationLine: 'underline' }}>打开 platform.openai.com/api-keys</T>
          </Tap>
        </View>
        <T v="small" style={{ color: C.sub, lineHeight: 20 }}>
          手机需要能访问 api.openai.com。部分地区（例如中国大陆）无法直接连接 OpenAI，AI 功能会提示网络连接失败。
        </T>
        <PrivacyNote text="Key 加密保存在手机的系统钥匙串里，只用来直接请求 OpenAI" />
      </View>
    </Screen>
  );
}
