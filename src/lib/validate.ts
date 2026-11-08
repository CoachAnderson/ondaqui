import { z } from 'zod';
import { badRequest } from './errors.js';

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
    throw badRequest(`${where}${issue.message}`, 'dados_invalidos');
  }
  return r.data;
}

/** Telefone só com dígitos, 10 a 13 números (com ou sem 55) */
export const phone = z
  .string()
  .transform((s) => s.replace(/\D/g, ''))
  .refine((s) => s.length >= 10 && s.length <= 13, 'telefone inválido');

export const latLng = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const place = latLng.extend({ address: z.string().min(3).max(200) });

export const uuid = z.string().uuid();
