import { Image } from 'expo-image';
import { ActivityIndicator, Text, View, type ViewStyle } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { SLOT_ORDER } from '@/domain/catalog';
import type { Item, Slot } from '@/domain/types';
import { displayUri } from '@/state/actions';
import { C } from './theme';


/** A garment picture on the card colour. Falls back to the name when there is no image (Excel imports). */
/**
 * A garment's picture filling its tile edge to edge. Catalog images are 2:3 with generous margins, so tiles between
 * 2:3 and 3:4 lose nothing; filling avoids a visible box where the generated background is a shade off the tile.
 */
export function ItemImage({ item, style }: { item: Pick<Item, 'catalogUri' | 'originalUri' | 'candidates' | 'name' | 'status'>; style?: ViewStyle }) {
  const uri = displayUri(item);
  return (
    <View style={[{ backgroundColor: C.card, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }, style]}>
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

/** Flat-lay of an outfit's garments in a 2×2 grid; used when no AI try-on image exists yet. */
export function OutfitBoard({ items, tryonUri, style, compact }: { items: Item[]; tryonUri?: string | null; style?: ViewStyle; compact?: boolean }) {
  if (tryonUri) {
    return (
      <View style={[{ backgroundColor: C.card, overflow: 'hidden' }, style]}>
        <Image source={{ uri: tryonUri }} style={{ width: '100%', height: '100%' }} contentFit="cover" contentPosition="top" transition={120} />
      </View>
    );
  }
  // Read top to bottom like a person: outerwear, top, bottoms, shoes, bag, accessories. The garment pictures are
  // laid out as separate tiles on white, so their slightly different backgrounds read as intended edges.
  const shown = [...items].sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot)).slice(0, 4);
  const extra = items.length - shown.length;
  const gap = compact ? 2 : 6;
  return (
    <View style={[{ backgroundColor: '#FFFFFF', padding: compact ? 2 : 10, flexDirection: 'row', flexWrap: 'wrap', alignContent: 'center', justifyContent: 'center', gap }, style]}>
      {shown.map((it, i) => (
        <View key={it.id} style={{ width: shown.length === 1 ? '90%' : `${(100 - 8) / 2}%`, aspectRatio: 0.75 }}>
          <ItemImage item={it} style={{ flex: 1 }} />
          {extra > 0 && !compact && i === shown.length - 1 ? (
            <View style={{ position: 'absolute', right: 2, bottom: 2, backgroundColor: C.ink, paddingHorizontal: 5 }}>
              <Text style={{ color: '#FFFFFF', fontSize: 10 }}>+{extra}</Text>
            </View>
          ) : null}
        </View>
      ))}
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

/** Garment cards beside the figure in the instant (free) preview, in bands from head to feet. */
const BANDS: Slot[] = ['accessory', 'outer', 'top', 'bag', 'bottom', 'shoes'];

export function Stage({
  avatarUri,
  items,
  tryonUri,
  busy,
  style,
}: {
  avatarUri: string | null;
  items: Item[];
  tryonUri: string | null;
  busy?: boolean;
  style?: ViewStyle;
}) {
  return (
    <View style={[{ backgroundColor: C.card, overflow: 'hidden' }, style]}>
      {tryonUri ? (
        <Image source={{ uri: tryonUri }} style={{ width: '100%', height: '100%' }} contentFit="cover" contentPosition="top" transition={200} />
      ) : (
        <>
          {/* The figure fills the stage exactly as the AI try-on will; the chosen garments sit in a narrow column
              on the right edge at about the height they are worn, so nothing looks "worn" before the try-on. */}
          {avatarUri ? <Image source={{ uri: avatarUri }} style={{ width: '100%', height: '100%' }} contentFit="cover" contentPosition="top" /> : <Silhouette />}
          <View style={{ position: 'absolute', right: 4, top: '2%', bottom: '2%', width: 60 }}>
            {BANDS.map((slot) => {
              const it = items.find((x) => x.slot === slot);
              return (
                <View key={slot} style={{ flex: 1, justifyContent: 'center', alignItems: 'flex-end' }}>
                  {it ? (
                    <View style={{ height: '94%', maxHeight: 80, aspectRatio: 0.75, padding: 2, backgroundColor: '#FFFFFF', boxShadow: '0 1px 3px rgba(0,0,0,0.18)' }}>
                      <ItemImage item={it} style={{ flex: 1 }} />
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        </>
      )}
      {busy ? (
        <View style={{ position: 'absolute', left: 8, top: 8, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.scrim, paddingHorizontal: 8, paddingVertical: 4 }}>
          <ActivityIndicator size="small" color="#FFFFFF" />
          <Text style={{ color: '#FFFFFF', fontSize: 11 }}>正在生成上身效果</Text>
        </View>
      ) : null}
    </View>
  );
}
