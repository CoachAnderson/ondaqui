import { badRequest } from './errors.js';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { FastifyReply } from 'fastify';
import { config } from './config.js';
import { notFound } from './errors.js';
/** Foto enviada pelo app (base64): aceita só JPG ou PNG de verdade */
export function decodeImage(data: string) {
  const b64 = data.replace(/^data:image\/(jpeg|jpg|png);base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isJpeg && !isPng) throw badRequest('Envie uma foto em JPG ou PNG');
  if (buf.length < 1000) throw badRequest('Foto muito pequena');
  return { buf, ext: isJpeg ? 'jpg' : 'png' };
}


/** Grava a foto em UPLOAD_DIR/<pasta> e devolve o caminho relativo guardado no banco */
export async function saveImage(folder: string, prefix: string, data: string) {
  const { buf, ext } = decodeImage(data);
  const dir = resolve(config.uploadDir, folder);
  await mkdir(dir, { recursive: true });
  const name = `${prefix}-${Date.now()}.${ext}`;
  await writeFile(join(dir, name), buf);
  return `${folder}/${name}`;
}

/** Apaga fotos que não são mais usadas (só dentro de UPLOAD_DIR; ignora as que já não existem) */
export async function removeImages(...relPaths: (string | null | undefined)[]) {
  const base = resolve(config.uploadDir);
  for (const p of relPaths) {
    if (!p) continue;
    const file = resolve(base, p);
    if (file.startsWith(base + sep)) await rm(file, { force: true });
  }
}

/** Responde com a foto guardada (só dentro de UPLOAD_DIR) */
export function sendImage(reply: FastifyReply, relPath: string | null | undefined, what = 'Foto') {
  if (!relPath) throw notFound(`${what} indisponível`);
  const base = resolve(config.uploadDir);
  const file = resolve(base, relPath);
  if (!file.startsWith(base + sep) || !existsSync(file)) throw notFound(`${what} indisponível`);
  reply.type(file.endsWith('.png') ? 'image/png' : 'image/jpeg').header('cache-control', 'private, max-age=300');
  return reply.send(createReadStream(file));
}
