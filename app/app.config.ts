import type { ExpoConfig } from 'expo/config';

/**
 * Um só código gera os dois apps e a marca de cada cidade.
 *
 *   EXPO_PUBLIC_VARIANT = passageiro | motorista
 *   EXPO_PUBLIC_TENANT  = endereço da cidade (ex.: bauru). Vazio = app "guarda-chuva",
 *                         o usuário escolhe a cidade no login.
 *   EXPO_PUBLIC_BRAND   = nome na loja (ex.: "OnDaqui Bauru"). Padrão: "OnDaqui".
 *   EXPO_PUBLIC_API_URL = endereço da API.
 *   EAS_PROJECT_ID      = id do projeto no EAS (necessário para notificações push).
 */
const variant = process.env.EXPO_PUBLIC_VARIANT === 'motorista' ? 'motorista' : 'passageiro';
const tenant = (process.env.EXPO_PUBLIC_TENANT ?? '').trim();
const brand = process.env.EXPO_PUBLIC_BRAND ?? 'OnDaqui';
const isDriver = variant === 'motorista';

const idPart = tenant ? `${tenant.replace(/[^a-z0-9]/g, '')}.` : '';
const bundleId = `com.ondaqui.${idPart}${variant}`;
const projectId = process.env.EAS_PROJECT_ID;

const locationText = isDriver
  ? 'Usamos sua localização para enviar corridas próximas e mostrar ao passageiro onde você está.'
  : 'Usamos sua localização para definir o ponto de embarque.';
const backgroundText =
  'Enquanto você estiver online, usamos sua localização mesmo com o app fechado ou a tela apagada, para enviar corridas próximas e mostrar ao passageiro onde você está.';

const config: ExpoConfig = {
  name: isDriver ? `${brand} Motorista` : brand,
  slug: `ondaqui-${tenant || 'app'}-${variant}`,
  scheme: `ondaqui${tenant.replace(/[^a-z0-9]/g, '')}${isDriver ? 'motorista' : ''}`,
  version: '0.1.0',
  orientation: 'portrait',
  icon: isDriver ? './assets/icon-motorista.png' : './assets/icon.png',
  userInterfaceStyle: 'light',
  ios: {
    bundleIdentifier: bundleId,
    supportsTablet: false,
    infoPlist: {
      NSLocationWhenInUseUsageDescription: locationText,
      ...(isDriver ? { NSLocationAlwaysAndWhenInUseUsageDescription: backgroundText, NSLocationAlwaysUsageDescription: backgroundText } : {}),
      NSMotionUsageDescription: 'Usamos o sensor de movimento para melhorar a precisão da localização e economizar bateria.',
      NSCameraUsageDescription: 'Usamos a câmera para a selfie de verificação do início do turno.',
      ...(isDriver ? { UIBackgroundModes: ['location', 'remote-notification'] } : { UIBackgroundModes: ['remote-notification'] }),
    },
  },
  android: {
    package: bundleId,
    adaptiveIcon: {
      backgroundColor: '#12263A',
      foregroundImage: './assets/android-icon-foreground.png',
    },
    permissions: isDriver
      ? ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION', 'ACCESS_BACKGROUND_LOCATION', 'FOREGROUND_SERVICE',
         'FOREGROUND_SERVICE_LOCATION', 'CAMERA', 'POST_NOTIFICATIONS', 'VIBRATE']
      : ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION', 'POST_NOTIFICATIONS'],
    // Mapas no Android: crie uma chave no Google Cloud e defina GOOGLE_MAPS_API_KEY antes do build
    config: process.env.GOOGLE_MAPS_API_KEY ? { googleMaps: { apiKey: process.env.GOOGLE_MAPS_API_KEY } } : undefined,
  },
  web: { favicon: './assets/favicon.png' },
  extra: projectId ? { eas: { projectId } } : {},
  plugins: [
    ['expo-splash-screen', { image: './assets/splash-icon.png', imageWidth: 180, resizeMode: 'contain', backgroundColor: '#12263A' }],
    [
      'expo-location',
      isDriver
        ? {
            locationWhenInUsePermission: locationText,
            locationAlwaysAndWhenInUsePermission: backgroundText,
            isIosBackgroundLocationEnabled: true,
            isAndroidBackgroundLocationEnabled: true,
            isAndroidForegroundServiceEnabled: true,
          }
        : { locationWhenInUsePermission: locationText, locationAlwaysAndWhenInUsePermission: false, locationAlwaysPermission: false },
    ],
    ['expo-notifications', { icon: './assets/notification-icon.png', color: '#F2622E', defaultChannel: 'avisos' }],
    'expo-task-manager',
    ['expo-image-picker', {
      cameraPermission: 'Usamos a câmera para a selfie de verificação do início do turno.',
      photosPermission: false,
      microphonePermission: false,
    }],
    ['expo-secure-store', { faceIDPermission: false }],
  ],
};

export default config;
