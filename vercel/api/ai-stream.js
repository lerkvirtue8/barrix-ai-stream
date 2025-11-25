/**
 * Vercel Serverless Function: /api/ai-stream
 *
 * Expects POST JSON: { prompt, activeFile, fileTree, systemPrompt, model }
 * Requires header: x-barrix-secret matching process.env.BARRIX_SERVERLESS_SECRET
 * Environment variables required:
 *  - BARRIX_AI_KEY             (your AI provider API key)
 *  - BARRIX_SERVERLESS_SECRET  (shared secret between WP and serverless)
 *
 * This function forwards a streaming request to an OpenAI-compatible endpoint
 * and proxies the stream back to the client as a plain text/event-stream passthrough.
 */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).setHeader('Allow', 'POST').end('Method Not Allowed');
    return;
  }

  try {
    // Authenticate: accept either a direct shared secret header (x-barrix-secret)
    // or a short-lived token (x-barrix-token) minted by WordPress.
    const directSecret = req.headers['x-barrix-secret'];
    const token = req.headers['x-barrix-token'];
    const serverlessSecret = process.env.BARRIX_SERVERLESS_SECRET;

    let authOk = false;
    if (directSecret && serverlessSecret && directSecret === serverlessSecret) {
      authOk = true;
    }

    // Validate short-lived token if provided
    if (!authOk && token && serverlessSecret) {
      try {
        const parts = token.split('.');
        if (parts.length === 2) {
          const b64 = parts[0];
          const sig_b64 = parts[1];
          const payload_json = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
          const expectedSig = require('crypto').createHmac('sha256', serverlessSecret).update(b64).digest();
          const sigBuf = Buffer.from(sig_b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
          if (sigBuf.length === expectedSig.length && require('crypto').timingSafeEqual(sigBuf, expectedSig)) {
            const payload = JSON.parse(payload_json);
            const now = Math.floor(Date.now() / 1000);
            if (payload.exp && payload.exp >= now) {
              authOk = true;
              // Optionally expose payload info to upstream logic
              req.__barrix_token_payload = payload;
            }
          }
        }
      } catch (e) {
        console.warn('Invalid token', e);
      }
    }

    if (!authOk) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const body = await (async () => {
      try { return await req.json(); } catch (e) { return {}; }
    })();

    const prompt = body.prompt || '';
    const activeFile = body.activeFile || null;
    const fileTree = body.fileTree || null;
    const systemPrompt = body.systemPrompt || '';
    const model = body.model || process.env.BARRIX_DEFAULT_MODEL || 'gpt-4o-mini';

    const aiKey = process.env.BARRIX_AI_KEY;
    if (!aiKey && !process.env.BARRIX_AI_HEADERS) {
      res.status(500).json({ error: 'Server misconfigured: AI key or headers missing' });
      return;
    }

    // Build upstream headers from environment (BARRIX_AI_HEADERS is optional JSON string)
    let upstreamHeaders = {};
    try {
      if (process.env.BARRIX_AI_HEADERS) {
        upstreamHeaders = JSON.parse(process.env.BARRIX_AI_HEADERS);
      }
    } catch (e) {
      console.warn('Invalid BARRIX_AI_HEADERS JSON, ignoring');
      upstreamHeaders = {};
    }

    // If Authorization not set in env headers and we have AI key, add Bearer
    if (!upstreamHeaders['Authorization'] && aiKey) {
      upstreamHeaders['Authorization'] = `Bearer ${aiKey}`;
    }

    // Allow the client to pass a full upstreamPayload to support providers with different schemas (e.g., Poe)
    // If provided, we'll send that payload as-is. Otherwise we default to an OpenAI-like payload.
    const upstreamPayload = body.upstreamPayload || null;

    let endpoint = process.env.BARRIX_AI_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
    let upstreamBody = null;

    if (upstreamPayload) {
      // Client provided the exact payload to send upstream
      upstreamBody = upstreamPayload;
      // If the client didn't provide an endpoint, allow overriding via env
      if (body.endpoint) endpoint = body.endpoint;
    } else {
      // Build messages for OpenAI-like chat API as fallback
      const messages = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      if (activeFile && activeFile.path) {
        messages.push({ role: 'system', content: `Active file path: ${activeFile.path}` });
        if (typeof activeFile.content === 'string' && activeFile.content.length < 2000) {
          messages.push({ role: 'system', content: `Active file contents:\n${activeFile.content}` });
        }
      }
      messages.push({ role: 'user', content: prompt });

      upstreamBody = {
        model,
        messages,
        max_tokens: 2000,
        temperature: 0.2,
        stream: true,
      };
    }

    // Ensure content-type if not provided
    if (!upstreamHeaders['Content-Type']) upstreamHeaders['Content-Type'] = 'application/json';

    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: upstreamHeaders,
      body: upstreamHeaders['Content-Type'].includes('json') ? JSON.stringify(upstreamBody) : upstreamBody,
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      res.status(502).json({ error: 'AI provider error', status: upstream.status, body: text });
      return;
    }

    // Proxy response headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // If Vercel strips chunked or buffers, streaming may be limited; but this is the standard approach.

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    // Read chunks from upstream and immediately write them to the client.
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      // Forward raw chunk. Clients should parse SSE or plain chunk content.
      res.write(chunk);
    }

    // End stream
    res.end();
  } catch (err) {
    console.error('ai-stream error', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    else res.end();
  }
}
