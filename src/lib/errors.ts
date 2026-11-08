export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export const badRequest = (msg: string, code?: string) => new HttpError(400, msg, code);
export const unauthorized = (msg = 'Faça login para continuar') => new HttpError(401, msg, 'nao_autenticado');
export const forbidden = (msg = 'Sem permissão para esta ação') => new HttpError(403, msg, 'sem_permissao');
export const notFound = (msg = 'Não encontrado') => new HttpError(404, msg, 'nao_encontrado');
export const conflict = (msg: string, code?: string) => new HttpError(409, msg, code);
