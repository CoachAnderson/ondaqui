import { useCallback, useEffect, useState } from 'react';
import { Image, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { api, errMsg, post } from '../api';
import { money } from '../format';
import { useRealtime } from '../realtime';
import { colors } from '../theme';
import { Button, Card, Muted, Notice } from '../components/ui';

interface Cod {
  amountCents: number; method: 'pix_mp' | 'pix_chave' | 'maquininha' | null;
  status: 'pendente' | 'pago' | 'aguardando_loja' | 'confirmado' | 'contestado';
  qrCode?: string | null; qrCodeBase64?: string | null; pixKey?: string; holderName?: string; warning?: string;
}

/**
 * Cobrar o produto na entrega (pedido de loja). O dinheiro vai direto para a loja:
 *  • Pix do Mercado Pago da loja: QR com o valor, confirmação automática
 *  • Pix pela chave conferida pela central: o motoboy confirma e a loja confere no painel
 *  • Maquininha da loja
 */
export default function CollectPayment({ rideId, onPaid }: { rideId: string; onPaid: () => void }) {
  const [cod, setCod] = useState<Cod | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try { setCod(await api<Cod>(`/rides/${rideId}/cod`)); } catch (e) { setError(errMsg(e)); }
  }, [rideId]);
  useEffect(() => { void load(); }, [load]);

  const paid = !!cod && ['pago', 'aguardando_loja', 'confirmado'].includes(cod.status);
  useEffect(() => { if (paid) onPaid(); }, [paid, onPaid]);

  // Pix do Mercado Pago: confere a cada 4 s até cair (e na hora, pelo aviso em tempo real)
  useEffect(() => {
    if (cod?.method !== 'pix_mp' || cod.status !== 'pendente') return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [cod?.method, cod?.status, load]);
  useRealtime<{ rideId: string }>('ride:cod', (d) => { if (d.rideId === rideId) void load(); });

  async function run(key: string, fn: () => Promise<Cod>) {
    setBusy(key);
    setError(null);
    try { setCod(await fn()); } catch (e) { setError(errMsg(e)); } finally { setBusy(null); }
  }

  if (!cod) return null;
  const value = money(cod.amountCents);

  return (
    <Card>
      <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>Cobrar {value} do produto</Text>
      {paid ? (
        <Notice tone="ok">{cod.status === 'pago' ? `Pix de ${value} recebido pela loja.` : 'Pagamento registrado. A loja confere no painel.'}</Notice>
      ) : (
        <>
          <Muted>O dinheiro vai direto para a loja. Você não recebe o valor do produto.</Muted>

          {cod.method === 'pix_mp' && cod.qrCode && (
            <View style={{ alignItems: 'center', gap: 10 }}>
              {cod.qrCodeBase64 ? (
                <Image accessibilityLabel="QR Code do Pix da loja" source={{ uri: `data:image/png;base64,${cod.qrCodeBase64}` }}
                  style={{ width: 220, height: 220, backgroundColor: colors.branco }} />
              ) : null}
              <Text style={{ fontSize: 15, color: colors.texto2, textAlign: 'center' }}>Mostre o QR para o cliente pagar {value}. A confirmação é automática.</Text>
              <Button kind="secondary" label={copied ? 'Código copiado' : 'Copiar Pix copia e cola'}
                onPress={async () => { await Clipboard.setStringAsync(cod.qrCode!); setCopied(true); }} />
              <Muted>Aguardando o pagamento…</Muted>
            </View>
          )}

          {cod.method === 'pix_chave' && (
            <View style={{ gap: 8 }}>
              <Text style={{ fontSize: 16, color: colors.texto }}>Chave Pix da loja: <Text style={{ fontWeight: '800' }}>{cod.pixKey}</Text></Text>
              <Text style={{ fontSize: 16, color: colors.texto }}>Recebedor: <Text style={{ fontWeight: '800' }}>{cod.holderName}</Text></Text>
              <Notice tone="warn">{cod.warning}</Notice>
              <Button label="O cliente pagou o Pix" onPress={() => run('confirm', () => post<Cod>(`/rides/${rideId}/cod/confirm`, { method: 'pix_chave' }))} busy={busy === 'confirm'} />
            </View>
          )}

          {!cod.method && (
            <Button label={`Gerar Pix da loja · ${value}`} onPress={() => run('pix', () => post<Cod>(`/rides/${rideId}/cod/pix`))} busy={busy === 'pix'} />
          )}
          {cod.method !== 'pix_mp' && (
            <Button kind="secondary" label="O cliente pagou na maquininha da loja"
              onPress={() => run('maq', () => post<Cod>(`/rides/${rideId}/cod/confirm`, { method: 'maquininha' }))} busy={busy === 'maq'} />
          )}
        </>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </Card>
  );
}
