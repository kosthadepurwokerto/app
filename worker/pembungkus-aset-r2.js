import asli from './index.js';
import { BERKAS_EMBED } from './aset-cadangan.js';

// Konstanta sama dengan worker/index.js (jangan diimpor: tidak diekspor di sana).
const CSP_HALAMAN = [
  "default-src 'self'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

function kepalaKeamanan(h) {
  h.set('x-frame-options', 'DENY');
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'same-origin');
  h.set('x-permitted-cross-domain-policies', 'none');
  h.set('permissions-policy', 'geolocation=(), camera=(), microphone=()');
  return h;
}

const TIPE = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
};

function tipe(jalur) {
  const i = jalur.lastIndexOf('.');
  return TIPE[jalur.slice(i).toLowerCase()] || 'application/octet-stream';
}

function dariB64(s) {
  const b = atob(s);
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}

// app.html & _headers tidak pernah dilayani langsung.
const LEWATI = new Set(['/_headers', '/app.html', '/index.html']);

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const jalur = url.pathname;

    // Halaman utama: kerangka app.html + header CSP yang sama dengan kode asli.
    if (jalur === '/' || jalur === '/manifest.webmanifest') {
      if (jalur === '/manifest.webmanifest') return asli.fetch(req, env, ctx);
      const hal = BERKAS_EMBED['/app.html'];
      if (!hal) return asli.fetch(req, env, ctx);
      const h = kepalaKeamanan(new Headers({
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      }));
      h.set('content-security-policy', CSP_HALAMAN);
      return new Response(req.method === 'HEAD' ? null : dariB64(hal.b64), { status: 200, headers: h });
    }

    const berkas = BERKAS_EMBED[jalur];
    if (!berkas || LEWATI.has(jalur) || (req.method !== 'GET' && req.method !== 'HEAD')) {
      // Rute API dan permintaan lain tetap ke kode asli.
      return asli.fetch(req, env, ctx);
    }

    return new Response(req.method === 'HEAD' ? null : dariB64(berkas.b64), {
      status: 200,
      headers: {
        'content-type': berkas.tipe || tipe(jalur),
        'cache-control': 'public, max-age=0, must-revalidate',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
      },
    });
  },
};

// Catatan: kode asli tetap memakai env.ASSETS untuk jalur lain (mis. /logo, /_headers).
// Worker ini sengaja TIDAK punya binding aset, jadi jalur itu jatuh ke 404/500 —
// dapat diterima selama deploy darurat; kembalikan ke `wrangler deploy` normal ASAP.
export { dariB64, kepalaKeamanan, CSP_HALAMAN };
