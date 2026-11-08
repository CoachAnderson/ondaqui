import { useCallback, useEffect, useState } from 'react';
import { Modal, Text, View } from 'react-native';
import { api } from '../api';
import { money } from '../format';
import { useRealtime } from '../realtime';
import { colors } from '../theme';
import { Button, Card, Check, Muted, Screen, Title } from '../components/ui';

export interface CashbackEntry {
  id: string; kind: 'corrida' | 'loja' | 'uso' | 'devolucao' | 'expirado' | 'ajuste';
  amountCents: number; createdAt: string; expiresAt: string | null; label: string;
}
export interface Wallet {
  balanceCents: number;
  nextExpiry: { amountCents: number; expiresAt: string } | null;
  rules: { enabled: boolean; pct: number; maxRideCents: number; maxMonthCents: number; days: number; usePct: number };
  entries: CashbackEntry[];
}

const dateBr = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
const pct = (n: number) => String(n).replace('.', ',');

/** Saldo de cashback do passageiro; atualiza quando ganha, usa ou recebe devolução */
export function useWallet() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const reload = useCallback(() => {
    api<Wallet>('/cashback').then(setWallet).catch(() => {});
  }, []);
  useEffect(() => { reload(); }, [reload]);
  useRealtime('cashback:updated', reload);
  return { wallet, reload };
}

/** Quanto do saldo dá para usar numa corrida deste valor (a API confere de novo ao pedir) */
export const usableCashback = (w: Wallet | null, priceCents: number) =>
  w ? Math.max(0, Math.min(w.balanceCents, Math.floor((priceCents * w.rules.usePct) / 100))) : 0;

/** Na hora de pedir: usar o saldo nesta corrida */
export function UseCashback({ wallet, priceCents, on, onChange }: {
  wallet: Wallet | null; priceCents: number; on: boolean; onChange: (v: boolean) => void;
}) {
  const usable = usableCashback(wallet, priceCents);
  if (usable <= 0) return null;
  return (
    <Card style={{ borderColor: on ? colors.verde : colors.linha, borderWidth: on ? 2 : 1 }}>
      <Check checked={on} onChange={onChange} label={`Usar ${money(usable)} do meu cashback`} />
      <Muted>
        {on
          ? `Você paga ${money(priceCents - usable)} ao motorista. Se cancelar, o cashback volta.`
          : `Saldo de ${money(wallet!.balanceCents)}. Dá para usar até ${wallet!.rules.usePct}% de cada corrida.`}
      </Muted>
    </Card>
  );
}

/** Cartão da tela inicial: saldo, o que vence primeiro e como ganhar */
export function CashbackCard({ wallet, onOpen }: { wallet: Wallet | null; onOpen: () => void }) {
  if (!wallet || (!wallet.rules.enabled && wallet.balanceCents === 0)) return null;
  return (
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <Text style={{ fontSize: 17, fontWeight: '800', color: colors.texto }}>Meu cashback</Text>
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors.verde }}>{money(wallet.balanceCents)}</Text>
      </View>
      <Muted>
        {wallet.rules.enabled
          ? `Ganhe ${pct(wallet.rules.pct)}% de volta em cada corrida e use até ${wallet.rules.usePct}% da próxima.`
          : 'Use seu saldo nas próximas corridas.'}
        {wallet.nextExpiry ? ` ${money(wallet.nextExpiry.amountCents)} vencem em ${dateBr(wallet.nextExpiry.expiresAt)}.` : ''}
      </Muted>
      <Button kind="secondary" label="Ver extrato" onPress={onOpen} />
    </Card>
  );
}

const SIGN: Record<string, string> = { corrida: '+', loja: '+', ajuste: '', devolucao: '+', uso: '', expirado: '' };

/** Extrato com as regras da cidade */
export function CashbackStatement({ visible, onClose, wallet }: { visible: boolean; onClose: () => void; wallet: Wallet | null }) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <Screen>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Title>Meu cashback</Title>
          <Text accessibilityRole="button" onPress={onClose} style={{ color: colors.texto2, textDecorationLine: 'underline', padding: 8 }}>Fechar</Text>
        </View>
        {wallet && (
          <>
            <Card>
              <Muted>Saldo para usar</Muted>
              <Text style={{ fontSize: 36, fontWeight: '800', color: colors.verde }}>{money(wallet.balanceCents)}</Text>
              {wallet.nextExpiry && <Muted>{`${money(wallet.nextExpiry.amountCents)} vencem em ${dateBr(wallet.nextExpiry.expiresAt)}. Use primeiro.`}</Muted>}
            </Card>
            <Card>
              <Text style={{ fontSize: 16, fontWeight: '800', color: colors.texto }}>Como funciona</Text>
              {wallet.rules.enabled && (
                <Muted>{`• Cada corrida concluída devolve ${pct(wallet.rules.pct)}% do que você pagou, até ${money(wallet.rules.maxRideCents)} por corrida e ${money(wallet.rules.maxMonthCents)} por mês.`}</Muted>
              )}
              <Muted>• Lojas parceiras dão cashback quando entregam o seu pedido.</Muted>
              <Muted>{`• Ao pedir, marque "Usar cashback": desconta até ${wallet.rules.usePct}% da corrida e você paga o resto ao motorista.`}</Muted>
              <Muted>{`• Cada crédito vale ${wallet.rules.days} dias. Não é dinheiro: não dá para sacar nem transferir.`}</Muted>
            </Card>
            <Card>
              <Text style={{ fontSize: 16, fontWeight: '800', color: colors.texto }}>Extrato</Text>
              {wallet.entries.length === 0 && <Muted>Nada por aqui ainda. Sua primeira corrida já rende cashback.</Muted>}
              {wallet.entries.map((e) => (
                <View key={e.id} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.linha }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ fontSize: 15, color: colors.texto }}>{e.label}</Text>
                    <Muted>{dateBr(e.createdAt)}{e.expiresAt && e.amountCents > 0 && e.kind !== 'devolucao' ? ` · vale até ${dateBr(e.expiresAt)}` : ''}</Muted>
                  </View>
                  <Text style={{ fontSize: 15, fontWeight: '800', color: e.amountCents > 0 ? colors.verde : colors.texto2 }}>
                    {`${e.amountCents > 0 ? SIGN[e.kind] || '+' : '−'} ${money(Math.abs(e.amountCents))}`}
                  </Text>
                </View>
              ))}
            </Card>
          </>
        )}
      </Screen>
    </Modal>
  );
}
