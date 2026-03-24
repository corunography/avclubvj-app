/**
 * AV Club VJ — Photo Upload Worker
 *
 * Endpoints:
 *   GET  /submit?venueId=xxx          Serve the mobile upload page
 *   POST /photos?venueId=xxx          Upload a photo  { dataUrl, caption }
 *   GET  /photos?venueId=xxx          List pending photos
 *   DELETE /photos/:id?venueId=xxx    Delete a photo (after approve/reject)
 *
 * R2 binding name: PHOTOS  (set in wrangler.toml)
 * Keys are stored as: {venueId}/{photoId}
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url      = new URL(request.url);
    const path     = url.pathname;
    const venueId  = url.searchParams.get('venueId') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── GET /submit — mobile upload page ─────────────────────────────────────
    if (path === '/submit' || path === '/') {
      if (request.method !== 'GET') return err(405, 'Method not allowed');
      return new Response(buildSubmitPage(venueId, url.origin), {
        headers: { 'Content-Type': 'text/html;charset=utf-8', ...CORS },
      });
    }

    // ── POST /photos — upload ─────────────────────────────────────────────────
    if (path === '/photos' && request.method === 'POST') {
      if (!venueId) return err(400, 'venueId required');

      let body;
      try { body = await request.json(); } catch (_) { return err(400, 'Invalid JSON'); }

      const { dataUrl = '', caption = '' } = body;
      if (!dataUrl.startsWith('data:image/')) return err(400, 'Invalid image data');

      const id   = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const key  = `${venueId}/${id}`;
      const data = { id, dataUrl, caption: caption.slice(0, 120), ts: Date.now() };

      await env.PHOTOS.put(key, JSON.stringify(data), {
        httpMetadata: { contentType: 'application/json' },
      });

      return json({ success: true, id });
    }

    // ── GET /photos — list pending ────────────────────────────────────────────
    if (path === '/photos' && request.method === 'GET') {
      if (!venueId) return json([]);

      const listed = await env.PHOTOS.list({ prefix: venueId + '/' });
      const photos = [];

      for (const obj of listed.objects) {
        try {
          const raw  = await env.PHOTOS.get(obj.key);
          if (!raw) continue;
          const data = await raw.json();
          photos.push({ id: data.id, caption: data.caption, ts: data.ts, dataUrl: data.dataUrl });
        } catch (_) {}
      }

      // Return newest first
      photos.sort((a, b) => b.ts - a.ts);
      return json(photos);
    }

    // ── DELETE /photos/:id — remove ───────────────────────────────────────────
    if (path.startsWith('/photos/') && request.method === 'DELETE') {
      if (!venueId) return err(400, 'venueId required');
      const photoId = path.slice('/photos/'.length);
      if (!photoId) return err(400, 'photoId required');
      await env.PHOTOS.delete(`${venueId}/${photoId}`);
      return json({ success: true });
    }

    return err(404, 'Not found');
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ── Mobile upload page HTML ───────────────────────────────────────────────────

function buildSubmitPage(venueId, origin) {
  const uploadUrl = `${origin}/photos?venueId=${encodeURIComponent(venueId)}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Share a Photo</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#111;color:#f5f5f7;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px 16px}
h1{font-size:26px;font-weight:800;margin-bottom:6px;text-align:center}
.sub{font-size:14px;color:#888;margin-bottom:24px;text-align:center}
.card{background:#1c1c1e;border-radius:18px;padding:20px;width:100%;max-width:440px;display:flex;flex-direction:column;gap:14px}
.pick-btn{display:flex;align-items:center;justify-content:center;gap:10px;background:#2c2c2e;border:2px dashed #444;border-radius:14px;padding:28px 16px;cursor:pointer;font-size:15px;color:#aaa;text-align:center;transition:border-color .2s}
.pick-btn:hover{border-color:#5e5ce6}
#preview-wrap{display:none;position:relative}
#preview{width:100%;border-radius:10px;display:block;object-fit:contain;max-height:300px;background:#000}
.rm-btn{position:absolute;top:8px;right:8px;background:rgba(0,0,0,.7);border:none;color:#fff;border-radius:50%;width:28px;height:28px;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center}
input[type=text]{background:#2c2c2e;border:1px solid #3a3a3c;border-radius:10px;padding:12px 14px;font-size:15px;color:#f5f5f7;width:100%;outline:none;font-family:inherit}
input[type=text]:focus{border-color:#5e5ce6}
input[type=text]::placeholder{color:#555}
.btn{display:block;width:100%;padding:15px;background:#5e5ce6;color:#fff;border:none;border-radius:12px;font-size:17px;font-weight:700;cursor:pointer;transition:opacity .2s}
.btn:hover{opacity:.88}
.btn:disabled{opacity:.4;cursor:not-allowed}
#status{text-align:center;font-size:14px;padding:4px 0}
.ok{color:#34c759}
.fail{color:#ff453a}
#file-input{display:none}
</style>
</head>
<body>
<h1>📸 Share a Photo</h1>
<p class="sub">Your photo could appear on screen!</p>
<div class="card">
  <label class="pick-btn" id="pick-label" for="file-input">
    <span id="pick-icon" style="font-size:32px">📷</span>
    <span id="pick-text">Tap to take a photo or choose one</span>
  </label>
  <input type="file" id="file-input" accept="image/*" capture="environment">
  <div id="preview-wrap">
    <img id="preview" alt="Preview">
    <button class="rm-btn" id="rm-btn" title="Remove">✕</button>
  </div>
  <input type="text" id="caption" placeholder="Add a caption (optional)" maxlength="100">
  <button class="btn" id="submit-btn" disabled>Send to Screen</button>
  <div id="status"></div>
</div>
<script>
const fileInput  = document.getElementById('file-input');
const previewWrap = document.getElementById('preview-wrap');
const preview    = document.getElementById('preview');
const pickLabel  = document.getElementById('pick-label');
const pickText   = document.getElementById('pick-text');
const submitBtn  = document.getElementById('submit-btn');
const statusEl   = document.getElementById('status');
const captionEl  = document.getElementById('caption');
const rmBtn      = document.getElementById('rm-btn');

let resizedDataUrl = null;

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  statusEl.textContent = 'Resizing…';
  resizedDataUrl = await resizeImage(file, 1024, 0.80);
  preview.src = resizedDataUrl;
  previewWrap.style.display = 'block';
  pickLabel.style.display = 'none';
  submitBtn.disabled = false;
  statusEl.textContent = '';
});

rmBtn.addEventListener('click', () => {
  resizedDataUrl = null;
  preview.src = '';
  previewWrap.style.display = 'none';
  pickLabel.style.display = 'flex';
  submitBtn.disabled = true;
  fileInput.value = '';
  statusEl.textContent = '';
});

submitBtn.addEventListener('click', async () => {
  if (!resizedDataUrl) return;
  submitBtn.disabled = true;
  statusEl.textContent = 'Sending…';
  try {
    const resp = await fetch('${uploadUrl}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl: resizedDataUrl, caption: captionEl.value.trim() }),
    });
    if (!resp.ok) throw new Error('Upload failed (' + resp.status + ')');
    statusEl.innerHTML = '<span class="ok">✓ Submitted! Watch the screen!</span>';
    // Reset
    resizedDataUrl = null;
    preview.src = '';
    previewWrap.style.display = 'none';
    pickLabel.style.display = 'flex';
    captionEl.value = '';
    fileInput.value = '';
  } catch (e) {
    statusEl.innerHTML = '<span class="fail">Upload failed — please try again.</span>';
    submitBtn.disabled = false;
  }
});

function resizeImage(file, maxPx, quality) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxPx || h > maxPx) {
          if (w > h) { h = Math.round(h * maxPx / w); w = maxPx; }
          else       { w = Math.round(w * maxPx / h); h = maxPx; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}
</script>
</body>
</html>`;
}
