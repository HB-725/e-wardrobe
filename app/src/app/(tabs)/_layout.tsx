import { Tabs } from 'expo-router/js-tabs';
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, type IconName } from '@/ui/Icon';
import { C } from '@/ui/theme';

const TABS: { name: string; label: string; icon: IconName }[] = [
  { name: 'index', label: '今天', icon: 'today' },
  { name: 'wardrobe', label: '衣橱', icon: 'wardrobe' },
  { name: 'fitting', label: '试衣间', icon: 'fitting' },
  { name: 'outfits', label: '穿搭', icon: 'outfits' },
  { name: 'me', label: '我的', icon: 'me' },
];

function TabBar({ state, navigateToTab }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View
      accessibilityRole="tablist"
      style={{ flexDirection: 'row', justifyContent: 'space-around', paddingTop: 8, paddingHorizontal: 8, paddingBottom: Math.max(insets.bottom, 10), backgroundColor: C.bg, borderTopWidth: 1, borderTopColor: C.line }}
    >
      {state.routes.map((route, i) => {
        const tab = TABS.find((t) => t.name === route.name);
        if (!tab) return null;
        const focused = state.index === i;
        const color = focused ? C.ink : C.sub;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={tab.label}
            onPress={() => {
              if (!focused) navigateToTab(route.key);
            }}
            style={{ width: 64, minHeight: 48, alignItems: 'center', gap: 4 }}
          >
            <Icon name={tab.icon} color={color} />
            <Text style={{ fontSize: 11, color, fontWeight: focused ? '700' : '400' }}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs tabBar={(p) => <TabBar {...p} />} screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: C.bg } }}>
      {TABS.map((t) => (
        <Tabs.Screen key={t.name} name={t.name} options={{ title: t.label }} />
      ))}
    </Tabs>
  );
}
