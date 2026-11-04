import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { type Box, withBox } from '@/domain/crop';
import type { Detection } from '@/domain/types';
import { getItem } from '@/db/items';
import { cropItem, setDetections } from '@/state/actions';
import { useApp, useData } from '@/state/app';
import { Btn, Loading, NavHeader, Screen, T } from '@/ui/kit';
import { CropBox } from '@/ui/PhotoBoxes';
import { C, PAD } from '@/ui/theme';

const NEW_BOX: Box = { x: 0.25, y: 0.3, w: 0.5, h: 0.4 };

/**
 * Full-screen crop box. `?id=&det=<index>` adjusts a garment found on a photo, `?id=&det=new` adds one the AI missed,
 * `?id=&mode=item` re-cuts a garment from its whole photo before regenerating.
 */
export default function CropPage() {
  const app = useApp();
  const { id, det, mode } = useLocalSearchParams<{ id: string; det?: string; mode?: string }>();
  const item = useData((db) => getItem(db, id), [id]);
  const [box, setBox] = useState<Box | null>(null);
  const [busy, setBusy] = useState(false);
  if (!item) return <Loading />;

  const index = det && det !== 'new' ? Number(det) : -1;
  const photo = mode === 'item' ? (item.sourceUri ?? item.originalUri) : item.originalUri;
  const start = mode === 'item' ? (item.crop ?? { x: 0, y: 0, w: 1, h: 1 }) : (item.detections[index]?.box ?? NEW_BOX);
  const current = box ?? start;

  const done = async () => {
    setBusy(true);
    try {
      if (mode === 'item') await cropItem(app, item.id, current);
      else if (index >= 0) await setDetections(app, item.id, item.detections.map((d, i) => (i === index ? { ...withBox(d, current), selected: true } : d)));
      else {
        const drawn: Detection = { box: current, selected: true, manual: true, edited: false, name: '新衣服', slot: 'top', subcategory: null, colorName: null, colorHex: null, seasons: [], brand: null, size: null, material: null };
        await setDetections(app, item.id, [...item.detections, drawn]);
      }
      app.refresh();
      router.back();
    } catch (e) {
      app.toast(`没有保存：${String(e)}`);
      setBusy(false);
    }
  };

  return (
    <Screen
      scroll={false}
      footer={
        <>
          <Btn label="取消" kind="outline" style={{ flex: 1 }} onPress={() => router.back()} />
          <Btn label="完成" style={{ flex: 2 }} loading={busy} onPress={done} />
        </>
      }
    >
      <NavHeader title={index >= 0 ? `调整「${item.detections[index]?.name ?? ''}」的框` : mode === 'item' ? '调整框选' : '框出一件衣服'} />
      {/* Wide side margins keep the corner handles out of Android's edge swipe, which would go back instead. */}
      <View style={{ flex: 1, paddingHorizontal: 56, paddingTop: PAD, paddingBottom: 8, backgroundColor: C.card }}>
        {photo ? <CropBox uri={photo} box={current} onChange={setBox} /> : null}
      </View>
      <T v="caption" style={{ textAlign: 'center', paddingVertical: 10 }}>
        拖四个角调整大小，拖框内移动
      </T>
    </Screen>
  );
}
