import { useEffect, useState } from 'react';
import { api, apiImage } from '../api';
import { money } from '../format';
import { Erro, Status, errMsg, useLoad } from '../ui';

const PLACES = [
  ['inicio', 'Passageiro · tela inicial'],
  ['corrida', 'Passageiro · durante a viagem'],
  ['motorista', 'App do motorista'],
] as const;
const placeLabel = Object.fromEntries(PLACES) as Record<string, string>;
const toCents = (v: string) => Math.round(Number(v.replace(/\./g, '').replace(',', '.')) * 100);
const day = (d: string | null) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR') : '');
const ctr = (clicks: number, imp: number) => (imp > 0 ? `${((clicks / imp) * 100).toFixed(1).replace('.', ',')}%` : '—');

const EMPTY = { advertiser: '', title: '', body: '', ctaLabel: '', link: '', places: ['inicio'] as string[], startsOn: '', endsOn: '', weight: '1', price: '' };

/**
 * Licenciado: anúncios de comércios da cidade no app (uma fonte de receita além das corridas).
 * Um anúncio por tela, sorteado pelo peso, sempre marcado como "Publicidade". Só contamos quantas vezes
 * apareceu e foi tocado, sem saber quem viu.
 */
export default function Ads() {
  const list = useLoad(() => api('/admin/ads'));
  const [f, setF] = useState(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  function edit(a: any) {
    setEditing(a.id);
    setF({
      advertiser: a.advertiser, title: a.title, body: a.body ?? '', ctaLabel: a.ctaLabel ?? '', link: a.link ?? '', places: a.placements,
      startsOn: String(a.startsOn).slice(0, 10), endsOn: a.endsOn ? String(a.endsOn).slice(0, 10) : '', weight: String(a.weight),
      price: a.priceCents != null ? (a.priceCents / 100).toFixed(2).replace('.', ',') : '',
    });
    setImage(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function pickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1.5 * 1024 * 1024) { setMsg({ ok: false, text: 'Imagem muito grande: use até 1,5 MB (formato deitado, 2 por 1).' }); return; }
    const r = new FileReader();
    r.onload = () => setImage(String(r.result));
    r.readAsDataURL(file);
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const body = {
        advertiser: f.advertiser.trim(), title: f.title.trim(), body: f.body.trim() || null, ctaLabel: f.ctaLabel.trim() || null,
        link: f.link.trim() || null, placements: f.places, startsOn: f.startsOn || undefined, endsOn: f.endsOn || null,
        weight: Number(f.weight), priceCents: f.price.trim() ? toCents(f.price) : null,
      };
      const r = editing
        ? await api(`/admin/ads/${editing}`, { method: 'PATCH', body })
        : await api('/admin/ads', { method: 'POST', body });
      if (image) await api(`/admin/ads/${r.ad.id}/image`, { method: 'PUT', body: { image } });
      setMsg({ ok: true, text: editing ? 'Anúncio atualizado.' : 'Anúncio no ar.' });
      setF(EMPTY); setEditing(null); setImage(null);
      list.reload();
    } catch (e) { setMsg({ ok: false, text: errMsg(e) }); } finally { setBusy(false); }
  }

  async function act(a: any, what: 'pausar' | 'retomar' | 'excluir') {
    if (what === 'excluir' && !window.confirm(`Excluir o anúncio de ${a.advertiser}? Os números dele somem junto.`)) return;
    setMsg(null);
    try {
      if (what === 'excluir') await api(`/admin/ads/${a.id}`, { method: 'DELETE' });
      else await api(`/admin/ads/${a.id}`, { method: 'PATCH', body: { active: what === 'retomar' } });
      list.reload();
    } catch (e) { setMsg({ ok: false, text: errMsg(e) }); }
  }

  const ads = list.data?.ads ?? [];
  const live = ads.filter((a: any) => a.live);
  const valid = f.advertiser.trim().length >= 2 && f.title.trim().length >= 3 && f.places.length > 0;

  return (
    <>
      <div className="topo">
        <div>
          <h1>Anúncios</h1>
          <p>
            Venda espaço no app para comércios da cidade: restaurantes, farmácias, oficinas, postos. Aparece um anúncio por tela,
            sorteado pelo peso, sempre marcado como "Publicidade". Você só vê quantas vezes apareceu e foi tocado, sem saber quem viu.
          </p>
        </div>
      </div>
      <Erro msg={list.error} />
      <section className="grade-kpi">
        <div className="cartao kpi"><span className="rotulo">No ar</span><span className="valor">{live.length}</span><span className="nota">de {ads.length} cadastrados</span></div>
        <div className="cartao kpi"><span className="rotulo">Exibições (7 dias)</span><span className="valor">{ads.reduce((s: number, a: any) => s + a.impressions7d, 0)}</span></div>
        <div className="cartao kpi"><span className="rotulo">Toques (7 dias)</span><span className="valor">{ads.reduce((s: number, a: any) => s + a.clicks7d, 0)}</span></div>
        <div className="cartao kpi"><span className="rotulo">Vendido (no ar)</span><span className="valor">{money(live.reduce((s: number, a: any) => s + (a.priceCents ?? 0), 0))}</span></div>
      </section>
      {msg && <div className={`aviso ${msg.ok ? 'ok' : 'erro'}`} role="status">{msg.text}</div>}

      <section className="cartao">
        <h2>{editing ? 'Editar anúncio' : 'Novo anúncio'}</h2>
        <div className="formulario" style={{ marginTop: 12 }}>
          <label>Anunciante<input value={f.advertiser} maxLength={60} onChange={(e) => setF({ ...f, advertiser: e.target.value })} placeholder="Pizzaria do Zé" /></label>
          <label>Título<input value={f.title} maxLength={60} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Pizza grande por R$ 39" /></label>
          <label>Texto (opcional)<input value={f.body} maxLength={140} onChange={(e) => setF({ ...f, body: e.target.value })} placeholder="Entrega grátis no centro" /></label>
          <label>Link (https://)<input value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })} placeholder="https://wa.me/5514999990000" /></label>
          <label>Texto do botão<input value={f.ctaLabel} maxLength={24} onChange={(e) => setF({ ...f, ctaLabel: e.target.value })} placeholder="Pedir no WhatsApp" /></label>
          <label>Início<input type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} /></label>
          <label>Fim (opcional)<input type="date" value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} /></label>
          <label>Peso (1 a 10)
            <select value={f.weight} onChange={(e) => setF({ ...f, weight: e.target.value })}>{Array.from({ length: 10 }, (_, i) => <option key={i + 1}>{i + 1}</option>)}</select>
          </label>
          <label>Valor cobrado (R$, opcional)<input inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} placeholder="150,00" /></label>
          <label>Imagem (opcional, deitada 2:1)<input type="file" accept="image/jpeg,image/png,image/webp" onChange={pickImage} /></label>
        </div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', margin: '14px 0' }} role="group" aria-label="Onde aparece">
          {PLACES.map(([id, label]) => (
            <label key={id} className="check">
              <input type="checkbox" checked={f.places.includes(id)}
                onChange={(e) => setF({ ...f, places: e.target.checked ? [...f.places, id] : f.places.filter((x) => x !== id) })} /> {label}
            </label>
          ))}
        </div>
        <div className="acoes">
          <button disabled={busy || !valid} onClick={save}>{editing ? 'Salvar' : 'Publicar'}</button>
          {editing && <button className="secundario" onClick={() => { setEditing(null); setF(EMPTY); setImage(null); }}>Cancelar</button>}
        </div>
        <p style={{ fontSize: 13, color: 'var(--texto-2)', marginTop: 12 }}>
          Não publique: propaganda política ou eleitoral, apostas, bebidas alcoólicas, cigarro, conteúdo adulto, remédios de venda
          sob prescrição nem nada ilegal. O peso define a frequência: peso 2 aparece o dobro do peso 1. Combine com o anunciante o
          valor e a forma de pagamento.
        </p>
      </section>

      <section className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2>Anúncios</h2>
        {list.data && ads.length === 0 && <p className="vazio">Nenhum anúncio ainda.</p>}
        {ads.length > 0 && (
          <div className="tabela">
            <table>
              <thead><tr><th></th><th>Anúncio</th><th>Onde</th><th>Período</th><th className="num">Exibições</th><th className="num">Toques</th><th className="num">Taxa</th><th>Situação</th><th></th></tr></thead>
              <tbody>
                {ads.map((a: any) => (
                  <tr key={a.id}>
                    <td style={{ width: 96 }}><AdThumb id={a.id} has={a.hasImage} /></td>
                    <td><strong>{a.title}</strong><br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{a.advertiser}{a.priceCents != null ? ` · ${money(a.priceCents)}` : ''}</span></td>
                    <td style={{ fontSize: 13 }}>{a.placements.map((p: string) => placeLabel[p]).join(', ')}</td>
                    <td style={{ fontSize: 13 }}>{day(a.startsOn)}{a.endsOn ? ` a ${day(a.endsOn)}` : ' em diante'}</td>
                    <td className="num">{a.impressions}</td>
                    <td className="num">{a.clicks}</td>
                    <td className="num">{ctr(a.clicks, a.impressions)}</td>
                    <td>{a.live ? <Status tone="ok">No ar</Status> : a.active ? <Status tone="alerta">Fora do período</Status> : <Status tone="neutra">Pausado</Status>}</td>
                    <td>
                      <div className="acoes">
                        <button className="secundario" onClick={() => edit(a)}>Editar</button>
                        <button className="secundario" onClick={() => act(a, a.active ? 'pausar' : 'retomar')}>{a.active ? 'Pausar' : 'Retomar'}</button>
                        <button className="secundario" onClick={() => act(a, 'excluir')}>Excluir</button>
                      </div>
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

function AdThumb({ id, has }: { id: string; has: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!has) return;
    let url: string | null = null;
    apiImage(`/ads/${id}/image`).then((u) => { url = u; setSrc(u); }).catch(() => {});
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [id, has]);
  return src ? <img src={src} alt="" style={{ width: 88, height: 44, objectFit: 'cover', borderRadius: 6 }} /> : null;
}
