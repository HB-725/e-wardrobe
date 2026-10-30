import * as SecureStore from 'expo-secure-store';

const KEY = 'openai_api_key';

/** The user's own OpenAI key, kept in the Android Keystore / iOS Keychain, never in SQLite or exports. */
export async function getApiKey(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY);
}

export async function setApiKey(value: string | null): Promise<void> {
  if (value) await SecureStore.setItemAsync(KEY, value);
  else await SecureStore.deleteItemAsync(KEY);
}

/** Any named secret (multi-provider keys are stored as `ai.key.<id>`). */
export const secureSecrets = {
  get: (name: string) => SecureStore.getItemAsync(name),
  async set(name: string, value: string | null) {
    if (value) await SecureStore.setItemAsync(name, value);
    else await SecureStore.deleteItemAsync(name);
  },
};
