import { useEffect, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { api, post } from '../api';
import { colors } from '../theme';
import AuthImage from './AuthImage';
import { Button, Card, Muted } from './ui';

interface Ad { id: string; advertiser: string; title: string; body: string | null; ctaLabel: string | null; link: string | null; hasImage: boolean }
type Placement = 'inicio' | 'corrida' | 'motorista';

/**
 * Anúncio de um comércio da cidade, sempre com a marca "Publicidade" (CDC, art. 36).
 * Um por tela, sorteado pela API. O toque é contado e abre o link do anunciante.
 */
export default function AdCard({ placement }: { placement: Placement }) {
  const [ad, setAd] = useState<Ad | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ ad: Ad | null }>(`/ads?lugar=${placement}`).then((r) => alive && setAd(r.ad)).catch(() => {});
    return () => { alive = false; };
  }, [placement]);

  if (!ad) return null;
  async function open() {
    try {
      const r = await post<{ link: string | null }>(`/ads/${ad!.id}/click`, { lugar: placement });
      if (r.link) await Linking.openURL(r.link);
    } catch { /* sem internet: tenta de novo depois */ }
  }
  return (
    <Card style={{ gap: 8 }}>
      <Text style={{ fontSize: 11, fontWeight: '800', letterSpacing: 1, color: colors.texto2, textTransform: 'uppercase' }}>
        {`Publicidade · ${ad.advertiser}`}
      </Text>
      {ad.hasImage && (
        <AuthImage path={`/ads/${ad.id}/image`} label={ad.title} style={{ width: '100%', aspectRatio: 2, borderRadius: 12, backgroundColor: colors.linha }} />
      )}
      <View style={{ gap: 2 }}>
        <Text style={{ fontSize: 17, fontWeight: '800', color: colors.texto }}>{ad.title}</Text>
        {ad.body && <Muted>{ad.body}</Muted>}
      </View>
      {ad.link && <Button kind="secondary" label={ad.ctaLabel || 'Saiba mais'} onPress={open} />}
    </Card>
  );
}
