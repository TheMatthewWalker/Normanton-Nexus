import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { buildTestApp } from '../helpers/testApp.js';

process.env.CLEARPORT_API_TOKEN ??= 'test-clearport-token';

const axiosMock = { post: jest.fn() };
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));

let clearportRouter;
let app;

beforeAll(async () => {
  ({ default: clearportRouter } = await import('../../routes/clearportexport.js'));
  app = buildTestApp(clearportRouter);
});

beforeEach(() => {
  axiosMock.post.mockReset();
});

const validPayload = { items: [{ commodityCode: '123456' }], exporter: 'Kongsberg Automotive' };

describe('POST /exports', () => {
  test('rejects a declaration with no items', async () => {
    const res = await request(app).post('/exports').send({ exporter: 'Kongsberg Automotive', items: [] });
    expect(res.status).toBe(400);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('rejects a declaration with no exporter', async () => {
    const res = await request(app).post('/exports').send({ items: [{ commodityCode: '123456' }] });
    expect(res.status).toBe(400);
  });

  test('forwards a valid declaration and returns ClearPort\'s response on success', async () => {
    axiosMock.post.mockResolvedValueOnce({ status: 201, data: { declarationId: 'CP123' } });

    const res = await request(app).post('/exports').send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, clearport: { declarationId: 'CP123' } });
    const [url, body, options] = axiosMock.post.mock.calls[0];
    expect(url).toContain('/v1/cds/exports');
    expect(body).toEqual(validPayload);
    expect(options.headers.Authorization).toBe('Bearer test-clearport-token');
  });

  test('maps a 401 from ClearPort to a 502 with a clear message', async () => {
    const err = new Error('unauthorized');
    err.response = { status: 401, data: { message: 'Invalid token' } };
    axiosMock.post.mockRejectedValueOnce(err);

    const res = await request(app).post('/exports').send(validPayload);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/rejected the API token/);
  });

  test('passes a 429 from ClearPort straight through', async () => {
    const err = new Error('rate limited');
    err.response = { status: 429, data: {} };
    axiosMock.post.mockRejectedValueOnce(err);

    const res = await request(app).post('/exports').send(validPayload);

    expect(res.status).toBe(429);
  });

  test('passes through other ClearPort error statuses with the validation detail', async () => {
    const err = new Error('bad request');
    err.response = { status: 400, data: { detail: 'Invalid commodity code' } };
    axiosMock.post.mockRejectedValueOnce(err);

    const res = await request(app).post('/exports').send(validPayload);

    expect(res.status).toBe(400);
    expect(res.body.clearportBody).toEqual({ detail: 'Invalid commodity code' });
  });

  test('maps a network/timeout failure (no response) to a 502', async () => {
    axiosMock.post.mockRejectedValueOnce(new Error('ETIMEDOUT'));

    const res = await request(app).post('/exports').send(validPayload);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Could not reach ClearPort API/);
  });
});
