import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Variável de ambiente ${name} não definida`);
  return v;
}

export const config = {
  databaseUrl: required('DATABASE_URL', 'postgres://ondaqui:ondaqui@localhost:5432/ondaqui'),
  jwtSecret: required('JWT_SECRET', process.env.NODE_ENV === 'production' ? undefined : 'dev-secret-nao-usar-em-producao'),
  port: Number(process.env.PORT ?? 3333),
  isProduction: process.env.NODE_ENV === 'production',
  /** endereços do painel que podem chamar a API (separados por vírgula). Vazio = qualquer um (só em desenvolvimento) */
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  /** aplica as migrações do banco ao iniciar */
  runMigrations: process.env.RUN_MIGRATIONS !== 'false',
  uploadDir: process.env.UPLOAD_DIR ?? './uploads',
  /** expo = envia push de verdade; off = desligado; test = só guarda (testes automáticos) */
  pushMode: (process.env.PUSH_MODE ?? 'expo') as 'expo' | 'off' | 'test',
  /** opcional: token de acesso da Expo, se ativar "enhanced push security" */
  expoAccessToken: process.env.EXPO_ACCESS_TOKEN ?? '',
  /** endereço público da API (para o Mercado Pago avisar os pagamentos) */
  publicApiUrl: (process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 3333}`).replace(/\/$/, ''),
  /** endereço do painel (link "Voltar ao painel" depois de pagar a fatura) */
  painelUrl: (process.env.PAINEL_URL ?? (process.env.CORS_ORIGINS ?? '').split(',')[0] ?? '').trim().replace(/\/$/, ''),
  /** códigos por SMS ou WhatsApp (veja lib/sms.ts): twilio, webhook, log ou test */
  smsProvider: (process.env.SMS_PROVIDER ?? 'log') as 'twilio' | 'webhook' | 'log' | 'test',
  twilioSid: process.env.TWILIO_ACCOUNT_SID ?? '',
  twilioToken: process.env.TWILIO_AUTH_TOKEN ?? '',
  twilioFrom: process.env.TWILIO_FROM ?? '',
  smsWebhookUrl: process.env.SMS_WEBHOOK_URL ?? '',
  smsWebhookToken: process.env.SMS_WEBHOOK_TOKEN ?? '',
  /** exige o código no cadastro de passageiros e motoristas (off só para testes antigos ou demonstração) */
  phoneVerification: process.env.PHONE_VERIFICATION !== 'off',
  /** empresa dona da tecnologia (operadora dos dados na política de privacidade de cada cidade) */
  platformLegalName: process.env.PLATFORM_LEGAL_NAME ?? 'OnDaqui Tecnologia',
  platformCnpj: process.env.PLATFORM_CNPJ ?? '44.607.634/0001-82',
  /** chave de 32 bytes (64 caracteres hex) para criptografar os tokens do Mercado Pago dos licenciados */
  encryptionKey: process.env.ENCRYPTION_KEY ?? '',
  /** conta Mercado Pago da plataforma (recebe as faturas dos licenciados) */
  mpAccessToken: process.env.MP_ACCESS_TOKEN ?? '',
  mpWebhookSecret: process.env.MP_WEBHOOK_SECRET ?? '',
  /** dia do mês em que vence a fatura do licenciado */
  invoiceDueDay: Number(process.env.INVOICE_DUE_DAY ?? 10),
  /** dias de atraso para suspender o licenciado automaticamente (0 = nunca) */
  suspendAfterDays: Number(process.env.BILLING_SUSPEND_AFTER_DAYS ?? 15),
  /** serviço de rotas OSRM (ex.: http://rotas:5000). Vazio = estimativa por linha reta */
  routingUrl: (process.env.ROUTING_URL ?? '').replace(/\/$/, ''),
  routingTimeoutMs: Number(process.env.ROUTING_TIMEOUT_MS ?? 1500),
  /** o OSRM calcula o tempo sem trânsito; multiplica por este fator para a cidade */
  routingTimeFactor: Number(process.env.ROUTING_TIME_FACTOR ?? 1.3),
  /** horas que a loja tem para conferir o produto cobrado na entrega (Pix na chave ou maquininha) */
  codConfirmHours: 24,
  /** motorista online sem enviar localização por mais tempo que isso fica offline */
  driverOfflineAfterMin: 10,
  /** motorista sem enviar localização há mais tempo que isso não recebe corridas */
  driverLocationMaxAgeSec: 120,
  /** corrida sem motorista é cancelada depois desse tempo */
  rideSearchTimeoutMin: 5,
  /** quantos motoristas recebem a oferta de uma vez */
  offersPerRound: 5,
};
