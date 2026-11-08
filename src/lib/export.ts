import { strToU8, zipSync } from 'fflate';
import { one, query } from './db.js';
import { dia, quando, reais, simNao, toCsv } from './csv.js';
import { notFound } from './errors.js';

const STATUS: Record<string, string> = {
  scheduled: 'agendada', requested: 'procurando motorista', accepted: 'aceita', arrived: 'motorista chegou',
  in_progress: 'em andamento', completed: 'concluída', cancelled: 'cancelada',
};
const PAY: Record<string, string> = { pix: 'Pix', card: 'cartão', cash: 'dinheiro', convenio: 'convênio', conta_loja: 'conta da loja' };

const LEIA_ME = (name: string, at: string) => `Dados da cidade ${name}, exportados em ${at} (horário de Brasília).

Arquivos (planilhas CSV, separadas por ponto e vírgula, abrem direto no Excel ou no Google Planilhas):
  passageiros.csv          contas de passageiros
  motoristas.csv           motoristas, veículos, documentos conferidos, plano e Pix
  corridas.csv             todas as corridas, entregas, fretes e transportes de pacientes
  lojas_e_convenios.csv    lojas do Daqui Entrega e convênios (Prefeitura)
  pacientes.csv            pacientes cadastrados pelos convênios da Saúde
  comissoes.csv            faturas de comissão do plano Livre
  mensalidades.csv         mensalidades pagas pelos motoristas
  cashback.csv             extrato do cashback dos passageiros (ganhos, usos, vencidos)
  repasses_cashback.csv    o que a central pagou ou abateu dos motoristas pelo cashback e pelo desconto do Clube
  clube.csv                meses do Clube do passageiro pagos ou dados de cortesia
  anuncios.csv             anúncios, período, quanto foi cobrado, vezes que apareceram e foram tocados
  escola.csv               contratos de transporte escolar (aluno, escola, motorista, mensalidade)
  food_pedidos.csv         pedidos do Daqui Food (restaurante, itens, valores, pagamento, comissão)
  food_turnos.csv          turnos de entregador fixo do Daqui Food (restaurante, entregador, valores, repasse)
  dados.json               tudo acima num arquivo só, para importar em outro sistema

Os códigos (id) ligam as planilhas: a coluna passageiro_id de corridas.csv é o id de passageiros.csv, e assim por diante.
Não vão nesta exportação: senhas, chaves de acesso do Mercado Pago e fotos.
Contas excluídas pelo titular aparecem como "Conta excluída", sem telefone.

Estes arquivos têm dados pessoais protegidos pela LGPD. Guarde em local seguro e compartilhe só com quem precisa.
`;

/** Todos os dados da cidade em planilhas, num ZIP (contrato de licença: portabilidade no fim do contrato) */
export async function tenantExport(tenantId: string) {
  const t = await one(`SELECT id, slug, name, city_label FROM tenants WHERE id = $1`, [tenantId]);
  if (!t) throw notFound('Cidade não encontrada');

  const passengers = await query(
    `SELECT id, name, CASE WHEN deleted_at IS NULL THEN phone END AS phone, created_at, phone_verified_at,
            declared_woman, privacy_version, privacy_accepted_at, blocked, deleted_at
       FROM users WHERE tenant_id = $1 AND role = 'passenger' ORDER BY created_at`,
    [tenantId],
  );
  const drivers = await query(
    `SELECT u.id, u.name, CASE WHEN u.deleted_at IS NULL THEN u.phone END AS phone, u.created_at, u.deleted_at,
            d.status, d.vehicle_type, d.vehicle_model, d.vehicle_color, d.vehicle_plate, d.services_opt_in, d.verified,
            d.cnh_ear_ok, d.inss_ok, d.criminal_record_ok, d.insurance_app_ok, d.photo_status,
            d.pix_key, d.pix_holder_name, d.pix_validated, d.plan_code, d.trial_until, d.paid_until,
            (SELECT round(avg(r.driver_rating)::numeric, 2) FROM rides r WHERE r.driver_id = u.id AND r.driver_rating IS NOT NULL) AS rating,
            (SELECT count(*) FROM rides r WHERE r.driver_id = u.id AND r.status = 'completed')::int AS rides
       FROM users u JOIN drivers d ON d.user_id = u.id WHERE u.tenant_id = $1 ORDER BY u.created_at`,
    [tenantId],
  );
  const rides = await query(
    `SELECT r.id, r.requested_at, r.scheduled_for, r.completed_at, r.cancelled_at, r.status, r.kind,
            coalesce(c.name, r.category_code) AS service, r.passenger_id, r.driver_id, r.account_id, r.patient_id,
            r.origin_address, r.dest_address, r.distance_km, r.duration_min, r.surge, r.price_cents, r.payment_method,
            r.commission_cents, r.license_fee_cents, r.commission_invoice_id, r.cancel_reason, r.cancelled_by,
            r.passenger_rating, r.driver_rating, r.recipient_name, r.package_desc, r.cod_amount_cents, r.cod_status, r.route_source,
            r.cashback_used_cents, r.cashback_earned_cents, r.club_member, r.club_discount_cents
       FROM rides r LEFT JOIN ride_categories c ON c.tenant_id = r.tenant_id AND c.code = r.category_code
      WHERE r.tenant_id = $1 ORDER BY r.requested_at`,
    [tenantId],
  );
  const accounts = await query(
    `SELECT id, kind, name, document, contact_name, contact_phone, active, created_at, billing_mode, balance_cents,
            credit_limit_cents, discount_pct, address, pix_key, pix_holder_name, pix_validated
       FROM accounts WHERE tenant_id = $1 ORDER BY kind, name`,
    [tenantId],
  );
  const patients = await query(
    `SELECT p.id, p.account_id, p.name, p.phone, p.document, p.address, p.wheelchair, p.needs_companion, p.notes, p.active, p.created_at
       FROM patients p JOIN accounts a ON a.id = p.account_id WHERE a.tenant_id = $1 ORDER BY p.name`,
    [tenantId],
  );
  const commissions = await query(
    `SELECT id, driver_id, period_start, period_end, rides, gross_cents, amount_cents, due_date, status, paid_at, paid_by, note
       FROM commission_invoices WHERE tenant_id = $1 ORDER BY period_start, driver_id`,
    [tenantId],
  );
  const subscriptions = await query(
    `SELECT s.id, s.driver_id, s.plan_code, s.amount_cents, s.period_start, s.period_end, s.paid_at,
            CASE WHEN s.registered_by IS NULL THEN 'Mercado Pago' ELSE 'central' END AS via
       FROM subscription_payments s JOIN users u ON u.id = s.driver_id WHERE u.tenant_id = $1 ORDER BY s.paid_at`,
    [tenantId],
  );

  const cashback = await query(
    `SELECT id, user_id, CASE WHEN user_id IS NULL THEN phone END AS phone, kind, amount_cents, expires_at, ride_id, account_id, note, created_at
       FROM cashback_ledger WHERE tenant_id = $1 ORDER BY id`,
    [tenantId],
  );
  const payouts = await query(
    `SELECT id, driver_id, period_start, period_end, rides, cashback_cents, offset_cents, amount_cents, status, paid_at, note
       FROM cashback_payouts WHERE tenant_id = $1 ORDER BY period_start, driver_id`,
    [tenantId],
  );
  const club = await query(
    `SELECT id, user_id, amount_cents, period_start, period_end, CASE WHEN registered_by IS NULL THEN 'Mercado Pago' ELSE 'central' END AS via, note, created_at
       FROM club_payments WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId],
  );
  const ads = await query(
    `SELECT a.id, a.advertiser, a.title, a.link, a.placements, a.starts_on, a.ends_on, a.price_cents, a.active, a.created_at,
            coalesce(sum(s.impressions), 0)::int AS impressions, coalesce(sum(s.clicks), 0)::int AS clicks
       FROM ads a LEFT JOIN ad_stats s ON s.ad_id = a.id WHERE a.tenant_id = $1 GROUP BY a.id ORDER BY a.created_at`,
    [tenantId],
  );
  const school = await query(
    `SELECT c.id, c.parent_id, c.student_name, c.grade, s.name AS school, c.driver_id, c.legs, c.weekdays, c.pickup_time, c.return_time,
            c.distance_km, c.monthly_cents, c.status, c.paid_until, c.created_at, c.ended_at,
            (SELECT coalesce(sum(amount_cents), 0) FROM school_payments p WHERE p.contract_id = c.id)::int AS paid_cents
       FROM school_contracts c JOIN schools s ON s.id = c.school_id WHERE c.tenant_id = $1 ORDER BY c.created_at`,
    [tenantId],
  );
  const food = await query(
    `SELECT o.id, o.number, o.account_id, a.name AS restaurant, o.customer_id, o.items, o.subtotal_cents, o.delivery_fee_cents,
            o.freight_cents, o.total_cents, o.payment, o.pay_status, o.status, o.commission_cents, o.ride_id, o.created_at, o.delivered_at,
            o.cancelled_by, o.refuse_reason
       FROM food_orders o JOIN accounts a ON a.id = o.account_id WHERE o.tenant_id = $1 ORDER BY o.created_at`,
    [tenantId],
  );
  const shifts = await query(
    `SELECT s.id, s.account_id, a.name AS restaurant, s.driver_id, s.starts_at, s.ends_at, s.hours, s.price_cents, s.driver_cents,
            s.status, s.deliveries, s.driver_paid_at, s.created_at
       FROM food_shifts s JOIN accounts a ON a.id = s.account_id WHERE s.tenant_id = $1 ORDER BY s.starts_at`,
    [tenantId],
  );
  const CB: Record<string, string> = {
    corrida: 'ganho na corrida', loja: 'presente de loja', uso: 'usado', devolucao: 'devolvido (corrida cancelada)', expirado: 'venceu', ajuste: 'ajuste da central',
  };

  const at = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const files: Record<string, Uint8Array> = {
    'LEIA-ME.txt': strToU8(LEIA_ME(t.name, at)),
    'passageiros.csv': strToU8(toCsv(
      ['id', 'nome', 'celular', 'cadastro', 'celular confirmado', 'Daqui Mulher', 'versão da política aceita', 'aceite em', 'bloqueada', 'excluída em'],
      passengers.map((u) => [u.id, u.name, u.phone, quando(u.created_at), quando(u.phone_verified_at), simNao(u.declared_woman),
        u.privacy_version ?? '', quando(u.privacy_accepted_at), simNao(u.blocked), quando(u.deleted_at)]),
    )),
    'motoristas.csv': strToU8(toCsv(
      ['id', 'nome', 'celular', 'cadastro', 'situação', 'tipo de veículo', 'modelo', 'cor', 'placa', 'serviços escolhidos', 'liberados pela central',
        'CNH com EAR', 'INSS', 'antecedentes', 'seguro APP', 'fotos', 'chave Pix', 'titular do Pix', 'Pix conferido', 'plano',
        'mês grátis até', 'pago até', 'nota média', 'corridas concluídas', 'excluída em'],
      drivers.map((d) => [d.id, d.name, d.phone, quando(d.created_at), d.status, d.vehicle_type, d.vehicle_model, d.vehicle_color, d.vehicle_plate,
        (d.services_opt_in ?? []).join(', '), (d.verified ?? []).join(', '), simNao(d.cnh_ear_ok), simNao(d.inss_ok), simNao(d.criminal_record_ok),
        simNao(d.insurance_app_ok), d.photo_status, d.pix_key, d.pix_holder_name, simNao(d.pix_validated), d.plan_code,
        dia(d.trial_until), dia(d.paid_until), d.rating ?? '', d.rides, quando(d.deleted_at)]),
    )),
    'corridas.csv': strToU8(toCsv(
      ['id', 'pedida em', 'agendada para', 'concluída em', 'cancelada em', 'situação', 'tipo', 'serviço', 'passageiro_id', 'motorista_id',
        'conta_id', 'paciente_id', 'origem', 'destino', 'km', 'minutos', 'dinâmica', 'preço (R$)', 'pagamento', 'comissão (R$)',
        'taxa da licença (R$)', 'fatura de comissão', 'motivo do cancelamento', 'cancelada por', 'nota dada pelo passageiro ao motorista',
        'nota dada pelo motorista ao passageiro', 'destinatário', 'pacote', 'produto cobrado na entrega (R$)', 'situação da cobrança', 'cálculo da rota',
        'cashback usado (R$)', 'cashback ganho (R$)', 'assinante do Clube', 'desconto do Clube (R$)'],
      rides.map((r) => [r.id, quando(r.requested_at), quando(r.scheduled_for), quando(r.completed_at), quando(r.cancelled_at), STATUS[r.status] ?? r.status,
        r.kind, r.service, r.passenger_id, r.driver_id, r.account_id, r.patient_id, r.origin_address, r.dest_address,
        String(r.distance_km).replace('.', ','), r.duration_min, String(r.surge).replace('.', ','), reais(r.price_cents), PAY[r.payment_method] ?? r.payment_method,
        reais(r.commission_cents), reais(r.license_fee_cents), r.commission_invoice_id, r.cancel_reason, r.cancelled_by,
        r.driver_rating ?? '', r.passenger_rating ?? '', r.recipient_name, r.package_desc, reais(r.cod_amount_cents), r.cod_status, r.route_source,
        reais(r.cashback_used_cents), reais(r.cashback_earned_cents), simNao(r.club_member), reais(r.club_discount_cents)]),
    )),
    'lojas_e_convenios.csv': strToU8(toCsv(
      ['id', 'tipo', 'nome', 'CNPJ', 'contato', 'telefone', 'ativa', 'cadastro', 'pagamento do frete', 'saldo (R$)', 'limite (R$)', 'desconto (%)',
        'endereço', 'chave Pix', 'titular do Pix', 'Pix conferido'],
      accounts.map((a) => [a.id, a.kind === 'loja' ? 'loja' : 'convênio (Prefeitura)', a.name, a.document, a.contact_name, a.contact_phone, simNao(a.active),
        quando(a.created_at), a.kind === 'loja' ? (a.billing_mode === 'fatura' ? 'fatura semanal' : 'créditos') : '', a.kind === 'loja' ? reais(a.balance_cents) : '',
        a.kind === 'loja' ? reais(a.credit_limit_cents) : '', a.kind === 'loja' ? String(a.discount_pct).replace('.', ',') : '', a.address, a.pix_key,
        a.pix_holder_name, a.kind === 'loja' ? simNao(a.pix_validated) : '']),
    )),
    'pacientes.csv': strToU8(toCsv(
      ['id', 'convênio_id', 'nome', 'telefone', 'documento (CNS ou CPF)', 'endereço', 'cadeirante', 'precisa de acompanhante', 'observações', 'ativo', 'cadastro'],
      patients.map((p) => [p.id, p.account_id, p.name, p.phone, p.document, p.address, simNao(p.wheelchair), simNao(p.needs_companion), p.notes,
        simNao(p.active), quando(p.created_at)]),
    )),
    'comissoes.csv': strToU8(toCsv(
      ['id', 'motorista_id', 'semana de', 'semana até', 'corridas', 'recebido pelo motorista (R$)', 'comissão (R$)', 'vencimento', 'situação', 'paga em', 'paga por', 'observação'],
      commissions.map((c) => [c.id, c.driver_id, dia(c.period_start), dia(c.period_end), c.rides, reais(c.gross_cents), reais(c.amount_cents), dia(c.due_date),
        c.status === 'open' ? 'em aberto' : c.status === 'paid' ? 'paga' : 'cancelada', quando(c.paid_at),
        c.paid_by === 'mercadopago' ? 'Mercado Pago' : c.paid_by === 'central' ? 'central' : '', c.note]),
    )),
    'mensalidades.csv': strToU8(toCsv(
      ['id', 'motorista_id', 'plano', 'valor (R$)', 'período de', 'período até', 'paga em', 'registrada por'],
      subscriptions.map((s) => [s.id, s.driver_id, s.plan_code, reais(s.amount_cents), dia(s.period_start), dia(s.period_end), quando(s.paid_at), s.via]),
    )),
    'cashback.csv': strToU8(toCsv(
      ['id', 'passageiro_id', 'celular (crédito aguardando cadastro)', 'tipo', 'valor (R$)', 'vence em', 'corrida_id', 'loja_id', 'observação', 'data'],
      cashback.map((c) => [c.id, c.user_id, c.phone, CB[c.kind] ?? c.kind, reais(c.amount_cents), quando(c.expires_at), c.ride_id, c.account_id, c.note, quando(c.created_at)]),
    )),
    'repasses_cashback.csv': strToU8(toCsv(
      ['id', 'motorista_id', 'semana de', 'semana até', 'corridas', 'cashback usado (R$)', 'abatido da comissão (R$)', 'pago ao motorista (R$)', 'situação', 'pago em', 'observação'],
      payouts.map((p) => [p.id, p.driver_id, dia(p.period_start), dia(p.period_end), p.rides, reais(p.cashback_cents), reais(p.offset_cents), reais(p.amount_cents),
        p.status === 'open' ? 'a pagar' : p.status === 'paid' ? 'pago' : 'abatido', quando(p.paid_at), p.note]),
    )),
    'clube.csv': strToU8(toCsv(
      ['id', 'passageiro_id', 'valor (R$)', 'de', 'até', 'registrado por', 'observação', 'data'],
      club.map((c) => [c.id, c.user_id, reais(c.amount_cents), dia(c.period_start), dia(c.period_end), c.via, c.note, quando(c.created_at)]),
    )),
    'anuncios.csv': strToU8(toCsv(
      ['id', 'anunciante', 'título', 'link', 'onde aparece', 'de', 'até', 'valor cobrado (R$)', 'ativo', 'vezes que apareceu', 'toques', 'criado em'],
      ads.map((a) => [a.id, a.advertiser, a.title, a.link, (a.placements ?? []).join(', '), dia(a.starts_on), dia(a.ends_on),
        a.price_cents == null ? '' : reais(a.price_cents), simNao(a.active), a.impressions, a.clicks, quando(a.created_at)]),
    )),
    'escola.csv': strToU8(toCsv(
      ['id', 'responsável_id', 'aluno', 'série', 'escola', 'motorista_id', 'trechos', 'dias', 'saída de casa', 'saída da escola', 'km',
        'mensalidade (R$)', 'situação', 'pago até', 'total recebido (R$)', 'pedido em', 'encerrado em'],
      school.map((c) => [c.id, c.parent_id, c.student_name, c.grade, c.school, c.driver_id, c.legs, (c.weekdays ?? []).join(','),
        c.pickup_time ? String(c.pickup_time).slice(0, 5) : '', c.return_time ? String(c.return_time).slice(0, 5) : '',
        String(c.distance_km).replace('.', ','), reais(c.monthly_cents), c.status, dia(c.paid_until), reais(c.paid_cents), quando(c.created_at), quando(c.ended_at)]),
    )),
    'food_pedidos.csv': strToU8(toCsv(
      ['id', 'número', 'restaurante_id', 'restaurante', 'cliente_id', 'itens', 'comida (R$)', 'taxa de entrega (R$)', 'frete da central (R$)',
        'total (R$)', 'pagamento', 'situação do pagamento', 'situação', 'comissão (R$)', 'corrida_id', 'pedido em', 'entregue em', 'cancelado por', 'motivo'],
      food.map((o) => [o.id, o.number, o.account_id, o.restaurant, o.customer_id,
        (o.items ?? []).map((i: any) => `${i.qty}x ${i.name}`).join('; '), reais(o.subtotal_cents), reais(o.delivery_fee_cents),
        reais(o.freight_cents), reais(o.total_cents), o.payment === 'app' ? 'Pix pelo app' : 'na entrega', o.pay_status, o.status,
        o.commission_cents == null ? '' : reais(o.commission_cents), o.ride_id, quando(o.created_at), quando(o.delivered_at), o.cancelled_by, o.refuse_reason]),
    )),
    'food_turnos.csv': strToU8(toCsv(
      ['id', 'restaurante_id', 'restaurante', 'entregador_id', 'início', 'fim', 'horas', 'valor do restaurante (R$)', 'repasse ao entregador (R$)',
        'situação', 'entregas', 'repasse pago em', 'pedido em'],
      shifts.map((x) => [x.id, x.account_id, x.restaurant, x.driver_id, quando(x.starts_at), quando(x.ends_at), x.hours, reais(x.price_cents),
        reais(x.driver_cents), x.status, x.deliveries, quando(x.driver_paid_at), quando(x.created_at)]),
    )),
    'dados.json': strToU8(JSON.stringify({
      exportadoEm: new Date().toISOString(),
      cidade: { slug: t.slug, nome: t.name, municipio: t.city_label },
      passageiros: passengers, motoristas: drivers, corridas: rides, lojasEConvenios: accounts, pacientes: patients,
      comissoes: commissions, mensalidades: subscriptions, cashback, repassesCashback: payouts, clube: club, anuncios: ads, escola: school,
      foodPedidos: food, foodTurnos: shifts,
    }, null, 2)),
  };
  const zip = zipSync(files, { level: 6 });
  const stamp = new Date().toISOString().slice(0, 10);
  return { zip, filename: `${t.slug}-dados-${stamp}.zip`, counts: { passageiros: passengers.length, motoristas: drivers.length, corridas: rides.length } };
}

/** Cópia dos dados pessoais do titular (LGPD, art. 18, II e V) */
export async function userExport(userId: string) {
  const u = await one(
    `SELECT u.id, u.role, u.name, u.phone, u.created_at, u.phone_verified_at, u.declared_woman, u.privacy_version, u.privacy_accepted_at, u.trip_prefs,
            t.name AS city, t.legal_name AS controller, t.cnpj AS controller_cnpj, t.dpo_email
       FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`,
    [userId],
  );
  if (!u) throw notFound('Conta não encontrada');
  const driver = u.role === 'driver'
    ? await one(
      `SELECT status, vehicle_type, vehicle_model, vehicle_color, vehicle_plate, services_opt_in, verified, plan_code, trial_until, paid_until,
              pix_key, pix_holder_name, pix_validated, photo_status, (photo_path IS NOT NULL) AS has_photo,
              (vehicle_photo_path IS NOT NULL) AS has_vehicle_photo, selfie_checked_at
         FROM drivers WHERE user_id = $1`, [userId])
    : null;
  const rides = await query(
    `SELECT r.id, r.requested_at, r.completed_at, r.cancelled_at, r.status, r.kind, coalesce(c.name, r.category_code) AS service,
            r.origin_address, r.dest_address, r.distance_km, r.duration_min, r.price_cents, r.payment_method,
            CASE WHEN r.driver_id = $1 THEN r.commission_cents END AS commission_cents,
            CASE WHEN r.passenger_id = $1 THEN 'passageiro' ELSE 'motorista' END AS as_role,
            r.passenger_rating, r.driver_rating
       FROM rides r LEFT JOIN ride_categories c ON c.tenant_id = r.tenant_id AND c.code = r.category_code
      WHERE r.passenger_id = $1 OR r.driver_id = $1 ORDER BY r.requested_at`,
    [userId],
  );
  const payments = await query(
    `SELECT kind, description, amount_cents, status, created_at, paid_at FROM charges WHERE driver_id = $1 ORDER BY created_at`, [userId],
  );
  const commissions = await query(
    `SELECT period_start, period_end, rides, amount_cents, status, paid_at FROM commission_invoices WHERE driver_id = $1 ORDER BY period_start`, [userId],
  );
  const devices = await one(`SELECT count(*)::int AS n FROM push_tokens WHERE user_id = $1`, [userId]);
  const family = await query(
    `SELECT name, phone, relation, declared_woman, monthly_limit_cents, notes, active, created_at FROM family_members WHERE owner_id = $1 ORDER BY name`,
    [userId],
  );
  const cashback = await query(
    `SELECT kind, amount_cents, expires_at, ride_id, note, created_at FROM cashback_ledger WHERE user_id = $1 ORDER BY id`, [userId],
  );
  const club = await query(
    `SELECT amount_cents, period_start, period_end, created_at FROM club_payments WHERE user_id = $1 ORDER BY created_at`, [userId],
  );
  const school = await query(
    `SELECT c.student_name, c.grade, s.name AS school, c.home_address, c.legs, c.weekdays, c.pickup_time, c.return_time, c.monthly_cents,
            c.status, c.paid_until, c.consent_at, c.created_at
       FROM school_contracts c JOIN schools s ON s.id = c.school_id WHERE c.parent_id = $1 ORDER BY c.created_at`, [userId],
  );
  const messages = await query(
    `SELECT ride_id, body, created_at FROM ride_messages WHERE sender_id = $1 ORDER BY created_at`, [userId],
  );
  const foodOrders = await query(
    `SELECT o.number, a.name AS restaurante, o.items, o.total_cents, o.payment, o.status, o.dest_address, o.created_at
       FROM food_orders o JOIN accounts a ON a.id = o.account_id WHERE o.customer_id = $1 ORDER BY o.created_at`, [userId],
  );
  return {
    sobre: `Cópia dos seus dados no app ${u.city}, gerada em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}. `
      + `Responsável pelos dados: ${u.controller ?? u.city}${u.controller_cnpj ? `, CNPJ ${u.controller_cnpj}` : ''}.`
      + `${u.dpo_email ? ` Dúvidas ou pedidos: ${u.dpo_email}.` : ''}`,
    conta: {
      nome: u.name, celular: u.phone, tipo: u.role === 'driver' ? 'motorista' : 'passageiro', cadastro: u.created_at,
      celularConfirmadoEm: u.phone_verified_at, daquiMulher: u.declared_woman,
      politicaDePrivacidade: { versaoAceita: u.privacy_version, aceitaEm: u.privacy_accepted_at },
      aparelhosComNotificacao: devices?.n ?? 0,
      preferenciasDaViagem: u.trip_prefs,
    },
    motorista: driver,
    corridas: rides,
    pagamentos: payments,
    comissoes: commissions,
    mensagensEnviadasNoChat: messages,
    familia: family,
    cashback: cashback,
    clube: club,
    transporteEscolar: school,
    pedidosDaquiFood: foodOrders,
  };
}
