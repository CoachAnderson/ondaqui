import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { one, pool, query } from './lib/db.js';
import { hashPassword } from './lib/auth.js';
import { migrate } from './migrate.js';

/**
 * Cria (ou troca a senha de) um usuário master — o dono da plataforma.
 * Uso:  node dist/criar-master.js "Seu Nome" 14999999999
 * A senha é gerada aqui e mostrada uma única vez.
 */
async function main() {
  const [name, rawPhone] = process.argv.slice(2);
  const phone = (rawPhone ?? '').replace(/\D/g, '');
  if (!name || name.trim().length < 3 || phone.length < 10 || phone.length > 13) {
    console.error('Uso: node dist/criar-master.js "Seu Nome" 14999999999');
    process.exitCode = 1;
    return;
  }
  await migrate();
  const password = randomBytes(12).toString('base64url');
  const hash = await hashPassword(password);
  const exists = await one(`SELECT id FROM users WHERE tenant_id IS NULL AND phone = $1`, [phone]);
  if (exists) {
    await query(`UPDATE users SET name = $2, password_hash = $3, blocked = false WHERE id = $1`, [exists.id, name.trim(), hash]);
  } else {
    await query(
      `INSERT INTO users (tenant_id, role, name, phone, password_hash) VALUES (NULL, 'master', $1, $2, $3)`,
      [name.trim(), phone, hash],
    );
  }
  console.log('');
  console.log(exists ? 'Senha do master trocada.' : 'Usuário master criado.');
  console.log(`  Telefone: ${phone}`);
  console.log(`  Senha:    ${password}`);
  console.log('  Guarde esta senha agora: ela não será mostrada de novo.');
  console.log('  No painel, escolha "Master" na tela de login.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().finally(() => pool.end());
}
