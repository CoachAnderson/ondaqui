import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { errMsg, post } from '../api';
import { colors, useBrand } from '../theme';
import { Notice } from './ui';

/** prefs: a corrida tinha preferências da viagem (o passageiro conta se foram respeitadas) */
export default function Stars({ rideId, question, prefs }: { rideId: string; question: string; prefs?: string[] }) {
  const { accentDark } = useBrand();
  const [stars, setStars] = useState(0);
  const [respected, setRespected] = useState<boolean | null>(null);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rate(n: number, r = respected) {
    setStars(n);
    setError(null);
    try {
      await post(`/rides/${rideId}/rate`, { stars: n, ...(r != null ? { prefsRespected: r } : {}) });
      setSent(true);
    } catch (e) {
      setError(errMsg(e));
    }
  }

  return (
    <View style={{ gap: 10 }}>
      <Text style={{ fontSize: 16, fontWeight: '700', color: colors.texto }}>{sent ? 'Obrigado pela avaliação!' : question}</Text>
      <View style={{ flexDirection: 'row', gap: 6 }} accessibilityRole="radiogroup" accessibilityLabel={question}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Pressable key={n} onPress={() => rate(n)} accessibilityRole="radio" accessibilityLabel={`${n} estrela${n > 1 ? 's' : ''}`}
            accessibilityState={{ selected: stars === n }} style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 34, color: n <= stars ? accentDark : colors.linha }}>★</Text>
          </Pressable>
        ))}
      </View>
      {prefs && prefs.length > 0 && stars > 0 && (
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 15, color: colors.texto }}>{`O motorista respeitou suas preferências (${prefs.join(', ').toLowerCase()})?`}</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {([true, false] as const).map((v) => (
              <Pressable key={String(v)} accessibilityRole="radio" accessibilityState={{ selected: respected === v }}
                onPress={() => { setRespected(v); rate(stars, v); }}
                style={{ minHeight: 44, paddingHorizontal: 18, borderRadius: 999, justifyContent: 'center', borderWidth: respected === v ? 2 : 1,
                  borderColor: respected === v ? colors.noite : colors.linha, backgroundColor: respected === v ? colors.noite : colors.branco }}>
                <Text style={{ fontWeight: '700', color: respected === v ? colors.branco : colors.texto }}>{v ? 'Sim' : 'Não'}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </View>
  );
}
