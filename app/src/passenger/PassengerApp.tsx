import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { api } from '../api';
import { colors } from '../theme';
import type { Brand, Ride } from '../types';
import PassengerHome from './Home';
import { useNotificationOpen, usePushRegistration } from '../push';
import RideScreen from './RideScreen';

export default function PassengerApp({ brand }: { brand: Brand }) {
  const [ride, setRide] = useState<Ride | null>(null);
  const [checked, setChecked] = useState(false);

  usePushRegistration();

  // ao abrir o app, retoma a corrida em andamento
  useEffect(() => {
    api<{ ride: Ride | null }>('/rides/current')
      .then((r) => setRide(r.ride))
      .catch(() => {})
      .finally(() => setChecked(true));
  }, []);

  // tocou na notificação de uma corrida: abre essa corrida
  useNotificationOpen((d) => {
    if (d.type !== 'ride' || !d.rideId) return;
    api<{ ride: Ride }>(`/rides/${d.rideId}`).then((r) => setRide(r.ride)).catch(() => {});
  });

  if (!checked) {
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.areia }}><ActivityIndicator color={colors.noite} /></View>;
  }
  if (ride) return <RideScreen key={ride.id} brand={brand} initial={ride} onDone={() => setRide(null)} />;
  return <PassengerHome brand={brand} onRide={setRide} />;
}
