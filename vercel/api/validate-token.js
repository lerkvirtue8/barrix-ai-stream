/**
 * Simple Vercel serverless endpoint to validate short-lived HMAC tokens created by the plugin
 * Expects: GET /api/validate-token?token=<token>
 * Returns: { valid: boolean, payload?: object, uncapped?: boolean }
 */

import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const token = req.query.token || req.headers['x-barrix-token'];
  const serverlessSecret = process.env.BARRIX_SERVERLESS_SECRET;
  const uncappedPlansRaw = process.env.BARRIX_UNCAPPED_PLANS || '[]';
  let uncappedPlans = [];
  try { uncappedPlans = JSON.parse(uncappedPlansRaw); } catch (e) { uncappedPlans = []; }

  if (!token) {
    res.status(400).json({ valid: false, error: 'Token missing' });
    return;
  }
  if (!serverlessSecret) {
    res.status(500).json({ valid: false, error: 'Server misconfigured (no secret)' });
    return;
  }

  try {
    const t = String(token);
    const parts = t.split('.');
    if (parts.length !== 2) throw new Error('Invalid format');
    const b64 = parts[0];
    const sig_b64 = parts[1];

    const payload_json = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const expectedSig = crypto.createHmac('sha256', serverlessSecret).update(b64).digest();
    const sigBuf = Buffer.from(sig_b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (sigBuf.length !== expectedSig.length || !crypto.timingSafeEqual(sigBuf, expectedSig)) {
      res.status(403).json({ valid: false, error: 'Invalid signature' });
      return;
    }
    const payload = JSON.parse(payload_json);
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now) {
      res.status(403).json({ valid: false, payload, error: 'Token expired' });
      return;
    }
    const plan = payload.plan || 'free';
    const isUncapped = Array.isArray(uncappedPlans) && uncappedPlans.includes(plan);
    res.status(200).json({ valid: true, payload, uncapped: isUncapped });
    return;
  } catch (e) {
    console.warn('validate-token', e.message);
    res.status(400).json({ valid: false, error: 'Invalid token' });
  }
}
