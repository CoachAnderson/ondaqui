import { useEffect, useState } from 'react';
import { Image, Platform, type ImageStyle, type StyleProp } from 'react-native';
import { getToken } from '../api';
import { API_URL } from '../config';

/** Foto protegida da API (motorista, veículo, comprovantes). Não aparece se não existir. */
export default function AuthImage({ path, style, label, version }: {
  path: string; style: StyleProp<ImageStyle>; label: string; version?: string | number;
}) {
  const url = `${API_URL}${path}${version != null ? `${path.includes('?') ? '&' : '?'}v=${version}` : ''}`;
  const [webUri, setWebUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let alive = true;
    let obj: string | null = null;
    fetch(url, { headers: { authorization: `Bearer ${getToken()}` } })
      .then(async (r) => { if (!r.ok) throw new Error(); obj = URL.createObjectURL(await r.blob()); if (alive) setWebUri(obj); })
      .catch(() => alive && setFailed(true));
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj); };
  }, [url]);

  if (failed) return null;
  if (Platform.OS === 'web') return webUri ? <Image accessibilityLabel={label} source={{ uri: webUri }} style={style} /> : null;
  return (
    <Image accessibilityLabel={label} style={style} onError={() => setFailed(true)}
      source={{ uri: url, headers: { authorization: `Bearer ${getToken()}` } }} />
  );
}
