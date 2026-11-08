import { useCallback, useEffect, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { api } from '../api';
import { money } from '../format';
import { useRealtime } from '../realtime';
import { colors } from '../theme';
import { Card, Muted, Notice } from '../components/ui';

interface Shift {
  id: string; status: 'confirmado' | 'concluido'; startsAt: string; endsAt: string; hours: number; driverCents: number; deliveries: number;
  restaurant: { name: string; address: string }; driverPaidAt: string | null;
}

const when = (iso: string) => new Date(iso).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const hm = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/**
 * Daqui Food: turnos de entregador fixo confirmados pela central. No turno, as entregas daquele restaurante
 * chegam primeiro para você, já pagas pelo turno (a central repassa o valor depois).
 */
export default function FoodShift() {
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const load = useCallback(() => { api<{ shifts: Shift[] }>('/driver/food/shifts').then((r) => setShifts(r.shifts)).catch(() => {}); }, []);
  useEffect(() => { load(); const t = setInterval(load, 120_000); return () => clearInterval(t); }, [load]);
  useRealtime('ride:updated', load);

  const next = (shifts ?? []).filter((s) => s.status === 'confirmado');
  if (next.length === 0) return null;
  const now = Date.now();
  return (
    <Card>
      <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>Turno fixo · Daqui Food</Text>
      {next.map((s) => {
        const live = new Date(s.startsAt).getTime() <= now && new Date(s.endsAt).getTime() > now;
        return (
          <View key={s.id} style={{ gap: 4, borderTopWidth: 1, borderTopColor: colors.linha, paddingTop: 8 }}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: colors.texto }}>{s.restaurant.name}</Text>
            <Muted>{`${when(s.startsAt)} até ${hm(s.endsAt)} · ${s.hours} h · você recebe ${money(s.driverCents)}`}</Muted>
            {live
              ? <Notice tone="ok">{`Turno valendo. Fique online perto do restaurante: as entregas dele chegam primeiro para você. ${s.deliveries} feitas até agora.`}</Notice>
              : <Muted>Chegue um pouco antes e fique online.</Muted>}
            <Text accessibilityRole="link" style={{ color: colors.texto2, textDecorationLine: 'underline', paddingVertical: 6 }}
              onPress={() => Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.restaurant.address)}`)}>{s.restaurant.address}</Text>
          </View>
        );
      })}
    </Card>
  );
}
