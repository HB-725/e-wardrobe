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
