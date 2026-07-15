import express from 'express';
import axios from 'axios';

const router = express.Router();

// ── Validate required ClearPort env vars on startup ───────────────────────────
const CLEARPORT_API_URL   = process.env.CLEARPORT_API_URL   || 'https://api.clear-port.com';
const CLEARPORT_API_TOKEN = process.env.CLEARPORT_API_TOKEN;

if (!CLEARPORT_API_TOKEN) {
    console.error('[clearportexport] Missing required env var: CLEARPORT_API_TOKEN');
}

// ── POST /api/clearport/exports ───────────────────────────────────────────────
//
// Forwards a CDS export declaration to the ClearPort API.
// The caller is responsible for assembling the full declaration payload —
// this route validates the minimum required fields, then proxies the request.
//
// Body: ClearPort CDS export schema (see .env.example for API docs reference)
//
// Returns the ClearPort 201 response on success, or a structured error.
// ---------------------------------------------------------------------------
router.post('/exports', async (req, res) => {
    if (!CLEARPORT_API_TOKEN) {
        return res.status(503).json({
            success: false,
            error: 'ClearPort integration is not configured. Check CLEARPORT_API_TOKEN in .env.',
        });
    }

    const payload = req.body;

    // Basic guard — ClearPort will reject if items or exporter are missing,
    // but catch obvious mistakes early to avoid a round-trip.
    if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ success: false, error: 'Request body must be a JSON object.' });
    }
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
        return res.status(400).json({ success: false, error: 'Declaration must include at least one item.' });
    }
    if (!payload.exporter) {
        return res.status(400).json({ success: false, error: 'Declaration must include an exporter.' });
    }

    console.group('[ClearPort] POST /v1/cds/exports');
    console.log('correlationId:', payload.correlationId ?? '(none)');
    console.log('declarationType:', payload.declarationType ?? '(none)');
    console.log('item count:', payload.items.length);

    try {
        const response = await axios.post(
            `${CLEARPORT_API_URL}/v1/cds/exports`,
            payload,
            {
                timeout: 30000,
                headers: {
                    'Content-Type':  'application/json',
                    'Accept':        'application/json',
                    'Authorization': `Bearer ${CLEARPORT_API_TOKEN}`,
                },
            }
        );

        console.log('HTTP status:', response.status);
        console.log('Response:', JSON.stringify(response.data, null, 2));
        console.groupEnd();

        return res.status(201).json({
            success:       true,
            clearport:     response.data,
        });

    } catch (err) {
        console.groupEnd();

        if (err.response) {
            const status = err.response.status;

            if (status === 401) {
                return res.status(502).json({
                    success:         false,
                    error:           'ClearPort rejected the API token (401 Unauthorised). Check CLEARPORT_API_TOKEN.',
                    clearportStatus: 401,
                    clearportBody:   err.response.data,
                });
            }
            if (status === 429) {
                return res.status(429).json({
                    success: false,
                    error:   'ClearPort rate limit reached (429). Please retry shortly.',
                });
            }
            // 400 Bad Request — surface ClearPort's validation detail
            return res.status(status).json({
                success:         false,
                error:           'ClearPort returned an error',
                clearportStatus: status,
                clearportBody:   err.response.data,
            });
        }

        // Network / timeout
        return res.status(502).json({
            success: false,
            error:   `Could not reach ClearPort API: ${err.message}`,
        });
    }
});

export default router;
