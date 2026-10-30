import { useCallback } from 'react';
import { hasPhotoConsent, setPhotoConsent } from '@/ai/config';
import { askAsync } from '@/ui/dialogs';
import { useApp } from './app';

export const PHOTO_NOTICE =
  '生成商品图、个人形象、上身效果和识别镜子照片时，用到的照片（包括全身照）会通过你的 API Key 发送给 OpenAI 处理。OpenAI 默认不用 API 数据训练模型，但可能保留最多 30 天用于安全审查。原图和生成结果只保存在这台手机上。';

/** Asks once, before the first photo is sent to OpenAI; remembers the answer. Resolves false if declined. */
export function usePhotoConsent() {
  const app = useApp();
  return useCallback(async (): Promise<boolean> => {
    if (await hasPhotoConsent(app.db)) return true;
    const ok = await askAsync('照片会发送给 OpenAI', PHOTO_NOTICE, '同意并继续');
    if (ok) {
      await setPhotoConsent(app.db);
      // Jobs paused for want of consent can continue.
      await app.reloadKey();
    }
    return ok;
  }, [app]);
}
