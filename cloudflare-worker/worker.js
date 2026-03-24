/**
 * AV Club VJ — Cloudflare Worker
 *
 * Handles two things:
 *   1. ntfy.sh proxy — adds auth token server-side so it's never exposed in QR codes
 *   2. Photo upload / listing / deletion via R2 storage
 *
 * Routes:
 *   POST   /{topic}              → relay to ntfy.sh (message submission)
 *   GET    /{topic}/json?...     → relay to ntfy.sh (polling)
 *   POST   /photos?venueId=xxx   → upload photo  { dataUrl, caption }
 *   GET    /photos?venueId=xxx   → list pending photos
 *   DELETE /photos/:id?venueId=  → delete a photo
 *
 * Deploy:
 *   1. npm install -g wrangler
 *   2. wrangler login
 *   3. wrangler r2 bucket create avclubvj-photos   (first time only)
 *   4. wrangler deploy
 *
 * This replaces the existing avclubvj.corunography.workers.dev worker.
 * The R2 binding "PHOTOS" is defined in wrangler.toml.
 */

// Set your ntfy.sh auth token as a Cloudflare Worker secret: wrangler secret put NTFY_TOKEN
const NTFY_TOKEN = typeof NTFY_TOKEN_SECRET !== 'undefined' ? NTFY_TOKEN_SECRET : '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── Message endpoints ─────────────────────────────────────────────────────
    if (path === '/messages' || path.startsWith('/messages/')) {
      return handleMessages(request, url, env);
    }

    // ── Photo endpoints ───────────────────────────────────────────────────────
    if (path === '/photos' || path.startsWith('/photos/')) {
      return handlePhotos(request, url, env);
    }

    // ── Remote tunnel registry ────────────────────────────────────────────────
    if (path === '/remote-url') return handleRemoteUrl(request, url, env);
    if (path === '/remote')     return handleRemoteRedirect(request, url, env);

    // ── ntfy.sh proxy ─────────────────────────────────────────────────────────
    return handleNtfy(request, url);
  },
};

// ── Message handler ───────────────────────────────────────────────────────────

async function handleMessages(request, url, env) {
  const path    = url.pathname;
  const venueId = url.searchParams.get('venueId') || '';

  // POST /messages — submit a text message
  if (path === '/messages' && request.method === 'POST') {
    if (!venueId) return jsonErr(400, 'venueId required');
    if (!env.PHOTOS) return jsonErr(503, 'Storage not configured');

    let body;
    try { body = await request.json(); } catch (_) { return jsonErr(400, 'Invalid JSON'); }

    const { text = '' } = body;
    if (!text.trim()) return jsonErr(400, 'text required');
    if (text.length > 500) return jsonErr(400, 'Message too long');

    // Cap pending messages per venue at 50
    const existing = await env.PHOTOS.list({ prefix: `messages/${venueId}/` });
    if (existing.objects.length >= 50) return jsonErr(429, 'Message queue full — please wait');

    const id  = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const key = `messages/${venueId}/${id}`;
    await env.PHOTOS.put(key, JSON.stringify({ id, text: text.slice(0, 500), ts: Date.now() }), {
      httpMetadata: { contentType: 'application/json' },
    });
    return jsonOk({ success: true, id });
  }

  // GET /messages — list pending messages
  if (path === '/messages' && request.method === 'GET') {
    if (!venueId || !env.PHOTOS) return jsonOk([]);
    const listed = await env.PHOTOS.list({ prefix: `messages/${venueId}/` });
    const messages = [];
    for (const obj of listed.objects) {
      try {
        const raw = await env.PHOTOS.get(obj.key);
        if (!raw) continue;
        const data = await raw.json();
        messages.push({ id: data.id, text: data.text, ts: data.ts });
      } catch (_) {}
    }
    messages.sort((a, b) => a.ts - b.ts); // oldest first
    return jsonOk(messages);
  }

  // DELETE /messages/:id — remove a message
  if (path.startsWith('/messages/') && request.method === 'DELETE') {
    if (!venueId || !env.PHOTOS) return jsonErr(400, 'venueId required');
    const msgId = path.slice('/messages/'.length);
    if (!msgId) return jsonErr(400, 'messageId required');
    await env.PHOTOS.delete(`messages/${venueId}/${msgId}`);
    return jsonOk({ success: true });
  }

  return jsonErr(405, 'Method not allowed');
}

// ── Photo handler ─────────────────────────────────────────────────────────────

async function handlePhotos(request, url, env) {
  const path    = url.pathname;
  const venueId = url.searchParams.get('venueId') || '';

  // POST /photos — upload a photo
  if (path === '/photos' && request.method === 'POST') {
    if (!venueId) return jsonErr(400, 'venueId required');
    if (!env.PHOTOS) return jsonErr(503, 'R2 not configured');

    let body;
    try { body = await request.json(); } catch (_) { return jsonErr(400, 'Invalid JSON'); }

    const { dataUrl = '', caption = '' } = body;
    if (!dataUrl.startsWith('data:image/')) return jsonErr(400, 'Invalid image data');
    // Reject oversized payloads (~1.5MB base64 ≈ ~1MB image — well above our 1024px resize)
    if (dataUrl.length > 1_500_000) return jsonErr(413, 'Image too large');

    // Cap pending photos per venue at 50 to prevent abuse
    const existing = await env.PHOTOS.list({ prefix: venueId + '/' });
    if (existing.objects.length >= 50) return jsonErr(429, 'Queue full — please wait for the venue to review photos');

    const id  = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const key = `${venueId}/${id}`;
    await env.PHOTOS.put(key, JSON.stringify({ id, dataUrl, caption: caption.slice(0, 120), ts: Date.now() }), {
      httpMetadata: { contentType: 'application/json' },
    });
    return jsonOk({ success: true, id });
  }

  // GET /photos — list pending photos
  if (path === '/photos' && request.method === 'GET') {
    if (!venueId || !env.PHOTOS) return jsonOk([]);
    const listed = await env.PHOTOS.list({ prefix: venueId + '/' });
    const photos = [];
    for (const obj of listed.objects) {
      try {
        const raw = await env.PHOTOS.get(obj.key);
        if (!raw) continue;
        const data = await raw.json();
        photos.push({ id: data.id, caption: data.caption, ts: data.ts, dataUrl: data.dataUrl });
      } catch (_) {}
    }
    photos.sort((a, b) => b.ts - a.ts);
    return jsonOk(photos);
  }

  // DELETE /photos/:id — remove a photo
  if (path.startsWith('/photos/') && request.method === 'DELETE') {
    if (!venueId || !env.PHOTOS) return jsonErr(400, 'venueId required');
    const photoId = path.slice('/photos/'.length);
    if (!photoId) return jsonErr(400, 'photoId required');
    await env.PHOTOS.delete(`${venueId}/${photoId}`);
    return jsonOk({ success: true });
  }

  return jsonErr(405, 'Method not allowed');
}

// ── ntfy proxy handler ────────────────────────────────────────────────────────

async function handleNtfy(request, url) {
  // Reconstruct the ntfy URL from the path + query string
  const ntfyUrl = 'https://ntfy.sh' + url.pathname + url.search;

  const headers = new Headers(request.headers);
  headers.set('Authorization', 'Bearer ' + NTFY_TOKEN);
  // Remove host header so ntfy gets its own
  headers.delete('host');

  const upstream = await fetch(ntfyUrl, {
    method:  request.method,
    headers,
    body:    request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
  });

  const respHeaders = new Headers(upstream.headers);
  respHeaders.set('Access-Control-Allow-Origin', '*');

  return new Response(upstream.body, {
    status:  upstream.status,
    headers: respHeaders,
  });
}

// ── Remote tunnel registry ────────────────────────────────────────────────────
// POST /remote-url?venueId=xxx  { tunnelUrl }  → store in R2
// DELETE /remote-url?venueId=xxx               → clear
// GET    /remote?venueId=xxx                   → 302 to tunnel URL or offline page

async function handleRemoteUrl(request, url, env) {
  const venueId = url.searchParams.get('venueId') || '';
  if (!venueId || !env.PHOTOS) return jsonErr(400, 'venueId required');
  const key = `remote-url/${venueId}`;

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch(_) { return jsonErr(400, 'Invalid JSON'); }
    const { tunnelUrl } = body;
    if (!tunnelUrl || !tunnelUrl.startsWith('https://')) return jsonErr(400, 'Invalid tunnelUrl');
    await env.PHOTOS.put(key, JSON.stringify({ url: tunnelUrl, ts: Date.now() }), {
      httpMetadata: { contentType: 'application/json' },
    });
    return jsonOk({ success: true });
  }

  if (request.method === 'DELETE') {
    await env.PHOTOS.delete(key);
    return jsonOk({ success: true });
  }

  return jsonErr(405, 'Method not allowed');
}

async function handleRemoteRedirect(request, url, env) {
  const venueId = url.searchParams.get('venueId') || '';
  if (venueId && env.PHOTOS) {
    const obj = await env.PHOTOS.get(`remote-url/${venueId}`);
    if (obj) {
      try {
        const { url: tunnelUrl } = await obj.json();
        if (tunnelUrl) return Response.redirect(tunnelUrl, 302);
      } catch(_) {}
    }
  }
  // App is offline — show a friendly page
  return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AV Club VJ — Offline</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0d0d0f;color:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100dvh;padding:32px;text-align:center}
.icon{font-size:52px;margin-bottom:16px}.title{font-size:22px;font-weight:700;margin-bottom:10px}.sub{font-size:14px;color:#888;line-height:1.6}
</style></head><body><div><div class="icon">🎛️</div><div class="title">App is Offline</div>
<div class="sub">AV Club VJ isn't running right now.<br>Ask the venue to launch the app.</div></div></body></html>`,
    { headers: { 'Content-Type': 'text/html', ...CORS } });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonOk(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function jsonErr(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
