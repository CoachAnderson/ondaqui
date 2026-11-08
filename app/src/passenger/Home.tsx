import { useCallback, useEffect, useMemo, useState } from 'react';
import { AccountMenu } from '../components/Account';
import { Pressable, Text, View } from 'react-native';
import { api, errMsg, placeBody, post } from '../api';
import { firstName, km, money, paymentLabel, serviceIcon, when } from '../format';
import { askLocation, currentPosition, describe, search } from '../location';
import { useSession } from '../session';
import { colors, useBrand } from '../theme';
import type { Brand, Category, Place, Ride } from '../types';
import RideMap from '../components/RideMap';
import { FamilyManager, FamilyRides, familyLeft, useFamily } from './Family';
import { CashbackCard, CashbackStatement, UseCashback, usableCashback, useWallet } from './Cashback';
import { ClubCard, useClub } from './Club';
import { TripPrefsModal, TripPrefsRow, useTripPrefs } from './TripPrefs';
import AdCard from '../components/AdCard';
import { EscolaCard, EscolaScreen, useEscola } from './Escola';
import { FoodCard, FoodScreen, useFood } from './Food';
import { decodePolyline } from '../polyline';
import { Button, Card, Field, Muted, Notice, Screen, Title } from '../components/ui';

interface Quote {
  category: string; priceCents: number; distanceKm: number; durationMin: number; surge: number; extraCents: number; routePolyline?: string | null;
  /** Clube: quanto o assinante deixa de pagar (para quem não assina, quanto economizaria) */
  club?: { member: boolean; discountCents: number; surgeWaivedCents: number; payCents: number } | null;
}
type Pay = 'pix' | 'card' | 'cash';

/** Um bloco da tela inicial por serviço (as duas entregas viram um só) */
interface Service { key: string; cats: Category[]; name: string; description: string }

function buildServices(cats: Category[]): Service[] {
  const list: Service[] = [];
  for (const c of cats) {
    if (c.code === 'entrega-carro') continue;
    if (c.code === 'entrega') {
      list.push({ key: 'entrega', cats: cats.filter((x) => x.kind === 'entrega'), name: c.name, description: 'Mande um pacote pela cidade' });
      continue;
    }
    list.push({ key: c.code, cats: [c], name: c.name, description: c.description });
  }
  return list;
}

/** Pílulas de escolha (horas, ajudantes, dias) */
function Pills<T extends string | number>({ options, value, onChange, label }: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string;
}) {
  return (
    <View style={{ gap: 8 }} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <Muted>{label}</Muted>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <Pressable key={String(o.value)} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={() => onChange(o.value)}
              style={{
                minHeight: 44, paddingHorizontal: 14, borderRadius: 999, justifyContent: 'center',
                borderWidth: on ? 2 : 1, borderColor: on ? colors.noite : colors.linha, backgroundColor: on ? colors.noite : colors.branco,
              }}>
              <Text style={{ fontWeight: '700', color: on ? colors.branco : colors.texto }}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const DAYS = Array.from({ length: 7 }, (_, i) => i);
const dayLabel = (i: number) => {
  if (i === 0) return 'Hoje';
  if (i === 1) return 'Amanhã';
  const d = new Date(); d.setDate(d.getDate() + i);
  return d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit' });
};

/** "Agora" ou um dia + horário; devolve ISO ou null */
function Schedule({ value, onChange }: { value: string | null; onChange: (iso: string | null) => void }) {
  const [mode, setMode] = useState<'agora' | 'agendar'>(value ? 'agendar' : 'agora');
  const [day, setDay] = useState(0);
  const [time, setTime] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode === 'agora') { onChange(null); setError(null); return; }
    const m = /^(\d{1,2}):?(\d{2})$/.exec(time.trim());
    if (!m) { onChange(null); setError(time ? 'Use o formato 14:30' : null); return; }
    const d = new Date(); d.setDate(d.getDate() + day); d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (Number(m[1]) > 23 || Number(m[2]) > 59) { onChange(null); setError('Horário inválido'); return; }
    if (d.getTime() < Date.now() + 30 * 60_000) { onChange(null); setError('Agende com pelo menos 30 minutos de antecedência'); return; }
    setError(null);
    onChange(d.toISOString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, day, time]);

  return (
    <View style={{ gap: 10 }}>
      <Pills label="Quando" value={mode} onChange={setMode}
        options={[{ value: 'agora', label: 'Agora' }, { value: 'agendar', label: 'Agendar' }]} />
      {mode === 'agendar' && (
        <>
          <Pills label="Dia" value={day} onChange={setDay} options={DAYS.map((i) => ({ value: i, label: dayLabel(i) }))} />
          <Field label="Horário" value={time} onChangeText={setTime} placeholder="14:30" keyboardType="numbers-and-punctuation" maxLength={5} />
          {error && <Notice tone="warn">{error}</Notice>}
        </>
      )}
    </View>
  );
}

export default function PassengerHome({ brand, onRide }: { brand: Brand; onRide: (r: Ride) => void }) {
  const { session } = useSession();
  const { accent } = useBrand();
  const services = useMemo(() => buildServices(brand.categories), [brand.categories]);
  const [service, setService] = useState<string>(services[0]?.key ?? 'carro');
  const [origin, setOrigin] = useState<Place | null>(null);
  const [locError, setLocError] = useState<string | null>(null);
  const [dest, setDest] = useState<Place | null>(null);
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<Place[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [pay, setPay] = useState<Pay>('pix');
  const [scheduledFor, setScheduledFor] = useState<string | null>(null);
  const [hours, setHours] = useState(2);
  const [helpers, setHelpers] = useState(0);
  const [notes, setNotes] = useState('');
  const [big, setBig] = useState(false); // entrega: pacote grande vai de carro
  const [recipient, setRecipient] = useState({ name: '', phone: '', pkg: '' });
  const [woman, setWoman] = useState<boolean | null>(null);
  const [scheduled, setScheduled] = useState<Ride[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<'search' | 'quote' | 'request' | null>(null);
  // Modo família: para quem é a corrida ('eu' ou o id do parente) e onde buscar o parente
  const family = useFamily();
  const [forWho, setForWho] = useState<string>('eu');
  const [familyOpen, setFamilyOpen] = useState(false);
  const [pickupQuery, setPickupQuery] = useState('');
  const [myOrigin, setMyOrigin] = useState<Place | null>(null);
  const member = family.members.find((m) => m.id === forWho) ?? null;
  // cashback: saldo e se vai usar nesta corrida
  const { wallet, reload: reloadWallet } = useWallet();
  const [useCash, setUseCash] = useState(true);
  const [statementOpen, setStatementOpen] = useState(false);
  const { club, reload: reloadClub } = useClub();
  const prefs = useTripPrefs();
  const escola = useEscola();
  const [escolaOpen, setEscolaOpen] = useState(false);
  const food = useFood(origin);
  const [foodOpen, setFoodOpen] = useState<{ orderId?: string } | null>(null);
  const [prefsOpen, setPrefsOpen] = useState(false);

  const svc = services.find((s) => s.key === service) ?? services[0];
  const cat = svc?.key === 'entrega' ? (svc.cats.find((c) => (big ? c.code === 'entrega-carro' : c.code === 'entrega')) ?? svc.cats[0]) : svc?.cats[0];
  const kind = cat?.kind ?? 'corrida';
  const needsDest = kind !== 'particular';

  async function locate() {
    setLocError(null);
    try {
      if (!(await askLocation())) {
        setLocError('Precisamos da sua localização para buscar você. Ative a localização nas configurações do celular.');
        return;
      }
      const p = await currentPosition();
      setOrigin(await describe(p, 'Minha localização atual'));
    } catch {
      setLocError('Não conseguimos achar sua localização. Verifique se o GPS está ligado.');
    }
  }

  const loadScheduled = useCallback(() => {
    api<{ rides: Ride[] }>('/rides/scheduled').then((r) => setScheduled(r.rides)).catch(() => {});
  }, []);

  useEffect(() => {
    void locate();
    loadScheduled();
    api<{ declared_woman: boolean }>('/me').then((m) => setWoman(!!m.declared_woman)).catch(() => {});
    api<{ rides: Ride[] }>('/rides/history').then((h) => {
      const seen = new Set<string>();
      const list: Place[] = [];
      for (const r of h.rides) {
        if (r.status !== 'completed' || r.kind === 'particular' || seen.has(r.destination.address)) continue;
        seen.add(r.destination.address);
        list.push(r.destination);
        if (list.length === 4) break;
      }
      setRecent(list);
    }).catch(() => {});
  }, [loadScheduled]);

  // preço fechado do serviço escolhido
  useEffect(() => {
    if (!origin || !cat || (needsDest && !dest)) { setQuote(null); return; }
    let alive = true;
    setBusy('quote');
    setError(null);
    post<Quote>('/rides/quote', {
      origin, destination: dest ?? undefined, category: cat.code, familyMemberId: member?.id,
      hours: kind === 'particular' ? hours : undefined,
      helpers: kind === 'frete' ? helpers : undefined,
      scheduledFor: scheduledFor ?? undefined,
    })
      .then((q) => alive && setQuote(q))
      .catch((e) => { if (alive) { setQuote(null); setError(errMsg(e)); } })
      .finally(() => alive && setBusy(null));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin?.lat, origin?.lng, dest?.lat, dest?.lng, cat?.code, hours, helpers, scheduledFor, member?.id]);

  function chooseWho(id: string) {
    setForWho(id);
    setQuote(null);
    setError(null);
    const m = family.members.find((x) => x.id === id);
    if (m) {
      if (forWho === 'eu') setMyOrigin(origin);
      setOrigin(m.lastPickup);
      setPickupQuery('');
    } else {
      setOrigin(myOrigin ?? origin);
    }
  }

  async function findPickup() {
    setBusy('search');
    setError(null);
    const r = await search(pickupQuery, brand.city_label);
    setBusy(null);
    if (r) setOrigin(r);
    else setError('Não encontramos esse endereço. Tente com número e bairro.');
  }

  async function find() {
    setBusy('search');
    setError(null);
    const r = await search(query, brand.city_label);
    setBusy(null);
    if (r) setDest(r);
    else setError('Não encontramos esse endereço. Tente com número e bairro, ou segure o dedo no mapa para marcar o destino.');
  }

  async function pickOnMap(p: { lat: number; lng: number }) {
    setDest(await describe(p, 'Ponto marcado no mapa'));
  }

  async function turnOnWoman() {
    try {
      const r = await api<{ declaredWoman: boolean }>('/me', { method: 'PATCH', body: { declaredWoman: true } });
      setWoman(r.declaredWoman);
    } catch (e) { setError(errMsg(e)); }
  }

  const deliveryOk = kind !== 'entrega' || (recipient.name.trim().length >= 2 && recipient.phone.replace(/\D/g, '').length >= 10 && recipient.pkg.trim().length >= 2);

  async function request() {
    if (!origin || !cat) return;
    setBusy('request');
    setError(null);
    setOkMsg(null);
    try {
      const r = await post<{ ride: Ride }>('/rides', {
        origin: placeBody(origin), destination: dest ? placeBody(dest) : undefined, category: cat.code, paymentMethod: pay,
        familyMemberId: member?.id,
        useCashback: useCash && cashOff > 0,
        hours: kind === 'particular' ? hours : undefined,
        helpers: kind === 'frete' ? helpers : undefined,
        scheduledFor: scheduledFor ?? undefined,
        notes: notes.trim() || undefined,
        delivery: kind === 'entrega'
          ? { recipientName: recipient.name.trim(), recipientPhone: recipient.phone, packageDesc: recipient.pkg.trim() }
          : undefined,
      });
      reloadWallet();
      if (r.ride.status === 'scheduled') {
        setOkMsg(`${r.ride.serviceName} agendado para ${when(r.ride.scheduledFor!)}. Avisamos quando o motorista aceitar.`);
        loadScheduled();
        setDest(null);
        setNotes('');
      } else {
        if (member) family.reload(); // atualiza o gasto do mês
        onRide(r.ride);
      }
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  async function cancelScheduled(id: string) {
    try { await post(`/rides/${id}/cancel`, { reason: 'desistiu' }); loadScheduled(); } catch (e) { setError(errMsg(e)); }
  }

  const points = useMemo(() => [
    ...(origin ? [{ id: 'origem', lat: origin.lat, lng: origin.lng, label: kind === 'entrega' ? 'Coleta' : member ? firstName(member.name) : 'Você', color: colors.verde }] : []),
    ...(dest ? [{ id: 'destino', lat: dest.lat, lng: dest.lng, label: kind === 'entrega' ? 'Entrega' : 'Destino', color: accent }] : []),
  ], [origin, dest, accent, kind, member]);

  // caminho da cotação desenhado antes de pedir
  const quoteLine = useMemo(() => decodePolyline(quote?.routePolyline), [quote?.routePolyline]);
  const blockedWoman = cat?.requires.includes('mulher') && (member ? !member.declaredWoman : woman === false);
  const memberLeft = member ? familyLeft(member) : null;
  // assinante do Clube: desconto (e sem dinâmica) antes do cashback
  const clubOff = quote?.club?.member ? quote.club.discountCents : 0;
  const afterClub = quote ? quote.priceCents - clubOff : 0;
  const cashOff = quote ? usableCashback(wallet, afterClub) : 0;
  const toPay = afterClub - (useCash ? cashOff : 0);
  const destLabel = kind === 'entrega' ? 'Para onde vai o pacote?' : kind === 'particular' ? 'Primeiro destino (opcional)' : 'Para onde?';

  return (
    <Screen>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title>Olá, {firstName(session?.user.name ?? '')}</Title>
        <AccountMenu />
      </View>

      {/* serviços */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityRole="radiogroup" accessibilityLabel="Serviço">
        {services.map((sv) => {
          const on = sv.key === service;
          return (
            <Pressable key={sv.key} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={sv.name}
              onPress={() => { setService(sv.key); setQuote(null); setError(null); setOkMsg(null); }}
              style={{
                width: '23%', minWidth: 74, flexGrow: 1, alignItems: 'center', gap: 4, paddingVertical: 10, borderRadius: 14,
                borderWidth: on ? 2 : 1, borderColor: on ? accent : colors.linha, backgroundColor: on ? '#FFF1E8' : colors.branco,
              }}>
              <Text style={{ fontSize: 24 }}>{serviceIcon[sv.key] ?? '🚗'}</Text>
              <Text numberOfLines={1} style={{ fontSize: 12.5, fontWeight: '700', color: colors.texto }}>{sv.name.replace(/^Daqui /, '')}</Text>
            </Pressable>
          );
        })}
      </View>
      {svc && <Muted>{svc.name}: {svc.description}</Muted>}

      <FamilyRides onOpen={onRide} />
      {food.active.length > 0 && <FoodCard enabled={food.enabled} open={0} active={food.active} onOpen={(orderId) => setFoodOpen({ orderId })} />}
      {(escola.data?.today.length ?? 0) > 0 && <EscolaCard data={escola.data} onOpen={() => setEscolaOpen(true)} />}

      {family.members.length > 0 && kind !== 'entrega' && (
        <Pills label="Para quem é a corrida?" value={forWho} onChange={chooseWho}
          options={[{ value: 'eu', label: 'Para mim' }, ...family.members.map((m) => ({ value: m.id, label: firstName(m.name) }))]} />
      )}
      {member && (
        <Card>
          <Text style={{ fontSize: 16, fontWeight: '800', color: colors.texto }}>{`Onde buscar ${firstName(member.name)}?`}</Text>
          <Field label="Endereço de embarque" value={pickupQuery} onChangeText={setPickupQuery} placeholder="Rua, número e bairro"
            onSubmitEditing={findPickup} returnKeyType="search" />
          <Button kind="secondary" label="Buscar endereço" onPress={findPickup} busy={busy === 'search'} disabled={pickupQuery.trim().length < 3} />
          {member.lastPickup && origin?.address !== member.lastPickup.address && (
            <Button kind="secondary" label={`Usar o da última vez: ${member.lastPickup.address}`} onPress={() => setOrigin(member.lastPickup)} />
          )}
          <Muted>{`${firstName(member.name)} recebe por SMS o motorista, o código de embarque e o link. Você é avisado no embarque e na chegada.`}</Muted>
          {memberLeft != null && <Muted>{`Limite do mês: sobram ${money(memberLeft)}.`}</Muted>}
        </Card>
      )}

      {points.length > 0 && <RideMap points={points} height={200} onLongPress={needsDest ? pickOnMap : undefined}
        routes={quoteLine.length > 1 && dest ? [{ id: 'cotacao', coords: quoteLine, color: accent }] : []} />}
      {locError && (
        <View style={{ gap: 10 }}>
          <Notice tone="warn">{locError}</Notice>
          <Button kind="secondary" label="Tentar de novo" onPress={locate} />
        </View>
      )}

      {blockedWoman ? (
        <Card>
          <Text style={{ fontSize: 17, fontWeight: '800', color: colors.texto }}>Daqui Mulher</Text>
          <Muted>Motoristas mulheres, conferidas pela central, atendendo só passageiras. Para usar, confirme que você é mulher.</Muted>
          <Button label="Sou mulher, ativar" onPress={turnOnWoman} />
        </Card>
      ) : (
        <>
          <Card>
            <View style={{ gap: 4 }}>
              <Muted>{kind === 'entrega' ? 'Coleta' : 'Embarque'}</Muted>
              <Text style={{ fontSize: 16, fontWeight: '700', color: colors.texto }}>{origin ? origin.address : member ? 'Informe acima onde buscar' : 'Buscando sua localização…'}</Text>
            </View>
            {dest ? (
              <View style={{ gap: 4 }}>
                <Muted>{kind === 'entrega' ? 'Entrega' : 'Destino'}</Muted>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
                  <Text style={{ fontSize: 16, fontWeight: '700', color: colors.texto, flex: 1 }}>{dest.address}</Text>
                  <Text accessibilityRole="button" onPress={() => { setDest(null); setQuote(null); }} style={{ color: colors.texto2, textDecorationLine: 'underline' }}>Trocar</Text>
                </View>
              </View>
            ) : (
              <>
                <Field label={destLabel} value={query} onChangeText={setQuery} placeholder="Rua, número e bairro" returnKeyType="search" onSubmitEditing={find} />
                <Button kind="dark" label="Buscar endereço" onPress={find} busy={busy === 'search'} disabled={query.trim().length < 3} />
                {recent.length > 0 && (
                  <View style={{ gap: 8 }}>
                    <Muted>Destinos recentes</Muted>
                    {recent.map((p) => (
                      <Pressable key={p.address} accessibilityRole="button" onPress={() => setDest(p)}
                        style={{ minHeight: 48, justifyContent: 'center', borderTopWidth: 1, borderTopColor: colors.linha }}>
                        <Text style={{ fontSize: 16, color: colors.texto }}>{p.address}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </>
            )}
          </Card>

          {/* opções de cada serviço */}
          {kind === 'entrega' && (
            <Card>
              <Text style={{ fontSize: 17, fontWeight: '800', color: colors.texto }}>Quem vai receber</Text>
              <Field label="Nome" value={recipient.name} onChangeText={(v) => setRecipient({ ...recipient, name: v })} autoComplete="name" />
              <Field label="Celular" value={recipient.phone} onChangeText={(v) => setRecipient({ ...recipient, phone: v })} keyboardType="phone-pad" placeholder="(14) 99999-9999" />
              <Field label="O que vai no pacote" value={recipient.pkg} onChangeText={(v) => setRecipient({ ...recipient, pkg: v })} placeholder="Ex.: documentos, uma caixa pequena" />
              {svc.cats.length > 1 && (
                <Pills label="Tamanho" value={big ? 'g' : 'p'} onChange={(v) => setBig(v === 'g')}
                  options={[{ value: 'p', label: 'Cabe na moto' }, { value: 'g', label: 'Grande (carro)' }]} />
              )}
              <Muted>Quem recebe ganha um código de entrega. Sem ele o pacote não é entregue.</Muted>
            </Card>
          )}
          {kind === 'particular' && (
            <Card>
              <Pills label="Por quantas horas?" value={hours} onChange={setHours}
                options={[2, 3, 4, 6, 8].map((h) => ({ value: h, label: `${h} h` }))} />
              <Field label="O que você precisa (opcional)" value={notes} onChangeText={setNotes} placeholder="Ex.: banco, mercado e farmácia" />
              <Muted>O motorista fica à sua disposição pelo tempo contratado. Dá para pedir mais horas durante o serviço.</Muted>
            </Card>
          )}
          {kind === 'frete' && (
            <Card>
              <Pills label="Ajudantes para carregar" value={helpers} onChange={setHelpers}
                options={[0, 1, 2].map((h) => ({ value: h, label: h === 0 ? 'Nenhum' : `${h}` }))} />
              <Field label="O que vai levar" value={notes} onChangeText={setNotes} placeholder="Ex.: geladeira, 10 caixas" />
            </Card>
          )}
          {cat?.code === 'pet' && (
            <Card>
              <Field label="Sobre o pet" value={notes} onChangeText={setNotes} placeholder="Ex.: cachorro de porte médio, na caixa" />
              <Muted>Só motoristas que aceitam pets recebem o pedido.</Muted>
            </Card>
          )}

          <Card><Schedule value={scheduledFor} onChange={setScheduledFor} /></Card>

          {error && <Notice tone="error">{error}</Notice>}
          {okMsg && <Notice tone="ok">{okMsg}</Notice>}

          {quote && (
            <>
              <Card>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ fontSize: 17, fontWeight: '800', color: colors.texto }}>{cat?.name}</Text>
                  <Text style={{ fontSize: 22, fontWeight: '800', color: colors.texto }}>{money(quote.priceCents)}</Text>
                </View>
                <Muted>
                  {kind === 'particular' ? `${hours} h de motorista` : `${km(quote.distanceKm)} · cerca de ${quote.durationMin} min`}
                  {quote.extraCents > 0 ? ` · inclui ${money(quote.extraCents)} ${kind === 'frete' ? 'de ajudantes' : 'de taxa do pet'}` : ''}
                  {quote.surge > 1 ? ` · dinâmica ${quote.surge}x` : ''}
                </Muted>
                {clubOff > 0 && (
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
                    <Text style={{ fontSize: 15, fontWeight: '700', color: colors.verde, flex: 1 }}>
                      {`${club?.rules.name ?? 'Clube'}${quote.club!.surgeWaivedCents > 0 ? ' (sem dinâmica)' : ''}`}
                    </Text>
                    <Text style={{ fontSize: 15, fontWeight: '800', color: colors.verde }}>{`− ${money(clubOff)}`}</Text>
                  </View>
                )}
                {quote.club && !quote.club.member && quote.club.discountCents > 0 && (
                  <Muted>{`Com o ${club?.rules.name ?? 'Clube'}, esta corrida sairia por ${money(quote.priceCents - quote.club.discountCents)}.`}</Muted>
                )}
              </Card>
              <UseCashback wallet={wallet} priceCents={afterClub} on={useCash} onChange={setUseCash} />
              {kind !== 'entrega' && !member && <Card><TripPrefsRow data={prefs.data} onEdit={() => setPrefsOpen(true)} /></Card>}
              <Pills label="Pagamento" value={pay} onChange={setPay}
                options={(['pix', 'card', 'cash'] as Pay[]).map((p) => ({ value: p, label: paymentLabel[p] }))} />
              <Muted>{toPay < quote.priceCents
                ? `O preço é fechado: ${money(quote.priceCents)}, e você paga ${money(toPay)} ao motorista com ${clubOff > 0 && useCash && cashOff > 0 ? 'o Clube e o cashback' : clubOff > 0 ? 'o desconto do Clube' : 'o cashback'}.`
                : 'O preço é fechado: você paga exatamente o valor mostrado.'}</Muted>
              {brand.camerasInUse && kind !== 'entrega' && (
                <Muted>Alguns veículos têm câmera de segurança. Se o seu tiver, você é avisado antes do embarque e pode cancelar sem custo.</Muted>
              )}
              <Button
                label={`${scheduledFor ? 'Agendar' : 'Pedir'} ${cat?.name ?? ''} · ${money(toPay)}`}
                onPress={request} busy={busy === 'request'} disabled={!origin || !deliveryOk}
              />
              {!deliveryOk && <Muted>Preencha quem vai receber e o que vai no pacote.</Muted>}
            </>
          )}
          {busy === 'quote' && <Muted>Calculando o preço…</Muted>}
        </>
      )}

      {scheduled.length > 0 && (
        <Card>
          <Text style={{ fontSize: 17, fontWeight: '800', color: colors.texto }}>Agendados</Text>
          {scheduled.map((r) => (
            <View key={r.id} style={{ borderTopWidth: 1, borderTopColor: colors.linha, paddingTop: 10, gap: 4 }}>
              <Text style={{ fontWeight: '700', color: colors.texto }}>{serviceIcon[r.category] ?? '🚗'} {r.serviceName} · {when(r.scheduledFor!)}</Text>
              <Muted>{r.kind === 'particular' ? `${r.hoursBooked} h · ${r.origin.address}` : `${r.origin.address} → ${r.destination.address}`}</Muted>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontWeight: '700', color: colors.texto }}>{money(r.priceCents)}</Text>
                <Text accessibilityRole="button" onPress={() => cancelScheduled(r.id)} style={{ color: colors.vermelho, fontWeight: '700', padding: 8 }}>Cancelar</Text>
              </View>
            </View>
          ))}
        </Card>
      )}
      {(escola.data?.today.length ?? 0) === 0 && <EscolaCard data={escola.data} onOpen={() => setEscolaOpen(true)} />}
      {food.active.length === 0 && <FoodCard enabled={food.enabled} open={food.restaurants.filter((r) => r.open).length} active={[]} onOpen={(orderId) => setFoodOpen({ orderId })} />}
      <AdCard placement="inicio" />
      <ClubCard club={club} cashbackOn={!!wallet?.rules.enabled} onChanged={() => { reloadClub(); setQuote(null); }} />
      <CashbackCard wallet={wallet} onOpen={() => { reloadWallet(); setStatementOpen(true); }} />
      <CashbackStatement visible={statementOpen} onClose={() => setStatementOpen(false)} wallet={wallet} />
      <Card>
        <Text style={{ fontSize: 17, fontWeight: '800', color: colors.texto }}>Minha família</Text>
        <Muted>
          {family.members.length > 0
            ? `${family.members.map((m) => firstName(m.name)).join(', ')}. Peça corrida para eles e acompanhe daqui.`
            : 'Peça corridas para seus pais, filhos ou avós, mesmo sem o app, com limite de gasto por mês.'}
        </Muted>
        <Button kind="secondary" label={family.members.length > 0 ? 'Ver minha família' : 'Adicionar parente'} onPress={() => setFamilyOpen(true)} />
      </Card>
      <FoodScreen visible={!!foodOpen} onClose={() => setFoodOpen(null)} food={food} here={origin} recent={recent} city={brand.city_label} orderId={foodOpen?.orderId ?? null} />
      <EscolaScreen visible={escolaOpen} onClose={() => setEscolaOpen(false)} data={escola.data} reload={escola.reload} city={brand.city_label} />
      <TripPrefsModal visible={prefsOpen} onClose={() => setPrefsOpen(false)} data={prefs.data} onSaved={prefs.setData} />
      <FamilyManager visible={familyOpen} onClose={() => setFamilyOpen(false)} members={family.members} onChanged={family.reload} />
    </Screen>
  );
}
