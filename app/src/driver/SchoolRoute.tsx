import { useCallback, useEffect, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { api, errMsg, post } from '../api';
import { firstName } from '../format';
import { useRealtime } from '../realtime';
import { colors } from '../theme';
import { Button, Card, Muted, Notice } from '../components/ui';

interface Trip {
  id: string; leg: 'ida' | 'volta'; time: string; status: 'previsto' | 'embarcou' | 'entregue' | 'ausente' | 'cancelado';
  absentBy: 'pais' | 'motorista' | null;
  student: { name: string; grade: string | null; notes: string | null };
  from: { address: string; lat: number; lng: number }; to: { address: string; lat: number; lng: number };
  parent: { name: string; phone: string };
}

const STATUS: Record<Trip['status'], string> = { previsto: 'A buscar', embarcou: 'No carro', entregue: 'Entregue', ausente: 'Não vai', cancelado: 'Cancelada' };

/**
 * Rota escolar do dia: o motorista marca embarque e chegada (os pais recebem aviso na hora) ou que o aluno não estava.
 * Fique online para os pais acompanharem no mapa.
 */
export default function SchoolRoute() {
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { api<{ today: Trip[] }>('/driver/escola').then((r) => setTrips(r.today)).catch(() => {}); }, []);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  useRealtime('escola:trip', load);

  async function mark(t: Trip, action: 'embarcou' | 'entregue' | 'ausente') {
    setBusy(t.id + action);
    setError(null);
    try { await post(`/driver/escola/trips/${t.id}/${action}`); load(); } catch (e) { setError(errMsg(e)); } finally { setBusy(null); }
  }

  if (!trips || trips.length === 0) return null;
  const pending = trips.filter((t) => t.status === 'previsto' || t.status === 'embarcou').length;
  return (
    <Card>
      <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>Rota escolar de hoje</Text>
      <Muted>{pending > 0 ? `${pending} ${pending === 1 ? 'embarque ou entrega' : 'embarques e entregas'} pela frente. Fique online para os pais acompanharem.` : 'Tudo feito por hoje.'}</Muted>
      {error && <Notice tone="error">{error}</Notice>}
      {trips.map((t) => (
        <View key={t.id} style={{ gap: 6, borderTopWidth: 1, borderTopColor: colors.linha, paddingTop: 10, opacity: t.status === 'cancelado' ? 0.5 : 1 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: colors.texto, flex: 1 }}>{`${t.time} · ${t.student.name}`}</Text>
            <Text style={{ fontWeight: '700', color: t.status === 'entregue' ? colors.verde : t.status === 'ausente' ? colors.vermelho : colors.texto2 }}>{STATUS[t.status]}</Text>
          </View>
          <Muted>{`${t.leg === 'ida' ? 'Ida' : 'Volta'}: ${t.from.address} → ${t.to.address}`}</Muted>
          {t.student.notes && <Notice tone="info">{t.student.notes}</Notice>}
          {t.status === 'ausente' && t.absentBy === 'pais' && <Muted>Os pais avisaram que não vai.</Muted>}
          {t.status === 'previsto' && (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button label="Embarcou" onPress={() => mark(t, 'embarcou')} busy={busy === t.id + 'embarcou'} style={{ flex: 1 }} />
              <Button kind="secondary" label="Não estava" onPress={() => mark(t, 'ausente')} busy={busy === t.id + 'ausente'} style={{ flex: 1 }} />
            </View>
          )}
          {t.status === 'embarcou' && (
            <Button label={t.leg === 'ida' ? 'Chegou à escola' : 'Entregue em casa'} onPress={() => mark(t, 'entregue')} busy={busy === t.id + 'entregue'} />
          )}
          {(t.status === 'previsto' || t.status === 'embarcou') && (
            <View style={{ flexDirection: 'row', gap: 16 }}>
              <Text accessibilityRole="link" style={{ color: colors.texto2, textDecorationLine: 'underline', paddingVertical: 6 }}
                onPress={() => Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${(t.status === 'previsto' ? t.from : t.to).lat},${(t.status === 'previsto' ? t.from : t.to).lng}`)}>Abrir no mapa</Text>
              <Text accessibilityRole="link" style={{ color: colors.texto2, textDecorationLine: 'underline', paddingVertical: 6 }}
                onPress={() => Linking.openURL(`tel:${t.parent.phone}`)}>{`Ligar para ${firstName(t.parent.name)}`}</Text>
            </View>
          )}
        </View>
      ))}
    </Card>
  );
}
