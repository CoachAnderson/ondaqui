import { useCallback, useEffect, useMemo, useState } from 'react';
import RideChat from '../components/RideChat';
import { Linking, Platform, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { api, errMsg, post } from '../api';
import { money, paymentLabel, when } from '../format';
import { useReconnect, useRealtime } from '../realtime';
import { colors, useBrand } from '../theme';
import type { Place, Ride } from '../types';
import RideMap from '../components/RideMap';
import { decodePolyline } from '../polyline';
import { usePickupRoute } from '../usePickupRoute';
import Panic from '../components/Panic';
import Stars from '../components/Stars';
import CollectPayment from './CollectPayment';
import { Button, Card, Field, Muted, Notice, Row, Screen, Title } from '../components/ui';

const headlines: Record<string, Partial<Record<Ride['status'], string>>> = {
  corrida: { accepted: 'Vá até o passageiro', arrived: 'Peça o código de embarque', in_progress: 'Em viagem', completed: 'Corrida finalizada', cancelled: 'Corrida cancelada' },
  entrega: { accepted: 'Vá até a coleta', arrived: 'Foto do pacote e código de coleta', in_progress: 'Leve o pacote', completed: 'Entrega concluída', cancelled: 'Entrega cancelada' },
  particular: { accepted: 'Vá até o cliente', arrived: 'Peça o código de embarque', in_progress: 'À disposição do cliente', completed: 'Serviço encerrado', cancelled: 'Serviço cancelado' },
  frete: { accepted: 'Vá até a carga', arrived: 'Peça o código para carregar', in_progress: 'Levando a carga', completed: 'Frete concluído', cancelled: 'Frete cancelado' },
  paciente: { accepted: 'Vá buscar o paciente', arrived: 'Confira o nome do paciente', in_progress: 'Levando o paciente', completed: 'Viagem concluída', cancelled: 'Viagem cancelada pela Saúde' },
};
const headline = (r: Ride) => headlines[r.kind]?.[r.status] ?? headlines.corrida[r.status] ?? 'Corrida';

function navigate(p: Place, app: 'google' | 'waze') {
  const url = app === 'waze'
    ? `https://waze.com/ul?ll=${p.lat},${p.lng}&navigate=yes`
    : Platform.OS === 'ios'
      ? `https://maps.apple.com/?daddr=${p.lat},${p.lng}`
      : `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
  Linking.openURL(url).catch(() => {});
}

export default function DriverRide({ initial, onDone }: { initial: Ride; onDone: () => void }) {
  const { accent } = useBrand();
  const [ride, setRide] = useState<Ride>(initial);
  const [code, setCode] = useState('');
  const [deliveryCode, setDeliveryCode] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [result, setResult] = useState<{ priceCents: number; commissionCents: number; driverReceivesCents: number } | null>(null);

  const refresh = useCallback(async () => {
    try { setRide((await api<{ ride: Ride }>(`/rides/${initial.id}`)).ride); } catch { /* tenta de novo depois */ }
  }, [initial.id]);

  useRealtime<Ride>('ride:updated', (r) => { if (r.id === initial.id) setRide((old) => ({ ...old, ...r })); });
  useReconnect(refresh);
  useEffect(() => {
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  // até o embarque: caminho a partir da posição do motorista; na viagem: o traçado até o destino
  // cashback e desconto do Clube: o passageiro paga menos e a central paga a diferença ao motorista
  const cashUsed = (ride.cashback?.usedCents ?? 0) + (ride.club?.discountCents ?? 0);
  const subsidyWhat = (ride.club?.discountCents ?? 0) > 0 && (ride.cashback?.usedCents ?? 0) > 0 ? 'cashback e desconto do Clube'
    : (ride.club?.discountCents ?? 0) > 0 ? 'desconto do Clube' : 'cashback';
  const pickup = usePickupRoute(ride.id, ride.status, ride.driver?.location ?? null);
  const tripLine = useMemo(() => decodePolyline(ride.routePolyline), [ride.routePolyline]);

  async function step(key: string, path: string, body: object = {}) {
    setBusy(key);
    setError(null);
    try {
      const r = await post(`/rides/${ride.id}/${path}`, body);
      if (path === 'complete') setResult(r);
      if (path === 'cancel') { onDone(); return; }
      await refresh();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  async function photo(which: 'pickup' | 'dropoff' = 'pickup') {
    setBusy(`photo-${which}`);
    setError(null);
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) throw new Error('Libere a câmera para tirar a foto.');
      const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.5, base64: true });
      if (r.canceled || !r.assets[0]?.base64) return;
      await post(`/rides/${ride.id}/${which}-photo`, { image: `data:image/jpeg;base64,${r.assets[0].base64}` });
      await refresh();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  const isPatient = ride.kind === 'paciente';
  const isDelivery = ride.kind === 'entrega';
  const needsPhotos = isDelivery || ride.kind === 'frete'; // foto da carga na coleta e na entrega
  const what = isDelivery ? 'do pacote' : 'da carga';
  const [codPaid, setCodPaid] = useState(false);
  const codOk = !ride.cod || codPaid || ['pago', 'aguardando_loja', 'confirmado'].includes(ride.cod.status);
  const onCodPaid = useCallback(() => setCodPaid(true), []);
  const target = ride.status === 'in_progress' ? ride.destination : ride.origin;
  const done = ride.status === 'completed' || ride.status === 'cancelled';

  return (
    <Screen>
      <Title>{headline(ride)}</Title>
      {ride.serviceName && <Muted>{ride.serviceName}{ride.scheduledFor ? ` · agendada para ${when(ride.scheduledFor)}` : ''}</Muted>}

      {!done && (
        <RideMap height={200} routes={
          ride.status === 'accepted' && pickup && pickup.coords.length > 1 ? [{ id: 'busca', coords: pickup.coords, color: colors.noite, dashed: true }]
            : ride.status === 'in_progress' && tripLine.length > 1 ? [{ id: 'viagem', coords: tripLine, color: accent }] : []
        } points={[
          ride.status === 'in_progress'
            ? { id: 'destino', lat: ride.destination.lat, lng: ride.destination.lng, label: 'Destino', color: accent }
            : { id: 'origem', lat: ride.origin.lat, lng: ride.origin.lng, label: ride.passenger.name, color: colors.verde },
        ]} />
      )}

      <Card>
        <Row label={isPatient ? 'Paciente' : isDelivery ? 'Remetente' : 'Passageiro'} value={ride.passenger.name} />
        {ride.family && <Row label="Pedida por" value={ride.family.requestedBy ?? 'um familiar'} />}
        {ride.family && <Muted>{`${ride.family.name} é ${ride.family.relation} de ${ride.family.requestedBy ?? 'quem pediu'}. O chat fala com quem pediu.`}</Muted>}
        {ride.family?.notes && <Notice tone="info">{ride.family.notes}</Notice>}
        {ride.patient?.phone && <Row label="Telefone" value={ride.patient.phone} />}
        {ride.patient && (ride.patient.wheelchair || ride.patient.companion) && (
          <Row label="Atenção" value={[ride.patient.wheelchair && 'cadeirante', ride.patient.companion && 'vai com acompanhante'].filter(Boolean).join(' · ')} />
        )}
        <Row label={ride.status === 'in_progress' ? (isDelivery ? 'Entregar em' : 'Destino') : (isDelivery ? 'Coletar em' : 'Buscar em')} value={target.address} />
        {ride.status !== 'in_progress' && ride.kind !== 'particular' && <Row label={isDelivery ? 'Entregar em' : 'Destino'} value={ride.destination.address} />}
        {ride.delivery && <Row label="Quem recebe" value={`${ride.delivery.recipientName}${ride.delivery.recipientPhone ? ` · ${ride.delivery.recipientPhone}` : ''}`} />}
        {ride.delivery && <Row label="Pacote" value={ride.delivery.packageDesc} />}
        {ride.hoursBooked != null && <Row label="Contratado" value={`${ride.hoursBooked} h`} />}
        {ride.kind === 'frete' && <Row label="Ajudantes" value={String(ride.helpers)} />}
        {ride.notes && <Row label="Observações" value={ride.notes} />}
        <Row label="Valor" value={money(ride.priceCents)} />
        {cashUsed > 0 && <Row label="Receber do passageiro" value={money(ride.cashback!.payCents)} />}
        <Row label="Pagamento" value={paymentLabel[ride.paymentMethod]} />
        {(ride.tripPrefs?.summary.length ?? 0) > 0 && (
          <Notice tone="info">{`Preferências do passageiro: ${ride.tripPrefs!.summary.join(' · ')}.`}</Notice>
        )}
        {cashUsed > 0 && (
          <Notice tone="info">{`O passageiro tem ${money(cashUsed)} de ${subsidyWhat}. Receba ${money(ride.cashback!.payCents)} dele; a central paga os ${money(cashUsed)} a você no acerto da semana.`}</Notice>
        )}
      </Card>

      {error && <Notice tone="error">{error}</Notice>}

      {!done && (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button kind="dark" style={{ flex: 1 }} label={Platform.OS === 'ios' ? 'Mapas' : 'Google Maps'} onPress={() => navigate(target, 'google')} />
          <Button kind="dark" style={{ flex: 1 }} label="Waze" onPress={() => navigate(target, 'waze')} />
        </View>
      )}

      {ride.status === 'accepted' && <Button label={isDelivery ? 'Cheguei na coleta' : 'Cheguei no embarque'} onPress={() => step('arrived', 'arrived')} busy={busy === 'arrived'} />}

      {needsPhotos && (ride.status === 'accepted' || ride.status === 'arrived') && (
        <Card>
          <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>Foto {what} na coleta</Text>
          <Muted>A foto fica para o cliente e para a central. Sem ela não dá para sair.</Muted>
          {ride.photos?.pickup
            ? <Notice tone="ok">Foto enviada.</Notice>
            : <Button kind="dark" label={`Tirar foto ${what}`} onPress={() => photo('pickup')} busy={busy === 'photo-pickup'} />}
        </Card>
      )}

      {isPatient && (ride.status === 'accepted' || ride.status === 'arrived') && (
        <Card>
          <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>Confira o paciente</Text>
          <Muted>Pergunte o nome completo antes de sair: {ride.passenger.name}. A central da Saúde acompanha a viagem.</Muted>
          <Button label="Paciente embarcou, iniciar" onPress={() => step('start', 'start', {})} busy={busy === 'start'} />
        </Card>
      )}

      {!isPatient && (ride.status === 'accepted' || ride.status === 'arrived') && (
        <Card>
          <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>{isDelivery ? 'Código de coleta' : 'Código de embarque'}</Text>
          <Muted>{isDelivery
            ? 'Peça a quem está entregando o pacote o código de 4 números que aparece no app.'
            : 'Peça ao passageiro o código de 4 números que aparece no app dele. Isso garante que é a pessoa certa.'}</Muted>
          <Field label="Código" value={code} onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 4))}
                 keyboardType="number-pad" maxLength={4} placeholder="0000" />
          <Button label={isDelivery ? 'Coletei, sair para entregar' : 'Iniciar viagem'} onPress={() => step('start', 'start', { boardingCode: code })}
                  busy={busy === 'start'} disabled={code.length !== 4 || (needsPhotos && !ride.photos?.pickup)} />
        </Card>
      )}

      {ride.status === 'in_progress' && needsPhotos && (
        <Card>
          <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>Foto da entrega (comprovante)</Text>
          <Muted>Fotografe {isDelivery ? 'o pacote com quem recebeu ou na portaria' : 'a carga descarregada'}. Evita o "não recebi".</Muted>
          {ride.photos?.dropoff
            ? <Notice tone="ok">Comprovante enviado.</Notice>
            : <Button kind="dark" label="Tirar foto da entrega" onPress={() => photo('dropoff')} busy={busy === 'photo-dropoff'} />}
        </Card>
      )}
      {ride.status === 'in_progress' && ride.cod && <CollectPayment rideId={ride.id} onPaid={onCodPaid} />}
      {ride.status === 'in_progress' && isDelivery && (
        <Card>
          <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>Código de entrega</Text>
          <Muted>Peça a {ride.delivery?.recipientName} o código que o remetente enviou. Sem ele, não entregue o pacote.</Muted>
          <Field label="Código" value={deliveryCode} onChangeText={(t) => setDeliveryCode(t.replace(/\D/g, '').slice(0, 4))}
                 keyboardType="number-pad" maxLength={4} placeholder="0000" />
          <Button label="Entreguei" onPress={() => step('complete', 'complete', { deliveryCode })} busy={busy === 'complete'}
                  disabled={deliveryCode.length !== 4 || !ride.photos?.dropoff || !codOk} />
          {!codOk && <Muted>Primeiro receba o valor do produto.</Muted>}
        </Card>
      )}
      {ride.status === 'in_progress' && !isDelivery && (
        <Button label={ride.kind === 'particular' ? 'Encerrar serviço' : ride.kind === 'frete' ? 'Finalizar frete' : 'Finalizar corrida'}
                onPress={() => step('complete', 'complete')} busy={busy === 'complete'} disabled={ride.kind === 'frete' && !ride.photos?.dropoff} />
      )}

      {ride.status === 'completed' && (
        <Card>
          <Muted>Você recebe</Muted>
          <Text style={{ fontSize: 40, fontWeight: '800', color: colors.verde }}>{money(result?.driverReceivesCents ?? ride.priceCents)}</Text>
          {result && result.commissionCents > 0 && <Muted>Corrida de {money(result.priceCents)} − comissão de {money(result.commissionCents)}</Muted>}
          {ride.paymentMethod === 'conta_loja'
            ? <Notice tone="info">Frete pago pela loja: a central repassa {money(ride.priceCents)} para você no fechamento.</Notice>
            : ride.paymentMethod === 'convenio'
            ? <Notice tone="info">Pago pela Prefeitura: a central repassa {money(ride.priceCents)} para você no fechamento do mês.</Notice>
            : ride.paymentMethod !== 'pix' && <Notice tone="info">Receba {money(ride.priceCents - cashUsed)} do passageiro ({paymentLabel[ride.paymentMethod].toLowerCase()}).</Notice>}
          {cashUsed > 0 && <Notice tone="info">{`${money(cashUsed)} de ${subsidyWhat}: a central abate da sua comissão ou paga no seu Pix no fechamento da semana.`}</Notice>}
          {!isPatient && <Stars rideId={ride.id} question={`Como foi ${isDelivery ? 'a entrega' : 'a viagem'} com ${ride.passenger.name}?`} />}
        </Card>
      )}

      <RideChat rideId={ride.id} side="motorista" status={ride.status} />
      {['accepted', 'arrived', 'in_progress'].includes(ride.status) && <Panic rideId={ride.id} />}

      {['accepted', 'arrived'].includes(ride.status) && (
        cancelling ? (
          <View style={{ gap: 8 }}>
            <Notice tone="warn">A corrida volta para outros motoristas. Cancelamentos frequentes podem bloquear sua conta.</Notice>
            <Button kind="danger" label="Cancelar mesmo assim" onPress={() => step('cancel', 'cancel', { reason: 'motorista_desistiu' })} busy={busy === 'cancel'} />
            <Button kind="secondary" label="Voltar" onPress={() => setCancelling(false)} />
          </View>
        ) : (
          <Button kind="secondary" label="Não posso fazer esta corrida" onPress={() => setCancelling(true)} />
        )
      )}

      {done && <Button label="Voltar a receber corridas" onPress={onDone} />}
    </Screen>
  );
}
