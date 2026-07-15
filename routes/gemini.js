import express from 'express';
import sql from 'mssql';
import rateLimit from 'express-rate-limit';
import { sqlConfig } from '../config.js';

const router = express.Router();

const askLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ success: false, error: 'Too many Gemini requests. Please wait a moment and try again.' });
  },
});

async function audit(eventType, username, detail, req) {
  try {
    const pool = await sql.connect(sqlConfig);
    const ip = req.ip || req.socket?.remoteAddress || null;
    await pool.request()
      .input('username', sql.NVarChar(80), username || null)
      .input('eventType', sql.NVarChar(50), eventType)
      .input('detail', sql.NVarChar(500), detail || null)
      .input('ip', sql.NVarChar(45), ip)
      .query(`
        INSERT INTO kongsberg.dbo.PortalAuditLog (Username, EventType, Detail, IPAddress)
        VALUES (@username, @eventType, @detail, @ip)
      `);
  } catch (err) {
    console.error('[audit]', err.message);
  }
}

function getGeminiUrl() {
  return String(process.env.GEMINI_URL || '').trim().replace(/\/+$/, '');
}

router.post('/ask', askLimiter, async (req, res) => {
  const query = String(req.body?.question || '').trim();
  const username = req.session?.user?.username || null;
  const geminiUrl = getGeminiUrl();

  if (!query) {
    return res.status(400).json({ success: false, error: 'Missing question' });
  }

  if (!geminiUrl) {
    return res.status(500).json({ success: false, error: 'GEMINI_URL is not configured.' });
  }

  try {
    const target = `${geminiUrl}/genai/chat`;
    const response = await fetch(target, {
      method: 'POST',
      headers: { 
        'Accept': 'application/json',
        'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        session_id: username, 
        message: query, 
        reset_history: false }),
    });

    console.log(`[ask] Asked Gemini: ${query} | Status: ${response.status}`);
    console.log(`[user] ${username} | IP: ${req.ip || req.socket?.remoteAddress}`);


    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || data.error || `Gemini server returned HTTP ${response.status}`);
    }

    const answer = String(data.reply || '').trim();
    
    await audit('ASK_GEMINI', username, `Q: ${query}`.slice(0, 500), req);
    res.json({ success: true, answer: answer || 'No response returned.' });
  } catch (err) {
    await audit('ASK_GEMINI_ERROR', username, `Q: ${query} | ERR: ${err.message}`.slice(0, 500), req);
    console.error('Error asking Gemini:', err.message);
    res.status(500).json({ success: false, error: 'Failed to get response from Gemini server' });
  }
});

export default router;
