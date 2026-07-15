
import axios from 'axios';
import { sapConfig } from '../config.js';
import jwt from 'jsonwebtoken';
import { sapServerSecret } from '../config.js';

function makeSapTokenForUser(req) {

  // ✅ USER CONTEXT (normal requests)
  if (req && req.session?.user) {
    return jwt.sign(
      {
        userId: req.session.user.userID,
        username: req.session.user.username,
        role: req.session.user.role,
        departments: req.session.user.departments
      },
      sapServerSecret,
      {
        issuer: 'sql2005-bridge',
        audience: 'sap-server',
        expiresIn: '60s'
      }
    );
  }

  // ✅ SYSTEM CONTEXT (cron / background)
  return jwt.sign(
    {
      userId: '0',
      username: 'system-refresh',
      role: 'system',
      departments: ['ALL']
    },
    sapServerSecret,
    {
      issuer: 'sql2005-bridge',
      audience: 'sap-server',
      expiresIn: '60s'
    }
  );
}


const client = axios.create({
  baseURL: sapConfig.url,
  timeout: 10 * 60 * 1000
});


function auth(req) {
  return {
    headers: {
      Authorization: `Bearer ${makeSapTokenForUser(req)}`
    }
  };
}

function unwrap(response) {
  const { success, data, error } = response.data;
  if (!success) throw new Error(error?.message || 'SAP API call failed');
  return data;
}

export const getStock = (req) =>
  client.get('/api/performance/stock', auth(req))
    .then(unwrap)
    .catch(err => {
      console.error('SAP ERROR (Stock):', err.response?.data);
      throw err;
    });


export const getAgreements = (req, horizonDays = 365) =>
  client.get('/api/performance/agreements', {
    ...auth(req), params: { horizonDays } })
      .then(unwrap)
      .catch(err => {
      console.error('SAP ERROR (Agreements):', err.response?.data);
      throw err;
    });

export const getInvoicing = (req, from, to) =>
  client.get('/api/performance/invoicing', {
    ...auth(req), params: { from, to } })
      .then(unwrap)
      .catch(err => {
      console.error('SAP ERROR (Invoicing):', err.response?.data);
      throw err;
    });

export const getOtif = (req, from, to) =>
  client.get('/api/performance/otif', {
    ...auth(req), params: { from, to } })
      .then(unwrap)
      .catch(err => {
      console.error('SAP ERROR (Otif):', err.response?.data);
      throw err;
    });

// ── MM Turns / Valuation Class ────────────────────────────────────────────────
// query may include: plant, profitCentres[], materials[], mrpControllers[],
// materialTypes[], valuationClasses[], turnMonths, historyMode — all optional,
// passed straight through as query params (axios serialises arrays as repeated
// keys, which ASP.NET model-binds into the [FromQuery] TurnsValClassQuery array props).
export const getTurnsValClass = (req, query = {}) =>
  client.get('/api/performance/turns-valclass', {
    ...auth(req), params: query })
      .then(unwrap)
      .catch(err => {
      console.error('SAP ERROR (TurnsValClass):', err.response?.data);
      throw err;
    });

export const getValuationClassCatalog = (req) =>
  client.get('/api/performance/turns-valclass/valuation-classes', auth(req))
    .then(unwrap)
    .catch(err => {
      console.error('SAP ERROR (ValuationClassCatalog):', err.response?.data);
      throw err;
    });

// WRITES to SAP — moves stock out/in and runs MM02. A 422 from SapServer means
// the pre-check rejected the batch (still a structured ChangeValuationClassResponse,
// not just an error) — surface that body instead of collapsing to a generic axios error.
export const postChangeValuationClass = (req, body) =>
  client.post('/api/performance/turns-valclass/change-valuation-class', body, auth(req))
    .then(unwrap)
    .catch(err => {
      console.error('SAP ERROR (ChangeValuationClass):', err.response?.data);
      const apiBody = err.response?.data;
      if (apiBody && apiBody.data) {
        const e = new Error(apiBody.error?.message || 'Valuation class change failed validation.');
        e.data = apiBody.data;
        throw e;
      }
      throw err;
    });