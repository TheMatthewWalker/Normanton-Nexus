import express from 'express';
import sql from 'mssql';
import axios from 'axios';
import fsp from 'fs/promises';
import path from 'path';
import { sqlConfig } from '../config.js';
import { requirePermission } from '../middleware/auth.js';
import { getShipmentContext, getShipmentFolderInfo, writeShipmentEvent } from './shipmentmain.js';

const router = express.Router();
const getPool = async () => await sql.connect(sqlConfig);

// ── Validate required KN env vars on startup ──────────────────────────────────
const KN_API_URL      = process.env.KN_API_URL;
const KN_CUSTOMER_ID  = process.env.KN_CUSTOMER_ID;
const KN_CUSTOMER_KEY = process.env.KN_CUSTOMER_KEY;
const KN_SECRET       = process.env.KN_SECRET_64;

if (!KN_API_URL || !KN_CUSTOMER_ID || !KN_CUSTOMER_KEY || !KN_SECRET) {
    console.error('[freightbooking] Missing required env vars: KN_API_URL, KN_CUSTOMER_ID, KN_CUSTOMER_KEY, KN_SECRET');
}

// ── Build KN booking payload from DB records ──────────────────────────────────
function buildBookingPayload(shipment, pallets, options = {}) {
    const cargoItems = pallets.map(p => ({
        description:     p.palletType   || 'Pallet',
        marksAndNumbers: String(p.palletID),
        stackable:       false,
        packageCount:    1,
        packageType:     'PLT',
        weight:          Number(p.grossWeight)   || 0,
        weightUom:       'KGM',
        volume:          Number(p.palletVolume)  || 0,
        volumeUom:       'MTQ',
        dimensionLength: Number(p.palletLength) * 10  || 0,
        dimensionWidth:  Number(p.palletWidth) * 10   || 0,
        dimensionHeight: Number(p.palletHeight) * 10  || 0,
        dimensionsUom:   'MMT',
    }));

    const pickupSource = options.plannedCollection || shipment.plannedCollection;
    const pickupDate = pickupSource
        ? new Date(pickupSource).toISOString().split('T')[0]
        : null;

    return {
        customerId:  KN_CUSTOMER_ID,
        customerKey: KN_CUSTOMER_KEY,

        bookingFlags: {
            appointmentRequired: false,
            tailLiftRequired:    false,
            highValue:           false,
            oversizedGoods:      false,
            privateConsignee:    false,
            insurance:           false,
        },

        bookingOptions: [],

        dangerousGoodsPackageCount: 0,

        incoterm: {
            code:     shipment.incoTerms || '',
            location: '',
        },

        shipperParty: {
            address: {
                name1:       shipment.originName        || '',
                street1:     shipment.originStreet      || '',
                city:        shipment.originCity        || '',
                postalCode:  shipment.originPostCode    || '',
                countryCode: shipment.originCountry     || '',
            },
            references: [
            {
                value: String(shipment.shipmentID),
                code: 'ABO'
            },
        ],
        },

        consigneeParty: {
            address: {
                name1:       shipment.destinationName        || '',
                street1:     shipment.destinationStreet      || '',
                city:        shipment.destinationCity        || '',
                postalCode:  shipment.destinationPostCode    || '',
                countryCode: shipment.destinationCountry     || '',
            },
        },

        pickupLocation: {
            address: {
                name1:       shipment.originName        || '',
                street1:     shipment.originStreet      || '',
                city:        shipment.originCity        || '',
                postalCode:  shipment.originPostCode    || '',
                countryCode: shipment.originCountry     || '',
            },
            requestDate: pickupDate,
        },

        deliveryLocation: {
            address: {
                name1:       shipment.destinationName        || '',
                street1:     shipment.destinationStreet      || '',
                city:        shipment.destinationCity        || '',
                postalCode:  shipment.destinationPostCode    || '',
                countryCode: shipment.destinationCountry     || '',
            },
        },

        cargoItems,
    };
}


function extractTrackingNumber(responseData) {
    if (!responseData || typeof responseData !== 'object') return '';
    return String(
        responseData.trackingNumber ||
        responseData.trackingNo ||
        responseData.consignmentNumber ||
        responseData.consignmentNo ||
        responseData.shipmentNumber ||
        responseData.bookingID ||
        responseData.transactionID ||
        ''
    ).trim();
}


// KN's own classification codes for the document types this app cares about
// (per the KN document-code list): 380 Commercial invoice, 271 Packing
// list, 944 Customs documents. 'customs' maps to Customs documents rather
// than Export declaration (833) since that's what ClearPort's CDS export
// PDF actually is here.
const KN_DOCUMENT_CODES = {
    'packing-list': '271',
    invoice:        '380',
    customs:        '944',
};



export async function getKnAccessToken() {
  const tokenUrl = 'https://portal.api.kuehne-nagel.com/oauth2/token';

  const basicAuth = 'Basic ' + KN_SECRET ; // Base64(client_secret)

  try {
    const response = await axios.post(
      tokenUrl,
      new URLSearchParams({
        grant_type: 'client_credentials',
      }),
      {
        headers: {
          Authorization: basicAuth,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        timeout: 15000,
      }
    );
    console.log(`[KN OAuth] Access token obtained, expires in ${response.data.expires_in} seconds.`);
    return response.data; // { access_token, token_type, expires_in, ... }
  } catch (err) {
    if (err.response) {
      throw new Error(
        `KN OAuth error ${err.response.status}: ${JSON.stringify(err.response.data)}`
      );
    }
    throw new Error(`KN OAuth request failed: ${err.message}`);
  }
}



// ── POST /api/freight-booking/shipment/:shipmentId ────────────────────────────
// Creates a KN freight booking for the given shipment, using ShipmentMain as
// the header and all linked PalletMain records as cargoItems.
router.post('/shipment/:shipmentId', async (req, res) => {
    if (!KN_API_URL || !KN_CUSTOMER_ID || !KN_CUSTOMER_KEY) {
        return res.status(503).json({ error: 'Freight booking is not configured. Check KN_API_URL, KN_CUSTOMER_ID, KN_CUSTOMER_KEY in .env.' });
    }

    const shipmentId = req.params.shipmentId;

    let shipment, pallets;

    try {
        const pool = await getPool();

        // Fetch shipment header
        const shipmentResult = await pool.request()
            .input('shipmentId', sql.BigInt, shipmentId)
            .query('USE Logistics SELECT * FROM dbo.ShipmentMain WHERE shipmentID = @shipmentId');

        if (shipmentResult.recordset.length === 0) {
            return res.status(404).json({ error: `Shipment ${shipmentId} not found.` });
        }
        shipment = shipmentResult.recordset[0];

        // Fetch all pallets linked to this shipment via ShipmentLink → DeliveryLink → PalletMain
        const palletsResult = await pool.request()
            .input('shipmentId', sql.BigInt, shipmentId)
            .query(`
                USE Logistics 
                SELECT pm.*
                FROM dbo.PalletMain pm
                INNER JOIN dbo.DeliveryLink dl ON dl.palletID = pm.palletID
                INNER JOIN dbo.ShipmentLink sl ON sl.deliveryID = dl.deliveryID
                WHERE sl.shipmentID = @shipmentId
            `);

        pallets = palletsResult.recordset;

        if (pallets.length === 0) {
            return res.status(422).json({ error: `No pallets found linked to shipment ${shipmentId}.` });
        }

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }

    const payload = buildBookingPayload(shipment, pallets, {
        plannedCollection: req.body?.plannedCollection || null,
    });

    var KN_ACCESS_TOKEN = await getKnAccessToken().then(tokenData => tokenData.access_token);

    try {
        const knResponse = await axios.post(KN_API_URL + '/bookings', payload, {
            headers: {
                'Content-Type': 'application/json',
                'Accept':       'application/problem+json',
                'Authorization': 'Bearer ' + KN_ACCESS_TOKEN
            },
            timeout: 30000,
        });

        return res.status(201).json({
            message: 'Booking created successfully',
            shipmentID: Number(shipmentId),
            bookingID: knResponse.data?.bookingID ?? null,
            transactionID: knResponse.data?.transactionID ?? null,
            bookingIsSuccessful: knResponse.data?.bookingIsSuccessful ?? null,
            trackingNumber: extractTrackingNumber(knResponse.data),
            data: knResponse.data,
            requestPayload: payload,
        });

    } catch (err) {
        if (err.response) {
            // KN API returned an error response
            return res.status(err.response.status).json({
                error:      'KN API returned an error',
                knStatus:   err.response.status,
                knResponse: err.response.data,
            });
        }
        // Network / timeout error
        return res.status(502).json({ error: `Could not reach KN API: ${err.message}` });
    }
});

// ── Upload booking documents to Kuehne+Nagel ──────────────────
// Final step of the KN booking flow (see private/js/logistics.js's
// submitBookingModal): once a booking has been placed and a bookingID
// received, the confirmed invoice/packing-list/customs files — already
// verified present by the operator in the pre-booking popup, never guessed
// again here — are pushed to KN against that booking.
//
// Per KN's API team, the ShipmentDocumentManagement swagger endpoint this
// used to call (KN_DOCUMENTS_API_URL, multipart, keyed by tracking number)
// was the wrong API. The correct one is KN_API_URL + '/upload' — the same
// base URL/OAuth client as booking creation below — which takes a single
// JSON document per call, base64-encoded, keyed by bookingID:
//   { customerID, customerKey, documentCode, documentExtension, bookingID,
//     base64EncodedDocument }
// with Accept: application/problem+json (KN's convention for this API).
//
// bookingID here is exactly what this app already stores as a shipment's
// trackingNumber — extractTrackingNumber (above) falls back to
// responseData.bookingID because that's the only identifier KN's booking
// response actually returns, so the two have always been the same value.
// The caller (submitBookingModal) just passes item.trackingNumber straight
// through under the bookingID key KN's document API expects.
//
// Uploads are attempted independently and reported per-file: a failure
// here doesn't unwind the booking, which has already happened and has its
// own bookingID, so the caller surfaces per-file failures as a warning
// rather than rolling anything back.
//
// ?dryRun=true (or dryRun=1) skips the actual POST to KN — and skips
// logging any ShipmentEvent — so it's safe to hit repeatedly while
// debugging without spamming KN with real uploads. It still does
// everything that can fail before that point (resolves the shipment's
// export folder, stats each file on disk, fetches a real OAuth token) and
// returns the exact payload/headers/URL that would have been sent, so a
// bad fileName/category/token shows up here instead of as an opaque KN
// error. See test.http for a ready-made request.
router.post('/:shipmentId/documents/upload-to-kn', requirePermission('LOG_PLANNING'), async (req, res) => {
  if (!KN_API_URL || !KN_CUSTOMER_ID || !KN_CUSTOMER_KEY) {
    return res.status(503).json({ success: false, error: 'Freight booking is not configured. Check KN_API_URL, KN_CUSTOMER_ID, KN_CUSTOMER_KEY in .env.' });
  }
  const dryRun = ['1', 'true', 'yes'].includes(String(req.query.dryRun || '').trim().toLowerCase());
  try {
    const bookingID = String(req.body.bookingID || '').trim();
    const requestedFiles = Array.isArray(req.body.files) ? req.body.files : [];
    if (!bookingID) {
      return res.status(400).json({ success: false, error: 'bookingID is required.' });
    }
    if (!requestedFiles.length) {
      return res.status(400).json({ success: false, error: 'At least one file is required.' });
    }

    const context = await getShipmentContext(req.params.shipmentId);
    const folder = getShipmentFolderInfo(context.shipment);
    const pool = await getPool();

    let accessToken = null;
    let authError = null;
    try {
      accessToken = (await getKnAccessToken()).access_token;
    } catch (err) {
      authError = err.message;
      if (!dryRun) {
        return res.status(502).json({ success: false, error: `Could not authenticate with Kuehne & Nagel: ${err.message}` });
      }
    }

    const uploaded = [];
    const failed = [];
    const preview = [];

    for (const item of requestedFiles) {
      const fileName = path.basename(String(item?.fileName || ''));
      const category = String(item?.category || '');
      const documentCode = KN_DOCUMENT_CODES[category];
      if (!fileName || !documentCode) {
        failed.push({ fileName: fileName || '(unnamed)', error: `Unknown document category '${category}'.` });
        continue;
      }

      const filePath = path.join(folder.shipmentPath, fileName);
      const documentExtension = (path.extname(fileName).slice(1) || 'pdf').toLowerCase();

      if (dryRun) {
        let fileSizeBytes = null;
        let fileError = null;
        try {
          fileSizeBytes = (await fsp.stat(filePath)).size;
        } catch (err) {
          fileError = `File not found at ${filePath} (${err.code || err.message}).`;
        }
        preview.push({
          fileName, category, documentCode, documentExtension,
          filePath, fileSizeBytes, fileError,
          url: `${KN_API_URL}/upload`,
          headers: {
            'Content-Type': 'application/json',
            'Accept':       'application/problem+json',
            'Authorization': accessToken ? 'Bearer <valid, fetched OK>' : `<KN OAuth FAILED: ${authError}>`,
          },
          payload: {
            customerID:  KN_CUSTOMER_ID,
            customerKey: KN_CUSTOMER_KEY.length > 8 ? `${KN_CUSTOMER_KEY.slice(0, 4)}...${KN_CUSTOMER_KEY.slice(-4)}` : KN_CUSTOMER_KEY,
            documentCode,
            documentExtension,
            bookingID,
            base64EncodedDocument: fileSizeBytes != null ? `<base64, ~${Math.ceil(fileSizeBytes * 4 / 3)} chars, ${fileSizeBytes} byte source file>` : '<unavailable — file could not be read, see fileError>',
          },
        });
        continue;
      }

      try {
        const fileBuffer = await fsp.readFile(filePath);

        const payload = {
          customerID:  KN_CUSTOMER_ID,
          customerKey: KN_CUSTOMER_KEY,
          documentCode,
          documentExtension,
          bookingID,
          base64EncodedDocument: fileBuffer.toString('base64'),
        };

        const response = await axios.post(`${KN_API_URL}/upload`, payload, {
          timeout: 120000,
          headers: {
            'Content-Type': 'application/json',
            'Accept':       'application/problem+json',
            'Authorization': `Bearer ${accessToken}`,
          },
        });

        const documentId = response.data?.documentId || response.data?.transactionID || null;
        uploaded.push({ fileName, category, documentCode, documentId });
        await writeShipmentEvent(
          pool, context.shipment.shipmentID, 'KN_DOCUMENT_UPLOAD',
          `Uploaded ${fileName} (${category}, code ${documentCode}) to KN booking ${bookingID}${documentId ? ` — documentId ${documentId}` : ''}.`
        );
      } catch (err) {
        const detail = err.response ? `KN API ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
        failed.push({ fileName, category, error: detail });
        await writeShipmentEvent(
          pool, context.shipment.shipmentID, 'KN_DOCUMENT_UPLOAD_FAILED',
          `Failed to upload ${fileName} (${category}) to KN booking ${bookingID}: ${detail}`
        ).catch(() => {});
      }
    }

    if (dryRun) {
      return res.json({ success: true, dryRun: true, data: { bookingID, preview } });
    }
    res.json({ success: uploaded.length > 0, data: { bookingID, uploaded, failed } });
  } catch (err) { res.status(err.statusCode || 500).json({ success: false, error: err.message }); }
});

export default router;
