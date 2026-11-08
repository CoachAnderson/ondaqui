import type { ReactNode } from 'react';
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
  type StyleProp, type TextInputProps, type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { colors, radius, useBrand } from '../theme';

/** O "O" do OnDaqui é o símbolo de ligar */
export function PowerO({ size = 24, color }: { size?: number; color?: string }) {
  const { accent } = useBrand();
  const c = color ?? accent;
  return (
    <Svg width={size * 0.93} height={size} viewBox="1.8 0.8 20.4 22" accessible={false}>
      <Path d="M7.2 5.4a8.6 8.6 0 1 0 9.6 0" fill="none" stroke={c} strokeWidth={3.2} strokeLinecap="round" />
      <Path d="M12 2.4v9" stroke={c} strokeWidth={3.2} strokeLinecap="round" />
    </Svg>
  );
}

/** Logo: ⏻nDaqui — "On" no laranja da marca, "Daqui" na cor do texto */
export function Wordmark({ size = 48, color = colors.areia }: { size?: number; color?: string }) {
  const { accent } = useBrand();
  const text = { fontSize: size, lineHeight: size * 1.05, fontWeight: '800' as const, letterSpacing: -size * 0.03 };
  return (
    <View accessible accessibilityRole="image" accessibilityLabel="OnDaqui" style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
      <View style={{ paddingBottom: size * 0.2 }}><PowerO size={size * 0.7} /></View>
      <Text style={[text, { color: accent, marginLeft: size * 0.02 }]}>n</Text>
      <Text style={[text, { color }]}>Daqui</Text>
    </View>
  );
}

/** Ícone: o pin de localização com o símbolo de ligar dentro */
export function Pin({ size = 28, inner = colors.noite }: { size?: number; inner?: string }) {
  const { accent } = useBrand();
  return (
    <Svg width={size} height={size * 1.25} viewBox="0 0 48 60" accessible={false}>
      <Path d="M24 2C12.4 2 3 11.2 3 22.6 3 38 24 58 24 58s21-20 21-35.4C45 11.2 35.6 2 24 2z" fill={accent} />
      <Path d="M19 15.6a8.6 8.6 0 1 0 10 0" fill="none" stroke={inner} strokeWidth={3.6} strokeLinecap="round" />
      <Path d="M24 12v9" stroke={inner} strokeWidth={3.6} strokeLinecap="round" />
    </Svg>
  );
}

export function Screen({ children, scroll = true, dark = false }: { children: ReactNode; scroll?: boolean; dark?: boolean }) {
  const bg = dark ? colors.noite : colors.areia;
  return (
    <SafeAreaView style={[s.screen, { backgroundColor: bg }]} edges={['top', 'bottom']}>
      {scroll ? (
        <ScrollView contentContainerStyle={s.scrollBody} keyboardShouldPersistTaps="handled">{children}</ScrollView>
      ) : (
        <View style={[s.scrollBody, { flex: 1 }]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

export function Title({ children, light = false }: { children: ReactNode; light?: boolean }) {
  return <Text accessibilityRole="header" style={[s.title, light && { color: colors.areia }]}>{children}</Text>;
}

export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<any> }) {
  return <Text style={[s.muted, style]}>{children}</Text>;
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.card, style]}>{children}</View>;
}

type Kind = 'primary' | 'secondary' | 'danger' | 'dark';

export function Button({
  label, onPress, kind = 'primary', disabled, busy, style, accessibilityHint, testID,
}: {
  label: string; onPress: () => void; kind?: Kind; disabled?: boolean; busy?: boolean;
  style?: StyleProp<ViewStyle>; accessibilityHint?: string; testID?: string;
}) {
  const { accentDark } = useBrand();
  const bg = { primary: accentDark, dark: colors.noite, secondary: colors.branco, danger: colors.vermelho }[kind];
  const fg = kind === 'secondary' ? colors.texto : colors.branco;
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      accessibilityHint={accessibilityHint}
      testID={testID}
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [
        s.button,
        { backgroundColor: bg, opacity: off ? 0.5 : pressed ? 0.85 : 1 },
        kind === 'secondary' && { borderColor: colors.linha, borderWidth: 1 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[s.buttonText, { color: fg }]}>{label}</Text>}
    </Pressable>
  );
}

export function Field({ label, hint, light, ...props }: TextInputProps & { label: string; hint?: string; light?: boolean }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={[s.label, light && { color: colors.areia }]} nativeID={`l-${label}`}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor="#7A8794"
        style={s.input}
        {...props}
      />
      {hint && <Text style={s.hint}>{hint}</Text>}
    </View>
  );
}

export function Choice({
  label, detail, selected, onPress,
}: { label: string; detail?: string; selected: boolean; onPress: () => void }) {
  const { accentDark } = useBrand();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[s.choice, selected && { borderColor: accentDark, borderWidth: 2, backgroundColor: '#FFF1E8' }]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.choiceLabel}>{label}</Text>
        {detail && <Text style={s.muted}>{detail}</Text>}
      </View>
      <View style={[s.radio, selected && { borderColor: accentDark }]}>
        {selected && <View style={[s.radioDot, { backgroundColor: accentDark }]} />}
      </View>
    </Pressable>
  );
}

export function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  const { accentDark } = useBrand();
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} onPress={() => onChange(!checked)} style={s.check}>
      <View style={[s.box, checked && { backgroundColor: accentDark, borderColor: accentDark }]}>
        {checked && <Text style={{ color: colors.branco, fontWeight: '800', fontSize: 14 }}>✓</Text>}
      </View>
      <Text style={{ flex: 1, color: colors.texto, fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}

export function Notice({ tone, children }: { tone: 'error' | 'ok' | 'warn' | 'info'; children: ReactNode }) {
  const st = {
    error: { backgroundColor: colors.vermelhoClaro, color: '#8E2A22' },
    ok: { backgroundColor: colors.verdeClaro, color: '#17694A' },
    warn: { backgroundColor: colors.amareloClaro, color: colors.amarelo },
    info: { backgroundColor: colors.areia2, color: colors.texto },
  }[tone];
  return (
    <View accessibilityRole={tone === 'error' ? 'alert' : undefined} style={[s.notice, { backgroundColor: st.backgroundColor }]}>
      <Text style={{ color: st.color, fontSize: 15, fontWeight: '500' }}>{children}</Text>
    </View>
  );
}

export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <View style={s.row}>
      <Text style={s.muted}>{label}</Text>
      <Text style={s.rowValue}>{value}</Text>
    </View>
  );
}

export const s = StyleSheet.create({
  screen: { flex: 1 },
  scrollBody: { padding: 20, gap: 16, flexGrow: 1 },
  title: { fontSize: 28, fontWeight: '800', color: colors.texto, letterSpacing: -0.5 },
  muted: { fontSize: 15, color: colors.texto2 },
  card: { backgroundColor: colors.branco, borderRadius: radius + 2, borderWidth: 1, borderColor: colors.linha, padding: 16, gap: 12 },
  button: { minHeight: 52, borderRadius: radius, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  buttonText: { fontSize: 17, fontWeight: '700' },
  label: { fontSize: 14, fontWeight: '600', color: colors.texto2 },
  hint: { fontSize: 13, color: colors.texto2 },
  input: {
    minHeight: 50, borderWidth: 1, borderColor: colors.linha, borderRadius: radius, paddingHorizontal: 14,
    fontSize: 17, color: colors.texto, backgroundColor: colors.branco,
  },
  choice: {
    flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, padding: 14, borderRadius: radius,
    borderWidth: 1, borderColor: colors.linha, backgroundColor: colors.branco,
  },
  choiceLabel: { fontSize: 16, fontWeight: '700', color: colors.texto },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.linha, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 11, height: 11, borderRadius: 6 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: colors.linha, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.branco },
  notice: { borderRadius: radius, padding: 14 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' },
  rowValue: { fontSize: 15, fontWeight: '600', color: colors.texto, flexShrink: 1, textAlign: 'right' },
});
