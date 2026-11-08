import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View, type ScrollViewInstance } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, errMsg, post } from '../api';
import { useRealtime } from '../realtime';
import { colors, radius, useBrand } from '../theme';
import { Button, Muted, Notice } from './ui';

interface Message { id: string; side: 'cliente' | 'motorista'; mine: boolean; body: string; at: string; read: boolean }
interface Chat { messages: Message[]; open: boolean; quickReplies: string[]; with: string | null }

const time = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/**
 * Chat da corrida: passageiro e motorista conversam sem trocar telefone.
 * Abre quando o motorista aceita e fecha no fim da corrida.
 */
export default function RideChat({ rideId, side, status }: { rideId: string; side: 'cliente' | 'motorista'; status: string }) {
  const { accent, accentDark } = useBrand();
  const [chat, setChat] = useState<Chat | null>(null);
  const [visible, setVisible] = useState(false);
  const [unread, setUnread] = useState(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<ScrollViewInstance>(null);
  const visibleRef = useRef(false);
  visibleRef.current = visible;

  const load = useCallback(async () => {
    const c = await api<Chat>(`/rides/${rideId}/messages`);
    setChat(c);
    setUnread(c.messages.filter((m) => !m.mine && !m.read).length);
    return c;
  }, [rideId]);

  // recarrega quando a corrida muda de etapa (abre no aceite, fecha no fim)
  useEffect(() => { load().catch(() => {}); }, [load, status]);

  const markRead = useCallback(() => {
    setUnread(0);
    post(`/rides/${rideId}/messages/read`).catch(() => {});
  }, [rideId]);

  useRealtime<{ rideId: string; id: string; side: Message['side']; body: string; at: string }>('ride:message', (m) => {
    if (m.rideId !== rideId) return;
    setChat((c) => {
      if (!c || c.messages.some((x) => x.id === m.id)) return c;
      return { ...c, messages: [...c.messages, { id: m.id, side: m.side, mine: m.side === side, body: m.body, at: m.at, read: false }] };
    });
    if (m.side !== side) {
      if (visibleRef.current) markRead();
      else setUnread((n) => n + 1);
    }
  });

  useEffect(() => {
    if (visible) setTimeout(() => scroll.current?.scrollToEnd({ animated: false }), 50);
  }, [visible, chat?.messages.length]);

  async function send(body: string) {
    const b = body.trim();
    if (!b) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ message: Message }>(`/rides/${rideId}/messages`, { body: b });
      setChat((c) => (c && !c.messages.some((x) => x.id === r.message.id) ? { ...c, messages: [...c.messages, r.message] } : c));
      setText('');
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  function openChat() {
    setVisible(true);
    load().then(() => markRead()).catch(() => {});
  }

  if (!chat || (!chat.open && chat.messages.length === 0)) return null;
  const other = side === 'cliente' ? `o motorista${chat.with ? ` ${chat.with}` : ''}` : chat.with ?? 'o passageiro';

  return (
    <>
      <Button kind="secondary" label={unread > 0 ? `Mensagens (${unread} nova${unread > 1 ? 's' : ''})` : `Mandar mensagem para ${other}`}
        onPress={openChat} accessibilityHint="Abre o chat da corrida. Seu telefone não aparece." />

      <Modal visible={visible} animationType="slide" onRequestClose={() => setVisible(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.areia }} edges={['top', 'bottom']}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, gap: 12 }}>
              <Text accessibilityRole="header" style={{ fontSize: 22, fontWeight: '800', color: colors.texto, flex: 1 }}>
                Conversa com {other}
              </Text>
              <Text accessibilityRole="button" onPress={() => setVisible(false)}
                style={{ color: colors.texto2, textDecorationLine: 'underline', padding: 8, fontSize: 16 }}>Fechar</Text>
            </View>
            <Muted style={{ paddingHorizontal: 16 }}>
              Seu telefone não aparece. Nunca pague por link ou chave Pix enviados aqui: a chave certa aparece na tela da corrida.
            </Muted>

            <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 8 }}>
              {chat.messages.length === 0 && <Muted>Nenhuma mensagem ainda.</Muted>}
              {chat.messages.map((m) => (
                <View key={m.id} style={{ alignSelf: m.mine ? 'flex-end' : 'flex-start', maxWidth: '82%' }}>
                  <View style={{
                    backgroundColor: m.mine ? accentDark : colors.branco, borderRadius: radius,
                    borderWidth: m.mine ? 0 : 1, borderColor: colors.linha, paddingHorizontal: 14, paddingVertical: 10,
                  }}>
                    <Text style={{ color: m.mine ? colors.branco : colors.texto, fontSize: 16 }}>{m.body}</Text>
                  </View>
                  <Text style={{ color: colors.texto2, fontSize: 12, marginTop: 2, alignSelf: m.mine ? 'flex-end' : 'flex-start' }}>
                    {time(m.at)}{m.mine && m.read ? ' · lida' : ''}
                  </Text>
                </View>
              ))}
            </ScrollView>

            {chat.open ? (
              <View style={{ padding: 12, gap: 10, borderTopWidth: 1, borderTopColor: colors.linha, backgroundColor: colors.branco }}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                  {chat.quickReplies.map((q) => (
                    <Pressable key={q} accessibilityRole="button" onPress={() => send(q)} disabled={busy}
                      style={{ borderWidth: 1, borderColor: accent, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 }}>
                      <Text style={{ color: colors.texto, fontWeight: '600' }}>{q}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
                {error && <Notice tone="error">{error}</Notice>}
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
                  <TextInput
                    value={text} onChangeText={setText} placeholder="Escreva uma mensagem" placeholderTextColor="#7A8794"
                    accessibilityLabel="Mensagem" multiline maxLength={500}
                    style={{ flex: 1, minHeight: 48, maxHeight: 120, borderWidth: 1, borderColor: colors.linha, borderRadius: radius,
                      paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: colors.texto, backgroundColor: colors.branco }}
                  />
                  <Button label="Enviar" onPress={() => send(text)} busy={busy} disabled={!text.trim()} style={{ minWidth: 96 }} />
                </View>
              </View>
            ) : (
              <View style={{ padding: 16 }}><Muted>A corrida terminou. O chat fica fechado.</Muted></View>
            )}
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    </>
  );
}
