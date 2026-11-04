import { useCallback } from 'react';
import type { ProviderId } from '@/ai/catalog';
import { pendingConsent, PROVIDER_LABEL, setConsentFor } from '@/ai/keys';
import { askAsync } from '@/ui/dialogs';
import { useApp } from './app';

const POLICY: Record<ProviderId, string> = {
  openai: 'OpenAI 默认不用 API 数据训练模型，但可能保留最多 30 天用于安全审查。',
  gemini: 'Google 在你使用免费额度时可能用这些内容改进其产品（可能有人工审核）；开通结算后不会这样使用，但会保留一段时间用于滥用监测。以 Google 的 Gemini API 条款为准。',
};

export function consentTitle(providers: ProviderId[]): string {
  return `照片会发送给 ${providers.map((p) => PROVIDER_LABEL[p]).join(' 和 ')}`;
}

export function photoNotice(providers: ProviderId[]): string {
  const names = providers.map((p) => PROVIDER_LABEL[p]).join(' 和 ');
  return [
    `生成商品图、个人形象、上身效果和识别镜子照片时，用到的照片（包括全身照）会通过你的 API Key 发送给 ${names} 处理。`,
    ...providers.map((p) => POLICY[p]),
    '原图和生成结果只保存在这台手机上。',
  ].join('');
}

/** Asks before the first photo goes to each provider the current settings use; remembers the answer. Resolves false if declined. */
export function usePhotoConsent() {
  const app = useApp();
  return useCallback(async (): Promise<boolean> => {
    const pending = await pendingConsent(app.db);
    if (pending.length === 0) return true;
    const ok = await askAsync(consentTitle(pending), photoNotice(pending), '同意并继续');
    if (ok) {
      for (const p of pending) await setConsentFor(app.db, p);
      // Jobs paused for want of consent can continue.
      await app.reloadKey();
    }
    return ok;
  }, [app]);
}
