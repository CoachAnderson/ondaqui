import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Modal, Platform, Pressable, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { api, errMsg, placeBody, post } from '../api';
import { firstName, money, plate } from '../format';
import { search } from '../location';
import { useRealtime } from '../realtime';
import { colors } from '../theme';
import type { Place } from '../types';
import RideMap from '../components/RideMap';
import { Button, Card, Check, Field, Muted, Notice, Row, Screen, Title } from '../components/ui';

interface School { id: string; name: string; address: string; lat: number; lng: number }
interface Trip {
  id: string; leg: 'ida' | 'volta'; time: string; status: 'previsto' | 'embarcou' | 'entregue' | 'ausente' | 'cancelado';
  boardedAt: string | null; deliveredAt: string | null; absentBy: 'pais' | 'motorista' | null; contractId: string;
  student: { name: string }; from: Place; to: Place;
  driver: null | { name: string; vehicle: { model: string; color: string; plate: string }; location: { lat: number; lng: number } | null };
}
interface Contract {
  id: string; studentName: string; grade: string | null; status: 'solicitado' | 'ativo' | 'pausado' | 'encerrado' | 'recusado';
  legs: 'ida' | 'volta' | 'ida_volta'; weekdays: number[]; pickupTime: string | null; returnTime: string | null;
  monthlyCents: number; paidUntil: string | null; overdue: boolean; school: { name: string };
  driver: null | { name: string; vehicle: { model: string; color: string; plate: string } };
}
interface EscolaData { rules: { enabled: boolean; graceDays: number }; schools: School[]; contracts: Contract[]; today: Trip[]; available: boolean }

const DAYS = [[1, 'Seg'], [2, 'Ter'], [3, 'Qua'], [4, 'Qui'], [5, 'Sex'], [6, 'Sáb']] as const;
const LEGS = [['ida_volta', 'Ida e volta'], ['ida', 'Só ida'], ['volta', 'Só volta']] as const;
const dateBr = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');

export function useEscola() {
  const [data, setData] = useState<EscolaData | null>(null);
  const reload = useCallback(() => { api<EscolaData>('/escola').then(setData).catch(() => {}); }, []);
  useEffect(() => { reload(); }, [reload]);
  useRealtime('escola:trip', reload);
  useRealtime('escola:paid', reload);
  useRealtime('escola:updated', reload);
  return { data, reload };
}

function tripText(t: Trip) {
  const n = firstName(t.student.name);
  if (t.status === 'previsto') return t.leg === 'ida' ? `${n}: buscar em casa às ${t.time}` : `${n}: buscar na escola às ${t.time}`;
  if (t.status === 'embarcou') return t.leg === 'ida' ? `${n} embarcou às ${hhmm(t.boardedAt)}, a caminho da escola` : `${n} saiu da escola às ${hhmm(t.boardedAt)}`;
  if (t.status === 'entregue') return t.leg === 'ida' ? `${n} chegou à escola às ${hhmm(t.deliveredAt)} ✅` : `${n} chegou em casa às ${hhmm(t.deliveredAt)} ✅`;
  if (t.status === 'ausente') return t.absentBy === 'pais' ? `${n} não vai (${t.leg}): avisado` : `${n} não estava no embarque (${t.leg})`;
  return `${n}: viagem cancelada`;
}

/** Cartão da tela inicial: viagens de hoje e acesso ao transporte escolar */
export function EscolaCard({ data, onOpen }: { data: EscolaData | null; onOpen: () => void }) {
  if (!data?.rules.enabled) return null;
  const active = data.contracts.filter((c) => c.status !== 'encerrado');
  return (
    <Card>
      <Text style={{ fontSize: 17, fontWeight: '800', color: colors.texto }}>Transporte escolar</Text>
      {data.today.length > 0
        ? data.today.map((t) => <Muted key={t.id}>{tripText(t)}</Muted>)
        : <Muted>{active.length > 0 ? 'Sem viagens hoje.' : 'Motorista fixo, conferido pela central, para levar e buscar seus filhos. Você acompanha ao vivo.'}</Muted>}
      {active.some((c) => c.overdue) && <Notice tone="warn">Há mensalidade do transporte escolar em aberto.</Notice>}
      <Button kind="secondary" label={active.length > 0 ? 'Ver transporte escolar' : 'Contratar transporte escolar'} onPress={onOpen} />
    </Card>
  );
}

/** Tela do transporte escolar: hoje, contratos (pagar, encerrar) e contratar */
export function EscolaScreen({ visible, onClose, data, reload, city }: {
  visible: boolean; onClose: () => void; data: EscolaData | null; reload: () => void; city: string;
}) {
  const [adding, setAdding] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'info' | 'error'; text: string } | null>(null);
  const waiting = useRef(false);

  const sync = useCallback(async () => {
    const r = await post<{ applied: boolean; pending: boolean }>('/escola/sync');
    if (r.applied) { waiting.current = false; setMsg({ tone: 'ok', text: 'Mensalidade paga. Obrigado!' }); reload(); }
    else if (r.pending) setMsg({ tone: 'info', text: 'Pagamento em análise. Com Pix, a confirmação costuma chegar em segundos.' });
  }, [reload]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active' && waiting.current) sync().catch(() => {}); });
    return () => sub.remove();
  }, [sync]);

  async function pay(c: Contract) {
    setMsg(null);
    try {
      const pref = await post<{ init_point: string }>(`/escola/contracts/${c.id}/checkout`);
      waiting.current = true;
      if (Platform.OS === 'web') window.open(pref.init_point, '_blank', 'noopener');
      else {
        await WebBrowser.openBrowserAsync(pref.init_point, { presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN, controlsColor: '#F2622E' });
        if (Platform.OS === 'ios') await sync();
      }
    } catch (e) { setMsg({ tone: 'error', text: errMsg(e) }); }
  }

  async function act(path: string, ok: string) {
    setMsg(null);
    try { await post(path); setMsg({ tone: 'ok', text: ok }); reload(); } catch (e) { setMsg({ tone: 'error', text: errMsg(e) }); }
  }

  const live = data?.today.find((t) => t.driver?.location && (t.status === 'embarcou' || t.status === 'previsto'));
  const contracts = (data?.contracts ?? []).filter((c) => c.status !== 'encerrado');

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <Screen>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Title>Transporte escolar</Title>
          <Text accessibilityRole="button" onPress={onClose} style={{ color: colors.texto2, textDecorationLine: 'underline', padding: 8 }}>Fechar</Text>
        </View>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

        {data && data.today.length > 0 && (
          <Card>
            <Text style={{ fontSize: 17, fontWeight: '800', color: colors.texto }}>Hoje</Text>
            {live?.driver?.location && (
              <RideMap height={200} points={[
                { id: 'motorista', lat: live.driver.location.lat, lng: live.driver.location.lng, label: firstName(live.driver.name), color: colors.noite },
                { id: 'destino', lat: live.to.lat, lng: live.to.lng, label: live.leg === 'ida' ? 'Escola' : 'Casa', color: colors.verde },
              ]} />
            )}
            {data.today.map((t) => (
              <View key={t.id} style={{ gap: 6, borderTopWidth: 1, borderTopColor: colors.linha, paddingTop: 8 }}>
                <Text style={{ fontSize: 15, fontWeight: '700', color: t.status === 'entregue' ? colors.verde : colors.texto }}>{tripText(t)}</Text>
                {t.status === 'previsto' && (
                  <Text accessibilityRole="button" onPress={() => act(`/escola/trips/${t.id}/ausente`, `Avisamos o motorista que ${firstName(t.student.name)} não vai.`)}
                    style={{ color: colors.vermelho, fontWeight: '700', paddingVertical: 4 }}>{`Avisar que ${firstName(t.student.name)} não vai`}</Text>
                )}
              </View>
            ))}
          </Card>
        )}

        {contracts.map((c) => (
          <Card key={c.id}>
            <Text style={{ fontSize: 17, fontWeight: '800', color: colors.texto }}>{c.studentName}{c.grade ? ` · ${c.grade}` : ''}</Text>
            <Muted>{`${c.school.name} · ${LEGS.find(([k]) => k === c.legs)![1].toLowerCase()} · ${c.weekdays.map((d) => DAYS.find(([n]) => n === d)![1]).join(', ')}`}</Muted>
            <Muted>{[c.pickupTime && `sai de casa ${c.pickupTime}`, c.returnTime && `sai da escola ${c.returnTime}`].filter(Boolean).join(' · ')}</Muted>
            {c.status === 'solicitado' && <Notice tone="info">A central está escolhendo o motorista. Você recebe um aviso.</Notice>}
            {c.status === 'pausado' && <Notice tone="warn">Pausado pela central. Fale com o atendimento.</Notice>}
            {c.driver && <Row label="Motorista" value={`${firstName(c.driver.name)} · ${c.driver.vehicle.model} ${c.driver.vehicle.color} · ${plate(c.driver.vehicle.plate)}`} />}
            <Row label="Mensalidade" value={money(c.monthlyCents)} />
            {c.status !== 'solicitado' && <Row label="Pago até" value={c.paidUntil ? dateBr(c.paidUntil) : 'Primeira mensalidade em aberto'} />}
            {c.overdue && c.paidUntil && <Notice tone="warn">{`Mensalidade vencida. O transporte segue por mais ${data?.rules.graceDays ?? 0} dias depois do vencimento.`}</Notice>}
            {(c.status === 'ativo' || c.status === 'pausado') && (data?.available
              ? <Button label={`Pagar ${money(c.monthlyCents)} (30 dias)`} onPress={() => pay(c)} accessibilityHint="Abre o Mercado Pago para pagar com Pix ou cartão" />
              : <Muted>Para pagar, fale com a central.</Muted>)}
            {confirmEnd === c.id ? (
              <View style={{ gap: 8 }}>
                <Notice tone="warn">{`Encerrar o transporte de ${firstName(c.studentName)}? As próximas viagens são canceladas.`}</Notice>
                <Button kind="danger" label="Sim, encerrar" onPress={() => { setConfirmEnd(null); act(`/escola/contracts/${c.id}/cancel`, 'Contrato encerrado.'); }} />
                <Button kind="secondary" label="Não, manter" onPress={() => setConfirmEnd(null)} />
              </View>
            ) : (
              <Text accessibilityRole="button" onPress={() => setConfirmEnd(c.id)}
                style={{ color: colors.texto2, textDecorationLine: 'underline', paddingVertical: 4 }}>Encerrar este transporte</Text>
            )}
          </Card>
        ))}

        {adding && data
          ? <NewContract schools={data.schools} city={city} onDone={() => { setAdding(false); reload(); setMsg({ tone: 'ok', text: 'Pedido enviado. A central escolhe o motorista e avisa você.' }); }} onCancel={() => setAdding(false)} />
          : <Button label="Contratar para um filho" onPress={() => { setAdding(true); setMsg(null); }} />}
      </Screen>
    </Modal>
  );
}

function Pick<T extends string | number>({ options, value, onToggle, multi, label }: {
  options: readonly (readonly [T, string])[]; value: T[]; onToggle: (v: T) => void; multi?: boolean; label: string;
}) {
  return (
    <View style={{ gap: 6 }} accessibilityRole={multi ? undefined : 'radiogroup'} accessibilityLabel={label}>
      <Muted>{label}</Muted>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {options.map(([v, l]) => {
          const on = value.includes(v);
          return (
            <Pressable key={String(v)} accessibilityRole={multi ? 'checkbox' : 'radio'} accessibilityState={multi ? { checked: on } : { selected: on }}
              onPress={() => onToggle(v)}
              style={{ minHeight: 44, paddingHorizontal: 14, borderRadius: 999, justifyContent: 'center', borderWidth: on ? 2 : 1,
                borderColor: on ? colors.noite : colors.linha, backgroundColor: on ? colors.noite : colors.branco }}>
              <Text style={{ fontWeight: '700', color: on ? colors.branco : colors.texto }}>{l}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Pedido: aluno, escola, casa, trechos, dias e horários; o preço aparece antes de enviar */
function NewContract({ schools, city, onDone, onCancel }: { schools: School[]; city: string; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ name: '', grade: '', pickup: '06:40', ret: '12:10', notes: '', homeQuery: '' });
  const [schoolId, setSchoolId] = useState<string>(schools[0]?.id ?? '');
  const [home, setHome] = useState<Place | null>(null);
  const [legs, setLegs] = useState<'ida_volta' | 'ida' | 'volta'>('ida_volta');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [consent, setConsent] = useState(false);
  const [quote, setQuote] = useState<{ distanceKm: number; monthlyCents: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!home || !schoolId || days.length === 0) { setQuote(null); return; }
    post<{ distanceKm: number; monthlyCents: number }>('/escola/quote', { schoolId, home: placeBody(home), legs, weekdays: days })
      .then(setQuote).catch((e) => setError(errMsg(e)));
  }, [home, schoolId, legs, days]);

  async function findHome() {
    setError(null);
    const r = await search(f.homeQuery, city);
    if (r) setHome(r); else setError('Não encontramos esse endereço. Tente com número e bairro.');
  }

  async function send() {
    if (!home) return;
    setBusy(true);
    setError(null);
    try {
      await post('/escola/contracts', {
        studentName: f.name.trim(), grade: f.grade.trim() || undefined, schoolId, home: placeBody(home), legs, weekdays: days,
        pickupTime: legs !== 'volta' ? f.pickup : undefined, returnTime: legs !== 'ida' ? f.ret : undefined, notes: f.notes.trim() || undefined, consent,
      });
      onDone();
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  if (schools.length === 0) return <Notice tone="info">A central ainda não cadastrou escolas. Fale com o atendimento.</Notice>;
  const valid = f.name.trim().length >= 3 && !!home && days.length > 0 && consent && !!quote;
  return (
    <Card>
      <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>Novo transporte escolar</Text>
      <Field label="Nome do aluno" value={f.name} onChangeText={(v) => setF({ ...f, name: v })} />
      <Field label="Série ou turma (opcional)" value={f.grade} onChangeText={(v) => setF({ ...f, grade: v })} placeholder="5º ano B" />
      <Pick label="Escola" options={schools.map((s) => [s.id, s.name] as const)} value={[schoolId]} onToggle={setSchoolId} />
      <Field label="Endereço de casa" value={f.homeQuery} onChangeText={(v) => setF({ ...f, homeQuery: v })} placeholder="Rua, número e bairro" onSubmitEditing={findHome} returnKeyType="search" />
      <Button kind="secondary" label="Buscar endereço" onPress={findHome} disabled={f.homeQuery.trim().length < 3} />
      {home && <Muted>{`Casa: ${home.address}`}</Muted>}
      <Pick label="Trechos" options={LEGS} value={[legs]} onToggle={setLegs} />
      <Pick label="Dias" multi options={DAYS} value={days} onToggle={(d) => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort())} />
      {legs !== 'volta' && <Field label="Saída de casa" value={f.pickup} onChangeText={(v) => setF({ ...f, pickup: v })} placeholder="06:40" maxLength={5} />}
      {legs !== 'ida' && <Field label="Saída da escola" value={f.ret} onChangeText={(v) => setF({ ...f, ret: v })} placeholder="12:10" maxLength={5} />}
      <Field label="Observação para o motorista (opcional)" value={f.notes} onChangeText={(v) => setF({ ...f, notes: v })} placeholder="Entregar só para a avó" maxLength={300} />
      {quote && <Row label={`Mensalidade (${quote.distanceKm.toLocaleString('pt-BR')} km até a escola)`} value={money(quote.monthlyCents)} />}
      <Check checked={consent} onChange={setConsent}
        label="Sou pai, mãe ou responsável legal e autorizo o uso do nome, da série e da escola do aluno para o transporte escolar (LGPD, art. 14)" />
      {error && <Notice tone="error">{error}</Notice>}
      <Button label="Enviar pedido" onPress={send} busy={busy} disabled={!valid} />
      <Button kind="secondary" label="Cancelar" onPress={onCancel} />
      <Muted>A central escolhe um motorista liberado para transporte escolar (CNH D, curso e autorização conferidos) e avisa você.</Muted>
    </Card>
  );
}
