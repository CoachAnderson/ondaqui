import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, centro, destino, login, startServer, stopServer, type Ctx } from './helpers.js';
import { one, query } from '../src/lib/db.js';

let ctx: Ctx;
let admin: string, joao: string, maria: string, joaoId: string, rideId: string, share: string;

beforeAll(async () => {
  ctx = await startServer();
  admin = await login(ctx, '14900000001');
  joao = await login(ctx, '14900000020');
  maria = await login(ctx, '14900000010');
  joaoId = (await one(`SELECT id FROM users WHERE phone = '14900000020'`)).id;
  const r = await api(ctx, 'POST', '/rides', { origin: centro, destination: destino, paymentMethod: 'pix' }, maria);
  rideId = r.body.ride.id;
  // motorista já aceitou (o despacho é testado em outro arquivo)
  const row = await one(`UPDATE rides SET driver_id = $2, status = 'accepted', accepted_at = now() WHERE id = $1 RETURNING share_token`, [rideId, joaoId]);
  share = row.share_token;
});
afterAll(async () => stopServer(ctx));

const passengerSees = async () => (await api(ctx, 'GET', '/rides/current', undefined, maria)).body.ride.driver.camera;
const familySees = async () => (await api(ctx, 'GET', `/public/share/${share}`)).body.driver.camera;

describe('câmera no veículo', () => {
  it('sem câmera: nada a avisar', async () => {
    expect(await passengerSees()).toBeNull();
    expect((await api(ctx, 'GET', '/public/tenants/bauru')).body.camerasInUse).toBe(false);
  });

  it('motorista só declara aceitando o compromisso; o passageiro e a família passam a ser avisados', async () => {
    let r = await api(ctx, 'PUT', '/driver/camera', { kind: 'video_audio' }, joao);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('compromisso_camera');
    r = await api(ctx, 'PUT', '/driver/camera', { kind: 'video_audio', agree: true }, joao);
    expect(r.body).toEqual({ cameraKind: 'video_audio', cameraStatus: 'pending' });

    expect(await passengerSees()).toBe('video_audio');
    expect(await familySees()).toBe('video_audio');
    expect((await api(ctx, 'GET', '/public/tenants/bauru')).body.camerasInUse).toBe(true);
    expect((await api(ctx, 'GET', '/driver/me', undefined, joao)).body).toMatchObject({ camera_kind: 'video_audio', camera_status: 'pending' });
  });

  it('a central confere ou barra; barrada, o aviso some (e o motorista não pode gravar)', async () => {
    let d = await api(ctx, 'PATCH', `/admin/drivers/${joaoId}`, { cameraApproved: false }, admin);
    expect(d.body.driver.camera).toMatchObject({ kind: 'video_audio', status: 'rejected' });
    expect(await passengerSees()).toBeNull();

    d = await api(ctx, 'PATCH', `/admin/drivers/${joaoId}`, { cameraApproved: true }, admin);
    expect(d.body.driver.camera.status).toBe('approved');
    expect(await passengerSees()).toBe('video_audio');

    // mudar para só vídeo volta para conferência, mas continua avisando
    const r = await api(ctx, 'PUT', '/driver/camera', { kind: 'video', agree: true }, joao);
    expect(r.body.cameraStatus).toBe('pending');
    expect(await passengerSees()).toBe('video');
  });

  it('tirou a câmera: some o aviso; central não confere quem não declarou', async () => {
    await api(ctx, 'PUT', '/driver/camera', { kind: 'none' }, joao);
    expect(await passengerSees()).toBeNull();
    const d = await api(ctx, 'PATCH', `/admin/drivers/${joaoId}`, { cameraApproved: true }, admin);
    expect(d.body.code).toBe('sem_camera');
  });

  it('entrega não mostra câmera no link do destinatário', async () => {
    await api(ctx, 'PUT', '/driver/camera', { kind: 'video', agree: true }, joao);
    await query(`UPDATE rides SET kind = 'entrega' WHERE id = $1`, [rideId]);
    expect(await familySees()).toBeNull();
  });
});
