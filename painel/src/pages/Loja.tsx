import { useEffect, useState } from 'react';
import RideChat from '../RideChat';
import { API_URL, api, apiImage } from '../api';
import { useRealtime } from '../realtime';
import { date, dateTime, money, rideStatus } from '../format';
import { Erro, Status, errMsg, rideTone, useLoad } from '../ui';
import PlacePicker, { type PickedPlace } from '../PlacePicker';
import DriverPhoto from '../DriverPhoto';

/*
 * Daqui Entrega para lojas — painel da loja.
 * Pede entregas (uma ou várias), acompanha, confere o Pix do produto e cuida dos créditos.
 */

const toCents = (v: string) => Math.round(Number(v.replace(/\./g, '').replace(',', '.')) * 100);
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : undefined);
const shareUrl = (token: string) => `${window.location.origin}/acompanhar/${token}`;

const COD: Record<string, { tone: 'ok' | 'alerta' | 'ruim' | 'neutra'; text: string }> = {
  pendente: { tone: 'alerta', text: 'A cobrar na entrega' },
  pago: { tone: 'ok', text: 'Pix recebido (Mercado Pago)' },
  aguardando_loja: { tone: 'alerta', text: 'Motoboy informou: confira' },
  confirmado: { tone: 'ok', text: 'Recebido' },
  contestado: { tone: 'ruim', text: 'Não recebido: central avisada' },
};

function useStore() {
  return useLoad(() => api('/account/store'));
}

function Balance({ s }: { s: any }) {
  const prepago = s.billingMode === 'prepago';
  return (
    <section className="cartao grade-kpi">
      <div className="kpi">
        <span className="rotulo">{prepago ? 'Saldo de créditos' : 'Em aberto (fatura semanal)'}</span>
        <span className="valor" style={{ color: prepago && s.balanceCents < 2000 ? 'var(--vermelho)' : undefined }}>
          {money(prepago ? s.balanceCents : Math.max(0, -s.balanceCents))}
        </span>
        <span className="nota">{prepago ? 'Cada entrega desconta o frete na hora' : `Limite de ${money(s.creditLimitCents)}`}</span>
      </div>
      <div className="kpi">
        <span className="rotulo">Desconto no frete</span>
        <span className="valor">{s.discountPct ? `${String(s.discountPct).replace('.', ',')}%` : '—'}</span>
      </div>
      <div className="kpi">
        <span className="rotulo">Cobrar o produto na entrega</span>
        <span className="valor" style={{ fontSize: 20 }}>
          {s.mercadopago.connected ? 'Pix automático' : s.pix.validated ? 'Pix pela chave' : 'Não configurado'}
        </span>
        <span className="nota">{s.mercadopago.connected ? 'Mercado Pago da loja confirma sozinho' : s.pix.key && !s.pix.validated ? 'Chave aguardando a central conferir' : 'Veja em Configurações'}</span>
      </div>
    </section>
  );
}

// ===================== entregas =====================

export function Deliveries() {
  const store = useStore();
  const [view, setView] = useState<'ativas' | 'agendadas' | 'dia'>('ativas');
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const list = useLoad(() => api(`/account/deliveries?view=${view}${view === 'dia' ? `&day=${day}` : ''}`), [view, day]);
  const [form, setForm] = useState<'uma' | 'varias' | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useRealtime('ride:updated', () => list.reload());
  useRealtime('ride:cod', () => list.reload());
  useRealtime('account:balance', () => store.reload());

  async function act(path: string, body: object, ok: string) {
    setMsg(null);
    try { await api(path, { method: 'POST', body }); setMsg({ ok: true, text: ok }); list.reload(); store.reload(); }
    catch (e) { setMsg({ ok: false, text: errMsg(e) }); }
  }

  const items = list.data?.deliveries ?? [];
  const s = store.data?.store;
  return (
    <>
      <div className="topo">
        <div>
          <h1>Entregas</h1>
          <p>Peça a entrega, acompanhe o motoboy e confira o pagamento do produto. Quem recebe ganha um código e um link.</p>
        </div>
        <span className="acoes">
          <button className="secundario" onClick={() => setForm(form === 'varias' ? null : 'varias')}>Várias de uma vez</button>
          <button className="destaque" onClick={() => setForm(form === 'uma' ? null : 'uma')}>{form === 'uma' ? 'Fechar' : 'Nova entrega'}</button>
        </span>
      </div>
      <Erro msg={store.error} />
      {s && <Balance s={s} />}
      {form === 'uma' && s && <NewDelivery store={s} onDone={(t) => { setForm(null); setMsg({ ok: true, text: t }); list.reload(); store.reload(); }} />}
      {form === 'varias' && s && <BatchDeliveries store={s} onDone={(t) => { setForm(null); setMsg({ ok: true, text: t }); list.reload(); store.reload(); }} />}
      {msg && <div className={`aviso ${msg.ok ? 'ok' : 'erro'}`} role="status">{msg.text}</div>}

      <div className="filtros" role="group" aria-label="Filtrar entregas">
        {([['ativas', 'Em andamento e a conferir'], ['agendadas', 'Agendadas'], ['dia', 'Por dia']] as const).map(([k, l]) => (
          <button key={k} className={view === k ? 'ativo' : ''} onClick={() => setView(k)}>{l}</button>
        ))}
        {view === 'dia' && <input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Dia" style={{ maxWidth: 180 }} />}
      </div>
      <Erro msg={list.error} />
      <section className="cartao">
        {list.data && items.length === 0 && <p className="vazio">Nenhuma entrega aqui.</p>}
        {items.length > 0 && (
          <div className="tabela">
            <table>
              <thead><tr><th>Pedido</th><th>Para</th><th>Situação</th><th>Motoboy</th><th className="num">Frete</th><th>Produto</th><th></th></tr></thead>
              <tbody>
                {items.map((d: any) => (
                  <tr key={d.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{dateTime(d.scheduledFor ?? d.requestedAt)}<br />
                      <span style={{ color: 'var(--texto-2)', fontSize: 13 }}>código {d.deliveryCode}</span></td>
                    <td><strong>{d.delivery?.recipientName}</strong><br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{d.destination.address}</span></td>
                    <td><Status tone={rideTone(d.status)}>{d.status === 'in_progress' ? 'A caminho do cliente' : d.status === 'completed' ? 'Entregue' : rideStatus[d.status]}</Status></td>
                    <td>{d.driver ? <>{d.driver.name}<br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{d.driver.vehicle.model} · {d.driver.vehicle.plate}</span>
                      {d.driver.hasPhoto && ['accepted', 'arrived', 'in_progress'].includes(d.status) && <><br /><DriverPhoto tripId={d.id} name={d.driver.name} plate={d.driver.vehicle.plate} /></>}</> : '—'}</td>
                    <td className="num">{money(d.priceCents)}</td>
                    <td>
                      {d.cod ? <>
                        {money(d.cod.amountCents)}<br />
                        <Status tone={COD[d.cod.status]?.tone ?? 'neutra'}>{COD[d.cod.status]?.text ?? d.cod.status}</Status>
                        {d.cod.method === 'maquininha' && <span style={{ color: 'var(--texto-2)', fontSize: 13 }}> · maquininha</span>}
                        {d.cod.status === 'aguardando_loja' && d.cod.confirmBy && (
                          <><br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>Confira até {dateTime(d.cod.confirmBy)}. Sem resposta, conta como recebido.</span></>
                        )}
                        {d.cod.status === 'confirmado' && d.cod.settledBy === 'automatico' && (
                          <><br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>Confirmado pelo prazo de 24 h</span></>
                        )}
                      </> : <span style={{ color: 'var(--texto-2)' }}>já pago</span>}
                    </td>
                    <td>
                      <span className="acoes">
                        {d.cod?.status === 'aguardando_loja' && <>
                          <button className="secundario" onClick={() => act(`/account/deliveries/${d.id}/cod-confirm`, { received: true }, 'Pagamento conferido.')}>Recebi</button>
                          <button className="perigo" onClick={() => window.confirm('Avisar a central que o dinheiro não caiu?') && act(`/account/deliveries/${d.id}/cod-confirm`, { received: false }, 'A central foi avisada.')}>Não recebi</button>
                        </>}
                        {d.shareToken && <button className="secundario" onClick={async () => {
                          await navigator.clipboard.writeText(`${shareUrl(d.shareToken)} — código de entrega ${d.deliveryCode}`).catch(() => {});
                          setMsg({ ok: true, text: 'Link e código copiados. Envie para o cliente.' });
                        }}>Copiar link</button>}
                        {d.driver && <RideChat rideId={d.id} label="Falar com o motoboy" />}
                        {['scheduled', 'requested', 'accepted', 'arrived'].includes(d.status) && (
                          <button className="perigo" onClick={() => window.confirm(`Cancelar a entrega para ${d.delivery?.recipientName}? O frete volta para a loja.`) && act(`/account/deliveries/${d.id}/cancel`, {}, 'Entrega cancelada. O frete voltou para a loja.')}>Cancelar</button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

interface Draft { dest: PickedPlace | null; name: string; phone: string; pkg: string; size: 'p' | 'g'; cod: string; notes: string }
const emptyDraft = (): Draft => ({ dest: null, name: '', phone: '', pkg: '', size: 'p', cod: '', notes: '' });
const draftBody = (d: Draft, scheduledFor?: string) => ({
  destination: d.dest, recipientName: d.name.trim(), recipientPhone: d.phone, packageDesc: d.pkg.trim(), size: d.size,
  codAmountCents: d.cod.trim() ? toCents(d.cod) : undefined, notes: d.notes.trim() || undefined, scheduledFor,
});
const draftOk = (d: Draft) => !!d.dest && d.name.trim().length >= 2 && d.phone.replace(/\D/g, '').length >= 10 && d.pkg.trim().length >= 2 && (!d.cod.trim() || toCents(d.cod) >= 100);

function DraftFields({ d, set }: { d: Draft; set: (d: Draft) => void }) {
  return (
    <>
      <div className="formulario">
        <label>Nome de quem recebe<input value={d.name} onChange={(e) => set({ ...d, name: e.target.value })} required /></label>
        <label>Celular de quem recebe<input value={d.phone} onChange={(e) => set({ ...d, phone: e.target.value })} inputMode="tel" required /></label>
        <label>O que vai<input value={d.pkg} onChange={(e) => set({ ...d, pkg: e.target.value })} placeholder="ex.: 2 caixas de remédio" required /></label>
        <label>Tamanho
          <select value={d.size} onChange={(e) => set({ ...d, size: e.target.value as 'p' | 'g' })}>
            <option value="p">Cabe na moto</option>
            <option value="g">Grande (carro)</option>
          </select>
        </label>
        <label>Cobrar do cliente na entrega (R$)<input value={d.cod} onChange={(e) => set({ ...d, cod: e.target.value })} inputMode="decimal" placeholder="vazio = já pago" /></label>
        <label>Observações para o motoboy<input value={d.notes} onChange={(e) => set({ ...d, notes: e.target.value })} maxLength={300} /></label>
      </div>
    </>
  );
}

function NewDelivery({ store, onDone }: { store: any; onDone: (msg: string) => void }) {
  const [d, setD] = useState<Draft>(emptyDraft());
  const [when, setWhen] = useState<'agora' | 'agendar'>('agora');
  const [at, setAt] = useState('');
  const [quote, setQuote] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!d.dest) { setQuote(null); return; }
    api('/account/deliveries/quote', { method: 'POST', body: { destination: d.dest, size: d.size } })
      .then(setQuote).catch((e) => { setQuote(null); setError(errMsg(e)); });
  }, [d.dest?.lat, d.dest?.lng, d.size]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api('/account/deliveries', { method: 'POST', body: draftBody(d, when === 'agendar' ? fromLocalInput(at) : undefined) });
      const dv = r.delivery;
      await navigator.clipboard.writeText(`${shareUrl(dv.shareToken)} — código de entrega ${dv.deliveryCode}`).catch(() => {});
      onDone(`Entrega pedida para ${dv.delivery.recipientName}. Código de entrega ${dv.deliveryCode} — link copiado para enviar ao cliente.`);
    } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  }

  if (!store.address) return <div className="aviso erro" role="alert">Cadastre o endereço de coleta da loja em Configurações antes de pedir entregas.</div>;
  return (
    <section className="cartao">
      <h2>Nova entrega</h2>
      <p style={{ color: 'var(--texto-2)', margin: '4px 0 12px' }}>Coleta em: {store.address.address}</p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <PlacePicker value={d.dest} onChange={(p) => setD({ ...d, dest: p })} label="Endereço de entrega" />
        <DraftFields d={d} set={setD} />
        <div className="formulario">
          <label>Quando
            <select value={when} onChange={(e) => setWhen(e.target.value as any)}><option value="agora">Agora</option><option value="agendar">Agendar</option></select>
          </label>
          {when === 'agendar' && <label>Data e hora<input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} required /></label>}
        </div>
        {quote && (
          <p style={{ margin: 0 }}>
            Frete <strong>{money(quote.priceCents)}</strong>{quote.discountPct ? <span style={{ color: 'var(--texto-2)' }}> (de {money(quote.fullPriceCents)}, com {quote.discountPct}% de desconto)</span> : null}
            {' '}· {quote.distanceKm} km · cerca de {quote.durationMin} min
          </p>
        )}
        {error && <div className="aviso erro" role="alert">{error}</div>}
        <div><button type="submit" className="destaque" disabled={busy || !draftOk(d)}>{busy ? 'Pedindo…' : 'Pedir entrega'}</button></div>
      </form>
    </section>
  );
}

function BatchDeliveries({ store, onDone }: { store: any; onDone: (msg: string) => void }) {
  const [rows, setRows] = useState<Draft[]>([emptyDraft()]);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ ok: boolean; text: string }[]>([]);
  const set = (i: number) => (d: Draft) => setRows(rows.map((r, k) => (k === i ? d : r)));

  async function sendAll() {
    setBusy(true);
    const out: { ok: boolean; text: string }[] = [];
    const left: Draft[] = [];
    for (const r of rows) {
      try {
        const res = await api('/account/deliveries', { method: 'POST', body: draftBody(r) });
        out.push({ ok: true, text: `${r.name}: pedida (código ${res.delivery.deliveryCode})` });
      } catch (e) {
        out.push({ ok: false, text: `${r.name}: ${errMsg(e)}` });
        left.push(r);
      }
    }
    setBusy(false);
    setResults(out);
    if (!left.length) onDone(`${out.length} entregas pedidas. Os códigos estão na lista.`);
    else setRows(left);
  }

  if (!store.address) return <div className="aviso erro" role="alert">Cadastre o endereço de coleta da loja em Configurações antes de pedir entregas.</div>;
  return (
    <section className="cartao">
      <h2>Várias entregas de uma vez</h2>
      <p style={{ color: 'var(--texto-2)', margin: '4px 0 12px' }}>Preencha uma por vez e clique em "Adicionar outra". No fim, peça todas juntas.</p>
      {rows.map((r, i) => (
        <div key={i} style={{ borderTop: i ? '1px solid var(--linha)' : undefined, paddingTop: i ? 16 : 0, marginTop: i ? 16 : 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h3>Entrega {i + 1}{rows.length > 1 && <button type="button" className="perigo" style={{ marginLeft: 12 }} onClick={() => setRows(rows.filter((_, k) => k !== i))}>Remover</button>}</h3>
          <PlacePicker value={r.dest} onChange={(p) => set(i)({ ...r, dest: p })} label="Endereço de entrega" />
          <DraftFields d={r} set={set(i)} />
        </div>
      ))}
      {results.length > 0 && <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        {results.map((x, i) => <div key={i} className={`aviso ${x.ok ? 'ok' : 'erro'}`}>{x.text}</div>)}
      </div>}
      <div className="acoes" style={{ marginTop: 16 }}>
        <button type="button" className="secundario" onClick={() => setRows([...rows, emptyDraft()])} disabled={rows.length >= 20}>Adicionar outra</button>
        <button type="button" className="destaque" onClick={sendAll} disabled={busy || !rows.every(draftOk)}>{busy ? 'Pedindo…' : `Pedir ${rows.length} entrega${rows.length > 1 ? 's' : ''}`}</button>
      </div>
    </section>
  );
}

// ===================== créditos e faturas =====================

const LEDGER: Record<string, string> = { recarga: 'Recarga', entrega: 'Entrega', estorno: 'Entrega cancelada', ajuste: 'Ajuste da central', pagamento_fatura: 'Fatura paga', cashback: 'Cashback para o cliente', comissao: 'Comissão do pedido (Daqui Food)', turno: 'Turno de entregador fixo' };

export function Credits() {
  const store = useStore();
  const ledger = useLoad(() => api('/account/store/ledger'));
  const [amount, setAmount] = useState('100,00');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useRealtime('account:balance', () => { store.reload(); ledger.reload(); });
  const s = store.data?.store;

  async function goPay(path: string, body: object, key: string) {
    setError(null);
    setBusy(key);
    try {
      const preference = await api<{ init_point: string }>(path, { method: 'POST', body });
      window.location.href = preference.init_point; // Mercado Pago (Pix ou cartão)
    } catch (e) { setError(errMsg(e)); setBusy(null); }
  }

  return (
    <>
      <div className="topo">
        <div>
          <h1>{s?.billingMode === 'fatura' ? 'Fatura e extrato' : 'Créditos e extrato'}</h1>
          <p>{s?.billingMode === 'fatura'
            ? 'As entregas da semana (segunda a domingo) viram uma fatura, que vence em 3 dias. Fatura vencida trava novos pedidos.'
            : 'Recarregue com Pix ou cartão. O frete de cada entrega sai do saldo e volta se a entrega for cancelada antes da coleta.'}</p>
        </div>
      </div>
      <Erro msg={store.error ?? ledger.error ?? error} />
      {s && <Balance s={s} />}
      {s?.billingMode === 'prepago' && (
        <section className="cartao">
          <h2>Recarregar créditos</h2>
          <div className="acoes" style={{ marginTop: 12, alignItems: 'flex-end' }}>
            {['50,00', '100,00', '200,00', '500,00'].map((v) => (
              <button key={v} className={amount === v ? '' : 'secundario'} onClick={() => setAmount(v)}>R$ {v}</button>
            ))}
            <label style={{ maxWidth: 160 }}>Outro valor (R$)<input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></label>
            <button className="destaque" disabled={busy !== null || toCents(amount) < 2000} onClick={() => goPay('/account/store/recharge', { amountCents: toCents(amount) }, 'recarga')}>
              {busy === 'recarga' ? 'Abrindo…' : 'Recarregar com Mercado Pago'}
            </button>
          </div>
          <p style={{ color: 'var(--texto-2)', fontSize: 14, marginTop: 10 }}>Mínimo de R$ 20,00. O saldo entra assim que o pagamento é aprovado.</p>
        </section>
      )}
      {s?.billingMode === 'fatura' && (
        <section className="cartao">
          <h2>Faturas</h2>
          {store.data.invoices.length === 0 && <p className="vazio">Nenhuma fatura fechada ainda.</p>}
          {store.data.invoices.length > 0 && (
            <div className="tabela"><table>
              <thead><tr><th>Semana</th><th className="num">Entregas</th><th className="num">Total</th><th>Vencimento</th><th>Situação</th><th></th></tr></thead>
              <tbody>{store.data.invoices.map((i: any) => (
                <tr key={i.id}>
                  <td>{date(i.period_start)} a {date(i.period_end)}</td><td className="num">{i.deliveries}</td><td className="num"><strong>{money(i.total_cents)}</strong></td>
                  <td>{date(i.due_date)}</td>
                  <td>{i.status === 'paid' ? <Status tone="ok">Paga</Status> : i.overdue ? <Status tone="ruim">Vencida</Status> : <Status tone="alerta">Em aberto</Status>}</td>
                  <td>{i.status === 'open' && <button className="destaque" disabled={busy !== null} onClick={() => goPay(`/account/store/invoices/${i.id}/checkout`, {}, i.id)}>Pagar com Mercado Pago</button>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      )}
      <section className="cartao">
        <h2>Extrato</h2>
        {ledger.data?.ledger.length === 0 && <p className="vazio">Sem movimentos.</p>}
        {ledger.data?.ledger.length > 0 && (
          <div className="tabela"><table>
            <thead><tr><th>Data</th><th>Movimento</th><th>Detalhe</th><th className="num">Valor</th><th className="num">Saldo</th></tr></thead>
            <tbody>{ledger.data.ledger.map((l: any) => (
              <tr key={l.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{dateTime(l.created_at)}</td>
                <td>{LEDGER[l.kind] ?? l.kind}</td>
                <td>{l.recipient_name ? `${l.recipient_name} · ${l.dest_address ?? ''}` : l.note ?? '—'}</td>
                <td className="num" style={{ color: l.amount_cents < 0 ? 'var(--vermelho)' : 'var(--verde)' }}>{l.amount_cents < 0 ? '− ' : '+ '}{money(Math.abs(l.amount_cents))}</td>
                <td className="num">{money(l.balance_after)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}

// ===================== configurações =====================

export function StoreSettings() {
  const store = useStore();
  const s = store.data?.store;
  const [addr, setAddr] = useState<PickedPlace | null>(null);
  const [pix, setPix] = useState({ key: '', holder: '' });
  const [mp, setMp] = useState({ token: '', secret: '' });
  const [logo, setLogo] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!s) return;
    setAddr(s.address ? { lat: s.address.lat, lng: s.address.lng, address: s.address.address } : null);
    setPix({ key: s.pix.key ?? '', holder: s.pix.holderName ?? '' });
    if (s.hasLogo) apiImage('/account/store/logo').then(setLogo).catch(() => {});
  }, [s]);

  async function save(path: string, body: object, ok: string, method = 'PUT') {
    setMsg(null);
    try { await api(path, { method, body }); setMsg({ ok: true, text: ok }); store.reload(); }
    catch (e) { setMsg({ ok: false, text: errMsg(e) }); }
  }

  function pickLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 1.5 * 1024 * 1024) { setMsg({ ok: false, text: 'Logo muito grande: use uma imagem de até 1,5 MB.' }); return; }
    const reader = new FileReader();
    reader.onload = () => save('/account/store/logo', { image: String(reader.result) }, 'Logo atualizada.');
    reader.readAsDataURL(f);
  }

  if (!s) return <Erro msg={store.error} />;
  return (
    <>
      <div className="topo">
        <div>
          <h1>Configurações da loja</h1>
          <p>Endereço de coleta, Pix para receber dos clientes e a marca que aparece para quem recebe.</p>
        </div>
      </div>
      {msg && <div className={`aviso ${msg.ok ? 'ok' : 'erro'}`} role="status">{msg.text}</div>}

      <section className="cartao">
        <h2>Endereço de coleta</h2>
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <PlacePicker value={addr} onChange={setAddr} label="Onde o motoboy busca os pacotes" />
          <div><button className="destaque" disabled={!addr} onClick={() => save('/account/store/settings', { address: addr }, 'Endereço salvo.')}>Salvar endereço</button></div>
        </div>
      </section>

      <StoreCashback onMsg={setMsg} />

      <section className="cartao">
        <h2>Receber o produto na entrega</h2>
        <p style={{ color: 'var(--texto-2)', margin: '4px 0 12px' }}>O cliente paga direto para a loja. O motoboy nunca carrega o dinheiro.</p>
        <h3>Opção 1 — Mercado Pago da loja (recomendado)</h3>
        <p style={{ color: 'var(--texto-2)', margin: '4px 0 10px' }}>
          O motoboy mostra um QR com o valor exato, gerado na conta da loja. A confirmação é automática.
          {s.mercadopago.connected && <> Conectado: <strong>{s.mercadopago.account}</strong>.</>}
        </p>
        <div className="formulario">
          <label>Access Token de produção<input value={mp.token} onChange={(e) => setMp({ ...mp, token: e.target.value })} placeholder="APP_USR-…" autoComplete="off" spellCheck={false} /></label>
          <label>Assinatura secreta dos webhooks (opcional)<input value={mp.secret} onChange={(e) => setMp({ ...mp, secret: e.target.value })} autoComplete="off" spellCheck={false} /></label>
          <button className="destaque" disabled={mp.token.trim().length < 20} onClick={() => save('/account/store/mercadopago', { accessToken: mp.token.trim(), webhookSecret: mp.secret.trim() || undefined }, 'Mercado Pago da loja conectado.').then(() => setMp({ token: '', secret: '' }))}>
            {s.mercadopago.connected ? 'Trocar conta' : 'Conectar'}
          </button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--texto-2)', marginTop: 8 }}>
          No Mercado Pago, em Webhooks, cadastre <code>{`${API_URL}/webhooks/mercadopago/loja/${s.id}`}</code> com o evento Pagamentos.
        </p>
        {s.mercadopago.connected && <button className="perigo" style={{ marginTop: 8 }} onClick={() => window.confirm('Desconectar o Mercado Pago da loja?') && save('/account/store/mercadopago', {}, 'Desconectado.', 'DELETE')}>Desconectar</button>}

        <h3 style={{ marginTop: 20 }}>Opção 2 — chave Pix da loja</h3>
        <p style={{ color: 'var(--texto-2)', margin: '4px 0 10px' }}>
          A central confere se a chave é da loja antes de mostrar ao cliente. Depois, você confere cada pagamento no painel.{' '}
          {s.pix.key && (s.pix.validated ? <Status tone="ok">Conferida pela central</Status> : <Status tone="alerta">Aguardando a central conferir</Status>)}
        </p>
        <div className="formulario">
          <label>Chave Pix<input value={pix.key} onChange={(e) => setPix({ ...pix, key: e.target.value })} /></label>
          <label>Nome que aparece no Pix<input value={pix.holder} onChange={(e) => setPix({ ...pix, holder: e.target.value })} /></label>
          <button className="secundario" disabled={pix.key.trim().length < 3 || pix.holder.trim().length < 3} onClick={() => save('/account/store/settings', { pixKey: pix.key.trim(), pixHolderName: pix.holder.trim() }, 'Chave salva. A central vai conferir.')}>Salvar chave</button>
        </div>
      </section>

      <section className="cartao">
        <h2>Logo da loja</h2>
        <p style={{ color: 'var(--texto-2)', margin: '4px 0 12px' }}>Aparece no link de acompanhamento que o cliente recebe.</p>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          {logo && <img src={logo} alt="Logo da loja" style={{ width: 96, height: 96, objectFit: 'contain', border: '1px solid var(--linha)', borderRadius: 12, background: '#fff' }} />}
          <label className="secundario" style={{ cursor: 'pointer' }}>Escolher imagem<input type="file" accept="image/png,image/jpeg" onChange={pickLogo} style={{ display: 'none' }} /></label>
        </div>
      </section>
    </>
  );
}

/** A loja escolhe quanto dá de cashback ao cliente por pedido entregue (crédito para corridas no app da cidade) */
function StoreCashback({ onMsg }: { onMsg: (m: { ok: boolean; text: string } | null) => void }) {
  const cb = useLoad(() => api('/account/store/cashback'));
  const [value, setValue] = useState('');
  useEffect(() => {
    if (cb.data) setValue(cb.data.amountCents > 0 ? (cb.data.amountCents / 100).toFixed(2).replace('.', ',') : '');
  }, [cb.data]);
  const cents = value.trim() ? Math.round(Number(value.replace(/\./g, '').replace(',', '.')) * 100) : 0;
  async function save(amountCents: number) {
    onMsg(null);
    try {
      await api('/account/store/cashback', { method: 'PUT', body: { amountCents } });
      onMsg({ ok: true, text: amountCents > 0 ? `Pronto: cada pedido entregue dá ${money(amountCents)} de cashback ao cliente.` : 'Cashback desligado.' });
      cb.reload();
    } catch (e) { onMsg({ ok: false, text: errMsg(e) }); }
  }
  const d = cb.data;
  if (!d) return null;
  return (
    <section className="cartao">
      <h2>Cashback para os seus clientes {d.amountCents > 0 ? <Status tone="ok">Ligado</Status> : <Status tone="neutra">Desligado</Status>}</h2>
      <p style={{ color: 'var(--texto-2)', margin: '4px 0 12px' }}>
        A cada pedido entregue, o cliente ganha crédito para usar em corridas no app {d.appName}. Sai dos seus créditos (ou entra
        na fatura da semana). Quem ainda não tem o app recebe um SMS e o crédito fica guardado no celular dele por {d.days} dias.
        Traz o cliente de volta e custa menos que um desconto no produto.
      </p>
      <div className="formulario">
        <label>Valor por pedido (R$)
          <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="ex.: 2,00 (vazio = desligado)" />
        </label>
        <button className="destaque" disabled={cents !== 0 && (cents < 50 || cents > 5000 || Number.isNaN(cents))} onClick={() => save(cents)}>Salvar</button>
        {d.amountCents > 0 && <button className="secundario" onClick={() => save(0)}>Desligar</button>}
      </div>
      {d.month.orders > 0 && (
        <p style={{ fontSize: 14, color: 'var(--texto-2)', marginTop: 10 }}>
          Neste mês: {money(d.month.total)} em {d.month.orders} {d.month.orders === 1 ? 'pedido' : 'pedidos'}
          {d.month.waiting_signup > 0 ? `, ${d.month.waiting_signup} ainda esperando o cliente se cadastrar` : ''}.
        </p>
      )}
    </section>
  );
}
