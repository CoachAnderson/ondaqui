import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_URL, getSession } from './api';

let socket: Socket | null = null;

function getSocket() {
  const s = getSession();
  if (!s) return null;
  if (!socket) socket = io(API_URL, { auth: { token: s.token }, transports: ['websocket', 'polling'] });
  return socket;
}

export function closeSocket() {
  socket?.disconnect();
  socket = null;
}

/** Escuta um evento em tempo real enquanto o componente estiver na tela */
export function useRealtime<T = any>(event: string, handler: (data: T) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const s = getSocket();
    if (!s) return;
    const fn = (d: T) => ref.current(d);
    s.on(event, fn);
    return () => { s.off(event, fn); };
  }, [event]);
}
