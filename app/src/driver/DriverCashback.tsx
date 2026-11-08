import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { api } from '../api';
import { money } from '../format';
import { useRealtime } from '../realtime';
import { colors } from '../theme';
import { Card, Muted, Row } from '../components/ui';

interface Payout {
  id: string; period_start: string; period_end: string; rides: number;
  cashback_cents: number; offset_cents: number; amount_cents: number; status: 'open' | 'paid' | 'abatido'; paid_at: string | null;
}
interface Summary { pendingRides: number; pendingCents: number; payouts: Payout[] }

const short = (d: string) => new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

/**
 * Cashback que os passageiros usaram nas corridas do motorista: ele recebeu menos do passageiro e a central
 * paga a diferença. Fecha toda segunda-feira: abate da comissão da semana; o que sobrar vai para o Pix.
 */
export default function DriverCashback() {
  const [data, setData] = useState<Summary | null>(null);
  const load = useCallback(() => { api<Summary>('/driver/cashback').then(setData).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);
  useRealtime('cashback:payout', load);
  useRealtime('ride:updated', (r: { status?: string }) => { if (r.status === 'completed') load(); });

  if (!data || (data.pendingCents === 0 && data.payouts.length === 0)) return null;
  const open = data.payouts.filter((p) => p.status === 'open');
  const done = data.payouts.filter((p) => p.status !== 'open').slice(0, 3);
  return (
    <Card>
      <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>Cashback e Clube a receber da central</Text>
      <Muted>
        Quando o passageiro usa cashback ou tem desconto do Clube, você recebe menos dele e a central paga a diferença. Toda
        segunda-feira o valor é abatido da sua comissão; o que sobrar a central paga no seu Pix.
      </Muted>
      {data.pendingCents > 0 && (
        <Row label="Nesta semana (ainda não fechada)" value={`${money(data.pendingCents)} · ${data.pendingRides} ${data.pendingRides === 1 ? 'corrida' : 'corridas'}`} />
      )}
      {open.map((p) => (
        <View key={p.id} style={{ gap: 4, borderTopWidth: 1, borderTopColor: colors.linha, paddingTop: 10 }}>
          <Row label={`Semana ${short(p.period_start)} a ${short(p.period_end)}`} value={`${money(p.amount_cents)} no seu Pix`} />
          {p.offset_cents > 0 && <Muted>{`${money(p.offset_cents)} já foram abatidos da comissão.`}</Muted>}
          <Muted>A central ainda vai pagar. Confira se a sua chave Pix está certa.</Muted>
        </View>
      ))}
      {done.length > 0 && (
        <View style={{ gap: 4, borderTopWidth: 1, borderTopColor: colors.linha, paddingTop: 10 }}>
          {done.map((p) => (
            <Row key={p.id} label={`Semana ${short(p.period_start)} a ${short(p.period_end)}`}
              value={p.status === 'abatido' ? `${money(p.cashback_cents)} · abatido da comissão` : `${money(p.amount_cents)} · pago`} />
          ))}
        </View>
      )}
    </Card>
  );
}
