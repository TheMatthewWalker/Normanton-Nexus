import express from 'express';
import sql from 'mssql';
import axios from 'axios';
import { sqlConfig } from '../config.js';

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

        references: [
            {
                value: String(shipment.shipmentID),
                code: 'ABO'
            },
        ],

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

export default router;
