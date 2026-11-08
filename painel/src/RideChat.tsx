import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useRealtime } from './realtime';
import { errMsg } from './ui';

interface Message { id: string; side: 'cliente' | 'motorista'; mine: boolean; body: string; at: string; read: boolean }
interface Chat { messages: Message[]; open: boolean; quickReplies: string[]; with: string | null }

const time = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * Chat da corrida no painel. Loja e central da Saúde conversam com o motorista da entrega ou da viagem;
 * o licenciado só lê (para apurar ocorrências).
 */
export default function RideChat({ rideId, label = 'Mensagens', readOnly = false }: { rideId: string; label?: string; readOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const [chat, setChat] = useState<Chat | null>(null);
  const [unread, setUnread] = useState(0);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const c = await api<Chat>(`/rides/${rideId}/messages`);
      setChat(c);
      setUnread(c.messages.filter((m) => !m.mine && !m.read).length);
    } catch (e) { setError(errMsg(e)); }
  }, [rideId]);

  useEffect(() => { if (!readOnly) load(); }, [load, readOnly]);
  useEffect(() => { if (open) end.current?.scrollIntoView({ block: 'end' }); }, [open, chat?.messages.length]);

  useRealtime<{ rideId: string; id: string; side: Message['side']; body: string; at: string }>('ride:message', (m) => {
    if (m.rideId !== rideId) return;
    setChat((c) => (c && !c.messages.some((x) => x.id === m.id)
      ? { ...c, messages: [...c.messages, { id: m.id, side: m.side, mine: m.side === 'cliente' && !readOnly, body: m.body, at: m.at, read: false }] }
      : c));
    if (m.side === 'motorista') {
      if (open) api(`/rides/${rideId}/messages/read`, { method: 'POST', body: {} }).catch(() => {});
      else setUnread((n) => n + 1);
    }
  });

  async function show() {
    setOpen(true);
    await load();
    if (!readOnly) { setUnread(0); api(`/rides/${rideId}/messages/read`, { method: 'POST', body: {} }).catch(() => {}); }
  }

  async function send(body: string) {
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ message: Message }>(`/rides/${rideId}/messages`, { method: 'POST', body: { body: body.trim() } });
      setChat((c) => (c && !c.messages.some((x) => x.id === r.message.id) ? { ...c, messages: [...c.messages, r.message] } : c));
      setText('');
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  if (!readOnly && chat && !chat.open && chat.messages.length === 0) return null;

  return (
    <>
      <button className="secundario" onClick={show}>{unread > 0 ? `${label} (${unread})` : label}</button>
      {open && (
        <div className="lateral-fundo" onClick={() => setOpen(false)}>
          <aside className="lateral" onClick={(e) => e.stopPropagation()} aria-label="Conversa da corrida">
            <div className="cabeca">
              <div>
                <h2>Conversa com {readOnly ? 'passageiro e motorista' : `o motorista${chat?.with ? ` ${chat.with}` : ''}`}</h2>
                <p style={{ margin: '4px 0 0', color: 'var(--texto-2)', fontSize: 14 }}>
                  {readOnly ? 'Só leitura. As conversas são apagadas 30 dias depois do fim da corrida.' : 'O telefone de ninguém aparece.'}
                </p>
              </div>
              <button className="secundario" onClick={() => setOpen(false)}>Fechar</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
              {chat?.messages.length === 0 && <p className="vazio">Nenhuma mensagem.</p>}
              {chat?.messages.map((m) => {
                const right = readOnly ? m.side === 'motorista' : m.mine;
                return (
                  <div key={m.id} style={{ alignSelf: right ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
                    <div style={{
                      background: right ? 'var(--noite)' : 'var(--branco)', color: right ? 'var(--branco)' : 'var(--texto)',
                      border: right ? 'none' : '1px solid var(--linha)', borderRadius: 12, padding: '8px 12px',
                    }}>{m.body}</div>
                    <div style={{ fontSize: 12, color: 'var(--texto-2)', textAlign: right ? 'right' : 'left', marginTop: 2 }}>
                      {readOnly ? (m.side === 'motorista' ? 'Motorista · ' : 'Cliente · ') : ''}{time(m.at)}{m.mine && m.read ? ' · lida' : ''}
                    </div>
                  </div>
                );
              })}
              <div ref={end} />
            </div>
            {error && <div className="aviso erro" role="alert">{error}</div>}
            {!readOnly && chat?.open && (
              <>
                <div className="acoes">
                  {chat.quickReplies.map((q) => <button key={q} className="secundario" disabled={busy} onClick={() => send(q)}>{q}</button>)}
                </div>
                <form onSubmit={(e) => { e.preventDefault(); send(text); }} style={{ display: 'flex', gap: 8 }}>
                  <input value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder="Escreva uma mensagem"
                    aria-label="Mensagem" style={{ flex: 1 }} />
                  <button type="submit" disabled={busy || !text.trim()}>Enviar</button>
                </form>
              </>
            )}
            {!readOnly && chat && !chat.open && <p style={{ color: 'var(--texto-2)' }}>A corrida terminou. O chat fica fechado.</p>}
          </aside>
        </div>
      )}
    </>
  );
}
