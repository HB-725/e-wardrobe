import { router } from 'expo-router';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  type PressableProps,
  ScrollView,
  StyleSheet,
  Text,
  type TextProps,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { FieldSource } from '@/domain/types';
import { Icon, type IconName } from './Icon';
import { C, PAD } from './theme';

// ---------- text ----------

type Variant = 'display' | 'h1' | 'h2' | 'title' | 'body' | 'small' | 'caption' | 'eyebrow';

const TEXT: Record<Variant, TextStyle> = {
  display: { fontSize: 76, fontWeight: '300', lineHeight: 70, letterSpacing: -3 },
  h1: { fontSize: 28, fontWeight: '700', letterSpacing: 0.5 },
  h2: { fontSize: 22, fontWeight: '700' },
  title: { fontSize: 16, fontWeight: '700' },
  body: { fontSize: 14, lineHeight: 22 },
  small: { fontSize: 13, lineHeight: 20 },
  caption: { fontSize: 12, color: C.sub, lineHeight: 18 },
  eyebrow: { fontSize: 11, letterSpacing: 1.8, color: C.sub },
};

export function T({ v = 'body', style, ...rest }: TextProps & { v?: Variant }) {
  return <Text {...rest} style={[{ color: C.ink }, TEXT[v], style]} />;
}

// ---------- buttons ----------

export function Btn({
  label,
  onPress,
  kind = 'primary',
  disabled,
  loading,
  style,
  height = 48,
  icon,
  testID,
}: {
  label: string;
  onPress?: () => void;
  kind?: 'primary' | 'outline' | 'ghost' | 'danger' | 'dangerGhost';
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
  height?: number;
  icon?: IconName;
  testID?: string;
}) {
  const primary = kind === 'primary';
  const fg = primary ? '#FFFFFF' : kind === 'danger' || kind === 'dangerGhost' ? C.danger : C.ink;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled || !!loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        {
          height,
          paddingHorizontal: 14,
          flexDirection: 'row',
          gap: 6,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: primary ? C.ink : C.bg,
          borderWidth: kind === 'ghost' || kind === 'dangerGhost' ? 0 : 1,
          borderColor: kind === 'danger' ? C.danger : C.ink,
          opacity: disabled ? 0.35 : pressed ? 0.7 : 1,
        },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={fg} /> : icon ? <Icon name={icon} size={18} color={fg} /> : null}
      <Text style={{ color: fg, fontSize: 14, fontWeight: primary ? '500' : '400', letterSpacing: 0.5 }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function IconBtn({ name, onPress, label, color = C.ink, bg, size = 22 }: { name: IconName; onPress?: () => void; label: string; color?: string; bg?: string; size?: number }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: bg, opacity: pressed ? 0.6 : 1 })}
    >
      <Icon name={name} size={size} color={color} />
    </Pressable>
  );
}

export function Tap({ style, ...rest }: PressableProps & { style?: ViewStyle | ViewStyle[] }) {
  return <Pressable accessibilityRole="button" {...rest} style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }, style as ViewStyle]} />;
}

// ---------- page structure ----------

export function Screen({ children, scroll = true, footer, style }: { children: ReactNode; scroll?: boolean; footer?: ReactNode; style?: ViewStyle }) {
  const insets = useSafeAreaInsets();
  return (
    // Edge-to-edge Android does not resize the window for the keyboard, so pad for it here.
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top }}>
      {scroll ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={[{ paddingBottom: 28 }, style]} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1 }, style]}>{children}</View>
      )}
      {footer ? (
        <View style={{ borderTopWidth: 1, borderTopColor: C.line, paddingHorizontal: PAD, paddingTop: 12, paddingBottom: 12 + insets.bottom, flexDirection: 'row', gap: 10 }}>
          {footer}
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

/** Large page header used by the tab pages. */
export function PageHeader({ eyebrow, title, right }: { eyebrow: string; title: string; right?: ReactNode }) {
  return (
    <View style={{ paddingTop: 28, paddingHorizontal: PAD, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
      <View style={{ gap: 4 }}>
        <T v="eyebrow">{eyebrow}</T>
        <T v="h1" accessibilityRole="header">
          {title}
        </T>
      </View>
      {right}
    </View>
  );
}

/** Compact header with back button for pushed screens. */
export function NavHeader({ title, subtitle, right, onBack, border = true, backIcon = 'back' }: { title?: string; subtitle?: string; right?: ReactNode; onBack?: () => void; border?: boolean; backIcon?: IconName }) {
  return (
    <View style={{ height: 56, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: border ? 1 : 0, borderBottomColor: C.line }}>
      <IconBtn name={backIcon} label={backIcon === 'close' ? '关闭' : '返回'} onPress={onBack ?? goBack} />
      <View style={{ alignItems: 'center', flex: 1 }}>
        {title ? <T style={{ fontSize: 15, fontWeight: '500' }}>{title}</T> : null}
        {subtitle ? <T style={{ fontSize: 11, color: C.sub }}>{subtitle}</T> : null}
      </View>
      <View style={{ minWidth: 44, alignItems: 'flex-end' }}>{right}</View>
    </View>
  );
}

export function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

export function SectionTitle({ children, style }: { children: ReactNode; style?: TextStyle }) {
  return <T style={[{ fontSize: 12, fontWeight: '700', letterSpacing: 1.4, color: C.sub, marginBottom: 4 }, style]}>{children}</T>;
}

export function Row({ label, value, sub, onPress, right, last, danger }: { label: string; value?: ReactNode; sub?: string; onPress?: () => void; right?: ReactNode; last?: boolean; danger?: boolean }) {
  const inner = (
    <View style={{ minHeight: sub ? 56 : 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottomWidth: last ? 0 : 1, borderBottomColor: C.lineSoft, paddingVertical: 6 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <T style={{ fontSize: 14, color: danger ? C.danger : C.ink }}>{label}</T>
        {sub ? <T style={{ fontSize: 11, color: C.sub }}>{sub}</T> : null}
      </View>
      {typeof value === 'string' ? (
        <T style={{ fontSize: 13, color: C.sub, flexShrink: 1, textAlign: 'right' }} numberOfLines={2}>
          {value}
        </T>
      ) : (
        value
      )}
      {right}
    </View>
  );
  return onPress ? <Tap onPress={onPress}>{inner}</Tap> : inner;
}

// ---------- small pieces ----------

export function SourceBadge({ source }: { source: FieldSource | undefined }) {
  if (source !== 'ai' && source !== 'tag') return null;
  return (
    <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderWidth: 1, borderColor: C.ink }}>
      <Text style={{ fontSize: 10, color: C.ink }}>{source === 'ai' ? 'AI' : '吊牌'}</Text>
    </View>
  );
}

export function Segmented<K extends string>({ options, value, onChange }: { options: { id: K; label: string }[]; value: K; onChange: (k: K) => void }) {
  return (
    <View style={{ flexDirection: 'row', backgroundColor: C.card, padding: 3 }}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <Pressable
            key={o.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.id)}
            style={{ height: 34, paddingHorizontal: 14, justifyContent: 'center', backgroundColor: on ? C.ink : 'transparent' }}
          >
            <Text style={{ fontSize: 13, color: on ? '#FFFFFF' : C.ink }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={{ height: 40, paddingHorizontal: 16, justifyContent: 'center', borderWidth: 1, borderColor: on ? C.ink : C.muted, backgroundColor: on ? C.ink : C.bg }}
    >
      <Text style={{ fontSize: 13, color: on ? '#FFFFFF' : C.ink }}>{label}</Text>
    </Pressable>
  );
}

export function Switch({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      style={{ width: 48, height: 28, padding: 2, backgroundColor: value ? C.ink : C.muted, flexDirection: 'row', justifyContent: value ? 'flex-end' : 'flex-start' }}
    >
      <View style={{ width: 24, height: 24, backgroundColor: '#FFFFFF' }} />
    </Pressable>
  );
}

export function Checkbox({ on }: { on: boolean }) {
  return (
    <View style={{ width: 22, height: 22, borderWidth: 1.5, borderColor: C.ink, backgroundColor: on ? C.ink : C.bg, alignItems: 'center', justifyContent: 'center' }}>
      {on ? <Icon name="check" size={16} color="#FFFFFF" strokeWidth={2.2} /> : null}
    </View>
  );
}

export function Banner({ title, sub, onPress, tone = 'card', left }: { title: string; sub?: string; onPress?: () => void; tone?: 'card' | 'warn'; left?: ReactNode }) {
  return (
    <Tap
      onPress={onPress}
      disabled={!onPress}
      style={{ marginHorizontal: PAD, padding: 14, backgroundColor: tone === 'warn' ? '#FBF1E3' : C.card, flexDirection: 'row', alignItems: 'center', gap: 14 }}
    >
      {left}
      <View style={{ flex: 1, gap: 2 }}>
        <T style={{ fontSize: 14, fontWeight: '700' }}>{title}</T>
        {sub ? <T v="caption">{sub}</T> : null}
      </View>
      {onPress ? <Icon name="forward" size={18} /> : null}
    </Tap>
  );
}

/** Bottom sheet modal with drag handle look. */
export function Sheet({ visible, onClose, children, title }: { visible: boolean; onClose: () => void; children: ReactNode; title?: string }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable accessibilityLabel="关闭" style={[StyleSheet.absoluteFill, { backgroundColor: C.overlay }]} onPress={onClose} />
        <View style={{ backgroundColor: C.bg, paddingHorizontal: PAD, paddingTop: 10, paddingBottom: 20 + insets.bottom, gap: 18, maxHeight: '90%' }}>
          <View style={{ alignSelf: 'center', width: 40, height: 4, backgroundColor: '#D4D4D7' }} />
          {title ? <T v="h2">{title}</T> : null}
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function Loading({ label }: { label?: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 40 }}>
      <ActivityIndicator color={C.ink} />
      {label ? <T v="caption">{label}</T> : null}
    </View>
  );
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <View style={{ height: 4, backgroundColor: C.line }}>
      <View style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`, height: '100%', backgroundColor: C.ink }} />
    </View>
  );
}

export function PrivacyNote({ text }: { text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
      <Icon name="lock" size={14} color={C.sub} strokeWidth={1.8} />
      <T v="caption">{text}</T>
    </View>
  );
}
