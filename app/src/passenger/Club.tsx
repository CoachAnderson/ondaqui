import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { api, errMsg, post } from '../api';
import { money } from '../format';
import { useRealtime } from '../realtime';
import { colors } from '../theme';
import { Button, Card, Muted, Notice } from '../components/ui';

export interface ClubInfo {
  rules: {
    enabled: boolean; name: string; priceCents: number; days: number;
    discountPct: number; discountMaxCents: number; noSurge: boolean; cashbackMultiplier: number; priority: boolean;
  };
  member: boolean; until: string | null; daysLeft: number | null;
  savedMonthCents: number; savedTotalCents: number; available: boolean;
}

const dateBr = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
const pct = (n: number) => String(n).replace('.', ',');

/** Clube do passageiro: regras da cidade e se a pessoa assina */
export function useClub() {
  const [club, setClub] = useState<ClubInfo | null>(null);
  const reload = useCallback(() => { api<ClubInfo>('/club').then(setClub).catch(() => {}); }, []);
  useEffect(() => { reload(); }, [reload]);
  useRealtime('club:paid', reload);
  return { club, reload };
}

/** Benefícios ligados pelo licenciado, em frases curtas */
export function clubBenefits(r: ClubInfo['rules'], cashbackOn: boolean) {
  const list: string[] = [];
  if (r.discountPct > 0) list.push(`${pct(r.discountPct)}% de desconto em cada corrida (até ${money(r.discountMaxCents)})`);
  if (r.noSurge) list.push('Sem tarifa dinâmica, nem nos horários de pico');
  if (cashbackOn && r.cashbackMultiplier > 1) list.push(`Cashback ${r.cashbackMultiplier === 2 ? 'em dobro' : `${r.cashbackMultiplier}x`}`);
  if (r.priority) list.push('Prioridade para achar motorista');
  return list;
}

/**
 * Cartão do Clube: assinar ou renovar pelo Mercado Pago (Pix ou cartão). Não renova sozinho:
 * o app avisa antes de vencer. A confirmação chega pela notificação do Mercado Pago ou ao voltar para o app.
 */
export function ClubCard({ club, cashbackOn, onChanged }: { club: ClubInfo | null; cashbackOn: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'info' | 'error'; text: string } | null>(null);
  const waiting = useRef(false);

  const sync = useCallback(async () => {
    const r = await post<{ applied: boolean; pending: boolean; until: string | null }>('/club/sync');
    if (r.applied) {
      waiting.current = false;
      setMsg({ tone: 'ok', text: `Pagamento confirmado. Seu clube vale até ${r.until ? dateBr(r.until) : ''}.` });
      onChanged();
    } else if (r.pending) {
      setMsg({ tone: 'info', text: 'Pagamento em análise. Com Pix, a confirmação costuma chegar em segundos.' });
    }
  }, [onChanged]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active' && waiting.current) sync().catch(() => {});
    });
    return () => sub.remove();
  }, [sync]);

  useRealtime<{ until: string }>('club:paid', (d) => {
    waiting.current = false;
    setMsg({ tone: 'ok', text: `Pagamento confirmado. Seu clube vale até ${dateBr(d.until)}.` });
  });

  async function subscribe() {
    setBusy(true);
    setMsg(null);
    try {
      const pref = await post<{ init_point: string }>('/club/checkout');
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
      setBusy(false);
    }
  }

  if (!club?.rules.enabled) return null;
  const r = club.rules;
  const benefits = clubBenefits(r, cashbackOn);
  return (
    <Card style={club.member ? { borderColor: colors.verde, borderWidth: 2 } : undefined}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <Text style={{ fontSize: 17, fontWeight: '800', color: colors.texto, flex: 1 }}>{r.name}</Text>
        {club.member
          ? <Text style={{ fontSize: 14, fontWeight: '800', color: colors.verde }}>{`Assinante até ${dateBr(club.until!)}`}</Text>
          : <Text style={{ fontSize: 17, fontWeight: '800', color: colors.texto }}>{`${money(r.priceCents)}/mês`}</Text>}
      </View>
      {benefits.map((b) => <Muted key={b}>{`• ${b}`}</Muted>)}
      {club.member && (
        <Muted>{club.savedMonthCents > 0 ? `Você já economizou ${money(club.savedMonthCents)} neste mês.` : 'Os descontos aparecem no preço de cada corrida.'}</Muted>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {club.available ? (
        (!club.member || (club.daysLeft ?? 0) <= 7) && (
          <Button kind={club.member ? 'secondary' : 'primary'} busy={busy} onPress={subscribe}
            label={club.member ? `Renovar mais ${r.days} dias · ${money(r.priceCents)}` : `Assinar por ${money(r.priceCents)} (${r.days} dias)`}
            accessibilityHint="Abre o Mercado Pago para pagar com Pix ou cartão" />
        )
      ) : (
        !club.member && <Muted>Para assinar, fale com a central da sua cidade.</Muted>
      )}
      {!club.member && <Muted>Sem renovação automática: avisamos antes de vencer.</Muted>}
    </Card>
  );
}
