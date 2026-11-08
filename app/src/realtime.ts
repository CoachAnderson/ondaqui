import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_URL } from './config';
import { getToken } from './api';

let socket: Socket | null = null;
let socketToken: string | null = null;

export function getSocket(): Socket | null {
  const t = getToken();
  if (!t) return null;
  if (socket && socketToken === t) return socket;
  socket?.disconnect();
  socket = io(API_URL, { auth: { token: t }, transports: ['websocket'], reconnection: true });
  socketToken = t;
  return socket;
}

export function closeSocket() {
  socket?.disconnect();
  socket = null;
  socketToken = null;
}

/** Escuta um evento em tempo real enquanto a tela estiver aberta */
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

/** Avisa quando o tempo real reconecta (para recarregar o estado) */
export function useReconnect(handler: () => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const s = getSocket();
    if (!s) return;
    const fn = () => ref.current();
    s.on('connect', fn);
    return () => { s.off('connect', fn); };
  }, []);
}
