import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { C } from './theme';

export type IconName =
  | 'today'
  | 'wardrobe'
  | 'fitting'
  | 'outfits'
  | 'me'
  | 'back'
  | 'forward'
  | 'plus'
  | 'close'
  | 'camera'
  | 'lock'
  | 'album'
  | 'flash'
  | 'play'
  | 'check';

const PATHS: Record<IconName, React.ReactNode> = {
  today: (
    <>
      <Rect x={4} y={5} width={16} height={15} />
      <Path d="M4 10h16M9 3v4M15 3v4" />
      <Rect x={10.5} y={13} width={3} height={3} fill="currentColor" stroke="none" />
    </>
  ),
  wardrobe: (
    <>
      <Path d="M10 6.5a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9V11" />
      <Path d="M12 11l-8.6 6.2a1 1 0 0 0 .6 1.8h16a1 1 0 0 0 .6-1.8z" />
    </>
  ),
  fitting: (
    <>
      <Circle cx={12} cy={4.5} r={2.2} />
      <Path d="M12 7.5v7M7.5 10.5h9M12 14.5l-3 6.5M12 14.5l3 6.5" />
    </>
  ),
  outfits: (
    <>
      <Path d="M12 3L3 8l9 5 9-5-9-5z" />
      <Path d="M3 13l9 5 9-5" />
    </>
  ),
  me: (
    <>
      <Circle cx={12} cy={8} r={4} />
      <Path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" />
    </>
  ),
  back: <Path d="M15 6l-6 6 6 6" />,
  forward: <Path d="M9 6l6 6-6 6" />,
  plus: <Path d="M12 5v14M5 12h14" />,
  close: <Path d="M6 6l12 12M18 6L6 18" />,
  camera: (
    <>
      <Path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <Circle cx={12} cy={13} r={3.5} />
    </>
  ),
  lock: (
    <>
      <Rect x={5} y={11} width={14} height={10} />
      <Path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  album: (
    <>
      <Rect x={3} y={5} width={14} height={14} />
      <Path d="M7 3h14v14" />
      <Path d="M3 15l4-4 4 4 2-2 4 4" />
    </>
  ),
  flash: <Path d="M13 3L5 13h6l-1 8 8-10h-6z" />,
  play: <Path d="M8 5v14l11-7z" fill="currentColor" stroke="none" />,
  check: <Path d="M5 12.5l4.5 4.5L19 7.5" />,
};

export function Icon({ name, size = 24, color = C.ink, strokeWidth = 1.7 }: { name: IconName; size?: number; color?: string; strokeWidth?: number }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      color={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name]}
    </Svg>
  );
}
