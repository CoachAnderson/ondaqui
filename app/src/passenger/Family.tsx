import { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { api, errMsg, post } from '../api';
import { firstName, money } from '../format';
import { useRealtime } from '../realtime';
import { colors } from '../theme';
import type { Place, Ride } from '../types';
import { Button, Card, Check, Field, Muted, Notice, Row, Screen, Title } from '../components/ui';

export interface FamilyMember {
  id: string; name: string; phone: string; relation: string; declaredWoman: boolean;
  monthlyLimitCents: number | null; spentThisMonthCents: number; notes: string | null;
  lastPickup: Place | null;
}

/** Parentes cadastrados pelo titular */
export function useFamily() {
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const reload = useCallback(() => {
    api<{ members: FamilyMember[] }>('/family/members').then((r) => setMembers(r.members)).catch(() => {});
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { members, reload };
}

/** Quanto ainda dá para gastar no mês com o parente (null = sem limite) */
export const familyLeft = (m: FamilyMember) =>
  m.monthlyLimitCents == null ? null : Math.max(0, m.monthlyLimitCents - m.spentThisMonthCents);

const toCents = (v: string) => Math.round(Number(v.replace(/\./g, '').replace(',', '.')) * 100);

/** Corridas dos parentes acontecendo agora: o titular toca para acompanhar */
export function FamilyRides({ onOpen }: { onOpen: (r: Ride) => void }) {
  const [rides, setRides] = useState<Ride[]>([]);
  const load = useCallback(() => {
    api<{ rides: Ride[] }>('/family/rides').then((r) => setRides(r.rides)).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);
  useRealtime<Ride>('ride:updated', (r) => { if (r.family) load(); });
  if (rides.length === 0) return null;
  const label: Record<string, string> = {
    requested: 'procurando motorista', accepted: 'motorista a caminho', arrived: 'motorista chegou', in_progress: 'em viagem',
  };
  return (
    <Card style={{ borderColor: colors.noite }}>
      <Text style={{ fontSize: 17, fontWeight: '800', color: colors.texto }}>Corridas da família agora</Text>
      {rides.map((r) => (
        <Pressable key={r.id} accessibilityRole="button" onPress={() => onOpen(r)}
          style={{ paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.linha, gap: 2 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: colors.texto }}>{r.family?.name} · {label[r.status] ?? r.status}</Text>
          <Muted>{`Para ${r.destination.address}. Toque para acompanhar.`}</Muted>
        </Pressable>
      ))}
    </Card>
  );
}

/** Tela "Minha família": cadastrar parentes, limite do mês e observações para o motorista */
export function FamilyManager({ visible, onClose, members, onChanged }: {
  visible: boolean; onClose: () => void; members: FamilyMember[]; onChanged: () => void;
}) {
  const empty = { name: '', phone: '', relation: '', limit: '', notes: '' };
  const [f, setF] = useState(empty);
  const [woman, setWoman] = useState(false);
  const [consent, setConsent] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const set = (k: keyof typeof empty) => (v: string) => setF({ ...f, [k]: v });
  const valid = f.name.trim().length >= 2 && f.phone.replace(/\D/g, '').length >= 10 && f.relation.trim().length >= 2 && consent
    && (!f.limit.trim() || toCents(f.limit) >= 500);

  async function add() {
    setBusy(true);
    setMsg(null);
    try {
      await post('/family/members', {
        name: f.name.trim(), phone: f.phone, relation: f.relation.trim(), declaredWoman: woman,
        monthlyLimitCents: f.limit.trim() ? toCents(f.limit) : null, notes: f.notes.trim() || null, consent,
      });
      setMsg({ tone: 'ok', text: `${firstName(f.name)} foi adicionado(a). Agora é só escolher na hora de pedir.` });
      setF(empty); setWoman(false); setConsent(false); setAdding(false);
      onChanged();
    } catch (e) {
      setMsg({ tone: 'error', text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(m: FamilyMember) {
    setMsg(null);
    try {
      await api(`/family/members/${m.id}`, { method: 'DELETE' });
      onChanged();
    } catch (e) {
      setMsg({ tone: 'error', text: errMsg(e) });
    }
  }

  async function changeLimit(m: FamilyMember, value: string) {
    setMsg(null);
    try {
      await api(`/family/members/${m.id}`, { method: 'PATCH', body: { monthlyLimitCents: value.trim() ? toCents(value) : null } });
      onChanged();
      setMsg({ tone: 'ok', text: `Limite de ${firstName(m.name)} atualizado.` });
    } catch (e) {
      setMsg({ tone: 'error', text: errMsg(e) });
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <Screen>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Title>Minha família</Title>
          <Text accessibilityRole="button" onPress={onClose} style={{ color: colors.texto2, textDecorationLine: 'underline', padding: 8 }}>Fechar</Text>
        </View>
        <Muted>
          Peça corrida para seus pais, filhos ou avós, mesmo que eles não tenham o app. Eles recebem por SMS quem vai
          buscar, o código de embarque e o link para acompanhar. Você recebe aviso no embarque e na chegada.
        </Muted>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

        {members.map((m) => <MemberCard key={m.id} m={m} onRemove={() => remove(m)} onLimit={(v) => changeLimit(m, v)} />)}

        {adding ? (
          <Card>
            <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>Adicionar parente</Text>
            <Field label="Nome" value={f.name} onChangeText={set('name')} autoComplete="name" />
            <Field label="Celular dele(a)" value={f.phone} onChangeText={set('phone')} keyboardType="phone-pad" placeholder="(14) 99999-9999"
              hint="Recebe o SMS com o código de embarque" />
            <Field label="Parentesco" value={f.relation} onChangeText={set('relation')} placeholder="ex.: mãe, filho, avó" />
            <Field label="Limite por mês (R$)" value={f.limit} onChangeText={set('limit')} keyboardType="decimal-pad" placeholder="sem limite"
              hint="Opcional. Ao chegar no limite, o app não pede mais corridas para ele(a) no mês." />
            <Field label="Observação para o motorista" value={f.notes} onChangeText={set('notes')} placeholder="ex.: usa bengala, precisa de ajuda para entrar" maxLength={200} />
            <Check checked={woman} onChange={setWoman} label="É mulher (pode usar o Daqui Mulher)" />
            <Check checked={consent} onChange={setConsent} label="Ele(a) sabe e concorda que eu cadastre o nome e o celular para pedir corridas" />
            <Button label="Salvar" onPress={add} busy={busy} disabled={!valid} />
            <Button kind="secondary" label="Cancelar" onPress={() => setAdding(false)} />
          </Card>
        ) : (
          <Button label="Adicionar parente" onPress={() => { setAdding(true); setMsg(null); }} />
        )}
      </Screen>
    </Modal>
  );
}

function MemberCard({ m, onRemove, onLimit }: { m: FamilyMember; onRemove: () => void; onLimit: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [limit, setLimit] = useState(m.monthlyLimitCents != null ? (m.monthlyLimitCents / 100).toFixed(2).replace('.', ',') : '');
  const [confirm, setConfirm] = useState(false);
  const left = familyLeft(m);
  return (
    <Card>
      <Text style={{ fontSize: 17, fontWeight: '800', color: colors.texto }}>{m.name}</Text>
      <Muted>{`${m.relation} · ${m.phone.replace(/^(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3')}`}</Muted>
      <Row label="Gasto neste mês" value={money(m.spentThisMonthCents)} />
      <Row label="Limite do mês" value={m.monthlyLimitCents == null ? 'Sem limite' : `${money(m.monthlyLimitCents)} · sobram ${money(left)}`} />
      {m.notes && <Muted>{`Para o motorista: ${m.notes}`}</Muted>}
      {editing ? (
        <>
          <Field label="Novo limite por mês (R$)" value={limit} onChangeText={setLimit} keyboardType="decimal-pad" placeholder="vazio = sem limite" />
          <Button label="Salvar limite" onPress={() => { onLimit(limit); setEditing(false); }} />
        </>
      ) : (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button kind="secondary" label="Mudar limite" onPress={() => setEditing(true)} style={{ flex: 1 }} />
          <Button kind="secondary" label={confirm ? 'Confirmar' : 'Remover'} onPress={() => (confirm ? onRemove() : setConfirm(true))} style={{ flex: 1 }} />
        </View>
      )}
    </Card>
  );
}
