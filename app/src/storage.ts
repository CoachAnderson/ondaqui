import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/** Guarda a sessão no cofre do celular (SecureStore) e, na versão web, no navegador */
export const storage = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
    }
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string) {
    if (Platform.OS === 'web') {
      try { globalThis.localStorage?.setItem(key, value); } catch { /* sem armazenamento */ }
      return;
    }
    await SecureStore.setItemAsync(key, value);
  },
  async remove(key: string) {
    if (Platform.OS === 'web') {
      try { globalThis.localStorage?.removeItem(key); } catch { /* sem armazenamento */ }
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};
