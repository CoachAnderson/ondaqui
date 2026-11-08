import { useCallback, useEffect, useMemo, useState } from 'react';
import RideChat from '../components/RideChat';
import { Platform, Share, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { api, errMsg, post } from '../api';
import { SHARE_BASE_URL } from '../config';
import AuthImage from '../components/AuthImage';
import { firstName, money, paymentLabel, plate, when } from '../format';
import { useReconnect, useRealtime } from '../realtime';
import { colors, useBrand } from '../theme';
import type { Brand, LatLng, Ride } from '../types';
import RideMap, { type MapRoute } from '../components/RideMap';
import { decodePolyline } from '../polyline';
import { usePickupRoute } from '../usePickupRoute';
import Panic from '../components/Panic';
import Stars from '../components/Stars';
import AdCard from '../components/AdCard';
import { Button, Card, Muted, Notice, Row, Screen, Title } from '../components/ui';

const headlines: Record<string, Partial<Record<Ride['status'], string>>> = {
  corrida: {
    scheduled: 'Corrida agendada', requested: 'Procurando motorista…', accepted: 'Motorista a caminho',
    arrived: 'Seu motorista chegou', in_progress: 'Em viagem', completed: 'Você chegou!', cancelled: 'Corrida cancelada',
  },
  entrega: {
    scheduled: 'Entrega agendada', requested: 'Procurando entregador…', accepted: 'Entregador a caminho da coleta',
    arrived: 'Entregador na coleta', in_progress: 'Pacote a caminho', completed: 'Pacote entregue!', cancelled: 'Entrega cancelada',
  },
  particular: {
    scheduled: 'Motorista particular agendado', requested: 'Procurando motorista…', accepted: 'Motorista a caminho',
    arrived: 'Seu motorista chegou', in_progress: 'Motorista à sua disposição', completed: 'Serviço encerrado', cancelled: 'Serviço cancelado',
  },
  frete: {
    scheduled: 'Frete agendado', requested: 'Procurando frete…', accepted: 'Frete a caminho',
    arrived: 'O frete chegou', in_progress: 'Levando sua carga', completed: 'Carga entregue!', cancelled: 'Frete cancelado',
  },
};
const headline = (r: Ride) => headlines[r.kind]?.[r.status] ?? headlines.corrida[r.status]!;

interface Payment { method: string; available?: boolean; amountCents: number; pixKey?: string; holderName?: string; warning?: string; message?: string }

export default function RideScreen({ brand, initial, onDone }: { brand: Brand; initial: Ride; onDone: () => void }) {
  const { accent } = useBrand();
  const [ride, setRide] = useState<Ride>(initial);
  const [driverPos, setDriverPos] = useState<LatLng | null>(initial.driver?.location ?? null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ ride: Ride }>(`/rides/${initial.id}`);
      setRide(r.ride);
      if (r.ride.driver?.location) setDriverPos(r.ride.driver.location);
    } catch { /* tenta de novo no próximo ciclo */ }
  }, [initial.id]);

  useRealtime<Ride>('ride:updated', (r) => {
    if (r.id !== initial.id) return;
    setRide(r);
    if (r.driver?.location) setDriverPos(r.driver.location);
  });
  useRealtime<{ rideId: string | null; lat: number; lng: number }>('driver:location', (p) => {
    if (p.rideId === initial.id) setDriverPos({ lat: p.lat, lng: p.lng });
  });
  useReconnect(refresh);

  // segurança extra: se o tempo real cair, atualiza a cada 10 s
  useEffect(() => {
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  const hasDriver = ['accepted', 'arrived', 'in_progress', 'completed'].includes(ride.status);
  const used = ride.cashback?.usedCents ?? 0;
  const clubOff = ride.club?.discountCents ?? 0;
  useEffect(() => {
    if (!hasDriver || ride.paymentMethod !== 'pix') return;
    api<Payment>(`/rides/${ride.id}/payment`).then(setPayment).catch(() => setPayment(null));
  }, [hasDriver, ride.id, ride.paymentMethod]);

  async function cancel() {
    setError(null);
    try {
      await post(`/rides/${ride.id}/cancel`, { reason: 'desistiu' });
      await refresh();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setCancelling(false);
    }
  }

  const [extending, setExtending] = useState(false);
  async function extend() {
    setExtending(true);
    setError(null);
    try { const r = await post<{ ride: Ride }>(`/rides/${ride.id}/extend`, { hours: 1 }); setRide(r.ride); }
    catch (e) { setError(errMsg(e)); } finally { setExtending(false); }
  }

  async function share() {
    const url = `${SHARE_BASE_URL}/acompanhar/${ride.shareToken}`;
    const message = ride.kind === 'entrega'
      ? `${ride.delivery?.recipientName}, seu pacote está vindo pelo ${brand.name}. Acompanhe: ${url} — Código de entrega: ${ride.deliveryCode}. Só passe o código quando receber o pacote.`
      : `Estou indo para ${ride.destination.address} com o ${brand.name}. Acompanhe ao vivo: ${url}`;
    try {
      if (Platform.OS === 'web') throw new Error('web');
      await Share.share({ message });
    } catch {
      await Clipboard.setStringAsync(url);
      setCopied(true);
    }
  }

  const points = useMemo(() => {
    const list = [
      { id: 'origem', lat: ride.origin.lat, lng: ride.origin.lng, label: ride.kind === 'entrega' ? 'Coleta' : 'Embarque', color: colors.verde },
      { id: 'destino', lat: ride.destination.lat, lng: ride.destination.lng, label: 'Destino', color: accent },
    ];
    if (driverPos && ['accepted', 'arrived', 'in_progress'].includes(ride.status)) {
      list.push({ id: 'motorista', lat: driverPos.lat, lng: driverPos.lng, label: ride.driver?.name ?? 'Motorista', color: colors.noite });
    }
    return ride.status === 'accepted' || ride.kind === 'particular' ? list.filter((p) => p.id !== 'destino') : list;
  }, [ride.status, ride.kind, ride.origin, ride.destination, ride.driver?.name, driverPos, accent]);

  const active = ['scheduled', 'requested', 'accepted', 'arrived', 'in_progress'].includes(ride.status);

  // rota: tracejada do motorista até você; depois, o caminho da viagem
  const pickup = usePickupRoute(ride.id, ride.status, driverPos);
  const tripLine = useMemo(() => decodePolyline(ride.routePolyline), [ride.routePolyline]);
  const routes: MapRoute[] = ride.status === 'accepted'
    ? (pickup && pickup.coords.length > 1 ? [{ id: 'busca', coords: pickup.coords, color: colors.noite, dashed: true }] : [])
    : ride.kind !== 'particular' && tripLine.length > 1 ? [{ id: 'viagem', coords: tripLine, color: accent }] : [];

  return (
    <Screen>
      <Title>{headline(ride)}</Title>
      {ride.family && (
        <Notice tone="info">{`Corrida para ${ride.family.name} (${ride.family.relation}). Você é avisado no embarque e na chegada.`}</Notice>
      )}
      {ride.serviceName && <Muted>{ride.serviceName}{ride.scheduledFor ? ` · agendado para ${when(ride.scheduledFor)}` : ''}</Muted>}
      {ride.status === 'requested' && <Muted>Avisamos os motoristas mais próximos. Isso costuma levar menos de um minuto.</Muted>}
      {ride.status === 'cancelled' && (
        <Notice tone="warn">
          {ride.cancelReason === 'sem_motorista' ? 'Nenhum motorista disponível agora. Tente de novo em alguns minutos.' : 'A corrida foi cancelada.'}
        </Notice>
      )}

      {active && <RideMap points={points} routes={routes} height={220} />}
      {ride.status === 'accepted' && pickup?.durationMin != null && (
        <Muted>{`O motorista chega em cerca de ${pickup.durationMin} min.`}</Muted>
      )}

      {ride.driver && hasDriver && (
        <Card>
          {(ride.driver.hasPhoto || ride.driver.hasVehiclePhoto) && ride.status !== 'completed' && (
            <View style={{ flexDirection: 'row', gap: 10 }}>
              {ride.driver.hasPhoto && <AuthImage path={`/rides/${ride.id}/driver-photo`} label={`Foto de ${ride.driver.name}`}
                style={{ width: 88, height: 88, borderRadius: 44 }} />}
              {ride.driver.hasVehiclePhoto && <AuthImage path={`/rides/${ride.id}/driver-photo?which=veiculo`} label="Foto do veículo"
                style={{ flex: 1, height: 88, borderRadius: 12 }} />}
            </View>
          )}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 20, fontWeight: '800', color: colors.texto }}>{ride.driver.name}</Text>
              <Muted>{ride.driver.vehicle.model} {ride.driver.vehicle.color}</Muted>
            </View>
            <View style={{ backgroundColor: colors.noite, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 }}>
              <Text accessibilityLabel={`Placa ${ride.driver.vehicle.plate.split('').join(' ')}`}
                style={{ color: colors.branco, fontSize: 20, fontWeight: '800', letterSpacing: 2 }}>{plate(ride.driver.vehicle.plate)}</Text>
            </View>
          </View>
          {ride.status !== 'completed' && <Muted>Confira a placa e o carro antes de entrar.</Muted>}
          {ride.driver.camera && ride.kind !== 'entrega' && ['accepted', 'arrived'].includes(ride.status) && (
            <Notice tone="info">
              {`Este veículo tem câmera de segurança que grava ${ride.driver.camera === 'video_audio' ? 'vídeo e áudio' : 'vídeo'} durante a viagem. `}
              As gravações servem só para segurança e não podem ser divulgadas. Se preferir, cancele agora, sem custo.
            </Notice>
          )}
          {ride.driver.camera && ride.kind !== 'entrega' && ride.status === 'in_progress' && (
            <Muted>{`Viagem gravada pela câmera de segurança do veículo (${ride.driver.camera === 'video_audio' ? 'vídeo e áudio' : 'vídeo'}).`}</Muted>
          )}
        </Card>
      )}

      {ride.boardingCode && ['accepted', 'arrived'].includes(ride.status) && (
        <Card style={{ alignItems: 'center', backgroundColor: colors.noite, borderColor: colors.noite }}>
          <Text style={{ color: colors.areia, fontSize: 15, fontWeight: '600' }}>{ride.kind === 'entrega' ? 'Código de coleta' : 'Código de embarque'}</Text>
          <Text accessibilityLabel={`Código ${ride.boardingCode.split('').join(' ')}`}
            style={{ color: accent, fontSize: 48, fontWeight: '800', letterSpacing: 10 }}>{ride.boardingCode}</Text>
          <Text style={{ color: colors.areia, fontSize: 15, textAlign: 'center' }}>
            {ride.kind === 'entrega'
              ? 'Diga este código ao entregador quando ele pegar o pacote.'
              : ride.family
                ? `Mandamos este código por SMS para ${firstName(ride.family.name)}. Ela(e) diz ao motorista ao entrar; se precisar, passe por telefone.`
                : 'Diga este código ao motorista quando entrar no carro. Sem ele a viagem não começa.'}
          </Text>
        </Card>
      )}

      {ride.kind === 'entrega' && ride.deliveryCode && !['completed', 'cancelled'].includes(ride.status) && (
        <Card>
          <Text style={{ fontSize: 17, fontWeight: '800', color: colors.texto }}>Código de entrega: {ride.deliveryCode}</Text>
          <Muted>Envie para {ride.delivery?.recipientName}. O entregador só finaliza com este código, dito por quem recebe.</Muted>
        </Card>
      )}

      {ride.photos?.pickup && (
        <Card>
          <Muted>{ride.kind === 'frete' ? 'Foto da carga na saída' : 'Foto do pacote na coleta'}</Muted>
          <AuthImage path={`/rides/${ride.id}/pickup-photo`} label="Foto na coleta" style={{ width: '100%', height: 200, borderRadius: 12 }} />
        </Card>
      )}
      {ride.photos?.dropoff && (
        <Card>
          <Muted>Comprovante: foto na entrega</Muted>
          <AuthImage path={`/rides/${ride.id}/dropoff-photo`} label="Foto da entrega" style={{ width: '100%', height: 200, borderRadius: 12 }} />
        </Card>
      )}

      <Card>
        <Row label={ride.kind === 'entrega' ? 'Coleta' : 'De'} value={ride.origin.address} />
        {ride.kind !== 'particular' && <Row label={ride.kind === 'entrega' ? 'Entrega' : 'Para'} value={ride.destination.address} />}
        {ride.delivery && <Row label="Quem recebe" value={ride.delivery.recipientName} />}
        {ride.delivery && <Row label="Pacote" value={ride.delivery.packageDesc} />}
        {ride.hoursBooked != null && <Row label="Contratado" value={`${ride.hoursBooked} h`} />}
        {ride.kind === 'frete' && <Row label="Ajudantes" value={String(ride.helpers)} />}
        {ride.notes && <Row label="Observações" value={ride.notes} />}
        <Row label="Valor" value={money(ride.priceCents)} />
        {clubOff > 0 && <Row label="Desconto do Clube" value={`− ${money(clubOff)}`} />}
        {used > 0 && <Row label="Cashback usado" value={`− ${money(used)}`} />}
        {(used > 0 || clubOff > 0) && <Row label="Você paga ao motorista" value={money(ride.cashback!.payCents)} />}
        <Row label="Pagamento" value={paymentLabel[ride.paymentMethod]} />
      </Card>
      {ride.status === 'completed' && (ride.cashback?.earnedCents ?? 0) > 0 && (
        <Notice tone="ok">{`Você ganhou ${money(ride.cashback!.earnedCents)} de cashback para a próxima corrida.`}</Notice>
      )}
      {ride.status === 'cancelled' && used > 0 && <Notice tone="info">{`Os ${money(used)} de cashback voltaram para o seu saldo.`}</Notice>}

      {payment && ride.paymentMethod === 'pix' && ride.status !== 'cancelled' && (
        <Card>
          <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>Pagar com Pix</Text>
          {payment.available ? (
            <>
              <Row label="Chave" value={payment.pixKey} />
              <Row label="Recebedor" value={payment.holderName} />
              <Row label="Valor" value={money(payment.amountCents)} />
              <Notice tone="warn">{payment.warning}</Notice>
              <Button kind="secondary" label={copied ? 'Chave copiada' : 'Copiar chave Pix'}
                onPress={async () => { await Clipboard.setStringAsync(payment.pixKey!); setCopied(true); }} />
            </>
          ) : (
            <Notice tone="warn">{payment.message}</Notice>
          )}
        </Card>
      )}

      {error && <Notice tone="error">{error}</Notice>}

      {ride.kind === 'particular' && ['accepted', 'arrived', 'in_progress'].includes(ride.status) && (
        <Button kind="secondary" label={`Mais 1 hora · ${money(Math.round(ride.priceCents / (ride.hoursBooked || 1)))}`} onPress={extend} busy={extending} />
      )}

      {active && ride.shareToken && (
        <Button kind="dark" onPress={share}
          label={copied && Platform.OS === 'web' ? 'Link copiado'
            : ride.kind === 'entrega' ? 'Enviar link e código para quem recebe' : 'Compartilhar corrida com a família'} />
      )}
      {ride.status === 'in_progress' && ride.kind !== 'entrega' && <AdCard placement="corrida" />}
      {ride.driver && <RideChat rideId={ride.id} side="cliente" status={ride.status} />}
      {['accepted', 'arrived', 'in_progress'].includes(ride.status) && <Panic rideId={ride.id} />}

      {['scheduled', 'requested', 'accepted', 'arrived'].includes(ride.status) && (
        cancelling ? (
          <View style={{ gap: 8 }}>
            <Notice tone="warn">Tem certeza que quer cancelar a corrida?</Notice>
            <Button kind="danger" label="Sim, cancelar" onPress={cancel} />
            <Button kind="secondary" label="Não, manter" onPress={() => setCancelling(false)} />
          </View>
        ) : (
          <Button kind="secondary" label="Cancelar corrida" onPress={() => setCancelling(true)} />
        )
      )}

      {ride.status === 'completed' && (
        <Card>
          <Stars rideId={ride.id} question={`Como foi a viagem com ${ride.driver?.name ?? 'o motorista'}?`} prefs={ride.tripPrefs?.summary} />
        </Card>
      )}
      {(!active || ride.status === 'scheduled') && <Button label={ride.status === 'scheduled' ? 'Voltar' : 'Novo pedido'} onPress={onDone} />}
    </Screen>
  );
}
