import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { api, errMsg, post } from '../api';
import { FIXED_TENANT, VARIANT } from '../config';
import { money } from '../format';
import { useSession } from '../session';
import { colors, useBrand } from '../theme';
import type { Brand } from '../types';
import { Button, Card, Check, Choice, Field, Muted, Notice, Screen, Title, Wordmark } from '../components/ui';
import { openPrivacy, openTerms } from '../components/Account';

const isDriver = VARIANT === 'motorista';

/** Escolha da cidade (só no app "guarda-chuva", sem cidade fixa) */
export function CityPicker({ onPick }: { onPick: (b: Brand) => void }) {
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      onPick(await api<Brand>(`/public/tenants/${encodeURIComponent(slug.trim().toLowerCase())}`));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Screen dark>
      <View style={{ flex: 1, justifyContent: 'center', gap: 20 }}>
        <Logo />
        <Title light>Em qual cidade você está?</Title>
        <Field light label="Cidade" value={slug} onChangeText={setSlug} placeholder="ex.: bauru" autoCapitalize="none" autoCorrect={false} />
        {error && <Notice tone="error">{error}</Notice>}
        <Button label="Continuar" onPress={go} busy={busy} disabled={slug.trim().length < 2} />
      </View>
    </Screen>
  );
}

function Logo() {
  return <Wordmark size={54} />;
}

export function Auth({ brand, onChangeCity }: { brand: Brand; onChangeCity?: () => void }) {
  const [mode, setMode] = useState<'login' | 'cadastro' | 'senha'>('login');
  if (mode === 'cadastro') return <Register brand={brand} onBack={() => setMode('login')} />;
  if (mode === 'senha') return <ForgotPassword brand={brand} onBack={() => setMode('login')} />;
  return <Login brand={brand} onRegister={() => setMode('cadastro')} onForgot={() => setMode('senha')} onChangeCity={onChangeCity} />;
}

function Login({ brand, onRegister, onForgot, onChangeCity }: { brand: Brand; onRegister: () => void; onForgot: () => void; onChangeCity?: () => void }) {
  const { signIn } = useSession();
  const { accent } = useBrand();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const r = await post('/auth/login', { tenant: brand.slug, phone, password });
      const expected = isDriver ? 'driver' : 'passenger';
      if (r.user.role !== expected) {
        throw new Error(isDriver ? 'Esta conta é de passageiro. Use o app do passageiro.' : 'Esta conta é de motorista. Use o app do motorista.');
      }
      await signIn({ token: r.token, tenant: brand.slug, user: r.user });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen dark>
      <View style={{ flex: 1, justifyContent: 'center', gap: 18 }}>
        <Logo />
        <Text style={{ color: colors.areia, fontSize: 18, fontWeight: '600', marginTop: -8 }}>Daqui eu vou.</Text>
        <Text style={{ color: accent, fontSize: 16, fontWeight: '800', letterSpacing: 4, textTransform: 'uppercase' }}>
          {brand.city_label}{isDriver ? ' · Motorista' : ''}
        </Text>
        <Field light label="Celular" value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel" placeholder="(14) 99999-9999" />
        <Field light label="Senha" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" />
        {error && <Notice tone="error">{error}</Notice>}
        <Button label="Entrar" onPress={go} busy={busy} disabled={!phone || !password} />
        <Text accessibilityRole="button" onPress={onForgot} style={{ color: colors.areia, textAlign: 'center', textDecorationLine: 'underline', padding: 8 }}>
          Esqueci minha senha
        </Text>
        <Button kind="secondary" label={isDriver ? 'Quero dirigir com o OnDaqui' : 'Criar minha conta'} onPress={onRegister} />
        {onChangeCity && !FIXED_TENANT && (
          <Text accessibilityRole="button" onPress={onChangeCity} style={{ color: colors.areia, textAlign: 'center', textDecorationLine: 'underline', padding: 8 }}>
            Trocar de cidade
          </Text>
        )}
      </View>
    </Screen>
  );
}

const PLATE = /^[A-Z]{3}-?\d[A-Z0-9]\d{2}$/;

/** Contagem para poder pedir outro código (o servidor libera depois de 60 segundos) */
function useCountdown() {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return { left, start: (sec = 60) => setLeft(sec) };
}

/** Campo do código de 6 números, com o botão de reenviar */
function CodeField({ phone, code, onChange, left, onResend, busy }: {
  phone: string; code: string; onChange: (v: string) => void; left: number; onResend: () => void; busy: boolean;
}) {
  return (
    <Card>
      <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>Digite o código</Text>
      <Muted>Enviamos um código de 6 números por SMS ou WhatsApp para {phone}. Ele vale por 10 minutos.</Muted>
      <Field label="Código" value={code} onChangeText={(v) => onChange(v.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad" autoComplete="sms-otp" textContentType="oneTimeCode" maxLength={6} placeholder="000000" />
      <Button kind="secondary" label={left > 0 ? `Reenviar código em ${left}s` : 'Reenviar código'} onPress={onResend} disabled={left > 0 || busy} />
    </Card>
  );
}

function ForgotPassword({ brand, onBack }: { brand: Brand; onBack: () => void }) {
  const { signIn } = useSession();
  const [phone, setPhone] = useState('');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useCountdown();

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await post('/auth/code', { tenant: brand.slug, phone, purpose: 'senha' });
      setSent(true);
      timer.start();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      const r = await post('/auth/reset-password', { tenant: brand.slug, phone, code, password });
      const expected = isDriver ? 'driver' : 'passenger';
      if (r.user.role !== expected) {
        throw new Error('Senha trocada. Esta conta não é deste app: entre pelo app ou pelo painel certo com a senha nova.');
      }
      await signIn({ token: r.token, tenant: brand.slug, user: r.user });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>Criar uma senha nova</Title>
      <Muted>Vamos mandar um código para o celular da sua conta.</Muted>
      <Card>
        <Field label="Celular" value={phone} onChangeText={(v) => { setPhone(v); setSent(false); }} keyboardType="phone-pad" autoComplete="tel" placeholder="(14) 99999-9999" />
      </Card>
      {!sent && <Button label="Enviar código" onPress={send} busy={busy} disabled={phone.replace(/\D/g, '').length < 10} />}
      {sent && (
        <>
          <Notice tone="info">Se este celular tiver conta no {brand.name}, o código chega em instantes.</Notice>
          <CodeField phone={phone} code={code} onChange={setCode} left={timer.left} onResend={send} busy={busy} />
          <Card>
            <Field label="Senha nova" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" hint="Mínimo de 6 caracteres" />
          </Card>
          <Button label="Salvar senha e entrar" onPress={reset} busy={busy} disabled={code.length !== 6 || password.length < 6} />
        </>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <Button kind="secondary" label="Voltar" onPress={onBack} />
    </Screen>
  );
}

function Register({ brand, onBack }: { brand: Brand; onBack: () => void }) {
  const { signIn } = useSession();
  const [f, setF] = useState({
    name: '', phone: '', password: '', plate: '', model: '', color: '', pixKey: '', pixHolderName: '',
    vehicleType: 'carro' as 'carro' | 'moto' | 'utilitario', plan: brand.plans.find((p) => p.code === 'livre')?.code ?? brand.plans[0]?.code ?? 'livre',
  });
  const [terms, setTerms] = useState(false);
  const [services, setServices] = useState<string[]>(['entrega']);
  const [woman, setWoman] = useState(false);
  const toggle = (k: string) => setServices((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null); // celular que recebeu o código
  const [code, setCode] = useState('');
  const timer = useCountdown();
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  const needsCode = !!brand.phoneVerification;
  const codeStep = needsCode && codeSentTo !== null && codeSentTo === f.phone.replace(/\D/g, '');

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      await post('/auth/code', { tenant: brand.slug, phone: f.phone, purpose: 'cadastro' });
      setCodeSentTo(f.phone.replace(/\D/g, ''));
      setCode('');
      timer.start();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const plateOk = PLATE.test(f.plate.trim().toUpperCase());
  const valid = f.name.trim().length >= 3 && f.phone.replace(/\D/g, '').length >= 10 && f.password.length >= 6 && terms &&
    (!isDriver || (plateOk && f.model.trim().length >= 2 && f.color.trim().length >= 3));

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const body: any = { tenant: brand.slug, name: f.name.trim(), phone: f.phone, password: f.password, role: isDriver ? 'driver' : 'passenger', acceptPrivacy: terms };
      if (needsCode) body.code = code;
      if (!isDriver) body.declaredWoman = woman;
      if (isDriver) {
        body.driver = {
          vehicleType: f.vehicleType,
          services: f.vehicleType === 'utilitario' ? [] : services,
          plan: f.plan,
          vehicle: { plate: f.plate.trim().toUpperCase(), model: f.model.trim(), color: f.color.trim() },
          pixKey: f.pixKey.trim() || undefined,
          pixHolderName: f.pixHolderName.trim() || undefined,
        };
      }
      const r = await post('/auth/register', body);
      await signIn({ token: r.token, tenant: brand.slug, user: r.user });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>{isDriver ? `Dirija com o ${brand.name}` : 'Criar conta'}</Title>
      {isDriver && <Muted>Seu cadastro passa pela central da cidade. Depois da aprovação, você já pode receber corridas.</Muted>}
      <Card>
        <Field label="Nome completo" value={f.name} onChangeText={set('name')} autoComplete="name" />
        <Field label="Celular" value={f.phone} onChangeText={set('phone')} keyboardType="phone-pad" autoComplete="tel" placeholder="(14) 99999-9999" />
        <Field label="Senha" value={f.password} onChangeText={set('password')} secureTextEntry autoComplete="new-password" hint="Mínimo de 6 caracteres" />
      </Card>

      {isDriver && (
        <>
          <Card>
            <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>Veículo</Text>
            <Field label="Placa" value={f.plate} onChangeText={set('plate')} autoCapitalize="characters" placeholder="ABC1D23"
                   hint={f.plate && !plateOk ? 'Placa no formato ABC1D23 ou ABC-1234' : undefined} />
            <Field label="Modelo" value={f.model} onChangeText={set('model')} placeholder="ex.: Onix" />
            <Field label="Cor" value={f.color} onChangeText={set('color')} placeholder="ex.: Prata" />
            <View style={{ gap: 8 }} accessibilityRole="radiogroup">
              <Text style={{ fontSize: 14, fontWeight: '600', color: colors.texto2 }}>Tipo de veículo</Text>
              {([['carro', 'Carro', 'Daqui Car e outros serviços de carro'], ['moto', 'Moto', 'Daqui Moto e entregas de moto'],
                 ['utilitario', 'Utilitário ou caminhonete', 'Daqui Frete: carretos e mudanças']] as const).map(([v, l, d]) => (
                <Choice key={v} label={l} detail={d} selected={f.vehicleType === v} onPress={() => setF({ ...f, vehicleType: v })} />
              ))}
            </View>
          </Card>

          {f.vehicleType !== 'utilitario' && (
            <Card>
              <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>O que você quer atender</Text>
              <Muted>Além das corridas. Dá para mudar depois no app.</Muted>
              <Check label="Daqui Entrega (pacotes)" checked={services.includes('entrega')} onChange={() => toggle('entrega')} />
              {f.vehicleType === 'carro' && <Check label="Daqui Particular (cliente contrata por hora)" checked={services.includes('particular')} onChange={() => toggle('particular')} />}
              {f.vehicleType === 'carro' && <Check label="Daqui Pet (aceito animais)" checked={services.includes('pet')} onChange={() => toggle('pet')} />}
              {f.vehicleType === 'carro' && <Muted>Daqui Mulher, Executivo e Prefeitura (pacientes) são liberados pela central depois de conferir.</Muted>}
            </Card>
          )}

          <Card>
            <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>Pix para receber</Text>
            <Muted>A central confere se a chave está no seu nome antes de mostrar ao passageiro. Isso protege você e o passageiro contra golpes.</Muted>
            <Field label="Chave Pix" value={f.pixKey} onChangeText={set('pixKey')} autoCapitalize="none" />
            <Field label="Nome do titular da chave" value={f.pixHolderName} onChangeText={set('pixHolderName')} />
          </Card>

          <Card>
            <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>Seu plano</Text>
            <Muted>O primeiro mês é grátis em qualquer plano.</Muted>
            <View style={{ gap: 8 }} accessibilityRole="radiogroup">
              {brand.plans.map((p) => (
                <Choice key={p.code} label={p.name} selected={f.plan === p.code} onPress={() => set('plan')(p.code)}
                  detail={p.period_days > 0
                    ? `${money(p.price_cents)} a cada ${p.period_days} dias · você fica com 100% das corridas`
                    : `Sem mensalidade · ${p.commission_pct}% de cada corrida`} />
              ))}
            </View>
          </Card>
        </>
      )}

      {!isDriver && (
        <Check checked={woman} onChange={setWoman} label="Sou mulher (libera o Daqui Mulher: motoristas mulheres, só para passageiras)" />
      )}
      <Check checked={terms} onChange={setTerms} label={`Li e aceito os termos de uso e a política de privacidade do ${brand.name}`} />
      <View style={{ flexDirection: 'row', gap: 20, flexWrap: 'wrap' }}>
        <Text accessibilityRole="link" onPress={() => openTerms(brand.slug)}
          style={{ color: colors.texto2, textDecorationLine: 'underline', paddingVertical: 4 }}>
          Ler os termos de uso
        </Text>
        <Text accessibilityRole="link" onPress={() => openPrivacy(brand.slug)}
          style={{ color: colors.texto2, textDecorationLine: 'underline', paddingVertical: 4 }}>
          Ler a política de privacidade
        </Text>
      </View>
      {codeStep && <CodeField phone={f.phone} code={code} onChange={setCode} left={timer.left} onResend={sendCode} busy={busy} />}
      {error && <Notice tone="error">{error}</Notice>}
      {needsCode && !codeStep
        ? <Button label="Continuar" accessibilityHint="Enviamos um código para confirmar o seu celular" onPress={sendCode} busy={busy} disabled={!valid} />
        : <Button label={isDriver ? 'Enviar cadastro' : 'Criar conta'} onPress={go} busy={busy} disabled={!valid || (needsCode && code.length !== 6)} />}
      <Button kind="secondary" label="Voltar" onPress={onBack} />
    </Screen>
  );
}
