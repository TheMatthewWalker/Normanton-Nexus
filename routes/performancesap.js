
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