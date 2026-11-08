import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, onSessionExpired, setToken } from './api';
import { storage } from './storage';
import { closeSocket } from './realtime';
import { VARIANT } from './config';
import { unregisterPush } from './push';
import { stopBackgroundLocation } from './driver/backgroundLocation';
import type { Session } from './types';

const KEY = `ondaqui.sessao.${VARIANT}`;

interface Ctx {
  session: Session | null;
  ready: boolean;
  signIn: (s: Session) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<Ctx>({ session: null, ready: false, signIn: async () => {}, signOut: async () => {} });
export const useSession = () => useContext(SessionContext);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  const signOut = useCallback(async () => {
    await unregisterPush();
    await stopBackgroundLocation();
    setToken(null);
    closeSocket();
    setSession(null);
    await storage.remove(KEY);
  }, []);

  useEffect(() => {
    onSessionExpired(() => { void signOut(); });
    (async () => {
      const raw = await storage.get(KEY);
      if (raw) {
        try {
          const s = JSON.parse(raw) as Session;
          setToken(s.token);
          await api('/me'); // confere se a sessão ainda vale
          setSession(s);
        } catch {
          setToken(null);
        }
      }
      setReady(true);
    })();
  }, [signOut]);

  const signIn = useCallback(async (s: Session) => {
    setToken(s.token);
    setSession(s);
    await storage.set(KEY, JSON.stringify(s));
  }, []);

  return <SessionContext.Provider value={{ session, ready, signIn, signOut }}>{children}</SessionContext.Provider>;
}
