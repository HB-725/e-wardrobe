import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Text, View, type ViewStyle } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { SLOT_ORDER } from '@/domain/catalog';
import type { Item } from '@/domain/types';
import { displayUri } from '@/state/actions';
import { C, R } from './theme';


/** A garment picture on the card colour. Falls back to the name when there is no image (Excel imports). */
/**
 * A garment's picture filling its tile edge to edge. Catalog images are 2:3 with generous margins, so tiles between
 * 2:3 and 3:4 lose nothing; filling avoids a visible box where the generated background is a shade off the tile.
 */
export function ItemImage({ item, style }: { item: Pick<Item, 'catalogUri' | 'originalUri' | 'candidates' | 'name' | 'status'>; style?: ViewStyle }) {
  const uri = displayUri(item);
  return (
    <View style={[{ backgroundColor: C.card, borderRadius: R.tile, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }, style]}>
      {uri ? (
        <Image
          source={{ uri }}
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}
          contentFit="cover"
          transition={120}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <Text style={{ fontSize: 11, color: C.sub, textAlign: 'center', paddingHorizontal: 4 }} numberOfLines={2}>
          {item.name}
        </Text>
      )}
      {item.status === 'processing' ? (
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(241,241,242,0.55)', alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="small" color={C.ink} />
        </View>
      ) : null}
    </View>
  );
}

const MIN_TILE = 24;

/** Flat-lay of an outfit's garments in a 2×2 grid; used when no AI try-on image exists yet. */
export function OutfitBoard({ items, tryonUri, style, compact }: { items: Item[]; tryonUri?: string | null; style?: ViewStyle; compact?: boolean }) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  if (tryonUri) {
    return (
      <View style={[{ backgroundColor: C.card, borderRadius: compact ? R.small : R.card, overflow: 'hidden' }, style]}>
        <Image source={{ uri: tryonUri }} style={{ width: '100%', height: '100%' }} contentFit="cover" contentPosition="top" transition={120} />
      </View>
    );
  }
  // Read top to bottom like a person: outerwear, top, bottoms, shoes, bag, accessories. The garment pictures are
  // laid out as separate tiles on white, so their slightly different backgrounds read as intended edges.
  const shown = [...items].sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot)).slice(0, 4);
  const extra = items.length - shown.length;
  const gap = compact ? 2 : 6;
  const pad = compact ? 2 : 10;
  return (
    <View
      style={[{ backgroundColor: '#FFFFFF', borderRadius: compact ? R.small : R.card, padding: pad, flexDirection: 'row', flexWrap: 'wrap', alignContent: 'center', justifyContent: 'center', gap, overflow: 'hidden' }, style]}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (width !== box.width || height !== box.height) setBox({ width, height });
      }}
    >
      {box.width > 0
        ? shown.map((it, i) => {
            // 3:4 tiles as large as fit both across and down (two columns unless there is a single garment).
            const fit = (n: number) => {
              const cols = n === 1 ? 1 : 2;
              const rows = Math.ceil(n / cols);
              // Floored with a pixel to spare: a rounding hair over the width would wrap the row.
              return Math.max(0, Math.floor(Math.min((box.width - 2 * pad - gap * (cols - 1)) / cols, ((box.height - 2 * pad - gap * (rows - 1)) / rows) * 0.75)) - 1);
            };
            // Too small to tell garments apart (calendar cells): show only the outermost one.
            if (fit(shown.length) < MIN_TILE && i > 0) return null;
            const w = fit(shown.length) < MIN_TILE ? fit(1) : fit(shown.length);
            return (
              <View key={it.id} style={{ width: w, height: w / 0.75 }}>
                <ItemImage item={it} style={{ flex: 1, borderRadius: compact ? 4 : R.tile }} />
                {extra > 0 && !compact && i === shown.length - 1 ? (
                  <View style={{ position: 'absolute', right: 4, bottom: 4, borderRadius: R.pill, backgroundColor: C.ink, paddingHorizontal: 6 }}>
                    <Text style={{ color: '#FFFFFF', fontSize: 10 }}>+{extra}</Text>
                  </View>
                ) : null}
              </View>
            );
          })
        : null}
    </View>
  );
}

/** Placeholder person drawn when no avatar has been generated yet. */
export function Silhouette({ color = '#B9B9BE' }: { color?: string }) {
  return (
    <Svg viewBox="0 0 100 300" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
      <Circle cx={50} cy={26} r={14} fill={color} />
      <Path d="M30 48 Q50 42 70 48 L78 120 L70 122 L66 80 L64 160 L62 282 L52 282 L50 170 L48 282 L38 282 L36 160 L34 80 L30 122 L22 120 Z" fill={color} />
    </Svg>
  );
}

/**
 * The figure: the try-on once there is one, else the avatar (or a silhouette). What is put on is listed in the
 * fitting room's drawer, not drawn here, so nothing looks "worn" before the try-on. While one is being made a
 * light band sweeps down the figure.
 */
/** `layers`: garment layers in the avatar's own coordinates, stacked over it exactly as it is drawn (see domain/layers). */
export function Stage({ avatarUri, tryonUri, layers = [], busy, style }: { avatarUri: string | null; tryonUri: string | null; layers?: string[]; busy?: boolean; style?: ViewStyle }) {
  return (
    <View style={[{ backgroundColor: C.card, borderRadius: R.card, overflow: 'hidden' }, style]}>
      {tryonUri ? (
        <Image source={{ uri: tryonUri }} style={{ width: '100%', height: '100%' }} contentFit="cover" contentPosition="top" transition={200} />
      ) : avatarUri ? (
        <>
          <Image source={{ uri: avatarUri }} style={{ width: '100%', height: '100%' }} contentFit="cover" contentPosition="top" />
          {layers.map((uri) => (
            <Image key={uri} source={{ uri }} pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' }} contentFit="cover" contentPosition="top" transition={150} />
          ))}
        </>
      ) : (
        <View style={{ position: 'absolute', left: '30%', right: '30%', top: '8%', bottom: '4%', opacity: 0.6 }}>
          <Silhouette color="#C9C9CC" />
        </View>
      )}
      {busy ? <Sweep /> : null}
    </View>
  );
}

function Sweep() {
  const [y] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(y, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [y]);
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, overflow: 'hidden' }}>
      <Animated.View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          height: '30%',
          backgroundColor: 'rgba(255,255,255,0.35)',
          transform: [{ translateY: y.interpolate({ inputRange: [0, 1], outputRange: [-300, 900] }) }],
        }}
      />
    </View>
  );
}
