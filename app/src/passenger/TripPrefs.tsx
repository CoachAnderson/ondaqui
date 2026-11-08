import { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { api, errMsg } from '../api';
import { colors } from '../theme';
import { Button, Card, Muted, Notice, Screen, Title } from '../components/ui';

export interface Prefs { music: string; talk: string; ac: string }
type Options = Record<keyof Prefs, { value: string; label: string }[]>;
interface Resp { prefs: Prefs; summary: string[]; options: Options }

/** Preferências da viagem do passageiro (perfil) */
export function useTripPrefs() {
  const [data, setData] = useState<Resp | null>(null);
  const reload = useCallback(() => { api<Resp>('/me/trip-prefs').then(setData).catch(() => {}); }, []);
  useEffect(() => { reload(); }, [reload]);
  return { data, setData };
}

function Choices({ label, options, value, onChange }: { label: string; options: { value: string; label: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <View style={{ gap: 8 }} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <Text style={{ fontSize: 16, fontWeight: '800', color: colors.texto }}>{label}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <Pressable key={o.value} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={() => onChange(o.value)}
              style={{
                minHeight: 44, paddingHorizontal: 14, borderRadius: 999, justifyContent: 'center',
                borderWidth: on ? 2 : 1, borderColor: on ? colors.noite : colors.linha, backgroundColor: on ? colors.noite : colors.branco,
              }}>
              <Text style={{ fontWeight: '700', color: on ? colors.branco : colors.texto }}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Linha na tela de pedir: o resumo das preferências e "Mudar" */
export function TripPrefsRow({ data, onEdit }: { data: Resp | null; onEdit: () => void }) {
  if (!data) return null;
  return (
    <Pressable accessibilityRole="button" onPress={onEdit} style={{ gap: 2, paddingVertical: 4 }}>
      <Muted>Preferências da viagem</Muted>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
        <Text style={{ fontSize: 15, fontWeight: '700', color: colors.texto, flex: 1 }}>
          {data.summary.length ? data.summary.join(' · ') : 'Nenhuma: o motorista decide'}
        </Text>
        <Text style={{ color: colors.texto2, textDecorationLine: 'underline' }}>Mudar</Text>
      </View>
    </Pressable>
  );
}

/** Escolher música, conversa e ar-condicionado. O motorista vê na tela da corrida. */
export function TripPrefsModal({ visible, onClose, data, onSaved }: {
  visible: boolean; onClose: () => void; data: Resp | null; onSaved: (r: Resp) => void;
}) {
  const [p, setP] = useState<Prefs>({ music: 'tanto_faz', talk: 'tanto_faz', ac: 'tanto_faz' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (data && visible) setP(data.prefs); }, [data, visible]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api<Resp>('/me/trip-prefs', { method: 'PUT', body: p }));
      onClose();
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <Screen>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Title>Sua viagem</Title>
          <Text accessibilityRole="button" onPress={onClose} style={{ color: colors.texto2, textDecorationLine: 'underline', padding: 8 }}>Fechar</Text>
        </View>
        <Muted>O motorista vê suas preferências quando aceita a corrida. A música toca no rádio do carro dele.</Muted>
        {data && (
          <Card>
            <Choices label="Música" options={data.options.music} value={p.music} onChange={(v) => setP({ ...p, music: v })} />
            <Choices label="Conversa" options={data.options.talk} value={p.talk} onChange={(v) => setP({ ...p, talk: v })} />
            <Choices label="Ar-condicionado" options={data.options.ac} value={p.ac} onChange={(v) => setP({ ...p, ac: v })} />
          </Card>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <Button label="Salvar para as próximas corridas" onPress={save} busy={busy} />
      </Screen>
    </Modal>
  );
}
