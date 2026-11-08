import { useState } from 'react';
import { CircleMarker, MapContainer, TileLayer, useMapEvents } from 'react-leaflet';

export interface PickedPlace { lat: number; lng: number; address: string }

interface Hit { lat: string; lon: string; display_name: string }

/** Encurta o endereço do OpenStreetMap: "Rua X, 200, Bairro, Cidade" */
function shortAddress(h: Hit) {
  const parts = h.display_name.split(',').map((s) => s.trim());
  return parts.slice(0, 4).join(', ');
}

function ClickToPick({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onPick(e.latlng.lat, e.latlng.lng) });
  return null;
}

/**
 * Escolher um endereço: busca pelo texto (OpenStreetMap) ou clique no mapa.
 * O texto digitado vira o endereço que o motorista vê.
 */
export default function PlacePicker({ value, onChange, city, label = 'Endereço' }: {
  value: PickedPlace | null; onChange: (p: PickedPlace | null) => void; city?: string; label?: string;
}) {
  const [text, setText] = useState(value?.address ?? '');
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function find() {
    setBusy(true);
    setError(null);
    try {
      const q = encodeURIComponent(`${text}${city ? `, ${city}` : ''}`);
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=br&q=${q}`, {
        headers: { 'accept-language': 'pt-BR' },
      });
      const list = (await r.json()) as Hit[];
      setHits(list);
      if (!list.length) setError('Endereço não encontrado. Clique no mapa para marcar o ponto.');
    } catch {
      setError('Busca indisponível agora. Clique no mapa para marcar o ponto.');
    } finally {
      setBusy(false);
    }
  }

  const center: [number, number] = value ? [value.lat, value.lng] : [-22.3246, -49.0871];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label style={{ flex: 1, minWidth: 220 }}>{label}
          <input value={text} onChange={(e) => {
            setText(e.target.value);
            if (value) onChange({ ...value, address: e.target.value });
          }} placeholder="Rua, número e bairro" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void find(); } }} />
        </label>
        <button type="button" className="secundario" onClick={find} disabled={busy || text.trim().length < 3}>{busy ? 'Buscando…' : 'Buscar'}</button>
      </div>
      {hits.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--linha)', borderRadius: 10, overflow: 'hidden' }}>
          {hits.map((h) => (
            <button type="button" key={h.lat + h.lon} className="secundario" style={{ borderRadius: 0, border: 0, borderBottom: '1px solid var(--linha)', textAlign: 'left', fontWeight: 500 }}
              onClick={() => {
                const address = shortAddress(h);
                setText(address);
                setHits([]);
                onChange({ lat: Number(h.lat), lng: Number(h.lon), address });
              }}>{h.display_name}</button>
          ))}
        </div>
      )}
      {error && <div className="aviso erro" role="status">{error}</div>}
      <div className="mapa" style={{ height: 220 }}>
        <MapContainer center={center} zoom={value ? 16 : 13} style={{ height: '100%', width: '100%' }} key={value ? `${value.lat}` : 'vazio'}>
          <TileLayer attribution='&copy; colaboradores do <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <ClickToPick onPick={(lat, lng) => onChange({ lat, lng, address: text.trim() || `Ponto no mapa (${lat.toFixed(5)}, ${lng.toFixed(5)})` })} />
          {value && <CircleMarker center={[value.lat, value.lng]} radius={9} pathOptions={{ color: '#fff', weight: 2, fillColor: '#F2622E', fillOpacity: 1 }} />}
        </MapContainer>
      </div>
      <span style={{ fontSize: 13, color: 'var(--texto-2)' }}>
        {value ? 'Ponto marcado. Clique no mapa para ajustar.' : 'Busque o endereço ou clique no mapa para marcar o ponto.'}
      </span>
    </div>
  );
}
