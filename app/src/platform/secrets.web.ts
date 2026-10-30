const KEY = 'openai_api_key';

export async function getApiKey(): Promise<string | null> {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export async function setApiKey(value: string | null): Promise<void> {
  try {
    if (value) localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable (private mode)
  }
}

/** Web preview only: localStorage stands in for the platform keystore. */
export const secureSecrets = {
  async get(name: string): Promise<string | null> {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  async set(name: string, value: string | null): Promise<void> {
    try {
      if (value) localStorage.setItem(name, value);
      else localStorage.removeItem(name);
    } catch {
      // storage unavailable (private mode)
    }
  },
};
