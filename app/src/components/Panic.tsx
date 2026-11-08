import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { errMsg, post } from '../api';
import { currentPosition } from '../location';
import { colors } from '../theme';
import { Button, Notice } from './ui';

/** Botão de emergência em duas etapas, para evitar toque sem querer */
export default function Panic({ rideId }: { rideId: string }) {
  const [step, setStep] = useState<'idle' | 'confirm' | 'sent'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    let pos = {};
    try { pos = await currentPosition(); } catch { /* sem GPS: a central usa a posição do motorista */ }
    try {
      await post(`/rides/${rideId}/panic`, pos);
      setStep('sent');
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const call190 = () => Linking.openURL('tel:190');

  if (step === 'sent') {
    return (
      <View style={{ gap: 10 }}>
        <Notice tone="ok">Alerta enviado para a central com a sua localização. Se estiver em perigo, ligue 190.</Notice>
        <Button kind="danger" label="Ligar 190" onPress={call190} />
      </View>
    );
  }
  if (step === 'confirm') {
    return (
      <View style={{ gap: 10, borderRadius: 16, borderWidth: 2, borderColor: colors.vermelho, padding: 14, backgroundColor: colors.vermelhoClaro }}>
        <Text style={{ fontSize: 17, fontWeight: '800', color: '#8E2A22' }}>Enviar alerta de emergência?</Text>
        <Text style={{ fontSize: 15, color: '#8E2A22' }}>A central da cidade recebe na hora a sua localização e os dados da corrida.</Text>
        {error && <Notice tone="error">{error}</Notice>}
        <Button kind="danger" label="Enviar alerta agora" onPress={send} busy={busy} />
        <Button kind="danger" label="Ligar 190" onPress={call190} />
        <Button kind="secondary" label="Cancelar" onPress={() => setStep('idle')} />
      </View>
    );
  }
  return <Button kind="secondary" label="Emergência" onPress={() => setStep('confirm')} accessibilityHint="Abre as opções de emergência" />;
}
