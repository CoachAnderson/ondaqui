// Inicia o app no modo passageiro ou motorista (funciona no Windows, Mac e Linux)
//   node scripts/start.mjs passageiro
//   node scripts/start.mjs motorista
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const variant = process.argv[2] === 'motorista' ? 'motorista' : 'passageiro';
const extra = process.argv.slice(3);

// lê app.env (cidade e endereço da API)
const env = { ...process.env, EXPO_PUBLIC_VARIANT: variant };
if (existsSync('app.env')) {
  for (const line of readFileSync('app.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2];
  }
}
console.log(`\nDaqui ${variant} · cidade: ${env.EXPO_PUBLIC_TENANT || '(o usuário escolhe)'} · API: ${env.EXPO_PUBLIC_API_URL}\n`);
const child = spawn('npx', ['expo', 'start', '--clear', ...extra], { stdio: 'inherit', env, shell: process.platform === 'win32' });
child.on('exit', (code) => process.exit(code ?? 0));
