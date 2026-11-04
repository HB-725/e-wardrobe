import { Image } from 'expo-image';
import { type ReactNode, useEffect, useState } from 'react';
import { type LayoutChangeEvent, Pressable, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import { type Box, dragBox, type Handle, handleAt } from '@/domain/crop';
import type { Detection } from '@/domain/types';
import { T } from './kit';
import { C } from './theme';

interface Frame {
  w: number;
  h: number;
}

/**
 * The whole photo at its own proportions, as large as fits the space (`maxHeight` caps it in a scroll view),
 * with `overlay` drawn on top in the photo's pixel frame.
 */
export function FittedPhoto({ uri, maxHeight, overlay }: { uri: string; maxHeight?: number; overlay?: (f: Frame) => ReactNode }) {
  const [space, setSpace] = useState<Frame | null>(null);
  const [aspect, setAspect] = useState<number | null>(null);
  const onLayout = (e: LayoutChangeEvent) => setSpace({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
  let frame: Frame | null = null;
  if (space && aspect) {
    const h = Math.min(maxHeight ?? (space.h || Infinity), space.w / aspect);
    frame = { w: h * aspect, h };
  }
  return (
    <View onLayout={onLayout} style={{ flex: maxHeight ? undefined : 1, minHeight: 120, alignItems: 'center', justifyContent: 'center' }}>
      <View style={frame ? { width: frame.w, height: frame.h } : { width: '100%', height: 240 }}>
        <Image
          source={{ uri }}
          style={{ width: '100%', height: '100%' }}
          contentFit="contain"
          onLoad={(e) => e.source.width && e.source.height && setAspect(e.source.width / e.source.height)}
        />
        {frame ? overlay?.(frame) : null}
      </View>
    </View>
  );
}

/** Whole points, so the dimmed pieces around a box meet without a darker overlapping seam. */
const pos = (b: Box, f: Frame) => {
  const left = Math.round(b.x * f.w);
  const top = Math.round(b.y * f.h);
  return { left, top, width: Math.round((b.x + b.w) * f.w) - left, height: Math.round((b.y + b.h) * f.h) - top };
};

/** How far from a corner, in points, a touch still grabs it. */
const GRAB = 28;

/** One crop box to drag: corners resize, the inside moves it; the rest of the photo is dimmed. */
export function CropBox({ uri, box, onChange }: { uri: string; box: Box; onChange: (b: Box) => void }) {
  return <FittedPhoto uri={uri} overlay={(f) => <BoxEditor frame={f} box={box} onChange={onChange} />} />;
}

/** The box being dragged, outside React: gesture callbacks read the latest box and frame, synced by an effect. */
class BoxDrag {
  private box: Box = { x: 0, y: 0, w: 1, h: 1 };
  private frame: Frame = { w: 1, h: 1 };
  private grab: { box: Box; handle: Handle } | null = null;

  sync(box: Box, frame: Frame) {
    this.box = box;
    this.frame = frame;
  }

  begin(x: number, y: number) {
    const f = this.frame;
    const handle = handleAt(this.box, x / f.w, y / f.h, GRAB / f.w, GRAB / f.h);
    this.grab = handle ? { box: this.box, handle } : null;
  }

  move(dx: number, dy: number): Box | null {
    return this.grab ? dragBox(this.grab.box, this.grab.handle, dx / this.frame.w, dy / this.frame.h) : null;
  }

  end() {
    this.grab = null;
  }
}

function BoxEditor({ frame, box, onChange }: { frame: Frame; box: Box; onChange: (b: Box) => void }) {
  const [drag] = useState(() => new BoxDrag());
  useEffect(() => drag.sync(box, frame), [drag, box, frame]);
  // Gesture handler rather than PanResponder: PanResponder touches never reached this view on Android.
  const pan = usePanGesture({
    runOnJS: true,
    minDistance: 0,
    onBegin: (e) => drag.begin(e.x, e.y),
    onUpdate: (e) => {
      const next = drag.move(e.translationX, e.translationY);
      if (next) onChange(next);
    },
    onFinalize: () => drag.end(),
  });
  const p = pos(box, frame);
  const dim = { position: 'absolute' as const, backgroundColor: C.overlay };
  const corner = (left: number, top: number) => (
    <View key={`${left}:${top}`} pointerEvents="none" style={{ position: 'absolute', left: left - 9, top: top - 9, width: 18, height: 18, borderRadius: 9, backgroundColor: '#FFFFFF', borderWidth: 2, borderColor: C.ink }} />
  );
  return (
    <GestureDetector gesture={pan}>
      {/* Touches land on this one view (the pieces below ignore them), so x / y are in the photo's frame. */}
      <View collapsable={false} style={{ position: 'absolute', left: 0, top: 0, width: frame.w, height: frame.h }}>
      {/* Each piece ignores touches itself: a pass-through parent may be flattened away on Android. */}
      <View pointerEvents="none" style={[dim, { left: 0, top: 0, width: frame.w, height: p.top }]} />
      <View pointerEvents="none" style={[dim, { left: 0, top: p.top + p.height, width: frame.w, height: frame.h - p.top - p.height }]} />
      <View pointerEvents="none" style={[dim, { left: 0, top: p.top, width: p.left, height: p.height }]} />
      <View pointerEvents="none" style={[dim, { left: p.left + p.width, top: p.top, width: frame.w - p.left - p.width, height: p.height }]} />
      <View pointerEvents="none" style={{ position: 'absolute', ...p, borderWidth: 2, borderColor: '#FFFFFF' }} />
      {[corner(p.left, p.top), corner(p.left + p.width, p.top), corner(p.left, p.top + p.height), corner(p.left + p.width, p.top + p.height)]}
      </View>
    </GestureDetector>
  );
}

/** The garments found on a photo: a dot on each (numbered once chosen), and the box of each chosen one. */
export function PickMarks({ uri, detections, onToggle, maxHeight }: { uri: string; detections: Detection[]; onToggle: (i: number) => void; maxHeight: number }) {
  let n = 0;
  const order = detections.map((d) => (d.selected ? ++n : 0));
  return (
    <FittedPhoto
      uri={uri}
      maxHeight={maxHeight}
      overlay={(f) => {
        const dots = dotPositions(detections, f);
        return detections.map((d, i) => {
          const p = pos(d.box, f);
          return (
            <View key={i} pointerEvents="box-none" style={{ position: 'absolute', left: 0, top: 0, width: f.w, height: f.h }}>
              {d.selected ? <View pointerEvents="none" style={{ position: 'absolute', ...p, borderWidth: 2, borderColor: '#FFFFFF', borderRadius: 4 }} /> : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${d.selected ? '取消' : '选择'}${d.name}`}
                accessibilityState={{ selected: d.selected }}
                onPress={() => onToggle(i)}
                hitSlop={12}
                style={{
                  position: 'absolute',
                  left: dots[i].x - 13,
                  top: dots[i].y - 13,
                  width: 26,
                  height: 26,
                  borderRadius: 13,
                  borderWidth: 3,
                  borderColor: '#FFFFFF',
                  backgroundColor: d.selected ? C.ink : 'rgba(255,255,255,0.55)',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {d.selected ? <T style={{ color: '#FFFFFF', fontSize: 11, fontWeight: '700' }}>{order[i]}</T> : null}
              </Pressable>
            </View>
          );
        });
      }}
    />
  );
}

/** Dot centres: each garment's middle, pushed down while it would cover an earlier dot (a T-shirt under an open jacket). */
function dotPositions(detections: Detection[], f: Frame): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const d of detections) {
    const x = (d.box.x + d.box.w / 2) * f.w;
    let y = (d.box.y + d.box.h / 2) * f.h;
    while (out.some((o) => Math.abs(o.x - x) < 30 && Math.abs(o.y - y) < 30) && y < f.h - 16) y += 32;
    out.push({ x, y });
  }
  return out;
}
