// routes/freightbooking.js talks to three externals: mssql (shipment/pallet
// lookups), axios (KN OAuth + booking + document-upload APIs), and the
// filesystem (document upload reads) — plus it imports three helpers from
// the (separately huge, not-yet-tested) routes/shipmentmain.js sibling
// module, which is mocked wholesale here rather than exercised for real.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

process.env.KN_API_URL      ??= 'https://kn-test.invalid/api';
process.env.KN_CUSTOMER_ID  ??= 'TestCustomer';
process.env.KN_CUSTOMER_KEY ??= 'test-kn-customer-key';
process.env.KN_SECRET_64    ??= 'dGVzdC1zZWNyZXQ='; // base64 "test-secret"

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const axiosMock = { get: jest.fn(), post: jest.fn() };
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));

const shipmentMainMock = {
  getShipmentContext: jest.fn(),
  getShipmentFolderInfo: jest.fn(),
  writeShipmentEvent: jest.fn().mockResolvedValue(undefined),
};
jest.unstable_mockModule('../../routes/shipmentmain.js', () => shipmentMainMock);

// Mocking 'fs'/'fs/promises' module-wide would also intercept config.js's
// own real fs.readFileSync("./config.json") call (config.js is imported
// transitively by nearly everything) — wrap the real implementations as the
// default mock behavior instead of replacing them outright, so only tests
// that explicitly override a call (mockReturnValueOnce/mockResolvedValueOnce)
// see fake data; everything else — including config.js's own read — still
// hits the real filesystem.
const realFsp = await import('fs/promises');
const fspMock = {
  stat: jest.fn(realFsp.default.stat),
  readFile: jest.fn(realFsp.default.readFile),
};
jest.unstable_mockModule('fs/promises', () => ({ default: fspMock }));

const realFs = await import('fs');
const fsMock = {
  readFileSync: jest.fn(realFs.default.readFileSync),
};
jest.unstable_mockModule('fs', () => ({ default: fsMock }));

const logPlanningUser = { ...operatorUser, permissions: ['LOG_PLANNING'] };

let freightRouter;
let app;

beforeAll(async () => {
  ({ default: freightRouter } = await import('../../routes/freightbooking.js'));
  app = buildTestApp(freightRouter, { sessionUser: logPlanningUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  axiosMock.get.mockReset();
  axiosMock.post.mockReset();
  Object.values(shipmentMainMock).forEach(fn => fn.mockClear?.());
  // mockClear only — NOT mockReset, which would wipe the real-fs default
  // implementation these were constructed with (see above).
  fspMock.stat.mockClear();
  fspMock.readFile.mockClear();
  fsMock.readFileSync.mockClear();

  // Every test that reaches KN needs an OAuth token first — the booking/upload
  // endpoints both call getKnAccessToken() before their own real work.
  axiosMock.post.mockImplementation((url) => {
    if (String(url).includes('/oauth2/token')) {
      return Promise.resolve({ data: { access_token: 'test-token', expires_in: 3600 } });
    }
    return Promise.reject(new Error(`Unexpected axios.post to ${url} in test`));
  });
});

describe('POST /shipment/:shipmentId', () => {
  test('404s when the shipment does not exist', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });
    const res = await request(app).post('/shipment/999').send({});
    expect(res.status).toBe(404);
  });

  test('422s when a non-manual shipment has no linked pallets', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ shipmentID: 1, IsManual: false }] })
      .mockResolvedValueOnce({ recordset: [] }); // no pallets
    const res = await request(app).post('/shipment/1').send({});
    expect(res.status).toBe(422);
  });

  test('422s when a manual shipment has no cargo lines', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ shipmentID: 1, IsManual: true }] })
      .mockResolvedValueOnce({ recordset: [] }); // no ManualCargoItem rows
    const res = await request(app).post('/shipment/1').send({});
    expect(res.status).toBe(422);
  });

  test('books successfully and extracts the tracking number from the KN response', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ shipmentID: 1, IsManual: false, originName: 'Normanton Site' }] })
      .mockResolvedValueOnce({ recordset: [{ palletID: 5, palletType: 'Euro', grossWeight: 100 }] });

    axiosMock.post.mockImplementation((url) => {
      if (String(url).includes('/oauth2/token')) return Promise.resolve({ data: { access_token: 'test-token', expires_in: 3600 } });
      if (String(url).endsWith('/bookings')) return Promise.resolve({ data: { bookingID: 'BK123', transactionID: 'TX1', bookingIsSuccessful: true, trackingNumber: 'TRACK123' } });
      return Promise.reject(new Error(`Unexpected axios.post to ${url}`));
    });

    const res = await request(app).post('/shipment/1').send({});

    expect(res.status).toBe(201);
    expect(res.body.bookingID).toBe('BK123');
    expect(res.body.trackingNumber).toBe('TRACK123');
  });

  test('maps a KN API error response through with its status', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ shipmentID: 1, IsManual: false }] })
      .mockResolvedValueOnce({ recordset: [{ palletID: 5, palletType: 'Euro', grossWeight: 100 }] });

    axiosMock.post.mockImplementation((url) => {
      if (String(url).includes('/oauth2/token')) return Promise.resolve({ data: { access_token: 'test-token', expires_in: 3600 } });
      const err = new Error('booking rejected');
      err.response = { status: 422, data: { detail: 'Invalid postal code' } };
      return Promise.reject(err);
    });

    const res = await request(app).post('/shipment/1').send({});

    expect(res.status).toBe(422);
    expect(res.body.knResponse).toEqual({ detail: 'Invalid postal code' });
  });
});

describe('POST /:shipmentId/documents/upload-to-kn', () => {
  test('requires a bookingID', async () => {
    const res = await request(app).post('/1/documents/upload-to-kn').send({ files: [{ fileName: 'a.pdf', category: 'invoice' }] });
    expect(res.status).toBe(400);
  });

  test('requires at least one file', async () => {
    const res = await request(app).post('/1/documents/upload-to-kn').send({ bookingID: 'BK123', files: [] });
    expect(res.status).toBe(400);
  });

  test('dryRun previews without calling the real upload endpoint', async () => {
    shipmentMainMock.getShipmentContext.mockResolvedValueOnce({ shipment: { shipmentID: 1 } });
    shipmentMainMock.getShipmentFolderInfo.mockReturnValueOnce({ shipmentPath: 'C:\\exports\\shipment-1' });
    fspMock.stat.mockResolvedValueOnce({ size: 1024 });

    const res = await request(app)
      .post('/1/documents/upload-to-kn?dryRun=true')
      .send({ bookingID: 'BK123', files: [{ fileName: 'invoice.pdf', category: 'invoice' }] });

    expect(res.status).toBe(200);
    expect(res.body.data.preview).toHaveLength(1);
    expect(res.body.data.preview[0].documentCode).toBe('380'); // invoice
    // Only the OAuth call — never the real /upload call.
    expect(axiosMock.post).toHaveBeenCalledTimes(1);
  });

  test('flags an unknown document category as a per-file failure without uploading it', async () => {
    shipmentMainMock.getShipmentContext.mockResolvedValueOnce({ shipment: { shipmentID: 1 } });
    shipmentMainMock.getShipmentFolderInfo.mockReturnValueOnce({ shipmentPath: 'C:\\exports\\shipment-1' });

    const res = await request(app)
      .post('/1/documents/upload-to-kn')
      .send({ bookingID: 'BK123', files: [{ fileName: 'weird.pdf', category: 'not-a-real-category' }] });

    expect(res.status).toBe(200);
    expect(res.body.data.failed).toEqual([{ fileName: 'weird.pdf', error: "Unknown document category 'not-a-real-category'." }]);
    // Only the OAuth call — the unknown-category file is never read or uploaded.
    expect(axiosMock.post).toHaveBeenCalledTimes(1);
  });

  test('uploads a known-category file and logs a shipment event on success', async () => {
    shipmentMainMock.getShipmentContext.mockResolvedValueOnce({ shipment: { shipmentID: 1 } });
    shipmentMainMock.getShipmentFolderInfo.mockReturnValueOnce({ shipmentPath: 'C:\\exports\\shipment-1' });
    fspMock.readFile.mockResolvedValueOnce(Buffer.from('fake-pdf'));
    fsMock.readFileSync.mockReturnValueOnce('ZmFrZS1wZGY=');
    axiosMock.post.mockImplementation((url) => {
      if (String(url).includes('/oauth2/token')) return Promise.resolve({ data: { access_token: 'test-token', expires_in: 3600 } });
      if (String(url).endsWith('/upload')) return Promise.resolve({ data: { documentId: 'DOC1' } });
      return Promise.reject(new Error(`Unexpected axios.post to ${url}`));
    });

    const res = await request(app)
      .post('/1/documents/upload-to-kn')
      .send({ bookingID: 'BK123', files: [{ fileName: 'invoice.pdf', category: 'invoice' }] });

    expect(res.status).toBe(200);
    expect(res.body.data.uploaded).toEqual([{ fileName: 'invoice.pdf', category: 'invoice', documentCode: '380', documentId: 'DOC1' }]);
    expect(shipmentMainMock.writeShipmentEvent).toHaveBeenCalledWith(
      expect.anything(), 1, 'KN_DOCUMENT_UPLOAD', expect.stringContaining('invoice.pdf'));
  });
});
