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
