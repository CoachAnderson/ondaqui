import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { errMsg, post } from '../api';
import { OFFER_SECONDS } from '../config';
import { km, money, paymentLabel, when } from '../format';
import { colors, useBrand } from '../theme';
import type { Offer, Ride } from '../types';
import { Button, Notice, Row } from '../components/ui';

/** Nova corrida: o motorista vê destino e valor antes de aceitar */
export default function OfferCard({ offer, onAccepted, onGone }: {
  offer: Offer; onAccepted: (r: Ride) => void; onGone: () => void;
}) {
  const { accent } = useBrand();
  const [left, setLeft] = useState(OFFER_SECONDS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setLeft((s) => s - 1), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (left <= 0) {
      post(`/rides/${offer.rideId}/decline`).catch(() => {});
      onGone();
    }
  }, [left, offer.rideId, onGone]);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ ride: Ride }>(`/rides/${offer.rideId}/accept`);
      onAccepted(r.ride);
    } catch (e) {
      setError(errMsg(e));
      setTimeout(onGone, 2500);
    } finally {
      setBusy(false);
    }
  }

  function decline() {
    post(`/rides/${offer.rideId}/decline`).catch(() => {});
    onGone();
  }

  return (
    <View accessibilityRole="alert" style={{ backgroundColor: colors.noite, borderRadius: 20, padding: 18, gap: 14 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ color: colors.areia, fontSize: 20, fontWeight: '800', flex: 1 }}>
          {offer.kind && offer.kind !== 'corrida' ? offer.serviceName : offer.serviceName && offer.serviceName !== 'Daqui Car' ? offer.serviceName : 'Nova corrida'}
        </Text>
        <Text accessibilityLabel={`${left} segundos para responder`} style={{ color: accent, fontSize: 18, fontWeight: '800' }}>{Math.max(left, 0)} s</Text>
      </View>
      {offer.shift
        ? <Text style={{ color: accent, fontSize: 24, fontWeight: '800' }}>Entrega do seu turno fixo</Text>
        : <Text style={{ color: accent, fontSize: 40, fontWeight: '800' }}>{money(offer.priceCents)}</Text>}
      <View style={{ backgroundColor: colors.areia, borderRadius: 14, padding: 14, gap: 10 }}>
        {offer.scheduledFor && <Row label="Agendada para" value={when(offer.scheduledFor)} />}
        <Row label={offer.kind === 'entrega' ? 'Coletar em' : 'Buscar em'} value={offer.origin.address} />
        {offer.pickupDistanceKm != null && <Row label="Até a busca" value={km(offer.pickupDistanceKm)} />}
        {offer.kind === 'particular'
          ? <Row label="Contratado" value={`${offer.hoursBooked} h à disposição`} />
          : <>
              <Row label={offer.kind === 'entrega' ? 'Entregar em' : 'Destino'} value={offer.destination.address} />
              <Row label="Viagem" value={`${km(offer.distanceKm)} · ${offer.durationMin} min`} />
            </>}
        {offer.kind === 'entrega' && offer.packageDesc && <Row label="Pacote" value={offer.packageDesc} />}
        {offer.kind === 'frete' && <Row label="Ajudantes" value={String(offer.helpers ?? 0)} />}
        {offer.kind === 'paciente' && (
          <Row label="Paciente" value={[offer.wheelchair && 'cadeirante', offer.companion && 'com acompanhante'].filter(Boolean).join(' · ') || 'sem necessidades especiais'} />
        )}
        {offer.codAmountCents ? <Row label="Cobrar na entrega" value={`${money(offer.codAmountCents)} (vai para a loja)`} /> : null}
        {offer.notes && <Row label="Observações" value={offer.notes} />}
        <Row label="Pagamento" value={paymentLabel[offer.paymentMethod]} />
      </View>
      {error && <Notice tone="error">{error}</Notice>}
      <Button label="Aceitar" onPress={accept} busy={busy} />
      <Button kind="secondary" label="Recusar" onPress={decline} disabled={busy} />
    </View>
  );
}
