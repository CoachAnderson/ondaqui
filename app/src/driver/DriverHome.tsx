import { useState } from 'react';
import { AccountMenu } from '../components/Account';
import { Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { api, errMsg, post } from '../api';
import { firstName, money } from '../format';
import { useSession } from '../session';
import { colors } from '../theme';
import type { Brand, Offer, Ride } from '../types';
import type { PushStatus } from '../push';
import type { BackgroundResult } from './backgroundLocation';
import OfferCard from './OfferCard';
import PayPlan from './PayPlan';
import Commission from './Commission';
import DriverCashback from './DriverCashback';
import AdCard from '../components/AdCard';
import SchoolRoute from './SchoolRoute';
import FoodShift from './FoodShift';
import AuthImage from '../components/AuthImage';
import { Button, Card, Check, Choice, Muted, Notice, Row, Screen, Title } from '../components/ui';

export interface DriverMe {
  status: string; plan_code: string; plan_name: string; plan_price_cents: number; period_days: number; commission_pct: number;
  trial_until: string | null; paid_until: string | null; pix_key: string | null; pix_validated: boolean;
  online: boolean; selfie_checked_at: string | null; canWork: boolean; blockedReason: string | null; onlinePayment?: boolean;
  vehicle_plate: string; vehicle_model: string; vehicle_color: string;
  vehicle_type: 'carro' | 'moto' | 'utilitario'; services_opt_in: string[]; verified: string[];
  photo_status: 'none' | 'pending' | 'approved' | 'rejected'; photo_review: 'pending' | 'rejected' | null; has_photo: boolean; has_vehicle_photo: boolean;
  camera_kind: 'video' | 'video_audio' | null; camera_status: 'pending' | 'approved' | 'rejected' | null;
  rating?: {
    average: number | null; ratings: number; below: number; minRatings: number;
    alert: null | { average: number; ratings: number; at: string; acknowledged: boolean };
    /** preferências da viagem: em quantas das corridas avaliadas o passageiro disse que foram respeitadas */
    prefs?: { asked: number; respected: number };
  };
}
export interface Earnings { rides: number; grossCents: number; commissionCents: number; netCents: number; toReceiveFromCentralCents?: number }

const VERIFIED_LABEL: Record<string, string> = {
  mulher: 'Daqui Mulher', executivo: 'Daqui Executivo', paciente: 'Daqui Prefeitura (pacientes)', cadeirante: 'Veículo adaptado (cadeirante)',
};

const dateBr = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('pt-BR');

export default function DriverHome({
  brand, me, earnings, offer, locationError, locationMode, push, onToggleOnline, onReload, onAccepted, onOfferGone,
}: {
  brand: Brand; me: DriverMe | null; earnings: Earnings | null; offer: Offer | null; locationError: string | null;
  locationMode: BackgroundResult | null; push: PushStatus | null;
  onToggleOnline: (v: boolean) => Promise<void>; onReload: () => Promise<void>;
  onAccepted: (r: Ride) => void; onOfferGone: () => void;
}) {
  const { session } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try { await fn(); } catch (e) { setError(errMsg(e)); } finally { setBusy(null); }
  }

  async function selfie() {
    await run('selfie', async () => {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) throw new Error('Libere a câmera para tirar a selfie.');
      const r = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'], cameraType: ImagePicker.CameraType.front, quality: 0.5, base64: true, allowsEditing: false,
      });
      if (r.canceled || !r.assets[0]?.base64) return;
      await post('/driver/shift-selfie', { image: `data:image/jpeg;base64,${r.assets[0].base64}` });
      await onReload();
    }).catch(() => {});
  }

  const needsSelfie = me?.blockedReason?.toLowerCase().includes('selfie');
  const isPending = me?.status === 'pending';
  const hasFee = (me?.period_days ?? 0) > 0;

  return (
    <Screen>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title>Olá, {firstName(session?.user.name ?? '')}</Title>
        <AccountMenu />
      </View>

      {offer && <OfferCard key={offer.rideId} offer={offer} onAccepted={onAccepted} onGone={onOfferGone} />}

      {me && (
        <Card style={me.online ? { backgroundColor: colors.verdeClaro, borderColor: '#B7E0CB' } : undefined}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: colors.texto }}>
            {me.online ? 'Você está online' : 'Você está offline'}
          </Text>
          <Muted>{me.online ? 'Aguarde: as corridas próximas aparecem aqui.' : `Fique online para receber corridas em ${brand.city_label}.`}</Muted>
          {me.canWork ? (
            <Button
              kind={me.online ? 'secondary' : 'primary'}
              label={me.online ? 'Ficar offline' : 'Ficar online'}
              busy={busy === 'online'}
              onPress={() => run('online', () => onToggleOnline(!me.online))}
            />
          ) : (
            <Notice tone="warn">{me.blockedReason}</Notice>
          )}
          {needsSelfie && !isPending && (
            <>
              <Muted>Por segurança, tire uma selfie no início de cada turno. Ela confirma que é você quem está dirigindo.</Muted>
              <Button label="Tirar selfie do turno" onPress={selfie} busy={busy === 'selfie'} />
            </>
          )}
          {isPending && <Muted>A central da cidade vai conferir seus documentos: CNH com EAR, inscrição no INSS, antecedentes criminais e seguro APP.</Muted>}
          {locationError && me.online && <Notice tone="error">{locationError}</Notice>}
          {me.online && locationMode === 'so-com-app-aberto' && (
            <Notice tone="warn">
              Deixe o app aberto para receber corridas. Para receber com a tela apagada, permita a localização "o tempo todo" nas configurações do celular.
            </Notice>
          )}
          {me.online && push === 'negado' && (
            <Notice tone="warn">Ative as notificações do app para ser avisado de novas corridas.</Notice>
          )}
        </Card>
      )}

      {error && <Notice tone="error">{error}</Notice>}

      {/* foto obrigatória: enquanto não estiver aprovada, o cartão fica no topo */}
      {me && me.photo_status !== 'approved' && <MyPhotos me={me} onSaved={onReload} />}

      {earnings && (
        <Card>
          <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>Hoje</Text>
          <Text style={{ fontSize: 36, fontWeight: '800', color: colors.texto }}>{money(earnings.netCents)}</Text>
          <Row label="Corridas" value={String(earnings.rides)} />
          <Row label="Total das corridas" value={money(earnings.grossCents)} />
          {earnings.commissionCents > 0 && <Row label="Comissão" value={`− ${money(earnings.commissionCents)}`} />}
          {(earnings.toReceiveFromCentralCents ?? 0) > 0 && <Row label="A receber da central (Prefeitura e lojas)" value={money(earnings.toReceiveFromCentralCents)} />}
        </Card>
      )}

      {me && (
        <Card>
          <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>Seu plano: {me.plan_name}</Text>
          {hasFee ? (
            <>
              <Muted>{money(me.plan_price_cents)} a cada {me.period_days} dias. Você fica com 100% das corridas.</Muted>
              {me.paid_until && <Row label="Pago até" value={dateBr(me.paid_until)} />}
              {me.trial_until && <Row label="Mês grátis até" value={dateBr(me.trial_until)} />}
              {me.onlinePayment ? (
                <PayPlan
                  priceCents={me.plan_price_cents} periodDays={me.period_days}
                  due={[me.paid_until, me.trial_until].filter(Boolean).sort().at(-1) ?? null}
                  onPaid={onReload}
                />
              ) : (
                <Muted>Para renovar, fale com a central da sua cidade.</Muted>
              )}
            </>
          ) : (
            <Muted>Sem mensalidade. A central fica com {me.commission_pct}% de cada corrida: descontado no repasse das corridas da central e cobrado toda semana nas que o passageiro paga a você.</Muted>
          )}
          <Row label="Pix" value={me.pix_validated ? 'Validado pela central' : me.pix_key ? 'Aguardando validação' : 'Não cadastrado'} />
          <Row label="Veículo" value={`${me.vehicle_model} ${me.vehicle_color} · ${me.vehicle_plate}`} />
        </Card>
      )}

      {me && <SchoolRoute />}
      {me && <FoodShift />}
      {me?.rating && <MyRating rating={me.rating} onAck={onReload} />}

      {me && <Commission commissionPct={Number(me.commission_pct)} onPaid={onReload} />}
      {me && <DriverCashback />}
      {me && <AdCard placement="motorista" />}

      {me && me.photo_status === 'approved' && <MyPhotos me={me} onSaved={onReload} />}
      {me && me.vehicle_type !== 'utilitario' && <MyServices me={me} onSaved={onReload} />}
      {me && me.vehicle_type !== 'moto' && <MyCamera me={me} onSaved={onReload} />}
    </Screen>
  );
}

/** Serviços que o motorista atende: os que ele escolhe e os que a central liberou */
function MyServices({ me, onSaved }: { me: DriverMe; onSaved: () => Promise<void> }) {
  const [list, setList] = useState<string[]>(me.services_opt_in ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = me.vehicle_type === 'moto'
    ? [['entrega', 'Daqui Entrega (pacotes)']]
    : [['entrega', 'Daqui Entrega (pacotes)'], ['particular', 'Daqui Particular (por hora)'], ['pet', 'Daqui Pet (aceito animais)']];

  async function toggle(k: string) {
    const next = list.includes(k) ? list.filter((x) => x !== k) : [...list, k];
    setList(next);
    setBusy(true);
    setError(null);
    try { await api('/driver/services', { method: 'PUT', body: { services: next } }); await onSaved(); }
    catch (e) { setError(errMsg(e)); setList(list); }
    finally { setBusy(false); }
  }

  return (
    <Card>
      <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>Serviços que você atende</Text>
      {options.map(([k, l]) => <Check key={k} label={l} checked={list.includes(k)} onChange={() => { if (!busy) void toggle(k); }} />)}
      {(me.verified ?? []).length > 0 && (
        <Muted>Liberados pela central: {me.verified.map((v) => VERIFIED_LABEL[v] ?? v).join(', ')}.</Muted>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </Card>
  );
}

const PHOTO_STATUS: Record<string, { tone: 'ok' | 'warn' | 'error' | 'info'; text: string }> = {
  none: { tone: 'error', text: 'Obrigatório: envie sua foto e a do veículo para receber corridas. O passageiro vê as duas quando você aceita.' },
  pending: { tone: 'warn', text: 'Fotos enviadas. Você começa a receber corridas assim que a central aprovar.' },
  approved: { tone: 'ok', text: 'Fotos aprovadas. Elas aparecem para o cliente em todas as corridas.' },
  rejected: { tone: 'error', text: 'A central recusou as fotos. Tire outras com boa luz, rosto de frente e o veículo inteiro.' },
  trocando: { tone: 'info', text: 'Foto nova em análise. Até a central aprovar, o cliente continua vendo a anterior e você segue trabalhando.' },
  trocaRecusada: { tone: 'warn', text: 'A central recusou a foto nova. O cliente continua vendo a anterior.' },
};

/** Foto do perfil e do veículo (o cliente vê depois que a central aprova) */
function MyPhotos({ me, onSaved }: { me: DriverMe; onSaved: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const status = me.photo_status === 'approved' && me.photo_review === 'pending' ? 'trocando'
    : me.photo_status === 'approved' && me.photo_review === 'rejected' ? 'trocaRecusada'
    : me.photo_review === 'rejected' ? 'rejected' : me.photo_status ?? 'none';
  const st = PHOTO_STATUS[status];

  async function take(which: 'perfil' | 'veiculo') {
    setBusy(which);
    setError(null);
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) throw new Error('Libere a câmera para tirar a foto.');
      const r = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'], quality: 0.6, base64: true, allowsEditing: true, aspect: which === 'perfil' ? [1, 1] : [4, 3],
        cameraType: which === 'perfil' ? ImagePicker.CameraType.front : ImagePicker.CameraType.back,
      });
      if (r.canceled || !r.assets[0]?.base64) return;
      await post('/driver/photos', { which, image: `data:image/jpeg;base64,${r.assets[0].base64}` });
      setVersion((v) => v + 1);
      await onSaved();
    } catch (e) { setError(errMsg(e)); } finally { setBusy(null); }
  }

  return (
    <Card>
      <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>Sua foto e do veículo</Text>
      <Notice tone={st.tone}>{st.text}</Notice>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        {me.has_photo && <AuthImage path="/driver/photos/perfil" version={version} label="Sua foto" style={{ width: 80, height: 80, borderRadius: 40 }} />}
        {me.has_vehicle_photo && <AuthImage path="/driver/photos/veiculo" version={version} label="Foto do veículo" style={{ flex: 1, height: 80, borderRadius: 12 }} />}
      </View>
      <Button kind="secondary" label={me.has_photo ? 'Trocar minha foto' : 'Tirar minha foto'} onPress={() => take('perfil')} busy={busy === 'perfil'} />
      <Button kind="secondary" label={me.has_vehicle_photo ? 'Trocar foto do veículo' : 'Foto do veículo'} onPress={() => take('veiculo')} busy={busy === 'veiculo'} />
      {error && <Notice tone="error">{error}</Notice>}
    </Card>
  );
}

const CAMERA_LABEL = { video: 'Grava vídeo', video_audio: 'Grava vídeo e áudio' } as const;

/** Câmera de segurança no carro: o motorista declara e o passageiro é avisado antes do embarque */
function MyCamera({ me, onSaved }: { me: DriverMe; onSaved: () => Promise<void> }) {
  const current = me.camera_kind ?? 'none';
  const [kind, setKind] = useState<'none' | 'video' | 'video_audio'>(current);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const changed = kind !== current;

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await api('/driver/camera', { method: 'PUT', body: { kind, agree } });
      setMsg({ tone: 'ok', text: kind === 'none' ? 'Pronto: os passageiros não veem mais o aviso de câmera.' : 'Salvo. A central vai conferir o adesivo de aviso no carro.' });
      setAgree(false);
      await onSaved();
    } catch (e) {
      setMsg({ tone: 'error', text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>Câmera de segurança</Text>
      <Muted>Se você grava as viagens, declare aqui. O passageiro é avisado antes de embarcar e pode cancelar sem custo.</Muted>
      {me.camera_kind && (
        <Row label={CAMERA_LABEL[me.camera_kind]} value={
          me.camera_status === 'approved' ? 'Conferida pela central' : me.camera_status === 'rejected' ? 'Barrada pela central' : 'Aguardando a central'} />
      )}
      {me.camera_status === 'rejected' && (
        <Notice tone="error">A central barrou a câmera. Não grave as viagens até falar com a central.</Notice>
      )}
      <View style={{ gap: 8 }} accessibilityRole="radiogroup">
        <Choice label="Não uso câmera" selected={kind === 'none'} onPress={() => setKind('none')} />
        <Choice label="Grava só vídeo" selected={kind === 'video'} onPress={() => setKind('video')} />
        <Choice label="Grava vídeo e áudio" selected={kind === 'video_audio'} onPress={() => setKind('video_audio')} />
      </View>
      {changed && kind !== 'none' && (
        <>
          <Notice tone="info">
            {'Compromissos: 1) adesivo visível no carro avisando que a viagem é gravada; '
              + '2) gravar só para segurança; 3) nunca publicar nem mandar gravações para ninguém, a não ser para a central ou a polícia quando pedirem; '
              + '4) apagar as gravações em até 30 dias, salvo se houver ocorrência.'}
          </Notice>
          <Check checked={agree} onChange={setAgree} label="Assumo estes compromissos (divulgar gravações pode gerar processo e bloqueio da conta)" />
        </>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {changed && <Button label="Salvar" onPress={save} busy={busy} disabled={kind !== 'none' && !agree} />}
    </Card>
  );
}

const nota = (n: number) => n.toFixed(2).replace('.', ',');

/** Média das avaliações e o aviso automático quando cai abaixo do mínimo da cidade */
function MyRating({ rating, onAck }: { rating: NonNullable<DriverMe['rating']>; onAck: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const low = rating.average != null && rating.ratings >= rating.minRatings && rating.average < rating.below;

  async function ack() {
    setBusy(true);
    try { await post('/driver/rating-alert/ack'); await onAck(); } catch { /* tenta de novo depois */ } finally { setBusy(false); }
  }

  return (
    <Card>
      <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>Sua avaliação</Text>
      {rating.average != null && rating.ratings >= rating.minRatings ? (
        <Row label={`Média das últimas ${rating.ratings} avaliações`} value={`★ ${nota(rating.average)}`} />
      ) : (
        <Muted>{`Sua média aparece a partir de ${rating.minRatings} avaliações (você tem ${rating.ratings}).`}</Muted>
      )}
      {(rating.prefs?.asked ?? 0) > 0 && (
        <Row label="Preferências da viagem respeitadas" value={`${Math.round((rating.prefs!.respected / rating.prefs!.asked) * 100)}% (${rating.prefs!.asked})`} />
      )}
      {rating.alert && !rating.alert.acknowledged && (
        <>
          <Notice tone="warn">
            {`Sua média caiu para ${nota(rating.alert.average)}, abaixo de ${nota(rating.below)}. `}
            Este é um aviso para ajudar você a melhorar, não uma punição.
          </Notice>
          <Muted>
            {'O que mais pesa para os passageiros: carro limpo e sem cheiro forte; cumprimentar e confirmar o nome; '
              + 'seguir o caminho do app; dirigir com calma; ar-condicionado e som baixo, perguntando antes. '
              + 'Se a média continuar baixa, a central pode conversar com você.'}
          </Muted>
          <Button kind="secondary" label="Entendi" onPress={ack} busy={busy} />
        </>
      )}
      {low && rating.alert?.acknowledged && <Muted>{`Continue melhorando: o mínimo da cidade é ${nota(rating.below)}.`}</Muted>}
    </Card>
  );
}
