import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'leaflet/dist/leaflet.css';
import './index.css';
import App from './App.tsx';
import Track from './pages/Track.tsx';
import Privacidade from './pages/Privacidade.tsx';
import Termos from './pages/Termos.tsx';

// /acompanhar/<código>: página pública para a família acompanhar a corrida
const track = window.location.pathname.match(/^\/acompanhar\/([A-Za-z0-9_-]{8,64})\/?$/);
if (track) document.title = 'Acompanhe a corrida · OnDaqui';
// /privacidade/<cidade>: política de privacidade pública da cidade (link exigido pelas lojas de aplicativos)
const privacy = window.location.pathname.match(/^\/privacidade\/([a-z0-9-]{2,40})\/?$/);
// /termos/<cidade>/passageiro ou /termos/<cidade>/motorista: termos de uso públicos da cidade
const terms = window.location.pathname.match(/^\/termos\/([a-z0-9-]{2,40})\/(passageiro|motorista)\/?$/);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {track ? <Track token={track[1]} />
      : privacy ? <Privacidade slug={privacy[1]} />
      : terms ? <Termos slug={terms[1]} who={terms[2] as 'passageiro' | 'motorista'} />
      : <App />}
  </StrictMode>,
);
