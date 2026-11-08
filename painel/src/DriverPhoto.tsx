import { useEffect, useState } from 'react';
import { apiImage } from './api';

/**
 * Foto do motorista e do veículo de uma viagem da conta (loja ou Saúde).
 * Só aparece com o motorista a caminho ou em viagem; clique para ampliar.
 */
export default function DriverPhoto({ tripId, name, plate }: { tripId: string; name: string; plate?: string }) {
  const [urls, setUrls] = useState<{ perfil?: string; veiculo?: string }>({});
  const [big, setBig] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const made: string[] = [];
    (async () => {
      const next: { perfil?: string; veiculo?: string } = {};
      for (const which of ['perfil', 'veiculo'] as const) {
        try {
          const u = await apiImage(`/account/trips/${tripId}/driver-photo?which=${which}`);
          made.push(u);
          next[which] = u;
        } catch { /* sem foto */ }
      }
      if (alive) setUrls(next);
    })();
    return () => { alive = false; made.forEach((u) => URL.revokeObjectURL(u)); };
  }, [tripId]);

  if (!urls.perfil && !urls.veiculo) return null;
  return (
    <>
      <span style={{ display: 'inline-flex', gap: 6, marginTop: 6 }}>
        {urls.perfil && (
          <button type="button" onClick={() => setBig(urls.perfil!)} style={{ padding: 0, minHeight: 0, background: 'none', border: 0 }} aria-label={`Ampliar foto de ${name}`}>
            <img src={urls.perfil} alt={`Foto de ${name}`} style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover', display: 'block' }} />
          </button>
        )}
        {urls.veiculo && (
          <button type="button" onClick={() => setBig(urls.veiculo!)} style={{ padding: 0, minHeight: 0, background: 'none', border: 0 }} aria-label="Ampliar foto do veículo">
            <img src={urls.veiculo} alt={`Veículo ${plate ?? ''}`} style={{ width: 64, height: 40, borderRadius: 8, objectFit: 'cover', display: 'block' }} />
          </button>
        )}
      </span>
      {big && (
        <div className="lateral-fundo" style={{ justifyContent: 'center', alignItems: 'center' }} onClick={() => setBig(null)} role="dialog" aria-label="Foto ampliada">
          <img src={big} alt="" style={{ maxWidth: 'min(480px, 90vw)', maxHeight: '80vh', borderRadius: 16, background: '#fff' }} />
        </div>
      )}
    </>
  );
}
