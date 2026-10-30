import { useCallback } from 'react';
import { getLogByDate } from '@/db/wear';
import { currentDateKey } from '@/domain/stats';
import type { WearSource } from '@/domain/types';
import { confirmAsync } from '@/ui/dialogs';
import { recordWear } from './actions';
import { useApp } from './app';

/**
 * Records what is worn today. The date is taken at the moment of the tap (the app may have been open since
 * yesterday), and replacing a different outfit already logged today asks first, since it also drops that
 * day's mirror photo. Resolves false when the user cancelled.
 */
export function useRecordToday() {
  const app = useApp();
  return useCallback(
    async (input: { itemIds: string[]; source: WearSource; outfitId?: string | null; photoUri?: string | null }): Promise<boolean> => {
      const date = currentDateKey();
      const prev = await getLogByDate(app.db, date);
      const same = prev && prev.itemIds.length === input.itemIds.length && prev.itemIds.every((id) => input.itemIds.includes(id));
      const extends_ = prev && input.photoUri === undefined && prev.itemIds.every((id) => input.itemIds.includes(id));
      if (prev && !same && !extends_) {
        const ok = await confirmAsync(
          '替换今天的记录？',
          `今天已经记录了另一套穿搭${prev.photoUri ? '（带镜子照片，替换后照片会删除）' : ''}。要换成这一套吗？`,
          '替换',
        );
        if (!ok) return false;
      }
      await recordWear(app, { date, ...input });
      app.refresh();
      return true;
    },
    [app],
  );
}
