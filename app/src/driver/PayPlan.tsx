import { useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { errMsg, post } from '../api';
import { useRealtime } from '../realtime';
import { money } from '../format';
import { Button, Notice } from '../components/ui';

const dateBr = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('pt-BR');

/**
 * Botão "Pagar com Mercado Pago" do card "Seu plano".
 * Abre o Checkout Pro (Pix, cartão ou saldo) e, ao voltar para o app, confere o pagamento
 * no servidor. A confirmação também chega sozinha pela notificação do Mercado Pago.
 */
export default function PayPlan({
  priceCents, periodDays, due, onPaid,
}: { priceCents: number; periodDays: number; due: string | null; onPaid: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn' | 'error' | 'info'; text: string } | null>(null);
  const waiting = useRef(false);

  async function sync() {
    const r = await post<{ applied: boolean; pending: boolean; paidUntil: string | null }>('/driver/subscription/sync');
    if (r.applied) {
      waiting.current = false;
      setMsg({ tone: 'ok', text: `Pagamento confirmado. Plano em dia${r.paidUntil ? ` até ${dateBr(r.paidUntil)}` : ''}.` });
      await onPaid();
    } else if (r.pending) {
      setMsg({ tone: 'info', text: 'Pagamento em análise. Com Pix, a confirmação costuma chegar em segundos.' });
    }
  }

  // no Android o navegador abre por cima e o app só "volta" depois: confere ao reaparecer
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active' && waiting.current) sync().catch(() => {});
    });
    return () => sub.remove();
  }, []);

  // confirmação enviada pelo servidor assim que o Mercado Pago avisa
  useRealtime<{ paidUntil: string }>('subscription:paid', (d) => {
    waiting.current = false;
    setMsg({ tone: 'ok', text: `Pagamento confirmado. Plano em dia até ${dateBr(d.paidUntil)}.` });
    onPaid().catch(() => {});
  });

  async function pay() {
    setBusy(true);
    setMsg(null);
    try {
      const preference = await post<{ init_point: string }>('/driver/subscription/checkout', { periods: 1 });
      waiting.current = true;
      if (Platform.OS === 'web') {
        window.open(preference.init_point, '_blank', 'noopener');
      } else {
        await WebBrowser.openBrowserAsync(preference.init_point, {
          presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
          controlsColor: '#F2622E',
        });
        // iOS: a promessa só termina quando a pessoa fecha o navegador
        if (Platform.OS === 'ios') await sync();
      }
    } catch (e) {
      setMsg({ tone: 'error', text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const late = !due || due < today;

  return (
    <>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <Button
        label={`${late ? 'Pagar' : 'Renovar'} com Mercado Pago · ${money(priceCents)}`}
        onPress={pay}
        busy={busy}
        accessibilityHint={`Abre o Mercado Pago para pagar ${periodDays} dias de plano com Pix ou cartão`}
        testID="mp-checkout-cta-checkout-pro"
      />
    </>
  );
}
