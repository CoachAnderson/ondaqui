import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Vibration, View } from 'react-native';
import { api, post } from '../api';
import { useReconnect, useRealtime } from '../realtime';
import { colors } from '../theme';
import type { Brand, Offer, Ride } from '../types';
import DriverHome, { type DriverMe, type Earnings } from './DriverHome';
import DriverRide from './DriverRide';
import { useDriverLocation } from './useDriverLocation';
import { useNotificationOpen, usePushRegistration, type PushStatus } from '../push';

export default function DriverApp({ brand }: { brand: Brand }) {
  const [me, setMe] = useState<DriverMe | null>(null);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [ride, setRide] = useState<Ride | null>(null);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [ready, setReady] = useState(false);
  const [push, setPush] = useState<PushStatus | null>(null);

  // a localização segue sendo enviada durante a corrida (e com a tela apagada, se permitido)
  const location = useDriverLocation(!!me?.online);
  usePushRegistration(setPush);

  const reload = useCallback(async () => {
    const [m, e, cur, offers] = await Promise.all([
      api<DriverMe>('/driver/me'),
      api<Earnings>('/driver/earnings?days=1'),
      api<{ ride: Ride | null }>('/rides/current'),
      api<{ offers: Offer[] }>('/driver/offers'),
    ]);
    setMe(m);
    setEarnings(e);
    setRide((old) => cur.ride ?? (old && ['completed', 'cancelled'].includes(old.status) ? old : null));
    if (!cur.ride && offers.offers[0]) setOffer((o) => o ?? offers.offers[0]);
  }, []);

  useEffect(() => { reload().catch(() => {}).finally(() => setReady(true)); }, [reload]);
  useReconnect(() => { reload().catch(() => {}); });

  // tocou na notificação de oferta ou de corrida: recarrega e mostra
  useNotificationOpen(() => { reload().catch(() => {}); });

  useRealtime<Offer>('ride:offer', (o) => {
    if (ride) return;
    setOffer(o);
    Vibration.vibrate([0, 400, 200, 400]);
  });
  useRealtime('driver:offline', () => { reload().catch(() => {}); });
  useRealtime<{ rideId: string }>('ride:offer:closed', (o) => setOffer((cur) => (cur?.rideId === o.rideId ? null : cur)));

  async function toggleOnline(v: boolean) {
    await post('/driver/online', { online: v });
    await reload();
  }

  const clearOffer = useCallback(() => setOffer(null), []);

  if (!ready) {
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.areia }}><ActivityIndicator color={colors.noite} /></View>;
  }
  if (ride) {
    return <DriverRide key={ride.id} initial={ride} onDone={() => { setRide(null); reload().catch(() => {}); }} />;
  }
  return (
    <DriverHome
      brand={brand} me={me} earnings={earnings} offer={offer} locationError={location.error}
      locationMode={location.mode} push={push}
      onToggleOnline={toggleOnline} onReload={reload}
      onAccepted={(r) => { setOffer(null); setRide(r); }} onOfferGone={clearOffer}
    />
  );
}
