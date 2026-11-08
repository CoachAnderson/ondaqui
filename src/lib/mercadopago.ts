import { createHmac, timingSafeEqual } from 'node:crypto';
import { MercadoPagoConfig, Payment, PaymentRefund, Preference } from 'mercadopago';

/**
 * Acesso ao Mercado Pago (SDK oficial). Cada chamada recebe o token da conta
 * que vai receber: a do licenciado (mensalidade do motorista) ou a da plataforma (fatura).
 * Os testes trocam este gateway por um simulado (setMercadoPagoGateway).
 */
export interface PreferenceInput {
  title: string;
  itemId: string;
  amountCents: number;
  externalReference: string;
  notificationUrl: string;
  backUrl: string;
  autoReturn: boolean;
  expiresInHours: number;
  statementDescriptor: string;
}

export interface MpPayment {
  id: string;
  status: string; // approved, pending, in_process, rejected, cancelled, refunded, charged_back
  external_reference: string | null;
  transaction_amount: number;
  currency_id: string;
}

export interface MpAccount { id: string; nickname: string; site_id: string }

/** Pix com valor gerado na conta de quem recebe (cobrança do produto na entrega) */
export interface PixInput { amountCents: number; description: string; externalReference: string; notificationUrl: string; payerEmail: string; expiresInMinutes: number }
export interface PixCharge { id: string; status: string; qrCode: string; qrCodeBase64: string }

export interface MercadoPagoGateway {
  createPreference(token: string, p: PreferenceInput, idempotencyKey: string): Promise<{ id: string; init_point: string }>;
  getPayment(token: string, id: string): Promise<MpPayment>;
  findPaymentsByReference(token: string, externalReference: string): Promise<MpPayment[]>;
  getAccount(token: string): Promise<MpAccount>;
  createPixPayment(token: string, p: PixInput, idempotencyKey: string): Promise<PixCharge>;
  /** Devolve o valor total de um pagamento (pedido recusado ou cancelado no Daqui Food) */
  refundPayment(token: string, id: string, idempotencyKey: string): Promise<{ status: string }>;
}

const TIMEOUT_MS = 10_000;

/** auto_return só é aceito pelo Mercado Pago com endereço público em HTTPS */
export function isPublicHttps(url: string) {
  return /^https:\/\//i.test(url) && !/^https:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::|\/|$)/i.test(url);
}

const sdkGateway: MercadoPagoGateway = {
  async createPreference(token, p, idempotencyKey) {
    const client = new MercadoPagoConfig({ accessToken: token, options: { timeout: TIMEOUT_MS } });
    const expires = new Date(Date.now() + p.expiresInHours * 3600_000).toISOString();
    const r = await new Preference(client).create({
      body: {
        items: [{ id: p.itemId, title: p.title, quantity: 1, unit_price: p.amountCents / 100, currency_id: 'BRL' }],
        external_reference: p.externalReference,
        notification_url: p.notificationUrl,
        back_urls: { success: p.backUrl, pending: p.backUrl, failure: p.backUrl },
        // auto_return só com endereço público HTTPS (o Mercado Pago recusa localhost)
        ...(p.autoReturn ? { auto_return: 'approved' } : {}),
        expires: true,
        expiration_date_to: expires,
        statement_descriptor: p.statementDescriptor,
      },
      requestOptions: { idempotencyKey },
    });
    // o link de pagamento é sempre o init_point (vale para teste e produção)
    if (!r.id || !r.init_point) throw new Error('Mercado Pago não devolveu o link de pagamento');
    return { id: r.id, init_point: r.init_point };
  },

  async getPayment(token, id) {
    const client = new MercadoPagoConfig({ accessToken: token, options: { timeout: TIMEOUT_MS } });
    const p = await new Payment(client).get({ id });
    return {
      id: String(p.id), status: String(p.status), external_reference: p.external_reference ?? null,
      transaction_amount: Number(p.transaction_amount), currency_id: String(p.currency_id),
    };
  },

  async findPaymentsByReference(token, externalReference) {
    const client = new MercadoPagoConfig({ accessToken: token, options: { timeout: TIMEOUT_MS } });
    const r = await new Payment(client).search({
      options: { external_reference: externalReference, sort: 'date_created', criteria: 'desc' },
    });
    return (r.results ?? []).map((p) => ({
      id: String(p.id), status: String(p.status), external_reference: p.external_reference ?? null,
      transaction_amount: Number(p.transaction_amount), currency_id: String(p.currency_id),
    }));
  },

  async createPixPayment(token, p, idempotencyKey) {
    const client = new MercadoPagoConfig({ accessToken: token, options: { timeout: TIMEOUT_MS } });
    const r = await new Payment(client).create({
      body: {
        transaction_amount: p.amountCents / 100,
        description: p.description,
        payment_method_id: 'pix',
        payer: { email: p.payerEmail },
        external_reference: p.externalReference,
        notification_url: p.notificationUrl,
        date_of_expiration: new Date(Date.now() + p.expiresInMinutes * 60_000).toISOString(),
      },
      requestOptions: { idempotencyKey },
    });
    const td = r.point_of_interaction?.transaction_data;
    if (!r.id || !td?.qr_code) throw new Error('Mercado Pago não devolveu o Pix');
    return { id: String(r.id), status: String(r.status), qrCode: td.qr_code, qrCodeBase64: td.qr_code_base64 ?? '' };
  },

  async refundPayment(token, id, idempotencyKey) {
    const client = new MercadoPagoConfig({ accessToken: token, options: { timeout: TIMEOUT_MS } });
    const r = await new PaymentRefund(client).total({ payment_id: id, requestOptions: { idempotencyKey } });
    return { status: String(r.status ?? 'approved') };
  },

  async getAccount(token) {
    const res = await fetch('https://api.mercadopago.com/users/me', {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Mercado Pago recusou o token (${res.status})`);
    const u = (await res.json()) as { id: number; nickname: string; site_id: string };
    return { id: String(u.id), nickname: u.nickname, site_id: u.site_id };
  },
};

let gateway: MercadoPagoGateway = sdkGateway;
export const mp = () => gateway;
export function setMercadoPagoGateway(g: MercadoPagoGateway | null) { gateway = g ?? sdkGateway; }

/**
 * Valida a assinatura x-signature de uma notificação (HMAC-SHA256).
 * Manifesto oficial: "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
 * (data.id vem da URL; se for alfanumérico, em minúsculas).
 */
export function validSignature(secret: string, signatureHeader: string | undefined, requestId: string | undefined, dataId: string | undefined) {
  if (!secret || !signatureHeader || !requestId || !dataId) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const { ts, v1 } = parts as { ts?: string; v1?: string };
  if (!ts || !v1 || !/^[0-9a-f]+$/i.test(v1)) return false;
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  const expected = createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
