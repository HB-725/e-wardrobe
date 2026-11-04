import * as SecureStore from 'expo-secure-store';

/** API keys (`ai.key.<id>`), kept in the Android Keystore / iOS Keychain, never in SQLite or exports. */
export const secureSecrets = {
  get: (name: string) => SecureStore.getItemAsync(name),
  async set(name: string, value: string | null) {
    if (value) await SecureStore.setItemAsync(name, value);
    else await SecureStore.deleteItemAsync(name);
  },
};
