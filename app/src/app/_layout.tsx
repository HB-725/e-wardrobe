import { type ErrorBoundaryProps, router, Stack } from 'expo-router';
import { Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '@/state/app';
import { Loading } from '@/ui/kit';
import { C } from '@/ui/theme';

/** Shown instead of a blank screen if any page throws while rendering. */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <View style={{ flex: 1, backgroundColor: C.bg, padding: 24, justifyContent: 'center', gap: 16 }}>
      <Text style={{ fontSize: 22, fontWeight: '700', color: C.ink }}>出错了</Text>
      <Text style={{ fontSize: 14, lineHeight: 22, color: C.sub }}>这个页面遇到了问题。你的数据都还在，可以重试或回到首页。</Text>
      <Text style={{ fontSize: 12, color: C.faint }} numberOfLines={4}>
        {error.message}
      </Text>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Text accessibilityRole="button" onPress={retry} style={{ flex: 1, textAlign: 'center', paddingVertical: 14, borderRadius: 999, overflow: 'hidden', backgroundColor: C.ink, color: '#FFFFFF', fontSize: 14 }}>
          重试
        </Text>
        <Text
          accessibilityRole="button"
          onPress={() => {
            router.replace('/');
            retry();
          }}
          style={{ flex: 1, textAlign: 'center', paddingVertical: 14, borderRadius: 999, overflow: 'hidden', backgroundColor: C.card, color: C.ink, fontSize: 14 }}
        >
          回到今天
        </Text>
      </View>
    </View>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: C.bg }}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <AppProvider fallback={<Loading />}>
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg }, animation: 'slide_from_right' }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="capture" options={{ animation: 'slide_from_bottom' }} />
            <Stack.Screen name="avatar" options={{ animation: 'slide_from_bottom' }} />
          </Stack>
        </AppProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
