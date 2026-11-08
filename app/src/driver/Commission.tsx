import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { api, errMsg, post } from '../api';
import { useRealtime } from '../realtime';
import { money } from '../format';
import { colors } from '../theme';
import { Button, Card, Muted, Notice, Row } from '../components/ui';

interface Invoice {
  id: string; period_start: string; period_end: string; rides: number; gross_cents: number; amount_cents: number;
  due_date: string; status: 'open' | 'paid'; paid_by: 'mercadopago' | 'central' | 'cashback' | null; overdue: boolean;
  /** cashback que os passageiros usaram nas suas corridas, abatido desta comissão */
  cashback_offset_cents?: number;
}
interface Summary { pendingRides: number; pendingCents: number; invoices: Invoice[]; available: boolean }

const dateBr = (d: string) => new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR');
const short = (d: string) => new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

/**
 * Plano Livre: a comissão das corridas que o passageiro pagou direto ao motorista (dinheiro, Pix, maquininha)
 * fecha toda segunda-feira numa fatura, paga aqui pelo Mercado Pago ou na central.
 */
export default function Commission({ commissionPct, onPaid }: { commissionPct: number; onPaid: () => Promise<void> }) {
  const [data, setData] = useState<Summary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'info' | 'error'; text: string } | null>(null);
  const waiting = useRef(false);

  const load = useCallback(() => api<Summary>('/driver/commissions').then(setData).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);

  const confirmed = useCallback(async () => {
    waiting.current = false;
    setMsg({ tone: 'ok', text: 'Comissão paga. Obrigado!' });
    await load();
    await onPaid();
  }, [load, onPaid]);

  async function sync() {
    const r = await post<{ applied: boolean; pending: boolean }>('/driver/subscription/sync');
    if (r.applied) await confirmed();
    else if (r.pending) setMsg({ tone: 'info', text: 'Pagamento em análise. Com Pix, a confirmação costuma chegar em segundos.' });
  }

  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active' && waiting.current) sync().catch(() => {});
    });
    return () => sub.remove();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useRealtime('commission:paid', () => { confirmed().catch(() => {}); });
  useRealtime('commission:new', () => { load(); });

  async function pay(inv: Invoice) {
    setBusy(inv.id);
    setMsg(null);
    try {
      const pref = await post<{ init_point: string }>(`/driver/commissions/${inv.id}/checkout`);
      waiting.current = true;
      if (Platform.OS === 'web') {
        window.open(pref.init_point, '_blank', 'noopener');
      } else {
        await WebBrowser.openBrowserAsync(pref.init_point, {
          presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN, controlsColor: '#F2622E',
        });
        if (Platform.OS === 'ios') await sync();
      }
    } catch (e) {
      setMsg({ tone: 'error', text: errMsg(e) });
    } finally {
      setBusy(null);
    }
  }

  if (!data) return null;
  const open = data.invoices.filter((i) => i.status === 'open');
  const paid = data.invoices.filter((i) => i.status === 'paid').slice(0, 3);
  if (commissionPct <= 0 && open.length === 0 && data.pendingCents === 0) return null;

  return (
    <Card>
      <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>Comissão das corridas pagas a você</Text>
      <Muted>
        Quando o passageiro paga em dinheiro, Pix ou maquininha, o valor fica todo com você e a comissão de {commissionPct}% é
        cobrada toda segunda-feira, com 3 dias para pagar.
      </Muted>
      <Row label="Nesta semana (ainda não fechada)" value={`${money(data.pendingCents)} · ${data.pendingRides} ${data.pendingRides === 1 ? 'corrida' : 'corridas'}`} />

      {open.map((inv) => (
        <View key={inv.id} style={{ gap: 8, borderTopWidth: 1, borderTopColor: colors.linha, paddingTop: 12 }}>
          {inv.overdue && <Notice tone="error">Vencida em {dateBr(inv.due_date)}. Pague para voltar a receber corridas.</Notice>}
          <Row label={`Semana ${short(inv.period_start)} a ${short(inv.period_end)}`} value={money(inv.amount_cents)} />
          <Muted>{inv.rides} {inv.rides === 1 ? 'corrida' : 'corridas'}, {money(inv.gross_cents)} recebidos por você. Vence em {dateBr(inv.due_date)}.</Muted>
          {(inv.cashback_offset_cents ?? 0) > 0 && <Muted>{`Já abatidos ${money(inv.cashback_offset_cents!)} do cashback que os passageiros usaram.`}</Muted>}
          {data.available
            ? <Button label={`Pagar ${money(inv.amount_cents)} com Mercado Pago`} onPress={() => pay(inv)} busy={busy === inv.id}
                accessibilityHint="Abre o Mercado Pago para pagar com Pix ou cartão" testID="commission-pay" />
            : <Muted>Para pagar, fale com a central da sua cidade.</Muted>}
        </View>
      ))}

      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      {paid.length > 0 && (
        <View style={{ gap: 4, borderTopWidth: 1, borderTopColor: colors.linha, paddingTop: 12 }}>
          {paid.map((inv) => (
            <Row key={inv.id} label={`Semana ${short(inv.period_start)} a ${short(inv.period_end)}`}
              value={inv.paid_by === 'cashback' ? `${money(inv.cashback_offset_cents ?? 0)} · abatida com cashback`
                : `${money(inv.amount_cents)} · paga${inv.paid_by === 'central' ? ' na central' : ''}`} />
          ))}
        </View>
      )}
    </Card>
  );
}
