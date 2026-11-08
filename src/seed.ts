import { fileURLToPath } from 'node:url';
import { copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { config } from './lib/config.js';
import { one, pool, query, tx } from './lib/db.js';
import { hashPassword } from './lib/auth.js';
import { createTenantDefaults } from './lib/rides.js';
import { migrate } from './migrate.js';

/**
 * Dados de demonstração: um master, a cidade "OnDaqui Bauru", o licenciado,
 * dois motoristas aprovados e um passageiro. NÃO use em produção.
 */
/** Fotos de demonstração (já aprovadas) copiadas para a pasta de uploads */
async function demoPhoto(kind: 'motorista' | 'veiculo', slug: string) {
  const dir = resolve(config.uploadDir, 'motoristas');
  await mkdir(dir, { recursive: true });
  const name = `demo-${kind}-${slug}.png`;
  await copyFile(fileURLToPath(new URL(`../demo/${kind}-${slug}.png`, import.meta.url)), join(dir, name));
  return `motoristas/${name}`;
}

/** Ilustrações de demonstração dos pratos do Daqui Food copiadas para a pasta de uploads */
async function demoDish(name: string) {
  const dir = resolve(config.uploadDir, 'cardapio');
  await mkdir(dir, { recursive: true });
  const file = `demo-${name}.jpg`;
  await copyFile(fileURLToPath(new URL(`../demo/prato-${name}.jpg`, import.meta.url)), join(dir, file));
  return `cardapio/${file}`;
}

export async function seed() {
  if (process.env.NODE_ENV === 'production') throw new Error('Seed de demonstração bloqueado em produção');
  await migrate();
  const pw = await hashPassword('ondaqui123');

  await tx(async (db) => {
    const master = await one(`SELECT 1 FROM users WHERE tenant_id IS NULL AND phone = '11900000000'`, [], db);
    if (!master) {
      await query(
        `INSERT INTO users (tenant_id, role, name, phone, password_hash) VALUES (NULL,'master','Dono da Plataforma','11900000000',$1)`,
        [pw], db,
      );
    }

    let t = await one(`SELECT id FROM tenants WHERE slug = 'bauru'`, [], db);
    if (t) return;
    t = await one(
      `INSERT INTO tenants (slug, name, city_label, min_lat, max_lat, min_lng, max_lng, license_monthly_cents,
                            legal_name, cnpj, legal_address, support_email, support_whatsapp, dpo_name, dpo_email)
       VALUES ('bauru','OnDaqui Bauru','Bauru', -22.42, -22.22, -49.18, -48.96, 49900,
               'Mobilidade Bauru Demonstração Ltda', '00.000.000/0001-00', 'Rua Exemplo, 100, Centro, Bauru/SP, 17010-000',
               'atendimento@exemplo.com.br', '(14) 99999-0000', 'Encarregado de Demonstração', 'privacidade@exemplo.com.br')
       RETURNING id`,
      [], db,
    );
    await createTenantDefaults(t!.id, db);

    const user = async (role: string, name: string, phone: string) =>
      (await one(
        `INSERT INTO users (tenant_id, role, name, phone, password_hash, privacy_version, privacy_accepted_at)
         VALUES ($1,$2,$3,$4,$5, 1, now()) RETURNING id`,
        [t!.id, role, name, phone, pw], db,
      ))!.id as string;

    await user('tenant_admin', 'Central OnDaqui Bauru', '14900000001');
    const maria = await user('passenger', 'Maria Passageira', '14900000010');
    await query(`UPDATE users SET declared_woman = true WHERE id = $1`, [maria], db); // pode usar o Daqui Mulher

    const drivers = [
      { slug: 'joao', name: 'João Motorista', phone: '14900000020', plate: 'BAU1A23', model: 'Onix', color: 'Prata', plan: 'profissional', lat: -22.3150, lng: -49.0700,
        vehicle: 'carro', services: ['entrega', 'particular', 'pet'], verified: ['executivo', 'paciente', 'cadeirante'] },
      { slug: 'ana', name: 'Ana Motorista', phone: '14900000021', plate: 'BAU2B34', model: 'HB20', color: 'Branco', plan: 'livre', lat: -22.3300, lng: -49.0600,
        vehicle: 'carro', services: ['entrega'], verified: ['mulher'] },
      { slug: 'carlos', name: 'Carlos Motoboy', phone: '14900000022', plate: 'BAU3C45', model: 'CG 160', color: 'Vermelha', plan: 'semanal', lat: -22.3200, lng: -49.0800,
        vehicle: 'moto', services: ['entrega'], verified: [] },
      { slug: 'pedro', name: 'Pedro Fretes', phone: '14900000023', plate: 'BAU4D56', model: 'Fiorino', color: 'Branca', plan: 'livre', lat: -22.3280, lng: -49.0900,
        vehicle: 'utilitario', services: [], verified: [] },
    ];
    for (const d of drivers) {
      const id = await user('driver', d.name, d.phone);
      await query(
        `INSERT INTO drivers (user_id, status, vehicle_plate, vehicle_model, vehicle_color,
            cnh_ear_ok, inss_ok, criminal_record_ok, insurance_app_ok,
            pix_key, pix_holder_name, pix_validated, plan_code, trial_until, lat, lng, location_at,
            vehicle_type, category_code, services_opt_in, verified, photo_path, vehicle_photo_path, photo_status)
         VALUES ($1,'approved',$2,$3,$4,true,true,true,true,$5,$6,true,$7,current_date + 30,$8,$9,now(),$10,$11,$12,$13,$14,$15,'approved')`,
        [id, d.plate, d.model, d.color, `${d.phone}`, d.name, d.plan, d.lat, d.lng,
         d.vehicle, d.vehicle === 'moto' ? 'moto' : d.vehicle === 'utilitario' ? 'frete' : 'carro', d.services, d.verified,
         await demoPhoto('motorista', d.slug), await demoPhoto('veiculo', d.slug)], db,
      );
    }

    // Daqui Prefeitura: convênio da Saúde com um operador, um paciente e destinos frequentes
    const acc = await one(
      `INSERT INTO accounts (tenant_id, name, document, contact_name, contact_phone)
       VALUES ($1, 'Secretaria Municipal de Saúde de Bauru', '00.000.000/0001-00', 'Coordenação de Transporte', '1432000000') RETURNING id`,
      [t!.id], db,
    );
    await query(
      `INSERT INTO users (tenant_id, role, name, phone, password_hash, account_id) VALUES ($1,'account_operator','Central da Saúde','14900000030',$2,$3)`,
      [t!.id, pw, acc!.id], db,
    );
    await query(
      `INSERT INTO patients (account_id, name, phone, document, address, lat, lng, wheelchair, needs_companion, notes) VALUES
         ($1, 'José da Silva', '14988887777', 'CNS 700000000000000', 'Rua Araújo Leite, 200, Vila Falcão', -22.3100, -49.0950, false, true, 'Hemodiálise às segundas, quartas e sextas'),
         ($1, 'Benedita Souza', '14977776666', 'CNS 700000000000001', 'Rua Gustavo Maciel, 50, Centro', -22.3230, -49.0750, true, true, 'Cadeirante')`,
      [acc!.id], db,
    );
    // Daqui Entrega para lojas: uma farmácia com créditos pré-pagos e Pix conferido
    const loja = await one(
      `INSERT INTO accounts (tenant_id, name, document, kind, address, lat, lng, billing_mode, balance_cents, discount_pct,
                             pix_key, pix_holder_name, pix_validated)
       VALUES ($1, 'Farmácia Central', '11.111.111/0001-11', 'loja', 'Rua Batista de Carvalho, 100, Centro, Bauru', -22.3260, -49.0700,
               'prepago', 10000, 10, 'farmacia@central.com.br', 'Farmácia Central Ltda', true) RETURNING id`,
      [t!.id], db,
    );
    await query(
      `INSERT INTO account_ledger (account_id, kind, amount_cents, balance_after, note) VALUES ($1, 'recarga', 10000, 10000, 'crédito de demonstração')`,
      [loja!.id], db,
    );
    await query(
      `INSERT INTO users (tenant_id, role, name, phone, password_hash, account_id) VALUES ($1,'account_operator','Atendente da Farmácia','14900000040',$2,$3)`,
      [t!.id, pw, loja!.id], db,
    );
    // Daqui Food: um restaurante com cardápio, aberto o dia todo (demonstração)
    await query(`UPDATE tenants SET food_enabled = true WHERE id = $1`, [t!.id], db);
    const all = JSON.stringify(Array.from({ length: 7 }, () => [['00:00', '23:59']]));
    const rest = await one(
      `INSERT INTO accounts (tenant_id, name, document, kind, address, lat, lng, billing_mode, balance_cents, discount_pct,
                             food_enabled, food_category, food_description, food_hours, food_prep_min, food_min_order_cents)
       VALUES ($1, 'Cantina da Praça', '22.222.222/0001-22', 'loja', 'Praça Rui Barbosa, 50, Centro, Bauru', -22.3249, -49.0866,
               'prepago', 10000, 0, true, 'Italiana', 'Massas e pizzas feitas na hora', $2::jsonb, 25, 2000) RETURNING id`,
      [t!.id, all], db,
    );
    await query(
      `INSERT INTO account_ledger (account_id, kind, amount_cents, balance_after, note) VALUES ($1, 'recarga', 10000, 10000, 'crédito de demonstração')`,
      [rest!.id], db,
    );
    await query(
      `INSERT INTO users (tenant_id, role, name, phone, password_hash, account_id) VALUES ($1,'account_operator','Cozinha da Cantina','14900000050',$2,$3)`,
      [t!.id, pw, rest!.id], db,
    );
    const cat = async (name: string, sort: number) => (await one(`INSERT INTO menu_categories (account_id, name, sort) VALUES ($1,$2,$3) RETURNING id`, [rest!.id, name, sort], db))!.id;
    const massas = await cat('Massas', 10), pizzas = await cat('Pizzas', 20), bebidas = await cat('Bebidas', 30);
    await query(
      `INSERT INTO menu_items (account_id, category_id, name, description, price_cents, sort, photo_path) VALUES
         ($1, $2, 'Lasanha à bolonhesa', 'Massa fresca, molho de carne e queijo gratinado. Serve 1 pessoa.', 3890, 10, $5),
         ($1, $2, 'Espaguete ao sugo', 'Molho de tomate da casa e manjericão.', 2990, 20, $6),
         ($1, $3, 'Pizza margherita (média)', 'Muçarela, tomate e manjericão. 6 fatias.', 4490, 10, $7),
         ($1, $3, 'Pizza calabresa (média)', 'Calabresa, cebola e azeitona. 6 fatias.', 4290, 20, $8),
         ($1, $4, 'Refrigerante lata', '350 ml', 650, 10, $9),
         ($1, $4, 'Suco natural de laranja', '500 ml', 900, 20, $10)`,
      [rest!.id, massas, pizzas, bebidas, await demoDish('lasanha'), await demoDish('espaguete'), await demoDish('pizza-margherita'),
       await demoDish('pizza-calabresa'), await demoDish('refri'), await demoDish('suco')], db,
    );
    await query(
      `INSERT INTO account_places (account_id, name, address, lat, lng) VALUES
         ($1, 'Hospital Estadual de Bauru', 'Av. Eng. Luís Edmundo Carrijo Coube, Bauru', -22.3388, -49.0447),
         ($1, 'UBS Centro', 'Rua Rio Branco, Centro, Bauru', -22.3255, -49.0710)`,
      [acc!.id], db,
    );
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seed()
    .then(() => {
      console.log('Dados de demonstração criados. Senha de todos: ondaqui123');
      console.log('  Master (painel master):     11900000000');
      console.log('  Licenciado OnDaqui Bauru:     14900000001  (cidade: bauru)');
      console.log('  Passageira:                 14900000010');
      console.log('  Motoristas:                 14900000020 (carro), 14900000021 (carro, Daqui Mulher),');
      console.log('                              14900000022 (moto) e 14900000023 (utilitário, frete)');
      console.log('  Central da Saúde (painel):  14900000030  (cidade: bauru)');
      console.log('  Loja Farmácia Central:      14900000040  (cidade: bauru)');
      console.log('  Restaurante (Daqui Food):   14900000050  (cidade: bauru)');
    })
    .finally(() => pool.end());
}
