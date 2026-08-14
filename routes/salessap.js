// routes/salessap.js
//
// SapServer client for the Sales department's SAP-backed features. Same
// per-user JWT / axios pattern as routes/performancesap.js — see that file
// for the makeSapTokenForUser rationale (real user context vs. system/cron
// fallback).
//
// Backs the "Schedule Agreement Waterfall" tool (routes/sales.js's
// GET /schedule-waterfall), a rebuild of
// N:\Config\Office\Templates\AT_46c\sd_waterfall.xltm inside the sales page —
// see that plan's Context section for the full reverse-engineering trail
// from the legacy tool's exported VBA module.

import axios from 'axios';
import jwt from 'jsonwebtoken';
import { sapConfig, sapServerSecret } from '../config.js';

function makeSapTokenForUser(req) {
  if (req && req.session?.user) {
    return jwt.sign(
      {
        userId: req.session.user.userID,
        username: req.session.user.username,
        role: req.session.user.role,
        departments: req.session.user.departments
      },
      sapServerSecret,
      { issuer: 'normanton-nexus', audience: 'sap-server', expiresIn: '60s' }
    );
  }

  return jwt.sign(
    { userId: '0', username: 'system-refresh', role: 'system', departments: ['ALL'] },
    sapServerSecret,
    { issuer: 'normanton-nexus', audience: 'sap-server', expiresIn: '60s' }
  );
}

const client = axios.create({
  baseURL: sapConfig.url,
  timeout: 10 * 60 * 1000
});

function auth(req) {
  return { headers: { Authorization: `Bearer ${makeSapTokenForUser(req)}` } };
}

function unwrap(response) {
  const { success, data, error } = response.data;
  if (!success) throw new Error(error?.message || 'SAP API call failed');
  return data;
}

// query: { salesOrg, shipToParties[], materials[], includeForecast, includeJit,
//          idocCreatedAfter, scheduleDateFrom, scheduleDateTo, includeZeroQty }
// — field names match SapServer's ScheduleWaterfallRequest (System.Text.Json's
// default camelCase policy), so this is passed straight through as the POST body.
export const getScheduleWaterfall = (req, query) =>
  client.post('/api/sales/schedule-waterfall', query, auth(req))
    .then(unwrap)
    .catch(err => {
      console.error('SAP ERROR (ScheduleWaterfall):', err.response?.data);
      throw err;
    });
