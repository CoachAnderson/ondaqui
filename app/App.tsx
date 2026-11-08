import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { api, errMsg } from './src/api';
import { FIXED_TENANT, VARIANT } from './src/config';
import { SessionProvider, useSession } from './src/session';
import { BrandContext, accentFor, colors } from './src/theme';
import { storage } from './src/storage';
import type { Brand } from './src/types';
import { Auth, CityPicker } from './src/screens/Auth';
import { Button } from './src/components/ui';
import PassengerApp from './src/passenger/PassengerApp';
import DriverApp from './src/driver/DriverApp';

const CITY_KEY = 'ondaqui.cidade';

export default function App() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <Root />
      </SessionProvider>
    </SafeAreaProvider>
  );
}

function Root() {
  const { session, ready } = useSession();
  const [brand, setBrand] = useState<Brand | null>(null);
  const [slug, setSlug] = useState<string | null>(FIXED_TENANT || null);
  const [slugReady, setSlugReady] = useState(!!FIXED_TENANT);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  // cidade: a do build, a da sessão ou a última escolhida
  useEffect(() => {
    if (FIXED_TENANT) return;
    storage.get(CITY_KEY).then((s) => { if (s) setSlug(s); }).finally(() => setSlugReady(true));
  }, []);
  const tenant = session?.tenant ?? slug;

  useEffect(() => {
    if (!tenant) { setBrand(null); return; }
    if (brand?.slug === tenant) return;
    setError(null);
    api<Brand>(`/public/tenants/${encodeURIComponent(tenant)}`).then(setBrand).catch((e) => setError(errMsg(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant, retry]);

  const theme = useMemo(() => ({ brand, ...accentFor(brand?.accent_color) }), [brand]);

  let body;
  if (!ready || !slugReady) body = <Loading />;
  else if (error) {
    body = (
      <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 16, backgroundColor: colors.noite }}>
        <Text style={{ color: colors.areia, fontSize: 18 }}>{error}</Text>
        <Button label="Tentar de novo" onPress={() => { setBrand(null); setError(null); setRetry((n) => n + 1); }} />
        {!FIXED_TENANT && <Button kind="secondary" label="Escolher outra cidade" onPress={() => { setError(null); setSlug(null); storage.remove(CITY_KEY); }} />}
      </View>
    );
  } else if (!tenant) {
    body = <CityPicker onPick={(b) => { setBrand(b); setSlug(b.slug); storage.set(CITY_KEY, b.slug); }} />;
  } else if (!brand) body = <Loading />;
  else if (!session) {
    body = <Auth brand={brand} onChangeCity={FIXED_TENANT ? undefined : () => { setSlug(null); setBrand(null); storage.remove(CITY_KEY); }} />;
  } else body = VARIANT === 'motorista' ? <DriverApp brand={brand} /> : <PassengerApp brand={brand} />;

  return (
    <BrandContext.Provider value={theme}>
      <StatusBar style={!session ? 'light' : 'dark'} />
      {body}
    </BrandContext.Provider>
  );
}

function Loading() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.noite }}>
      <ActivityIndicator color={colors.areia} size="large" />
    </View>
  );
}
