const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const money = (cents: number | null | undefined) => brl.format((cents ?? 0) / 100);

export const dateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

export const date = (iso: string | null | undefined) =>
  iso ? new Date(iso.length === 10 ? iso + 'T12:00:00' : iso).toLocaleDateString('pt-BR') : '—';

export const phone = (p: string) =>
  p.length === 11 ? `(${p.slice(0, 2)}) ${p.slice(2, 7)}-${p.slice(7)}` : p.length === 10 ? `(${p.slice(0, 2)}) ${p.slice(2, 6)}-${p.slice(6)}` : p;

export const rideStatus: Record<string, string> = {
  scheduled: 'Agendada',
  requested: 'Procurando motorista',
  accepted: 'Motorista a caminho',
  arrived: 'Motorista chegou',
  in_progress: 'Em viagem',
  completed: 'Finalizada',
  cancelled: 'Cancelada',
};

export const driverStatus: Record<string, string> = {
  pending: 'Aguardando aprovação',
  approved: 'Aprovado',
  rejected: 'Recusado',
  blocked: 'Bloqueado',
};

export const payment: Record<string, string> = { pix: 'Pix', card: 'Cartão', cash: 'Dinheiro', convenio: 'Convênio' };

export const cancelReason: Record<string, string> = {
  sem_motorista: 'Nenhum motorista disponível', cancelada_pela_saude: 'Cancelada pela central da Saúde',
};
