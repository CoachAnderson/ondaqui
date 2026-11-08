const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const money = (cents: number | null | undefined) => brl.format((cents ?? 0) / 100);

export const paymentLabel: Record<string, string> = {
  pix: 'Pix',
  card: 'Cartão na maquininha',
  cash: 'Dinheiro',
  convenio: 'Pago pela Prefeitura (convênio)',
  conta_loja: 'Pago pela loja (créditos)',
};

/** "qua., 05/11 às 14:30" */
export const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
};

/** Ícone de cada serviço */
export const serviceIcon: Record<string, string> = {
  carro: '🚗', moto: '🏍️', executivo: '💼', mulher: '👩', pet: '🐾', entrega: '📦', 'entrega-carro': '📦',
  particular: '🕐', frete: '🚚', paciente: '🏥',
};

export const plate = (p: string) => (p.length === 7 ? `${p.slice(0, 3)}-${p.slice(3)}` : p);

export const firstName = (n: string) => n.trim().split(/\s+/)[0];

export const km = (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km`;
