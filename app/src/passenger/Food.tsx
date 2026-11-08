import { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, Modal, Pressable, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { api, errMsg, placeBody, post } from '../api';
import { firstName, km, money, plate } from '../format';
import { search } from '../location';
import { useRealtime } from '../realtime';
import { colors } from '../theme';
import type { Place } from '../types';
import AuthImage from '../components/AuthImage';
import RideMap from '../components/RideMap';
import { Button, Card, Field, Muted, Notice, Row, Screen, Title } from '../components/ui';

/**
 * Daqui Food no app do passageiro: restaurantes da cidade, cardápio, carrinho e pedido.
 * A comida é paga direto ao restaurante (Pix pelo app ou na entrega); a entrega é da central, com código.
 */

interface Restaurant {
  id: string; name: string; category: string | null; description: string | null; address: string; hasLogo: boolean;
  open: boolean; paused: boolean; prepMin: number; minOrderCents: number; freeDelivery: boolean; distanceKm?: number;
  pay: { app: boolean; delivery: boolean };
}
interface Item { id: string; name: string; description: string | null; priceCents: number; hasPhoto: boolean }
interface Section { id: string | null; name: string; items: Item[] }
interface OrderItem { itemId: string; name: string; qty: number; priceCents: number; notes: string | null }
export interface FoodOrder {
  id: string; number: number; status: 'aguardando_pagamento' | 'novo' | 'aceito' | 'pronto' | 'em_entrega' | 'entregue' | 'recusado' | 'cancelado';
  restaurant: { id: string; name: string; hasLogo: boolean; address: string };
  items: OrderItem[]; subtotalCents: number; deliveryFeeCents: number; totalCents: number;
  payment: 'app' | 'entrega'; payStatus: string; pix: { qrCode: string; qrCodeBase64: string } | null;
  prepMin: number | null; readyBy: string | null; destination: Place; refuseReason: string | null; createdAt: string;
  delivery: null | {
    status: string; deliveryCode: string; shareToken: string;
    courier: null | { name: string; vehicle: { model: string; color: string; plate: string }; location: { lat: number; lng: number } | null };
    cod: null | { amountCents: number; status: string };
  };
}
interface Quote { subtotalCents: number; deliveryFeeCents: number; totalCents: number; distanceKm: number; prepMin: number; minOrderOk: boolean; minOrderCents: number; pay: { app: boolean; delivery: boolean } }

const ACTIVE = ['aguardando_pagamento', 'novo', 'aceito', 'pronto', 'em_entrega'];
const STEPS: [FoodOrder['status'], string][] = [['novo', 'Pedido enviado'], ['aceito', 'Em preparo'], ['pronto', 'Pronto'], ['em_entrega', 'Saiu para entrega'], ['entregue', 'Entregue']];
const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');

export function statusText(o: FoodOrder) {
  switch (o.status) {
    case 'aguardando_pagamento': return 'Aguardando o Pix';
    case 'novo': return 'Esperando o restaurante aceitar';
    case 'aceito': return o.readyBy ? `Em preparo · pronto por volta de ${hhmm(o.readyBy)}` : 'Em preparo';
    case 'pronto': return o.delivery?.courier ? `${firstName(o.delivery.courier.name)} está indo buscar` : 'Pronto · chamando o entregador';
    case 'em_entrega': return o.delivery?.courier ? `${firstName(o.delivery.courier.name)} está a caminho` : 'Saiu para entrega';
    case 'entregue': return 'Entregue ✅';
    case 'recusado': return 'O restaurante não pôde aceitar';
    default: return 'Cancelado';
  }
}

export function useFood(here: Place | null) {
  const [enabled, setEnabled] = useState(false);
  const [restaurants, setRestaurants] = useState<Restaurant[]>([]);
  const [orders, setOrders] = useState<FoodOrder[]>([]);
  const q = here ? `?lat=${here.lat}&lng=${here.lng}` : '';
  const reload = useCallback(() => {
    api<{ enabled: boolean; restaurants: Restaurant[] }>(`/food/restaurants${q}`).then((r) => { setEnabled(r.enabled); setRestaurants(r.restaurants); }).catch(() => {});
    api<{ orders: FoodOrder[] }>('/food/orders').then((r) => setOrders(r.orders)).catch(() => {});
  }, [q]);
  useEffect(() => { reload(); }, [reload]);
  useRealtime<FoodOrder>('food:order', (o) => setOrders((list) => [o, ...list.filter((x) => x.id !== o.id)]));
  return { enabled, restaurants, orders, active: orders.filter((o) => ACTIVE.includes(o.status)), reload };
}

/** Cartão da tela inicial: pedidos em andamento e acesso aos restaurantes */
export function FoodCard({ enabled, open, active, onOpen }: { enabled: boolean; open: number; active: FoodOrder[]; onOpen: (orderId?: string) => void }) {
  if (!enabled) return null;
  return (
    <Card>
      <Text style={{ fontSize: 17, fontWeight: '800', color: colors.texto }}>🍝 Daqui Food</Text>
      {active.length > 0
        ? active.map((o) => (
            <Pressable key={o.id} accessibilityRole="button" onPress={() => onOpen(o.id)} style={{ gap: 2, paddingVertical: 4 }}>
              <Text style={{ fontWeight: '700', color: colors.texto }}>{`${o.restaurant.name} · pedido ${o.number}`}</Text>
              <Muted>{statusText(o)}</Muted>
            </Pressable>
          ))
        : <Muted>{open > 0 ? `${open} ${open === 1 ? 'restaurante aberto' : 'restaurantes abertos'} agora. Comida da cidade, entregue pelos motoboys daqui.` : 'Comida dos restaurantes da cidade, entregue pelos motoboys daqui.'}</Muted>}
      <Button kind={active.length > 0 ? 'secondary' : 'primary'} label={active.length > 0 ? 'Ver restaurantes' : 'Pedir comida'} onPress={() => onOpen()} />
    </Card>
  );
}

type Cart = Record<string, { item: Item; qty: number; notes: string }>;

export function FoodScreen({ visible, onClose, food, here, recent, city, orderId }: {
  visible: boolean; onClose: () => void; food: ReturnType<typeof useFood>; here: Place | null; recent: Place[]; city: string; orderId?: string | null;
}) {
  const [rest, setRest] = useState<Restaurant | null>(null);
  const [menu, setMenu] = useState<Section[]>([]);
  const [cart, setCart] = useState<Cart>({});
  const [step, setStep] = useState<'lista' | 'cardapio' | 'sacola' | 'pedido' | 'pedidos'>('lista');
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Item | null>(null);

  useEffect(() => {
    if (!visible) return;
    food.reload();
    if (orderId) { setCurrent(orderId); setStep('pedido'); } else if (step === 'pedido') setStep('lista');
  }, [visible, orderId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function openRestaurant(r: Restaurant) {
    setError(null);
    try {
      const d = await api<{ restaurant: Restaurant; menu: Section[] }>(`/food/restaurants/${r.id}`);
      if (rest?.id !== r.id) setCart({});
      setRest(d.restaurant);
      setMenu(d.menu);
      setStep('cardapio');
    } catch (e) { setError(errMsg(e)); }
  }

  const count = Object.values(cart).reduce((s, c) => s + c.qty, 0);
  const subtotal = Object.values(cart).reduce((s, c) => s + c.qty * c.item.priceCents, 0);
  const add = (i: Item, d: number) => setCart((c) => {
    const qty = Math.max(0, (c[i.id]?.qty ?? 0) + d);
    const n = { ...c };
    if (qty === 0) delete n[i.id]; else n[i.id] = { item: i, qty, notes: c[i.id]?.notes ?? '' };
    return n;
  });
  const back = () => {
    setError(null);
    if (step === 'sacola') setStep('cardapio');
    else if (step === 'cardapio' || step === 'pedidos') setStep('lista');
    else if (step === 'pedido') setStep(food.active.length > 1 ? 'pedidos' : 'lista');
    else onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={back}>
      <Screen>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text accessibilityRole="button" onPress={back} style={{ color: colors.texto2, textDecorationLine: 'underline', padding: 8, marginLeft: -8 }}>
            {step === 'lista' ? 'Fechar' : 'Voltar'}
          </Text>
          {step === 'lista' && food.orders.length > 0 && (
            <Text accessibilityRole="button" onPress={() => setStep('pedidos')} style={{ color: colors.texto2, textDecorationLine: 'underline', padding: 8 }}>Meus pedidos</Text>
          )}
        </View>
        {error && <Notice tone="error">{error}</Notice>}

        {step === 'lista' && (
          <>
            <Title>Daqui Food</Title>
            <Muted>Você paga a comida direto ao restaurante. A entrega é dos motoboys da cidade, com código de entrega.</Muted>
            {food.active.map((o) => (
              <Card key={o.id}>
                <Text style={{ fontWeight: '800', color: colors.texto }}>{`Pedido ${o.number} · ${o.restaurant.name}`}</Text>
                <Muted>{statusText(o)}</Muted>
                <Button kind="secondary" label="Acompanhar" onPress={() => { setCurrent(o.id); setStep('pedido'); }} />
              </Card>
            ))}
            {food.restaurants.length === 0 && <Notice tone="info">Nenhum restaurante no app ainda.</Notice>}
            {food.restaurants.map((r) => (
              <Pressable key={r.id} accessibilityRole="button" accessibilityLabel={`${r.name}, ${r.open ? 'aberto' : 'fechado'}`} onPress={() => openRestaurant(r)}
                style={{ backgroundColor: colors.branco, borderRadius: 16, borderWidth: 1, borderColor: colors.linha, padding: 14, flexDirection: 'row', gap: 12, opacity: r.open ? 1 : 0.55 }}>
                {r.hasLogo
                  ? <AuthImage path={`/food/restaurants/${r.id}/logo`} label={`Logo de ${r.name}`} style={{ width: 56, height: 56, borderRadius: 12 }} />
                  : <View style={{ width: 56, height: 56, borderRadius: 12, backgroundColor: '#FFF1E8', alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 26 }}>🍽️</Text></View>}
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ fontSize: 16, fontWeight: '800', color: colors.texto }}>{r.name}</Text>
                  <Muted>{[r.category, r.distanceKm != null ? km(r.distanceKm) : null, `${r.prepMin} min de preparo`].filter(Boolean).join(' · ')}</Muted>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: r.open ? colors.verde : colors.texto2 }}>
                    {r.open ? (r.freeDelivery ? 'Aberto · entrega grátis' : 'Aberto') : r.paused ? 'Pausado agora' : 'Fechado agora'}
                    {r.minOrderCents > 0 ? `  ·  mínimo ${money(r.minOrderCents)}` : ''}
                  </Text>
                </View>
              </Pressable>
            ))}
          </>
        )}

        {step === 'cardapio' && rest && (
          <>
            <Title>{rest.name}</Title>
            {rest.description && <Muted>{rest.description}</Muted>}
            {!rest.open && <Notice tone="warn">{rest.paused ? 'O restaurante pausou os pedidos agora.' : 'Fechado agora. Veja o cardápio e volte no horário.'}</Notice>}
            {menu.map((s) => (
              <View key={s.id ?? 'outros'} style={{ gap: 8 }}>
                <Text style={{ fontSize: 17, fontWeight: '800', color: colors.texto, marginTop: 6 }}>{s.name}</Text>
                {s.items.map((i) => {
                  const q = cart[i.id]?.qty ?? 0;
                  return (
                    <View key={i.id} style={{ backgroundColor: colors.branco, borderRadius: 14, borderWidth: q ? 2 : 1, borderColor: q ? colors.noite : colors.linha, padding: 12, flexDirection: 'row', gap: 12 }}>
                      {i.hasPhoto && (
                        <Pressable accessibilityRole="imagebutton" accessibilityLabel={`Ver foto de ${i.name}`} onPress={() => setZoom(i)}>
                          <AuthImage path={`/food/items/${i.id}/photo`} label={`Foto de ${i.name}`} style={{ width: 84, height: 84, borderRadius: 12 }} />
                        </Pressable>
                      )}
                      <View style={{ flex: 1, gap: 4 }}>
                        <Text style={{ fontWeight: '800', color: colors.texto }}>{i.name}</Text>
                        {i.description && <Muted>{i.description}</Muted>}
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Text style={{ fontWeight: '800', color: colors.texto }}>{money(i.priceCents)}</Text>
                          {q === 0 ? (
                            <Pressable accessibilityRole="button" accessibilityLabel={`Adicionar ${i.name}`} disabled={!rest.open} onPress={() => add(i, 1)}
                              style={{ minHeight: 40, paddingHorizontal: 16, borderRadius: 999, backgroundColor: rest.open ? colors.noite : colors.linha, justifyContent: 'center' }}>
                              <Text style={{ color: colors.branco, fontWeight: '800' }}>Adicionar</Text>
                            </Pressable>
                          ) : (
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                              <Qty label="−" a11y={`Tirar um ${i.name}`} onPress={() => add(i, -1)} />
                              <Text style={{ minWidth: 22, textAlign: 'center', fontWeight: '800', color: colors.texto }}>{q}</Text>
                              <Qty label="+" a11y={`Mais um ${i.name}`} onPress={() => add(i, 1)} />
                            </View>
                          )}
                        </View>
                      </View>
                    </View>
                  );
                })}
              </View>
            ))}
            {count > 0 && <View style={{ height: 76 }} />}
          </>
        )}

        {step === 'sacola' && rest && (
          <Checkout rest={rest} cart={cart} setCart={setCart} here={here} recent={recent} city={city}
            onDone={(o) => { setCart({}); food.reload(); setCurrent(o.id); setStep('pedido'); }} />
        )}

        {step === 'pedido' && current && <OrderView id={current} onChanged={food.reload} />}

        {step === 'pedidos' && (
          <>
            <Title>Meus pedidos</Title>
            {food.orders.map((o) => (
              <Pressable key={o.id} accessibilityRole="button" onPress={() => { setCurrent(o.id); setStep('pedido'); }}
                style={{ backgroundColor: colors.branco, borderRadius: 14, borderWidth: 1, borderColor: colors.linha, padding: 12, gap: 2 }}>
                <Text style={{ fontWeight: '800', color: colors.texto }}>{`${o.restaurant.name} · ${money(o.totalCents)}`}</Text>
                <Muted>{`Pedido ${o.number} · ${new Date(o.createdAt).toLocaleDateString('pt-BR')} · ${statusText(o)}`}</Muted>
              </Pressable>
            ))}
          </>
        )}
      </Screen>
      {zoom && (
        // foto grande do prato
        <Pressable accessibilityRole="button" accessibilityLabel="Fechar foto" onPress={() => setZoom(null)}
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: colors.noite, justifyContent: 'center', padding: 20, gap: 14 }}>
          <AuthImage path={`/food/items/${zoom.id}/photo`} label={`Foto de ${zoom.name}`} style={{ width: '100%', aspectRatio: 1, borderRadius: 18 }} />
          <Text style={{ color: colors.areia, fontSize: 20, fontWeight: '800' }}>{zoom.name}</Text>
          {zoom.description && <Text style={{ color: colors.areia }}>{zoom.description}</Text>}
          <Text style={{ color: '#F2622E', fontSize: 20, fontWeight: '800' }}>{money(zoom.priceCents)}</Text>
          <Text style={{ color: colors.areia, textDecorationLine: 'underline' }}>Toque para fechar</Text>
        </Pressable>
      )}
      {step === 'cardapio' && count > 0 && !zoom && (
        // sacola sempre à mão, por cima do cardápio
        <View style={{ position: 'absolute', left: 16, right: 16, bottom: 20 }}>
          <Button label={`Ver sacola · ${count} ${count === 1 ? 'item' : 'itens'} · ${money(subtotal)}`} onPress={() => setStep('sacola')} />
        </View>
      )}
    </Modal>
  );
}

function Qty({ label, a11y, onPress }: { label: string; a11y: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} onPress={onPress} hitSlop={6}
      style={{ width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: colors.linha, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.branco }}>
      <Text style={{ fontSize: 20, fontWeight: '800', color: colors.texto }}>{label}</Text>
    </Pressable>
  );
}

function Checkout({ rest, cart, setCart, here, recent, city, onDone }: {
  rest: Restaurant; cart: Cart; setCart: (c: Cart) => void; here: Place | null; recent: Place[]; city: string; onDone: (o: FoodOrder) => void;
}) {
  const [dest, setDest] = useState<Place | null>(here ? { ...here, address: here.address } : recent[0] ?? null);
  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState('');
  const [pay, setPay] = useState<'app' | 'entrega'>(rest.pay.app ? 'app' : 'entrega');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = useMemo(() => Object.values(cart).map((c) => ({ itemId: c.item.id, qty: c.qty, notes: c.notes.trim() || undefined })), [cart]);

  useEffect(() => {
    if (!dest || items.length === 0) { setQuote(null); return; }
    let alive = true;
    setError(null);
    post<Quote>('/food/quote', { restaurantId: rest.id, destination: placeBody(dest), items })
      .then((q) => alive && setQuote(q)).catch((e) => alive && setError(errMsg(e)));
    return () => { alive = false; };
  }, [dest, items, rest.id]);

  async function find() {
    setError(null);
    const r = await search(query, city);
    if (r) setDest(r); else setError('Não encontramos esse endereço. Tente com número e bairro.');
  }

  async function send() {
    if (!dest) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ order: FoodOrder }>('/food/orders', { restaurantId: rest.id, destination: placeBody(dest), items, payment: pay, notes: notes.trim() || undefined });
      onDone(r.order);
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  const places = [...(here ? [{ ...here, address: here.address }] : []), ...recent.filter((p) => p.address !== here?.address)].slice(0, 4);
  return (
    <>
      <Title>Sua sacola</Title>
      <Card>
        <Text style={{ fontWeight: '800', color: colors.texto }}>{rest.name}</Text>
        {Object.values(cart).map((c) => (
          <View key={c.item.id} style={{ gap: 6, borderTopWidth: 1, borderTopColor: colors.linha, paddingTop: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ color: colors.texto, fontWeight: '700', flex: 1 }}>{`${c.qty}× ${c.item.name}`}</Text>
              <Text style={{ color: colors.texto, fontWeight: '700' }}>{money(c.qty * c.item.priceCents)}</Text>
            </View>
            <Field label="Observação (opcional)" value={c.notes} placeholder="sem cebola, bem passado..." maxLength={140}
              onChangeText={(v) => setCart({ ...cart, [c.item.id]: { ...c, notes: v } })} />
          </View>
        ))}
      </Card>

      <Card>
        <Text style={{ fontWeight: '800', color: colors.texto }}>Entregar em</Text>
        {places.map((p) => {
          const on = dest?.address === p.address && dest?.lat === p.lat;
          return (
            <Pressable key={`${p.lat},${p.lng}`} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={() => setDest(p)}
              style={{ minHeight: 44, padding: 10, borderRadius: 12, borderWidth: on ? 2 : 1, borderColor: on ? colors.noite : colors.linha, backgroundColor: colors.branco }}>
              <Text style={{ color: colors.texto, fontWeight: on ? '800' : '500' }}>{p.address}</Text>
            </Pressable>
          );
        })}
        <Field label="Outro endereço" value={query} onChangeText={setQuery} placeholder="Rua, número e bairro" onSubmitEditing={find} returnKeyType="search" />
        <Button kind="secondary" label="Buscar endereço" onPress={find} disabled={query.trim().length < 3} />
        <Field label="Observação para a entrega (opcional)" value={notes} onChangeText={setNotes} placeholder="Portão azul, apartamento 12" maxLength={300} />
      </Card>

      <Card>
        <Text style={{ fontWeight: '800', color: colors.texto }}>Pagamento</Text>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {([['app', 'Pix pelo app'], ['entrega', 'Na entrega']] as const).filter(([k]) => (k === 'app' ? rest.pay.app : rest.pay.delivery)).map(([k, l]) => (
            <Pressable key={k} accessibilityRole="radio" accessibilityState={{ selected: pay === k }} onPress={() => setPay(k)}
              style={{ minHeight: 44, paddingHorizontal: 16, borderRadius: 999, justifyContent: 'center', borderWidth: pay === k ? 2 : 1,
                borderColor: pay === k ? colors.noite : colors.linha, backgroundColor: pay === k ? colors.noite : colors.branco }}>
              <Text style={{ fontWeight: '700', color: pay === k ? colors.branco : colors.texto }}>{l}</Text>
            </Pressable>
          ))}
        </View>
        <Muted>{pay === 'app'
          ? `O Pix vai direto para a conta do ${rest.name}. O pedido chega à cozinha assim que o Pix cair.`
          : 'Na entrega, pague com o Pix do restaurante ou a maquininha dele. O entregador nunca recebe dinheiro na mão.'}</Muted>
        {quote && (
          <>
            <Row label="Comida" value={money(quote.subtotalCents)} />
            <Row label={`Entrega (${km(quote.distanceKm)})`} value={quote.deliveryFeeCents ? money(quote.deliveryFeeCents) : 'Grátis'} />
            <Row label="Total" value={<Text style={{ fontWeight: '800', fontSize: 18, color: colors.texto }}>{money(quote.totalCents)}</Text>} />
            {!quote.minOrderOk && <Notice tone="warn">{`Pedido mínimo deste restaurante: ${money(quote.minOrderCents)} em comida.`}</Notice>}
          </>
        )}
      </Card>
      {error && <Notice tone="error">{error}</Notice>}
      <Button label={quote ? `Fazer pedido · ${money(quote.totalCents)}` : 'Fazer pedido'} onPress={send} busy={busy}
        disabled={!quote || !quote.minOrderOk || !dest || !rest.open} />
    </>
  );
}

function OrderView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [o, setO] = useState<FoodOrder | null>(null);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const load = useCallback(() => { api<{ order: FoodOrder }>(`/food/orders/${id}`).then((r) => setO(r.order)).catch(() => {}); }, [id]);
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);
  useRealtime<FoodOrder>('food:order', (x) => { if (x.id === id) setO(x); });

  async function cancel() {
    setMsg(null);
    try { await post(`/food/orders/${id}/cancel`); setMsg({ tone: 'ok', text: 'Pedido cancelado.' }); load(); onChanged(); }
    catch (e) { setMsg({ tone: 'error', text: errMsg(e) }); }
  }

  if (!o) return <Muted>Carregando o pedido…</Muted>;
  const stepIdx = STEPS.findIndex(([s]) => s === o.status);
  const d = o.delivery;
  const ended = ['entregue', 'recusado', 'cancelado'].includes(o.status);
  return (
    <>
      <Title>{`Pedido ${o.number}`}</Title>
      <Muted>{o.restaurant.name}</Muted>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <Card>
        <Text style={{ fontSize: 18, fontWeight: '800', color: o.status === 'entregue' ? colors.verde : ['recusado', 'cancelado'].includes(o.status) ? colors.vermelho : colors.texto }}>{statusText(o)}</Text>
        {o.refuseReason && ['recusado', 'cancelado'].includes(o.status) && <Muted>{`Motivo: ${o.refuseReason}.${o.payStatus === 'estornado' ? ' O Pix foi devolvido.' : ''}`}</Muted>}
        {!ended && o.status !== 'aguardando_pagamento' && (
          <View style={{ gap: 6 }}>
            {STEPS.map(([s, label], i) => (
              <View key={s} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: i <= stepIdx ? colors.verde : colors.linha }} />
                <Text style={{ color: i <= stepIdx ? colors.texto : colors.texto2, fontWeight: i === stepIdx ? '800' : '500' }}>{label}</Text>
              </View>
            ))}
          </View>
        )}
      </Card>

      {o.status === 'aguardando_pagamento' && o.pix && (
        <Card>
          <Text style={{ fontWeight: '800', color: colors.texto }}>{`Pague ${money(o.totalCents)} com Pix`}</Text>
          <Muted>{`O Pix vai direto para o ${o.restaurant.name}. Vale por 30 minutos.`}</Muted>
          {!!o.pix.qrCodeBase64 && <Image accessibilityLabel="QR Code do Pix" source={{ uri: `data:image/png;base64,${o.pix.qrCodeBase64}` }} style={{ width: 200, height: 200, alignSelf: 'center' }} />}
          <Button label={copied ? 'Código copiado ✓' : 'Copiar Pix copia e cola'} onPress={async () => { await Clipboard.setStringAsync(o.pix!.qrCode); setCopied(true); }} />
          <Muted>Pagou? A confirmação chega sozinha em alguns segundos.</Muted>
        </Card>
      )}

      {d && d.courier && ['pronto', 'em_entrega'].includes(o.status) && (
        <Card>
          {d.courier.location && (
            <RideMap height={200} points={[
              { id: 'entregador', lat: d.courier.location.lat, lng: d.courier.location.lng, label: firstName(d.courier.name), color: colors.noite },
              { id: 'destino', lat: o.destination.lat, lng: o.destination.lng, label: 'Você', color: colors.verde },
            ]} />
          )}
          <Row label="Entregador" value={`${firstName(d.courier.name)} · ${d.courier.vehicle.model} ${d.courier.vehicle.color} · ${plate(d.courier.vehicle.plate)}`} />
          <View style={{ backgroundColor: colors.noite, borderRadius: 14, padding: 14, alignItems: 'center', gap: 4 }}>
            <Text style={{ color: colors.areia, fontWeight: '700' }}>Código de entrega</Text>
            <Text style={{ color: '#F2622E', fontSize: 34, fontWeight: '800', letterSpacing: 6 }}>{d.deliveryCode}</Text>
            <Text style={{ color: colors.areia, textAlign: 'center' }}>Diga este código ao receber. Sem ele o pedido não é entregue.</Text>
          </View>
          {o.payment === 'entrega' && <Muted>{`Na entrega, pague ${money(o.totalCents)} com o Pix ou a maquininha do restaurante.`}</Muted>}
        </Card>
      )}

      <Card>
        {o.items.map((i, k) => (
          <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <Text style={{ color: colors.texto, flex: 1 }}>{`${i.qty}× ${i.name}${i.notes ? ` (${i.notes})` : ''}`}</Text>
            <Text style={{ color: colors.texto }}>{money(i.qty * i.priceCents)}</Text>
          </View>
        ))}
        <Row label="Entrega" value={o.deliveryFeeCents ? money(o.deliveryFeeCents) : 'Grátis'} />
        <Row label="Total" value={money(o.totalCents)} />
        <Row label="Pagamento" value={o.payment === 'app' ? (o.payStatus === 'pago' ? 'Pix pago pelo app' : o.payStatus === 'estornado' ? 'Pix devolvido' : 'Pix pelo app') : 'Na entrega'} />
        <Muted>{`Entregar em ${o.destination.address}`}</Muted>
      </Card>
      {['aguardando_pagamento', 'novo'].includes(o.status) && <Button kind="secondary" label="Cancelar pedido" onPress={cancel} />}
    </>
  );
}
