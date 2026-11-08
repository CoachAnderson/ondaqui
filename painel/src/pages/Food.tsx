import { useEffect, useMemo, useState } from 'react';
import { api, apiImage } from '../api';
import { dateTime, money, phone as fmtPhone } from '../format';
import { useRealtime } from '../realtime';
import { Erro, Status, errMsg, useLoad } from '../ui';

/**
 * Daqui Food no painel.
 *  • Restaurante (operador da loja): Pedidos, Cardápio, Entregador fixo e Restaurante (horários, pagamento).
 *  • Central (licenciado): regras, restaurantes, pedidos do dia e turnos de entregador fixo.
 */

const ORDER: Record<string, [string, 'ok' | 'alerta' | 'ruim' | 'neutra']> = {
  aguardando_pagamento: ['Aguardando Pix', 'neutra'], novo: ['Novo', 'alerta'], aceito: ['Em preparo', 'alerta'], pronto: ['Pronto', 'alerta'],
  em_entrega: ['Saiu para entrega', 'ok'], entregue: ['Entregue', 'ok'], recusado: ['Recusado', 'ruim'], cancelado: ['Cancelado', 'ruim'],
};
const RIDE: Record<string, string> = {
  requested: 'Chamando entregador', accepted: 'Entregador a caminho', arrived: 'Entregador chegou', in_progress: 'A caminho do cliente',
  completed: 'Entregue', cancelled: 'Sem entregador',
};
const SHIFT: Record<string, [string, 'ok' | 'alerta' | 'ruim' | 'neutra']> = {
  solicitado: ['Aguardando a central', 'alerta'], confirmado: ['Confirmado', 'ok'], concluido: ['Concluído', 'neutra'], cancelado: ['Cancelado', 'ruim'],
};
const WEEK = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const toCents = (v: string) => Math.round(Number(v.replace(/\./g, '').replace(',', '.')) * 100);
const reais = (c: number) => (c / 100).toFixed(2).replace('.', ',');
const payLabel = (o: any) => (o.payment === 'app'
  ? (o.payStatus === 'estornado' ? 'Pix pelo app (devolvido)' : 'Pago pelo app (Pix)')
  : 'Cobrar na entrega');
const hm = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

/** Toque curto quando chega pedido novo (o navegador só toca depois do primeiro clique na página) */
function beep() {
  try {
    const ctx = new AudioContext();
    [0, 0.25].forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.18, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.2);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.21);
    });
  } catch { /* sem áudio */ }
}

function useMsg() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const view = msg ? <div className={`aviso ${msg.ok ? 'ok' : 'erro'}`} role="status">{msg.text}</div> : null;
  return { setMsg, view };
}

// ============================ restaurante ============================

export function useFood() {
  return useLoad(() => api('/account/food'));
}

export function FoodOrders() {
  const food = useFood();
  const [view, setView] = useState<'ativos' | 'dia'>('ativos');
  const [day, setDay] = useState(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }));
  const list = useLoad(() => api(`/account/food/orders?view=${view}${view === 'dia' ? `&day=${day}` : ''}`), [view, day]);
  const [prep, setPrep] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const m = useMsg();
  useRealtime('food:order', () => list.reload());
  useRealtime('food:new', (d: any) => { beep(); m.setMsg({ ok: true, text: `Pedido novo: ${d.number}` }); list.reload(); food.reload(); });
  useRealtime('food:cancelled', (d: any) => { m.setMsg({ ok: false, text: `O cliente cancelou o pedido ${d.number}.` }); list.reload(); });
  useRealtime('food:no-courier', (d: any) => { m.setMsg({ ok: false, text: `Nenhum entregador aceitou o pedido ${d.number}. Chame de novo.` }); list.reload(); });

  async function act(id: string, path: string, body: object, ok: string) {
    setBusy(id + path);
    m.setMsg(null);
    try { await api(`/account/food/orders/${id}/${path}`, { method: 'POST', body }); m.setMsg({ ok: true, text: ok }); list.reload(); food.reload(); }
    catch (e) { m.setMsg({ ok: false, text: errMsg(e) }); }
    finally { setBusy(null); }
  }

  const r = food.data?.restaurant;
  const orders = list.data?.orders ?? [];
  const novos = orders.filter((o: any) => o.status === 'novo').length;
  return (
    <>
      <div className="topo">
        <div>
          <h1>Pedidos {novos > 0 && <Status tone="alerta">{novos} {novos === 1 ? 'novo' : 'novos'}</Status>}</h1>
          <p>Aceite, marque como pronto e o entregador da central vem buscar. O cliente acompanha tudo pelo app.</p>
        </div>
        {r && (
          <span className="acoes" style={{ alignItems: 'center' }}>
            {r.open ? <Status tone="ok">Aberto agora</Status> : <Status tone="neutra">{r.paused ? 'Pausado' : 'Fora do horário'}</Status>}
            <button className={r.paused ? 'destaque' : 'secundario'} onClick={async () => {
              try { await api('/account/food/settings', { method: 'PUT', body: { open: r.paused } }); food.reload(); } catch (e) { m.setMsg({ ok: false, text: errMsg(e) }); }
            }}>{r.paused ? 'Voltar a receber pedidos' : 'Pausar pedidos'}</button>
          </span>
        )}
      </div>
      <Erro msg={food.error} />
      {food.data?.today && (
        <section className="grade-kpi">
          <div className="cartao kpi"><span className="rotulo">Em andamento</span><span className="valor">{food.data.today.open}</span></div>
          <div className="cartao kpi"><span className="rotulo">Entregues hoje</span><span className="valor">{food.data.today.delivered}</span></div>
          <div className="cartao kpi"><span className="rotulo">Vendas hoje</span><span className="valor">{money(food.data.today.salesCents)}</span><span className="nota">só a comida</span></div>
          <div className="cartao kpi"><span className="rotulo">Comissão da central</span><span className="valor">{String(food.data.rules.commissionPct).replace('.', ',')}%</span><span className="nota">por pedido entregue</span></div>
        </section>
      )}
      {m.view}
      <div className="filtros" role="group" aria-label="Filtrar pedidos">
        {([['ativos', 'Em andamento'], ['dia', 'Por dia']] as const).map(([k, l]) => (
          <button key={k} className={view === k ? 'ativo' : ''} onClick={() => setView(k)}>{l}</button>
        ))}
        {view === 'dia' && <input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Dia" style={{ maxWidth: 180 }} />}
      </div>
      <Erro msg={list.error} />
      {list.data && orders.length === 0 && <section className="cartao"><p className="vazio">{view === 'ativos' ? 'Nenhum pedido em andamento.' : 'Nenhum pedido neste dia.'}</p></section>}
      <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
        {orders.map((o: any) => {
          const d = o.delivery;
          const noCourier = ['aceito', 'pronto'].includes(o.status) && (!d || d.status === 'cancelled');
          return (
            <section key={o.id} className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 10, borderColor: o.status === 'novo' ? 'var(--laranja)' : undefined }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                <h2 style={{ margin: 0 }}>Pedido {o.number}</h2>
                <Status tone={ORDER[o.status][1]}>{ORDER[o.status][0]}</Status>
              </div>
              <div style={{ color: 'var(--texto-2)', fontSize: 14 }}>
                {hm(o.createdAt)} · {o.customer.name}{o.customer.phone ? ` · ${fmtPhone(o.customer.phone)}` : ''}<br />{o.destination.address}
              </div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {o.items.map((i: any, k: number) => (
                  <li key={k}><strong>{i.qty}× {i.name}</strong>{i.notes ? <span style={{ color: 'var(--laranja-escuro)' }}> · {i.notes}</span> : null}</li>
                ))}
              </ul>
              {o.notes && <div style={{ margin: 0, background: '#FFF1E8', borderRadius: 10, padding: '8px 10px', fontSize: 14 }}>Observação: {o.notes}</div>}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                <span>{payLabel(o)}</span>
                <strong>{money(o.totalCents)}</strong>
              </div>
              {o.refuseReason && ['recusado', 'cancelado'].includes(o.status) && <div style={{ fontSize: 14, color: 'var(--texto-2)' }}>Motivo: {o.refuseReason}</div>}
              {o.readyBy && o.status === 'aceito' && <div style={{ fontSize: 14 }}>Pronto até cerca de <strong>{hm(o.readyBy)}</strong></div>}
              {d && d.status !== 'cancelled' && (
                <div style={{ fontSize: 14, background: 'var(--areia-2, #F3ECE2)', borderRadius: 10, padding: 10 }}>
                  <strong>{RIDE[d.status] ?? d.status}</strong>{d.shift ? ' · entregador fixo' : ''}
                  {d.courier && <><br />{d.courier.name} · {d.courier.vehicle.model} {d.courier.vehicle.plate}</>}
                  {['requested', 'accepted', 'arrived'].includes(d.status) && <><br />Código de coleta para o entregador: <strong style={{ fontSize: 18, letterSpacing: 2 }}>{d.boardingCode}</strong></>}
                  {d.cod && d.cod.status === 'aguardando_loja' && <><br /><span style={{ color: 'var(--laranja-escuro)' }}>O entregador marcou que recebeu. Confira em Entregas.</span></>}
                </div>
              )}
              {noCourier && d?.status === 'cancelled' && <div className="aviso erro" style={{ margin: 0 }}>Nenhum entregador aceitou. Chame de novo.</div>}
              <div className="acoes" style={{ flexWrap: 'wrap' }}>
                {o.status === 'novo' && (
                  <>
                    <select style={{ width: 'auto' }} value={prep[o.id] ?? String(r?.prepMin ?? 30)} onChange={(e) => setPrep({ ...prep, [o.id]: e.target.value })} aria-label="Tempo de preparo">
                      {[10, 15, 20, 25, 30, 40, 50, 60, 90].map((n) => <option key={n} value={n}>{n} min</option>)}
                    </select>
                    <button className="destaque" disabled={busy === o.id + 'accept'} onClick={() => act(o.id, 'accept', { prepMin: Number(prep[o.id] ?? r?.prepMin ?? 30) }, `Pedido ${o.number} aceito. O cliente foi avisado.`)}>Aceitar</button>
                    <button className="secundario" onClick={() => { const reason = window.prompt('Por que não dá para aceitar? (o cliente recebe)'); if (reason && reason.trim().length >= 3) act(o.id, 'refuse', { reason }, `Pedido ${o.number} recusado.${o.payment === 'app' ? ' O Pix foi devolvido.' : ''}`); }}>Recusar</button>
                  </>
                )}
                {o.status === 'aceito' && (
                  <button className="destaque" disabled={busy === o.id + 'ready'} onClick={() => act(o.id, 'ready', {}, d && d.status !== 'cancelled' ? 'Pedido pronto.' : 'Pedido pronto. Chamamos o entregador.')}>Pronto</button>
                )}
                {(o.status === 'aceito' && (!d || d.status === 'cancelled')) || (o.status === 'pronto' && noCourier) ? (
                  <button className="secundario" disabled={busy === o.id + 'call-courier'} onClick={() => act(o.id, 'call-courier', {}, 'Chamando o entregador.')}>{d ? 'Chamar de novo' : 'Chamar entregador agora'}</button>
                ) : null}
                {['aceito', 'pronto'].includes(o.status) && (
                  <button className="secundario" onClick={() => { const reason = window.prompt('Motivo do cancelamento (o cliente recebe):'); if (reason && reason.trim().length >= 3) act(o.id, 'cancel', { reason }, `Pedido ${o.number} cancelado.`); }}>Cancelar</button>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

export function FoodMenu() {
  const menu = useLoad(() => api('/account/food/menu'));
  const m = useMsg();
  const [cat, setCat] = useState('');
  const [item, setItem] = useState({ name: '', description: '', price: '', categoryId: '' });
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const sections = menu.data?.menu ?? [];
  const cats = sections.filter((s: any) => s.id);

  useEffect(() => {
    for (const s of sections) for (const i of s.items) {
      if (i.hasPhoto && !photos[i.id]) apiImage(`/food/items/${i.id}/photo`).then((u) => setPhotos((p) => ({ ...p, [i.id]: u }))).catch(() => {});
    }
  }, [menu.data]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(fn: () => Promise<unknown>, ok: string) {
    m.setMsg(null);
    try { await fn(); m.setMsg({ ok: true, text: ok }); menu.reload(); } catch (e) { m.setMsg({ ok: false, text: errMsg(e) }); }
  }

  function pickPhoto(id: string, e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 3 * 1024 * 1024) { m.setMsg({ ok: false, text: 'Foto muito grande: use uma imagem de até 3 MB.' }); return; }
    const reader = new FileReader();
    reader.onload = () => run(async () => {
      await api(`/account/food/items/${id}/photo`, { method: 'PUT', body: { image: String(reader.result) } });
      setPhotos((p) => { const n = { ...p }; delete n[id]; return n; });
    }, 'Foto atualizada.');
    reader.readAsDataURL(f);
  }

  return (
    <>
      <div className="topo">
        <div>
          <h1>Cardápio</h1>
          <p>O que aparece no app para o cliente. Toque na foto de um item para colocar ou trocar a foto (no celular, dá para tirar na hora). Marque "Acabou" quando um prato terminar: ele some do app até você marcar "Voltou".</p>
        </div>
      </div>
      <Erro msg={menu.error} />
      {m.view}
      {sections.map((s: any) => (
        <section key={s.id ?? 'outros'} className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="acoes" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>{s.name}</h2>
            {s.id && (
              <span className="acoes">
                <button className="secundario" onClick={() => { const name = window.prompt('Novo nome da categoria:', s.name); if (name && name.trim().length >= 2) run(() => api(`/account/food/categories/${s.id}`, { method: 'PUT', body: { name: name.trim() } }), 'Categoria renomeada.'); }}>Renomear</button>
                {s.items.length === 0 && <button className="secundario" onClick={() => run(() => api(`/account/food/categories/${s.id}`, { method: 'DELETE' }), 'Categoria apagada.')}>Apagar</button>}
              </span>
            )}
          </div>
          {s.items.length === 0 ? <p className="vazio">Nenhum item nesta categoria.</p> : (
            <div className="tabela">
              <table>
                <thead><tr><th>Foto</th><th>Item</th><th className="num">Preço</th><th>No app</th><th></th></tr></thead>
                <tbody>
                  {s.items.map((i: any) => (
                    <tr key={i.id} style={{ opacity: i.available ? 1 : 0.55 }}>
                      <td style={{ width: 76 }}>
                        <label style={{ cursor: 'pointer' }} title="Trocar a foto">
                          {photos[i.id]
                            ? <img src={photos[i.id]} alt={`Foto de ${i.name}`} style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 10 }} />
                            : <span style={{ display: 'inline-grid', placeItems: 'center', width: 64, height: 64, borderRadius: 10, background: 'var(--areia-2, #F3ECE2)', fontSize: 12, color: 'var(--texto-2)' }}>+ foto</span>}
                          <input type="file" accept="image/jpeg,image/png" style={{ display: 'none' }} onChange={(e) => pickPhoto(i.id, e)} />
                        </label>
                      </td>
                      <td><strong>{i.name}</strong>{i.description ? <><br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{i.description}</span></> : null}</td>
                      <td className="num">{money(i.priceCents)}</td>
                      <td>{i.available ? <Status tone="ok">Disponível</Status> : <Status tone="neutra">Acabou</Status>}</td>
                      <td>
                        <div className="acoes">
                          <button className="secundario" onClick={() => run(() => api(`/account/food/items/${i.id}`, { method: 'PUT', body: { available: !i.available } }), i.available ? `${i.name} saiu do app.` : `${i.name} voltou ao app.`)}>{i.available ? 'Acabou' : 'Voltou'}</button>
                          <button className="secundario" onClick={() => { const v = window.prompt(`Novo preço de ${i.name} (R$):`, reais(i.priceCents)); if (v && toCents(v) >= 50) run(() => api(`/account/food/items/${i.id}`, { method: 'PUT', body: { priceCents: toCents(v) } }), 'Preço atualizado.'); }}>Preço</button>
                          {cats.length > 1 && (
                            <select aria-label="Mover para" style={{ width: 'auto', maxWidth: 150 }} value={i.categoryId ?? ''} onChange={(e) => run(() => api(`/account/food/items/${i.id}`, { method: 'PUT', body: { categoryId: e.target.value || null } }), 'Item movido.')}>
                              {cats.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                          )}
                          <button className="secundario" onClick={() => window.confirm(`Apagar ${i.name} do cardápio?`) && run(() => api(`/account/food/items/${i.id}`, { method: 'DELETE' }), 'Item apagado.')}>Apagar</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}

      <section className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2>Novo item</h2>
        <div className="formulario">
          <label>Nome<input value={item.name} onChange={(e) => setItem({ ...item, name: e.target.value })} placeholder="Pizza portuguesa (média)" /></label>
          <label>Preço (R$)<input inputMode="decimal" value={item.price} onChange={(e) => setItem({ ...item, price: e.target.value })} placeholder="42,90" /></label>
          <label>Categoria
            <select value={item.categoryId} onChange={(e) => setItem({ ...item, categoryId: e.target.value })}>
              <option value="">Sem categoria</option>
              {cats.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label style={{ flexBasis: '100%' }}>Descrição (opcional)<input value={item.description} onChange={(e) => setItem({ ...item, description: e.target.value })} placeholder="Presunto, ovo, cebola e azeitona. 6 fatias." /></label>
          <button disabled={item.name.trim().length < 2 || toCents(item.price || '0') < 50} onClick={() => run(async () => {
            await api('/account/food/items', { method: 'POST', body: { name: item.name.trim(), description: item.description.trim() || undefined, priceCents: toCents(item.price), categoryId: item.categoryId || null } });
            setItem({ ...item, name: '', description: '', price: '' });
          }, 'Item adicionado ao cardápio.')}>Adicionar</button>
        </div>
        <div className="formulario">
          <label>Nova categoria<input value={cat} onChange={(e) => setCat(e.target.value)} placeholder="Sobremesas" /></label>
          <button className="secundario" disabled={cat.trim().length < 2} onClick={() => run(async () => {
            await api('/account/food/categories', { method: 'POST', body: { name: cat.trim(), sort: (cats.length + 1) * 10 } });
            setCat('');
          }, 'Categoria criada.')}>Criar categoria</button>
        </div>
      </section>
    </>
  );
}

export function FoodShifts() {
  const list = useLoad(() => api('/account/food/shifts'));
  const m = useMsg();
  const [f, setF] = useState({ date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }), time: '18:00', hours: '4' });
  useRealtime('food:shift', () => list.reload());
  const hourCents = list.data?.hourCents ?? 0;
  const price = hourCents * Number(f.hours || 0);

  async function run(fn: () => Promise<unknown>, ok: string) {
    m.setMsg(null);
    try { await fn(); m.setMsg({ ok: true, text: ok }); list.reload(); } catch (e) { m.setMsg({ ok: false, text: errMsg(e) }); }
  }

  return (
    <>
      <div className="topo">
        <div>
          <h1>Entregador fixo</h1>
          <p>
            Reserve um entregador só para o seu restaurante no horário de pico. No turno, todas as suas entregas vão primeiro para ele, sem frete
            por entrega. Se ele estiver ocupado, a entrega vai para o entregador mais próximo, com o frete normal.
          </p>
        </div>
      </div>
      {m.view}
      <section className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2>Pedir um turno</h2>
        <div className="formulario">
          <label>Dia<input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
          <label>Começa às<input type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></label>
          <label>Horas
            <select value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })}>
              {[2, 3, 4, 5, 6, 8, 10, 12].map((n) => <option key={n} value={n}>{n} h</option>)}
            </select>
          </label>
          <button disabled={!f.date || !f.time} onClick={() => run(
            () => api('/account/food/shifts', { method: 'POST', body: { startsAt: new Date(`${f.date}T${f.time}:00-03:00`).toISOString(), hours: Number(f.hours) } }),
            'Turno pedido. A central escolhe o entregador e você é avisado.',
          )}>Pedir turno de {money(price)}</button>
        </div>
        <p style={{ margin: 0, color: 'var(--texto-2)', fontSize: 14 }}>
          {money(hourCents)} por hora, debitado dos créditos (ou na fatura da semana) ao pedir. Cancelado ou sem entregador até o começo, o valor volta.
        </p>
      </section>
      <section className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2>Seus turnos</h2>
        <Erro msg={list.error} />
        {list.data && list.data.shifts.length === 0 && <p className="vazio">Nenhum turno ainda.</p>}
        {list.data?.shifts.length > 0 && (
          <div className="tabela">
            <table>
              <thead><tr><th>Quando</th><th>Entregador</th><th className="num">Entregas</th><th className="num">Valor</th><th>Situação</th><th></th></tr></thead>
              <tbody>
                {list.data.shifts.map((s: any) => (
                  <tr key={s.id}>
                    <td>{dateTime(s.startsAt)} – {hm(s.endsAt)}<br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{s.hours} h</span></td>
                    <td>{s.driver ? <>{s.driver.name}<br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{s.driver.vehicle}</span></> : '—'}</td>
                    <td className="num">{s.deliveries}</td>
                    <td className="num">{money(s.priceCents)}</td>
                    <td><Status tone={SHIFT[s.status][1]}>{SHIFT[s.status][0]}</Status></td>
                    <td>{['solicitado', 'confirmado'].includes(s.status) && new Date(s.startsAt).getTime() > Date.now() && (
                      <button className="secundario" onClick={() => window.confirm('Cancelar este turno? O valor volta para os créditos.') && run(() => api(`/account/food/shifts/${s.id}/cancel`, { method: 'POST', body: {} }), 'Turno cancelado. O valor voltou.')}>Cancelar</button>
                    )}</td>
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

function hoursToText(h: [string, string][][]) {
  return (h ?? []).map((day) => day.map(([a, b]) => `${a}-${b}`).join(', '));
}
function textToHours(t: string[]) {
  return t.map((line) => line.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = x.match(/^(\d{1,2}):?(\d{2})\s*[-–a]+\s*(\d{1,2}):?(\d{2})$/);
    if (!m) throw new Error(`Horário inválido: "${x}". Use 11:00-15:00`);
    const p = (h: string, mm: string) => `${h.padStart(2, '0')}:${mm}`;
    return [p(m[1], m[2]), p(m[3], m[4])] as [string, string];
  }));
}

export function FoodSettings() {
  const food = useFood();
  const m = useMsg();
  const r = food.data?.restaurant;
  const [f, setF] = useState({ category: '', description: '', prep: '30', min: '0,00', free: false, payApp: true, payDelivery: true });
  const [hours, setHours] = useState<string[]>(Array(7).fill(''));

  useEffect(() => {
    if (!r) return;
    setF({ category: r.category ?? '', description: r.description ?? '', prep: String(r.prepMin), min: reais(r.minOrderCents),
      free: r.freeDelivery, payApp: r.payAppSetting, payDelivery: r.pay.delivery });
    setHours(hoursToText(r.hours));
  }, [r]);

  async function save() {
    m.setMsg(null);
    try {
      await api('/account/food/settings', { method: 'PUT', body: {
        ...(f.category.trim().length >= 2 ? { category: f.category.trim() } : {}), description: f.description.trim(),
        prepMin: Number(f.prep), minOrderCents: toCents(f.min || '0'), freeDelivery: f.free, payApp: f.payApp, payDelivery: f.payDelivery,
        hours: textToHours(hours),
      } });
      m.setMsg({ ok: true, text: 'Restaurante atualizado.' });
      food.reload();
    } catch (e) { m.setMsg({ ok: false, text: e instanceof Error && !('status' in e) ? e.message : errMsg(e) }); }
  }

  return (
    <>
      <div className="topo">
        <div>
          <h1>Restaurante</h1>
          <p>Como o seu restaurante aparece no app do Daqui Food: horários, tempo de preparo, pedido mínimo e formas de pagamento.</p>
        </div>
      </div>
      <Erro msg={food.error} />
      {m.view}
      {r && (
        <section className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="formulario">
            <label>Tipo de comida<input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="Pizzaria, Lanches, Japonesa..." /></label>
            <label>Tempo de preparo (min)<input inputMode="numeric" value={f.prep} onChange={(e) => setF({ ...f, prep: e.target.value })} /></label>
            <label>Pedido mínimo (R$)<input inputMode="decimal" value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} /></label>
            <label style={{ flexBasis: '100%' }}>Descrição curta<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Massas e pizzas feitas na hora" /></label>
          </div>
          <fieldset style={{ border: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <legend style={{ fontWeight: 700, marginBottom: 6 }}>Entrega e pagamento</legend>
            <label className="check"><input type="checkbox" checked={f.free} onChange={(e) => setF({ ...f, free: e.target.checked })} />
              Entrega grátis para o cliente (o frete da central continua com o restaurante)</label>
            <label className="check"><input type="checkbox" checked={f.payApp} onChange={(e) => setF({ ...f, payApp: e.target.checked })} />
              Pix pelo app, direto na conta Mercado Pago do restaurante{!r.mercadopagoConnected ? ' (conecte o Mercado Pago em Configurações)' : ''}</label>
            <label className="check"><input type="checkbox" checked={f.payDelivery} onChange={(e) => setF({ ...f, payDelivery: e.target.checked })} />
              Pagar na entrega: Pix ou maquininha do restaurante (o entregador nunca carrega dinheiro)</label>
          </fieldset>
          <fieldset style={{ border: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <legend style={{ fontWeight: 700, marginBottom: 6 }}>Horários</legend>
            <p style={{ margin: 0, color: 'var(--texto-2)', fontSize: 14 }}>Uma ou mais faixas por dia, separadas por vírgula. Ex.: 11:00-15:00, 18:00-23:30. Fechado: deixe vazio. Depois da meia-noite: 18:00-02:00.</p>
            {WEEK.map((w, i) => (
              <label key={w} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 90 }}>{w}</span>
                <input value={hours[i] ?? ''} onChange={(e) => setHours(hours.map((h, k) => (k === i ? e.target.value : h)))} placeholder="fechado" style={{ maxWidth: 320 }} />
              </label>
            ))}
          </fieldset>
          <div><button onClick={save}>Salvar</button></div>
        </section>
      )}
    </>
  );
}

// ============================ central ============================

export default function FoodAdmin() {
  const f = useLoad(() => api('/admin/food'));
  const sh = useLoad(() => api('/admin/food/shifts?view=proximos'));
  const done = useLoad(() => api('/admin/food/shifts?view=concluidos'));
  const orders = useLoad(() => api('/admin/food/orders'));
  const m = useMsg();
  const [rules, setRules] = useState({ pct: '', hour: '', shiftPct: '' });
  const [pick, setPick] = useState<Record<string, string>>({});
  useRealtime('food:order', () => orders.reload());
  useRealtime('food:shift', () => sh.reload());

  useEffect(() => {
    const r = f.data?.rules;
    if (r) setRules({ pct: String(r.commissionPct).replace('.', ','), hour: reais(r.shiftHourCents), shiftPct: String(r.shiftCommissionPct).replace('.', ',') });
  }, [f.data]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    m.setMsg(null);
    try { await fn(); m.setMsg({ ok: true, text: ok }); f.reload(); sh.reload(); done.reload(); orders.reload(); } catch (e) { m.setMsg({ ok: false, text: errMsg(e) }); }
  }

  const r = f.data?.rules;
  const mo = f.data?.month;
  const body = (enabled?: boolean) => ({
    ...(enabled !== undefined ? { enabled } : {}),
    commissionPct: Number(rules.pct.replace(',', '.')) || 0, shiftHourCents: toCents(rules.hour || '0'), shiftCommissionPct: Number(rules.shiftPct.replace(',', '.')) || 0,
  });
  const couriers = sh.data?.couriers ?? [];
  const toPay = useMemo(() => (done.data?.shifts ?? []).filter((s: any) => !s.driverPaidAt), [done.data]);

  return (
    <>
      <div className="topo">
        <div>
          <h1>Daqui Food</h1>
          <p>
            Restaurantes com cardápio no app. O cliente paga direto ao restaurante (Pix pelo app ou na entrega); a central entrega e cobra do
            restaurante o frete e a comissão de cada pedido entregue, nos créditos ou na fatura da semana.
          </p>
        </div>
      </div>
      <Erro msg={f.error} />
      {mo && (
        <section className="grade-kpi">
          <div className="cartao kpi"><span className="rotulo">Pedidos entregues no mês</span><span className="valor">{mo.delivered}</span><span className="nota">{mo.cancelled} recusados ou cancelados</span></div>
          <div className="cartao kpi"><span className="rotulo">Vendas dos restaurantes</span><span className="valor">{money(mo.salesCents)}</span></div>
          <div className="cartao kpi"><span className="rotulo">Comissão da central</span><span className="valor">{money(mo.commissionCents)}</span><span className="nota">frete à parte: {money(mo.freightCents)}</span></div>
          <div className="cartao kpi"><span className="rotulo">Turnos de entregador fixo</span><span className="valor">{money(mo.shiftMarginCents)}</span><span className="nota">o que fica com a central em {mo.shifts} {mo.shifts === 1 ? 'turno' : 'turnos'}</span></div>
        </section>
      )}
      {m.view}

      {r && (
        <section className="cartao">
          <h2>Regras {r.enabled ? <Status tone="ok">Ligado</Status> : <Status tone="neutra">Desligado</Status>}</h2>
          <div className="formulario">
            <label>Comissão por pedido (% da comida)<input inputMode="decimal" value={rules.pct} onChange={(e) => setRules({ ...rules, pct: e.target.value })} /></label>
            <label>Entregador fixo: valor por hora (R$)<input inputMode="decimal" value={rules.hour} onChange={(e) => setRules({ ...rules, hour: e.target.value })} /></label>
            <label>Entregador fixo: fica com a central (%)<input inputMode="decimal" value={rules.shiftPct} onChange={(e) => setRules({ ...rules, shiftPct: e.target.value })} /></label>
            <button onClick={() => run(() => api('/admin/food', { method: 'PATCH', body: body() }), 'Regras salvas.')}>Salvar</button>
            {r.enabled
              ? <button className="secundario" onClick={() => window.confirm('Desligar o Daqui Food? Os clientes deixam de ver os restaurantes.') && run(() => api('/admin/food', { method: 'PATCH', body: { enabled: false } }), 'Desligado.')}>Desligar</button>
              : <button className="destaque" onClick={() => run(() => api('/admin/food', { method: 'PATCH', body: body(true) }), 'Daqui Food ligado. Os clientes já veem no app.')}>Salvar e ligar</button>}
          </div>
          <p style={{ color: 'var(--texto-2)', margin: '12px 0 0', fontSize: 14 }}>
            Exemplo: pedido de {money(6000)} em comida com {rules.pct || '0'}% de comissão: {money(Math.round(6000 * (Number(rules.pct.replace(',', '.')) || 0) / 100))} para a central, mais o frete da entrega.
            Turno de 4 h: o restaurante paga {money(toCents(rules.hour || '0') * 4)} e o entregador recebe {money(Math.round(toCents(rules.hour || '0') * 4 * (1 - (Number(rules.shiftPct.replace(',', '.')) || 0) / 100)))}.
          </p>
        </section>
      )}

      {f.data && (
        <section className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2>Restaurantes</h2>
          <p style={{ margin: 0, color: 'var(--texto-2)' }}>Todo restaurante é uma loja do Daqui Entrega (cadastre em Lojas). Aqui você liga o cardápio no app.</p>
          {f.data.restaurants.length === 0 ? <p className="vazio">Nenhuma loja cadastrada.</p> : (
            <div className="tabela">
              <table>
                <thead><tr><th>Loja</th><th>No app</th><th className="num">Itens</th><th className="num">Pedidos no mês</th><th className="num">Comissão no mês</th><th>Comissão própria</th><th></th></tr></thead>
                <tbody>
                  {f.data.restaurants.map((a: any) => (
                    <tr key={a.id} style={{ opacity: a.active ? 1 : 0.5 }}>
                      <td><strong>{a.name}</strong>{a.category ? <><br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{a.category}</span></> : null}</td>
                      <td>{!a.foodEnabled ? <Status tone="neutra">Desligado</Status> : a.open ? <Status tone="ok">Aberto</Status> : <Status tone="alerta">Fechado agora</Status>}
                        {a.foodEnabled && !a.hasAddress && <><br /><span style={{ color: 'var(--vermelho)', fontSize: 13 }}>sem endereço</span></>}</td>
                      <td className="num">{a.items}</td>
                      <td className="num">{a.monthOrders}</td>
                      <td className="num">{money(a.monthCommissionCents)}</td>
                      <td>{a.commissionPct == null ? 'a da cidade' : `${String(a.commissionPct).replace('.', ',')}%`}{' '}
                        <button className="secundario" style={{ padding: '0 8px', minHeight: 0 }} onClick={() => {
                          const v = window.prompt('Comissão própria deste restaurante (%). Vazio = a da cidade.', a.commissionPct == null ? '' : String(a.commissionPct));
                          if (v === null) return;
                          run(() => api(`/admin/food/restaurants/${a.id}`, { method: 'PATCH', body: { commissionPct: v.trim() === '' ? null : Number(v.replace(',', '.')) } }), 'Comissão atualizada.');
                        }}>Mudar</button></td>
                      <td><button className={a.foodEnabled ? 'secundario' : ''} onClick={() => run(() => api(`/admin/food/restaurants/${a.id}`, { method: 'PATCH', body: { foodEnabled: !a.foodEnabled } }), a.foodEnabled ? 'Cardápio desligado.' : 'Cardápio ligado. O restaurante já pode montar o cardápio no painel.')}>{a.foodEnabled ? 'Desligar' : 'Ligar cardápio'}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2>Turnos de entregador fixo</h2>
        <p style={{ margin: 0, color: 'var(--texto-2)' }}>O restaurante pede o turno; você escolhe o entregador (moto ou carro, com entregas marcadas). Sem entregador até o começo, o turno é cancelado e o valor volta.</p>
        <Erro msg={sh.error} />
        {sh.data && sh.data.shifts.length === 0 && <p className="vazio">Nenhum turno pedido.</p>}
        {sh.data?.shifts.length > 0 && (
          <div className="tabela">
            <table>
              <thead><tr><th>Restaurante</th><th>Quando</th><th className="num">Valor</th><th>Entregador</th><th></th></tr></thead>
              <tbody>
                {sh.data.shifts.map((s: any) => (
                  <tr key={s.id}>
                    <td><strong>{s.restaurant?.name}</strong><br /><Status tone={SHIFT[s.status][1]}>{SHIFT[s.status][0]}</Status></td>
                    <td>{dateTime(s.startsAt)} – {hm(s.endsAt)}<br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{s.hours} h</span></td>
                    <td className="num">{money(s.priceCents)}<br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>entregador: {money(s.driverCents)}</span></td>
                    <td>
                      <div className="acoes" style={{ alignItems: 'center' }}>
                        <select value={pick[s.id] ?? s.driver?.id ?? ''} onChange={(e) => setPick({ ...pick, [s.id]: e.target.value })} aria-label="Entregador">
                          <option value="">Escolha o entregador</option>
                          {couriers.map((c: any) => <option key={c.id} value={c.id}>{c.name} · {c.vehicle}</option>)}
                        </select>
                        <button disabled={!(pick[s.id] ?? s.driver?.id)} onClick={() => run(() => api(`/admin/food/shifts/${s.id}/assign`, { method: 'POST', body: { driverId: pick[s.id] ?? s.driver?.id } }), 'Entregador confirmado. Ele e o restaurante foram avisados.')}>{s.driver ? 'Trocar' : 'Confirmar'}</button>
                      </div>
                    </td>
                    <td><button className="secundario" onClick={() => window.confirm('Cancelar este turno? O valor volta para o restaurante.') && run(() => api(`/admin/food/shifts/${s.id}/cancel`, { method: 'POST', body: {} }), 'Turno cancelado.')}>Cancelar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {couriers.length === 0 && sh.data && <div className="aviso erro" role="status">Nenhum entregador com entregas marcadas no app.</div>}
      </section>

      {toPay.length > 0 && (
        <section className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2>Repasse aos entregadores fixos</h2>
          <div className="tabela">
            <table>
              <thead><tr><th>Entregador</th><th>Turno</th><th className="num">Entregas</th><th className="num">Repassar</th><th></th></tr></thead>
              <tbody>
                {toPay.map((s: any) => (
                  <tr key={s.id}>
                    <td>{s.driver?.name ?? '—'}</td>
                    <td>{s.restaurant?.name} · {dateTime(s.startsAt)}</td>
                    <td className="num">{s.deliveries}</td>
                    <td className="num"><strong>{money(s.driverCents)}</strong></td>
                    <td><button className="secundario" onClick={() => run(() => api(`/admin/food/shifts/${s.id}/paid`, { method: 'POST', body: {} }), 'Repasse registrado.')}>Paguei</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2>Pedidos de hoje</h2>
        <Erro msg={orders.error} />
        {orders.data && orders.data.orders.length === 0 && <p className="vazio">Nenhum pedido hoje.</p>}
        {orders.data?.orders.length > 0 && (
          <div className="tabela">
            <table>
              <thead><tr><th>Pedido</th><th>Restaurante</th><th>Cliente</th><th className="num">Comida</th><th className="num">Frete</th><th>Pagamento</th><th>Situação</th></tr></thead>
              <tbody>
                {orders.data.orders.map((o: any) => (
                  <tr key={o.id}>
                    <td>{o.number}<br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{hm(o.createdAt)}</span></td>
                    <td>{o.restaurant.name}</td>
                    <td>{o.customer.name}</td>
                    <td className="num">{money(o.subtotalCents)}</td>
                    <td className="num">{money(o.freightCents)}{o.delivery?.shift ? <><br /><span style={{ fontSize: 12, color: 'var(--texto-2)' }}>turno fixo</span></> : null}</td>
                    <td style={{ fontSize: 13 }}>{payLabel(o)}</td>
                    <td><Status tone={ORDER[o.status][1]}>{ORDER[o.status][0]}</Status></td>
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
