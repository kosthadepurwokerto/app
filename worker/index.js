// =====================================================================
// Kost Hade — Worker API (Cloudflare Workers + D1)
// Sajikan UI statis dari folder pub/ dan API JSON di /api/*.
// =====================================================================
import * as logic from './logic.js';
import { dbKost, TABEL_BERKOST } from './db-kost.js';
import { ringkasKost, daftarLedger } from './ringkasan.js';

const SESI_HARI = 7;
// "Ingat saya": sesi 90 hari supaya petugas tidak mengetik sandi tiap hari.
const SESI_INGAT_HARI = 90;
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

function cookieValue(req, name) {
  // APK Android memuat halaman dari dalam aplikasi (file://) lalu memanggil API lintas-asal.
  // Token sesi dikirim lewat header ini karena cookie lintas-asal sering diblokir WebView;
  // tetap dicocokkan dengan tabel sessions, jadi keamanannya sama.
  const dariHeader = req.headers.get('x-sesi-apk');
  if (dariHeader) return dariHeader;
  const raw = req.headers.get('cookie') || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function setSesiCookie(token, secure, maxAge = SESI_HARI * 86400) {
  return `hade_sesi=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` + (secure ? '; Secure' : '');
}

// =====================================================================
// PERTAHANAN PERIMETER (diterapkan ke SEMUA respons, termasuk galat)
// - Header keamanan: halaman dan API tidak boleh dibingkai (anti clickjacking),
//   tidak boleh ditebak tipenya, dan API tidak di-cache.
// Batas laju sederhana: penghitung di memori isolate. Servis satu pengguna
//   3–10 kamar tidak butuh Durable Object, tapi tetap bisa menahan banjir permintaan.
//   Kuota login lebih longgar dari penguncian per akun (10 gagal/15 menit) supaya
//   penguncian akun tetap yang memberi pesan jelas; batas ini menahan banjir kasar.
// =====================================================================
const BATAS_LAJU = { jendelaMs: 60000, baca: 3000, login: 60, tulis: 600, sandi: 100, post: 300 };
const _hitung = new Map();  // kunci -> { n, mulai }

function kepalaKeamanan(h, api) {
  h.set('x-frame-options', 'DENY');  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'same-origin');
  h.set('x-permitted-cross-domain-policies', 'none');
  h.set('permissions-policy', 'geolocation=(), camera=(), microphone=()');
  if (api) {
    h.set('cache-control', 'no-store');
    h.set('vary', 'origin');
    // Kebijakan isi ketat: hanya skrip/gaya dari asal sendiri.
    h.set('content-security-policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  }
  return h;
}

// true = boleh lanjut, false = kena batas
function bolehLewat(kunci, maks) {
  const now = Date.now();
  const c = _hitung.get(kunci);
  if (!c || now - c.mulai > BATAS_LAJU.jendelaMs) {
    _hitung.set(kunci, { n: 1, mulai: now });
    if (_hitung.size > 5000) {                       // cegah memori isolate membengkak
      for (const [k, v] of _hitung) if (now - v.mulai > BATAS_LAJU.jendelaMs) _hitung.delete(k);
    }
    return true;
  }
  c.n += 1;
  return c.n <= maks;
}

function ipKlien(req) {
  // Cloudflare selalu menimpa cf-connecting-ip dengan IP asli klien; header lain
  // (x-real-ip) hanya dipakai saat berjalan lokal.
  return req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || `lokal:${req.headers.get('host') || '?'}`;
}

function jawabApi(req, data, status = 200, headers = {}) {
  const h = kepalaKeamanan(new Headers({ 'content-type': 'application/json; charset=utf-8', ...headers }), true);
  return new Response(JSON.stringify(data), { status, headers: h });
}

// APK Android memuat halaman dari file:// sehingga origin-nya "null" dan setiap permintaan
// ke API dianggap lintas-asal. Tanpa header ini WebView menolak semua balasan.
const ASAL_APK = new Set(['null', 'file://']);
function corsApk(req, res) {
  const asal = req.headers.get('origin');
  if (asal && ASAL_APK.has(asal)) {
    const h = new Headers(res.headers);
    h.set('access-control-allow-origin', 'null');   // JANGAN pakai "*" bersama kredensial
    h.set('access-control-allow-credentials', 'true');
    h.set('access-control-allow-headers', 'content-type, x-sesi-apk');
    h.set('access-control-allow-methods', 'GET, POST, OPTIONS');
    h.set('vary', 'origin');
    return new Response(res.body, { status: res.status, headers: h });
  }
  return res;
}

async function sesiAktif(env, req) {
  const token = cookieValue(req, 'hade_sesi');
  if (!token) return null;
  const hash = await logic.sha256hex(token);
  const row = await env.DB.prepare(
    `select s.token_hash, s.expires_at, s.kost as sesi_kost, u.id, u.username, u.fullname, u.role,
            u.must_change_password, u.kost as user_kost
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = ? and u.aktif = 1`
  ).bind(hash).first();
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    await env.DB.prepare('delete from sessions where token_hash = ?').bind(hash).run();
    return null;
  }
  // Kost aktif: pilihan sesi (bila akun punya akses), selain itu kost induk akun.
  row.kost = row.sesi_kost || row.user_kost;
  // Sesi "belum memilih kost" dibuat saat login: ambil status wajib-ganti-sandi terbaru
  // dari tabel users, supaya akun yang barusan mengganti sandi langsung bisa memilih kost.
  if (!row.sesi_kost) row.must_change_password = 0;
  return row;
}

// ---------- pembacaan data ----------
async function dashboard(env, DB, kost) {
  const db = DB || env.DB;
  // Query berurutan (bukan Promise.all): batch/beberapa statement paralel di D1 lokal
  // sesekali terbaca sebelum tulisan sebelumnya terlihat, sehingga dashboard menampilkan
  // angka lama walau data sudah tersimpan. Konsistensi lebih penting daripada beberapa ms.
  // Catatan konsistensi: query berurutan (bukan Promise.all) karena di D1 lokal batch
  // paralel sesekali terbaca sebelum tulisan sebelumnya terlihat.
  const rooms = await db.prepare('select * from rooms order by no_kamar').all();
  const tenants = await db.prepare('select * from tenants order by created_at desc').all();
  const bills = await db.prepare("select * from bills where status='belum_bayar' order by jatuh_tempo, id").all();
  // 200 transaksi terakhir: cukup untuk cetak ulang struk beberapa bulan ke belakang.
  const pays = await db.prepare('select * from payments where voided_at is null order by tgl_bayar desc, id desc limit 200').all();

  // Angka kas/tunggakan dihitung per kost oleh worker/ringkasan.js (query kecil &
  // eksplisit per tabel). Query agregat panjang sebelumnya tidak bisa difilter otomatis.
  const ringkas = await ringkasKost(env.DB, kost);
  const roomMap = {};
  const aktif = (tenants.results || []).filter((t) => t.status === 'aktif');
  (rooms.results || []).forEach((r) => { roomMap[r.id] = r.no_kamar; });
  const label = (s) => ({ terisi: 'Terisi', perbaikan: 'Perbaikan' }[s] || 'Tersedia');

  return {
    stats: {
      totalKamar: (rooms.results || []).length,
      kamarTerisi: (rooms.results || []).filter((r) => r.status === 'terisi').length,
      kamarTersedia: (rooms.results || []).filter((r) => r.status === 'tersedia').length,
      totalPenyewa: aktif.length,
      totalPendapatan: ringkas.total_pendapatan,
      totalPengeluaran: ringkas.total_pengeluaran,
      sisaKas: ringkas.sisa_kas,
      modalNeraca: ringkas.modal_neraca,
      pendapatanBulanIni: ringkas.pendapatan_bulan_ini,
      tunggakan: ringkas.tunggakan,
    },
    kamar: (rooms.results || []).map((r) => {
      const t = aktif.find((x) => x.kamar_id === r.id);
      return [r.no_kamar, r.tipe, String(r.harga_bulanan), String(r.harga_harian), label(r.status), t ? t.nama : ''];
    }),
    penyewa: (tenants.results || []).map((t) => {
      const b = (bills.results || []).find((x) => x.tenant_id === t.id);
      return [t.kode, t.nama, t.hp || '', roomMap[t.kamar_id] || '', t.tgl_masuk,
              t.status === 'aktif' ? 'Aktif' : 'Keluar', b ? b.jatuh_tempo : '',
              b ? String(b.jumlah) : '', b ? b.id : '',
              t.kontak_darurat || '', t.hp_darurat || '', t.ktp_key ? 'ada' : '', t.sumber || 'manual'];
    }),
    transaksi: (pays.results || []).map((p) => {
      const t = (tenants.results || []).find((x) => x.id === p.tenant_id);
      return [p.tgl_bayar, t ? t.nama : '-', t ? (roomMap[t.kamar_id] || '') : '', String(p.jumlah),
              (p.keterangan || '') + ' • ' + p.nomor_struk, String(p.id), p.bukti_key || ''];
    }),
  };
}



// ---------- FOTO KTP (R2) ----------
// Berkas biner disimpan di R2; D1 hanya menyimpan kuncinya. Tidak ada URL publik:
// foto KTP hanya bisa diambil lewat endpoint ini dan hanya oleh user yang login.
const KTP_TIPE = logic.KTP_TIPE;
const KTP_MAKS = 5 * 1024 * 1024;          // 5 MB (R2); mode cadangan D1 dibatasi 2 MB oleh tabel
const KUNCI_KTP = logic.KUNCI_KTP;

// Catatan: handler khusus ini membalas JSON sendiri (bukan melempar) — error object yang
// dilempar dari dalam pemrosesan multipart tidak sampai ke penangkap error utama Worker.
// ---------- BUKTI PEMBAYARAN ----------
// Berkas bukti transfer/QRIS dari penyewa atau petugas. Disimpan seperti foto KTP
// (R2 bila aktif, cadangan D1) dengan awalan "bukti/". Bisa PDF selain gambar.
const BUKTI_TIPE = { ...KTP_TIPE, 'application/pdf': 'pdf' };
const BUKTI_MAKS = 5 * 1024 * 1024;
const KUNCI_BUKTI = /^bukti\/\d{4}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|pdf)$/;

async function unggahBerkas(req, env, sesi, opsi) {
  const pakaiR2 = logic.KTP_MODE === 'r2' && !!env.KTP;
  let form;
  try { form = await req.formData(); } catch { return json({ error: 'Unggahan tidak valid. Kirim sebagai multipart/form-data.' }, 400); }
  const file = form.get('file');
  if (!file || typeof file === 'string' || !file.size) return json({ error: `Berkas ${opsi.label} wajib diunggah.` }, 400);
  const ext = opsi.tipe[file.type];
  if (!ext) return json({ error: `Format ${opsi.label} harus ${opsi.format}.` }, 400);
  if (file.size > opsi.maks) return json({ error: `Ukuran ${opsi.label} maksimal ${opsi.maks / 1048576} MB.` }, 400);
  const isi = await file.arrayBuffer();
  const kunciBaru = `${opsi.awalan}/${new Date().getFullYear()}/${crypto.randomUUID()}.${ext}`;
  try {
    if (pakaiR2) {
      await env.KTP.put(kunciBaru, isi, { httpMetadata: { contentType: file.type } });
    } else {
      await env.DB.prepare('insert into ktp_berkas (kunci, tipe, ukuran, isi) values (?,?,?,?)')
        .bind(kunciBaru, file.type, file.size, new Uint8Array(isi)).run();
    }
  } catch (e) {
    console.error('[hade] simpan berkas', e);
    return json({ error: 'Gagal menyimpan berkas. Coba lagi.' }, 500);
  }
  await logic.audit(env, sesi, `${opsi.awalan}.upload`, opsi.tabel, null, null, { kunci: kunciBaru, bytes: file.size, simpan: pakaiR2 ? 'r2' : 'd1' });
  return json({ ok: true, kunci: kunciBaru, tipe: file.type });
}

async function unggahBukti(req, env, sesi) {
  return unggahBerkas(req, env, sesi, {
    label: 'bukti pembayaran', awalan: 'bukti', tabel: 'payments',
    tipe: BUKTI_TIPE, maks: BUKTI_MAKS, format: 'JPG, PNG, WEBP, atau PDF',
  });
}

async function lihatBerkas(env, kunci, sesi, opsi) {
  await logic.audit(env, sesi, `${opsi.awalan}.lihat`, opsi.tabel, kunci, null, null);
  let body, tipe;
  if (logic.KTP_MODE === 'r2' && env.KTP) {
    const obj = await env.KTP.get(kunci);
    if (!obj) return json({ error: 'Berkas tidak ditemukan.' }, 404);
    body = obj.body;
    tipe = (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream';
  } else {
    const row = await env.DB.prepare('select tipe, isi from ktp_berkas where kunci=?').bind(kunci).first();
    if (!row) return json({ error: 'Berkas tidak ditemukan.' }, 404);
    const isi = row.isi;
    if (isi instanceof ArrayBuffer) body = new Uint8Array(isi);
    else if (ArrayBuffer.isView(isi)) body = isi;
    else if (Array.isArray(isi)) body = new Uint8Array(isi);
    else if (typeof isi === 'string') body = new TextEncoder().encode(isi);
    else body = isi;
    tipe = row.tipe;
  }
  // Bukti bayar adalah dokumen keuangan: tidak di-cache publik, hanya untuk user login.
  // Berkas yang tersimpan tanpa tipe yang dikenal diperlakukan sebagai unduhan, bukan
  // halaman — mencegah berkas tak dikenal dirender sebagai HTML di asal aplikasi.
  const aman = BUKTI_TIPE[tipe] ? tipe : 'application/octet-stream';
  return new Response(body, {
    headers: kepalaKeamanan(new Headers({
      'content-type': aman,
      'cache-control': 'private, no-store',
      // jangan biarkan browser menebak tipe lain (berkas bisa disajikan sebagai HTML)
      'x-content-type-options': 'nosniff',
      'content-disposition': `inline; filename="${kunci.split('/').pop()}"`,
    }), true),
  });
}

async function lihatBukti(env, kunci, sesi) {
  if (!KUNCI_BUKTI.test(kunci)) return json({ error: 'Kunci bukti tidak valid.' }, 400);
  return lihatBerkas(env, kunci, sesi, { awalan: 'bukti', tabel: 'payments' });
}

async function unggahKtp(req, env, sesi) {
  const pakaiR2 = logic.KTP_MODE === 'r2' && !!env.KTP;
  let form;
  try { form = await req.formData(); } catch { return json({ error: 'Unggahan tidak valid. Kirim sebagai multipart/form-data.' }, 400); }
  const file = form.get('file');
  if (!file || typeof file === 'string' || !file.size) return json({ error: 'Berkas foto KTP wajib diunggah.' }, 400);
  const extKtp = KTP_TIPE[file.type];
  if (!extKtp) return json({ error: 'Format foto harus JPG, PNG, atau WEBP.' }, 400);
  if (file.size > KTP_MAKS) return json({ error: 'Ukuran foto maksimal ' + (KTP_MAKS / 1048576) + ' MB.' }, 400);
  const isi = await file.arrayBuffer();
  const kunciBaru = `ktp/${new Date().getFullYear()}/${crypto.randomUUID()}.${extKtp}`;
  try {
    if (pakaiR2) {
      await env.KTP.put(kunciBaru, isi, { httpMetadata: { contentType: file.type } });
    } else {
      // mode cadangan: simpan di D1 (foto sudah diperkecil di browser, maks 1,5 MB)
      await env.DB.prepare('insert into ktp_berkas (kunci, tipe, ukuran, isi) values (?,?,?,?)')
        .bind(kunciBaru, file.type, file.size, new Uint8Array(isi)).run();
    }
  } catch (e) {
    console.error('[hade] simpan ktp', e);
    return json({ error: 'Gagal menyimpan foto. Coba lagi.' }, 500);
  }
  await logic.audit(env, sesi, 'ktp.upload', 'tenants', null, null, { kunci: kunciBaru, bytes: file.size, simpan: pakaiR2 ? 'r2' : 'd1' });
  return json({ ok: true, kunci: kunciBaru, tipe: file.type });
}

async function lihatKtp(env, kunci, sesi) {
  // Foto KTP data pribadi: hanya admin (staff tidak, walau mendaftarkan penyewa).
  if (sesi.role !== 'admin') return json({ error: 'Hanya admin yang boleh membuka foto KTP.' }, 403);
  // kunci harus persis bentuk yang kita buat (mencegah ../ dan kunci lain)
  if (!KUNCI_KTP.test(kunci)) return json({ error: 'Kunci foto tidak valid.' }, 400);
  await logic.audit(env, sesi, 'ktp.lihat', 'tenants', kunci, null, null);
  let body, tipe;
  if (logic.KTP_MODE === 'r2' && env.KTP) {
    const obj = await env.KTP.get(kunci);
    if (!obj) return json({ error: 'Foto KTP tidak ditemukan.' }, 404);
    body = obj.body;
    tipe = (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream';
  } else {
    const row = await env.DB.prepare('select tipe, isi from ktp_berkas where kunci=?').bind(kunci).first();
    if (!row) return json({ error: 'Foto KTP tidak ditemukan.' }, 404);
    // D1 mengembalikan kolom BLOB sebagai array angka — harus dijadikan Uint8Array,
    // kalau langsung dijadikan body Response hasilnya 0 byte.
    const isi = row.isi;
    if (isi instanceof ArrayBuffer) body = new Uint8Array(isi);
    else if (ArrayBuffer.isView(isi)) body = isi;
    else if (Array.isArray(isi)) body = new Uint8Array(isi);
    else if (typeof isi === 'string') body = new TextEncoder().encode(isi);
    else body = isi;
    tipe = row.tipe;
  }
  return new Response(body, {
    headers: kepalaKeamanan(new Headers({
      'content-type': BUKTI_TIPE[tipe] ? tipe : 'application/octet-stream',
      'cache-control': 'private, no-store',          // data pribadi: jangan di-cache proxy
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
    }), true),
  });
}

// ---------- PENGINGAT WHATSAPP (sekali klik, tanpa biaya) ----------
// Aplikasi tidak mengirim WhatsApp sendiri; ia menyiapkan daftar + pesan siap kirim.
// Riwayat kirim disimpan supaya tagihan yang sama tidak diingatkan dua kali.
async function daftarPengingat(env, DB) {
  const db = DB || env.DB;
  const r = await db.prepare(`
    select b.id as bill_id, b.jatuh_tempo, b.jumlah, t.kode, t.nama, t.hp, r.no_kamar,
           cast(julianday(date('now','localtime')) - julianday(b.jatuh_tempo) as integer) as terlambat,
           p.created_at as diingatkan_pada
      from bills b
      join tenants t on t.id = b.tenant_id
      left join rooms r on r.id = t.kamar_id
      left join pengingat_wa p on p.bill_id = b.id
     where b.status = 'belum_bayar' and t.status = 'aktif'
     order by b.jatuh_tempo, t.nama
  `).all();
  return (r.results || []).map((x) => ({
    billId: x.bill_id,
    kode: x.kode,
    nama: x.nama,
    kamar: x.no_kamar || '',
    hp: x.hp || '',
    jatuhTempo: x.jatuh_tempo,
    jumlah: x.jumlah,
    terlambat: x.terlambat,                 // >0 = sudah lewat; <0 = belum jatuh tempo
    sudahDiingatkan: !!x.diingatkan_pada,
    diingatkanPada: x.diingatkan_pada || null,
  }));
}

async function catatPengingat(ctx, billId) {
  const id = Number(billId);
  if (!Number.isInteger(id) || id <= 0) throw logic.httpError(400, 'ID tagihan tidak valid.');
  const b = await ctx.db.prepare(`select b.id, b.tenant_id, b.jumlah, b.jatuh_tempo, t.nama, t.hp
                                     from bills b join tenants t on t.id=b.tenant_id where b.id=?`).bind(id).first();
  if (!b) throw logic.httpError(404, 'Tagihan tidak ditemukan.');
  await ctx.db.prepare('insert or ignore into pengingat_wa (bill_id, tenant_id, hp, dikirim_oleh) values (?,?,?,?)')
    .bind(b.id, b.tenant_id, b.hp || null, ctx.user.id).run();
  await ctx.audit('wa.ingatkan', 'bills', b.id, null, { nama: b.nama, hp: b.hp, jumlah: b.jumlah, jatuh_tempo: b.jatuh_tempo });
  return `Pengingat untuk ${b.nama} dicatat terkirim.`;
}


// ---------- LOGO APLIKASI (disajikan publik, dipakai layar login) ----------
const LOGO_TIPE = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const LOGO_MAKS = 1024 * 1024;                    // 1 MB, cukup untuk logo

async function unggahLogo(req, env, sesi) {
  let form;
  try { form = await req.formData(); } catch { return json({ error: 'Unggahan tidak valid. Kirim multipart/form-data.' }, 400); }
  const file = form.get('file');
  if (!file || typeof file === 'string' || !file.size) return json({ error: 'Berkas logo wajib diunggah.' }, 400);
  const ext = LOGO_TIPE[file.type];
  if (!ext) return json({ error: 'Format logo harus PNG, JPG, atau WEBP.' }, 400);
  if (file.size > LOGO_MAKS) return json({ error: 'Ukuran logo maksimal 1 MB.' }, 400);
  const isi = await file.arrayBuffer();
  const kunci = `logo/${sesi.kost}/${Date.now()}.${ext}`;
  try {
    await env.DB.prepare('insert or replace into ktp_berkas (kunci, tipe, ukuran, isi) values (?,?,?,?)')
      .bind(kunci, file.type, file.size, new Uint8Array(isi)).run();
    const lama = await env.DB.prepare('select logo_kunci from kosts where kunci=?').bind(sesi.kost).first();
    await env.DB.prepare('update kosts set logo_kunci=?, logo_tipe=? where kunci=?')
      .bind(kunci, file.type, sesi.kost).run();
    // berkas logo lama dibersihkan supaya D1 tidak menumpuk
    if (lama && lama.logo_kunci && lama.logo_kunci !== kunci) {
      await env.DB.prepare('delete from ktp_berkas where kunci=?').bind(lama.logo_kunci).run().catch(() => {});
    }
  } catch (e) {
    console.error('[hade] simpan logo', e);
    return json({ error: 'Gagal menyimpan logo.' }, 500);
  }
  await logic.audit(env, sesi, 'kost.logo', 'kosts', sesi.kost, null, { kunci, bytes: file.size });
  return json({ ok: true, message: 'Logo diperbarui.', kost: await ambilKost(env, sesi.kost) });
}

async function sajikanLogo(env, kunciLogo, kunciKost) {
  // kunci logo harus milik kost yang disebut (mencegah menebak logo kost lain)
  if (!/^logo\/[a-z0-9-]+\/\d+\.(png|jpg|webp)$/.test(kunciLogo)) return json({ error: 'Kunci logo tidak valid.' }, 400);
  if (!kunciLogo.startsWith(`logo/${kunciKost}/`)) return json({ error: 'Logo bukan milik aplikasi ini.' }, 403);
  const row = await env.DB.prepare('select tipe, isi from ktp_berkas where kunci=?').bind(kunciLogo).first();
  if (!row) return json({ error: 'Logo tidak ditemukan.' }, 404);
  let body = row.isi;
  if (body instanceof ArrayBuffer) body = new Uint8Array(body);
  else if (ArrayBuffer.isView(body)) body = body;
  else if (Array.isArray(body)) body = new Uint8Array(body);
  else if (typeof body === 'string') body = new TextEncoder().encode(body);
  return new Response(body, {
    headers: kepalaKeamanan(new Headers({
      'content-type': LOGO_TIPE[row.tipe] ? row.tipe : 'application/octet-stream',
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    }), false),
  });
}

// ---------- MASTER: daftar/daftar-ulang admin untuk sebuah kost ----------
/**
 * Beri akses satu akun ke satu kost: satu akun boleh mengelola banyak kost
 * (didaftarkan master), tanpa membuat akun kedua dengan HP yang sama.
 * Mengembalikan { status: 'baru' | 'sudah' }.
 */
async function beriAksesKost(env, userId, kunci, { mintaPilih = false } = {}) {
  await env.DB.prepare('insert or ignore into akses_kost (user_id, kost) values (?,?)').bind(userId, kunci).run();
  const lama = await env.DB.prepare('select akses_diminta from users where id=?').bind(userId).first();
  await env.DB.prepare('update users set akses_diminta=? where id=?')
    .bind(mintaPilih || (lama && lama.akses_diminta) ? 1 : 0, userId).run();
  return { status: 'baru' };
}

/**
 * Master membuat kost baru. Tiga cara mendaftarkan adminnya:
 *   1. `hp` milik akun yang sudah ada  -> akun itu langsung diberi akses (tanpa akun baru)
 *   2. `hp` + username + password baru -> akun admin baru dibuat
 *   3. tanpa `hp` (cara lama)          -> akun baru dengan username + password, login dengan username
 * Master juga boleh mendaftarkan admin untuk kost yang SUDAH ADA (tanpa `namaApp` baru).
 */
async function buatKost(req, env, sesi) {
  const data = await req.json().catch(() => ({}));

  // ---- jalur daftar-admin ke kost yang sudah ada ----
  const kunciDiminta = slugKost(String(data.kunci || ''));
  const hpUkuran = logic.normalHpLogin(data.hp || '');
  if (String(data.hp || '').trim() && !hpUkuran) return json({ error: 'Nomor HP tidak valid. Contoh: 081234567890.' }, 400);
  if (kunciDiminta && !String(data.namaApp || '').trim()) {
    const kostAda = await env.DB.prepare('select kunci, nama_app from kosts where kunci=?').bind(kunciDiminta).first();
    if (!kostAda) return json({ error: 'Kost tidak ditemukan.' }, 404);
    if (!hpUkuran) return json({ error: 'Isi No. HP admin yang mau didaftarkan ke kost ini.' }, 400);
    const akun = await env.DB.prepare('select * from users where hp=? and aktif=1').bind(hpUkuran).first();
    if (!akun) {
      return json({
        error: 'Nomor HP ini belum punya akun. Buat akun baru (isi username dan password) atau periksa nomornya.',
        belum_punya_akun: true,
      }, 404);
    }
    const sudahAda = await env.DB.prepare('select 1 as ada from akses_kost where user_id=? and kost=?').bind(akun.id, kunciDiminta).first();
    const pulang = await env.DB.prepare('select count(*) as n from akses_kost where user_id=?').bind(akun.id).first();
    await beriAksesKost(env, akun.id, kunciDiminta, { mintaPilih: true });
    await logic.audit(env, sesi, 'user.akses', 'akses_kost', `${akun.id}:${kunciDiminta}`, null, { hp: hpUkuran, kost: kunciDiminta });
    return json({
      ok: true,
      sudah_ada: !!sudahAda,
      message: sudahAda
        ? `Akun ${akun.username} (${hpUkuran}) memang sudah terdaftar di ${kostAda.nama_app}.`
        : `Akun ${akun.username} (${hpUkuran}) kini bisa mengelola ${kostAda.nama_app}. Saat login akan muncul pilihan kost.`,
      kost: { kunci: kostAda.kunci, namaApp: kostAda.nama_app },
      jumlahKost: Math.max(1, pulang ? pulang.n : 1),
    });
  }

  // ---- jalur buat kost baru ----
  const nama = String(data.namaApp || '').trim().slice(0, 60);
  if (nama.length < 3) return json({ error: 'Nama aplikasi minimal 3 karakter.' }, 400);
  const kunci = slugKost(nama);
  if (!kunci) return json({ error: 'Nama aplikasi harus mengandung huruf atau angka.' }, 400);
  const kota = String(data.kota || '').trim().slice(0, 80);
  const tagline = String(data.tagline || '').trim().slice(0, 120);
  const uname = String(data.username || '').trim().toLowerCase();
  const password = String(data.password || '');

  const sudah = await env.DB.prepare('select kunci from kosts where kunci=? or lower(nama_app)=lower(?)').bind(kunci, nama).first();
  if (sudah) return json({ error: 'Nama aplikasi sudah dipakai. Nama aplikasi harus unik karena menjadi kunci data.' }, 409);

  // Admin bisa berupa akun lama (dikenali dari No. HP) atau akun baru (username+password).
  let akunLama = null;
  if (hpUkuran) {
    akunLama = await env.DB.prepare('select * from users where hp=? and aktif=1').bind(hpUkuran).first();
  }
  if (akunLama) {
    if (uname || password) {
      return json({
        error: `Nomor HP ini sudah dipakai akun "${akunLama.username}". Kosongkan username/password: admin akan memakai akun tersebut dan cukup diberi akses ke kost baru.`,
        akun_ada: true,
      }, 409);
    }
  } else {
    if (!/^[a-z0-9._-]{3,32}$/.test(uname)) return json({ error: 'Username admin 3-32 karakter (huruf kecil/angka/._-).' }, 400);
    if (password.length < 8) return json({ error: 'Password admin minimal 8 karakter.' }, 400);
  }

  await env.DB.prepare('insert into kosts (kunci, nama_app, kota, tagline) values (?,?,?,?)')
    .bind(kunci, nama, kota, tagline).run();

  // Kategori standar untuk kost baru (mengikuti daftar bawaan)
  const bawaan = await env.DB.prepare('select jenis, nama, saldo_normal, arus_kas from categories where kost=?').bind(sesi.kost).all();
  for (const c of (bawaan.results || [])) {
    await env.DB.prepare('insert or ignore into categories (jenis, nama, saldo_normal, arus_kas, kost) values (?,?,?,?,?)')
      .bind(c.jenis, c.nama, c.saldo_normal, c.arus_kas, kunci).run();
  }
  await env.DB.prepare("insert or ignore into counters (kost, nama, value) values (?, 'kode_penyewa', 0)").bind(kunci).run();

  let idUser, namaAdmin, keterangan;
  if (akunLama) {
    idUser = akunLama.id;
    namaAdmin = akunLama.username;
    await beriAksesKost(env, idUser, kunci, { mintaPilih: true });
    keterangan = `Kost "${nama}" dibuat. No. HP ${hpUkuran} (akun ${akunLama.username}) kini mengelola ${nama}.`;
  } else {
    idUser = 'usr_' + crypto.randomUUID().slice(0, 8);
    const hash = await logic.hashPassword(password);
    await env.DB.prepare("insert into users (id, username, fullname, role, password_hash, aktif, must_change_password, kost, hp) values (?,?,?,'admin',?,1,1,?,?)")
      .bind(idUser, uname, String(data.fullname || nama).slice(0, 120), hash, kunci, hpUkuran || null).run();
    await beriAksesKost(env, idUser, kunci, { mintaPilih: false });
    namaAdmin = uname;
    keterangan = `Aplikasi "${nama}" dibuat. Admin ${uname} wajib ganti password saat login pertama.`;
  }

  await logic.audit(env, sesi, 'kost.create', 'kosts', kunci, null, { nama, kota, admin: namaAdmin, hp: hpUkuran || null });
  return json({ ok: true, message: keterangan, kost: { kunci, namaApp: nama, kota, tagline } });
}

// ---------- MASTER: daftarkan No. HP sebagai admin sebuah kost ----------
/**
 * Master mendaftarkan No. HP sebagai admin kost tertentu (kost yang sudah ada).
 * - HP yang sudah punya akun: cukup diberi baris akses_kost (satu akun, banyak kost).
 * - HP yang belum punya akun: dibuatkan akun admin baru di kost itu.
 * Tidak pernah mengubah kost asal akun, jadi HP hanya membuka kost yang terdaftar.
 */
async function daftarkanAdmin(req, env, sesi) {
  const d = await req.json().catch(() => ({}));
  const kunci = slugKost(String(d.kunci || ''));
  if (!kunci) return json({ error: 'Tentukan kost yang mau dikelola.' }, 400);
  const kost = await env.DB.prepare('select kunci, nama_app, aktif from kosts where kunci=?').bind(kunci).first();
  if (!kost || !kost.aktif) return json({ error: 'Kost tidak ditemukan atau tidak aktif.' }, 404);

  const hp = logic.normalHpLogin(d.hp || '');
  if (!hp) return json({ error: 'Nomor HP tidak valid. Contoh: 081234567890.' }, 400);

  const unameDiminta = String(d.username || '').trim().toLowerCase();
  const password = String(d.password || '');
  const akun = await env.DB.prepare('select id, username, role, kost from users where hp=?').bind(hp).first();

  if (akun) {
    const sudah = await env.DB.prepare('select 1 as ada from akses_kost where user_id=? and kost=?').bind(akun.id, kunci).first();
    await beriAksesKost(env, akun.id, kunci, { mintaPilih: true });
    await logic.audit(env, sesi, 'user.akses', 'akses_kost', `${akun.id}:${kunci}`, null, { hp, kost: kunci, sudah: !!sudah });
    return json({
      ok: true,
      akunBaru: false,
      sudahTerdaftar: !!sudah,
      message: sudah
        ? `Nomor HP ${hp} (akun ${akun.username}) memang sudah terdaftar sebagai admin ${kost.nama_app}.`
        : `Nomor HP ${hp} (akun ${akun.username}) sekarang menjadi admin ${kost.nama_app}. Saat login ia akan memilih kost.`,
      kost: { kunci: kost.kunci, namaApp: kost.nama_app },
    });
  }

  // HP belum punya akun -> buatkan akun admin di kost ini.
  const uname = unameDiminta || 'admin';
  if (!/^[a-z0-9._-]{3,32}$/.test(uname)) return json({ error: 'Username admin 3-32 karakter (huruf kecil/angka/._-).' }, 400);
  if (password.length < 8) return json({ error: 'Password awal admin minimal 8 karakter.' }, 400);
  const kembar = await env.DB.prepare('select id from users where username=? and kost=?').bind(uname, kunci).first();
  if (kembar) return json({ error: `Username "${uname}" sudah dipakai di ${kost.nama_app}. Isi username lain.` }, 409);

  const id = 'usr_' + crypto.randomUUID().slice(0, 8);
  const hash = await logic.hashPassword(password);
  await env.DB.prepare("insert into users (id, username, fullname, role, password_hash, aktif, must_change_password, kost, hp) values (?,?,?,'admin',?,1,1,?,?)")
    .bind(id, uname, String(d.fullname || uname).slice(0, 120), hash, kunci, hp).run();
  await beriAksesKost(env, id, kunci, { mintaPilih: true });
  await logic.audit(env, sesi, 'user.create', 'users', id, null, { username: uname, hp, kost: kunci, olehMaster: true });
  return json({
    ok: true,
    akunBaru: true,
    message: `Admin ${uname} (${hp}) dibuat untuk ${kost.nama_app}. Password awal wajib diganti saat login pertama.`,
    kost: { kunci: kost.kunci, namaApp: kost.nama_app },
  });
}

// ---------- rute ----------
// Aksi yang hanya boleh dilakukan admin. Aksi lain boleh untuk semua user aktif.
const KEPERLUAN = {
  'tenants.delete': 'admin',
  'tenants.update': 'admin',
  'tenants.checkout': 'admin',
  'rooms.create': 'admin',
  'payments.void': 'admin',
  'ledger.void': 'admin',
  'rooms.delete': 'admin',
  'rooms.update': 'admin',
  'categories.create': 'admin',
  'categories.update': 'admin',
  'categories.delete': 'admin',
  'data.resetLog': 'master',
  'data.resetPabrik': 'master',
  'users.create': 'admin',
  'users.update': 'admin',
  'users.delete': 'admin',
};


/**
 * RESET (khusus master). Kedua aksi ini menghapus data secara permanen, jadi:
 *   - hanya role master (diperiksa di KEPERLUAN),
 *   - wajib menyertakan password akun sendiri (konfirmasi),
 *   - hanya menyentuh kost yang sedang aktif.
 * Backup disarankan lewat `npm run backup` sebelum menjalankannya; aksi ini dicatat di audit_log.
 */
async function konfirmasiSandi(ctx, sandi) {
  const u = await ctx.env.DB.prepare('select password_hash from users where id=?').bind(ctx.user.id).first();
  if (!u || !(await logic.verifyPassword(String(sandi || ''), u.password_hash))) {
    throw logic.httpError(401, 'Password konfirmasi salah.');
  }
}

async function resetLog(ctx, d) {
  await konfirmasiSandi(ctx, d && d.password);
  const kost = ctx.kost;
  const db = ctx.env.DB;
  const jumlah = await db.prepare('select count(*) as n from payments where kost=?').bind(kost).first();
  const ledger = await db.prepare('select count(*) as n from ledger where kost=?').bind(kost).first();
  // Urutan: pengingat -> pembayaran -> tagihan (yang belum bayar tetap? tidak: semua tagihan dibatalkan)
  await db.batch([
    db.prepare('delete from pengingat_wa where bill_id in (select id from bills where kost=?)').bind(kost),
    db.prepare('delete from payments where kost=?').bind(kost),
    db.prepare('delete from bills where kost=?').bind(kost),
    db.prepare('delete from ledger where kost=?').bind(kost),
    db.prepare("update rooms set status='tersedia' where kost=? and status='terisi'").bind(kost),
  ]);
  await ctx.audit('data.resetLog', 'kosts', kost, null, { payments: jumlah.n, ledger: ledger.n });
  return `Log transaksi ${kost} dikosongkan (${jumlah.n} pembayaran, ${ledger.n} transaksi ledger). Kamar & kategori tetap.`;
}

async function resetPabrik(ctx, d) {
  await konfirmasiSandi(ctx, d && d.password);
  const kost = ctx.kost;
  const db = ctx.env.DB;
  // Urutan penting karena foreign key: pembayaran & tagihan sebelum penyewa, penyewa sebelum kamar.
  await db.batch([
    db.prepare('delete from pengingat_wa where bill_id in (select id from bills where kost=?)').bind(kost),
    db.prepare('delete from payments where kost=?').bind(kost),
    db.prepare('delete from bills where kost=?').bind(kost),
    db.prepare('delete from ledger where kost=?').bind(kost),
    db.prepare('delete from tenants where kost=?').bind(kost),
    db.prepare('delete from rooms where kost=?').bind(kost),
    db.prepare('delete from categories where kost=?').bind(kost),
    db.prepare("update counters set value=0 where kost=? and nama='kode_penyewa'").bind(kost),
  ]);
  await ctx.audit('data.resetPabrik', 'kosts', kost, null, { keterangan: 'setelan pabrik' });
  return `Aplikasi ${kost} disetel ulang ke kondisi pabrik. Akun pengguna tetap ada.`;
}

const AKSI = {
  'tenants.create': logic.createTenant,
  'tenants.update': logic.updateTenant,
  'tenants.checkout': (ctx, d) => logic.checkoutTenant(ctx, d.id, d.kamar),
  'tenants.delete': (ctx, d) => logic.deleteTenant(ctx, d.id, d.kamar),
  'payments.create': logic.recordPayment,
  'payments.void': (ctx, d) => logic.voidPayment(ctx, d.id),
  'ledger.create': addLedger,
  'ledger.void': (ctx, d) => logic.voidOpsTransaction(ctx, d.id),
  'rooms.create': addRoom,
  'rooms.update': updateRoom,
  'rooms.delete': deleteRoom,
  'categories.create': addCategory,
  'categories.update': updateCategory,
  'categories.delete': deleteCategory,
  'pengingat.catat': (ctx, d) => catatPengingat(ctx, d.billId || d.id),
  'data.resetLog': resetLog,
  'data.resetPabrik': resetPabrik,
  'users.create': addUser,
  'users.update': updateUser,
  'users.delete': deleteUser,
};

async function addLedger(ctx, d) {
  // UI lama mengirim jenis berkapital: "Pengeluaran" -> normalisasi
  return logic.addOpsTransaction(ctx, { ...d, jenis: String(d.jenis || '').toLowerCase() });
}

function validRoom(d) {
  const tipe = String(d.tipe || '').trim() || 'Standar';
  const bulanan = logic.num(d.hargaBulanan);
  const harian = logic.num(d.hargaHarian);
  if (bulanan < 0 || harian < 0) throw logic.httpError(400, 'Harga kamar tidak boleh negatif.');
  // Harga 0 dulu lolos (hanya negatif yang ditolak) sehingga kamar bisa tersimpan tanpa tarif
  // dan tagihan berikutnya memakai nominal lama (prorata) — sekarang wajib ada angka.
  if (!(bulanan > 0)) throw logic.httpError(400, 'Harga bulanan wajib diisi dan lebih dari 0.');
  if (!(harian >= 0) || harian > 10000000) throw logic.httpError(400, 'Harga harian tidak masuk akal.');
  if (bulanan > 100000000) throw logic.httpError(400, 'Harga bulanan tidak masuk akal.');
  return { tipe, bulanan, harian };
}

async function addRoom(ctx, d) {
  const no = String(d.noKamar || '').trim();
  if (!no) throw logic.httpError(400, 'Nomor kamar wajib diisi.');
  const { tipe, bulanan, harian } = validRoom(d);
  const dup = await ctx.db.prepare('select id from rooms where no_kamar=?').bind(no).first();
  if (dup) throw logic.httpError(409, `Unit Kamar ${no} sudah terdaftar.`);
  await ctx.db.prepare('insert into rooms (no_kamar, tipe, harga_bulanan, harga_harian, status) values (?,?,?,?,?)')
    .bind(no, tipe, bulanan, harian, 'tersedia').run();
  await ctx.audit('room.create', 'rooms', no, null, { no, tipe, bulanan, harian });
  return `Kamar ${no} (${tipe}) berhasil ditambahkan.`;
}

async function updateRoom(ctx, d) {
  const oldNo = String(d.oldNoKamar || '').trim(), newNo = String(d.noKamar || '').trim();
  if (!newNo) throw logic.httpError(400, 'Nomor kamar wajib diisi.');
  const { tipe, bulanan, harian } = validRoom(d);
  const r = await ctx.db.prepare('select * from rooms where no_kamar=?').bind(oldNo).first();
  if (!r) throw logic.httpError(404, `Kamar ${oldNo} tidak ditemukan.`);
  if (newNo !== oldNo) {
    const dup = await ctx.db.prepare('select id from rooms where no_kamar=?').bind(newNo).first();
    if (dup) throw logic.httpError(409, `Unit Kamar ${newNo} sudah terdaftar.`);
  }
  await ctx.db.prepare('update rooms set no_kamar=?, tipe=?, harga_bulanan=?, harga_harian=? where id=?')
    .bind(newNo, tipe, bulanan, harian, r.id).run();
  await ctx.audit('room.update', 'rooms', newNo, { no: oldNo, tipe: r.tipe, bulanan: r.harga_bulanan }, { no: newNo, tipe, bulanan });
  return `Kamar ${newNo} berhasil diperbarui.`;
}

async function deleteRoom(ctx, d) {
  const r = await ctx.db.prepare('select * from rooms where no_kamar=?').bind(String(d.noKamar || '')).first();
  if (!r) throw logic.httpError(404, `Kamar ${d.noKamar} tidak ditemukan.`);
  const aktif = await ctx.db.prepare("select count(*) as n from tenants where kamar_id=? and status='aktif'").bind(r.id).first();
  if (aktif.n) throw logic.httpError(409, `Kamar ${d.noKamar} masih memiliki penyewa aktif. Check-out dulu.`);
  await ctx.db.prepare('delete from rooms where id=?').bind(r.id).run();
  await ctx.audit('room.delete', 'rooms', r.no_kamar, { no: r.no_kamar, tipe: r.tipe, bulanan: r.harga_bulanan }, null);
  return `Unit Kamar ${d.noKamar} telah dihapus.`;
}

const JENIS_KAT = { pengeluaran: 'Pengeluaran', pendapatan: 'Pendapatan', neraca: 'Neraca' };

function validKat(d) {
  const jenis = String(d.jenis || '').toLowerCase();
  if (!JENIS_KAT[jenis]) throw logic.httpError(400, 'Jenis kategori harus Pendapatan, Pengeluaran, atau Neraca.');
  const nama = String(d.nama || '').trim();
  if (!nama) throw logic.httpError(400, 'Nama kategori wajib diisi.');
  const saldo = String(d.saldoNormal || (jenis === 'pengeluaran' ? 'Debet' : 'Kredit'));
  if (!['Debet', 'Kredit'].includes(saldo)) throw logic.httpError(400, 'Saldo normal harus Debet atau Kredit.');
  const arusKas = d.arusKas === undefined ? 1 : (d.arusKas ? 1 : 0);
  return { jenis, nama, saldo, arusKas };
}

async function addCategory(ctx, d) {
  const { jenis, nama, saldo, arusKas } = validKat(d);
  const dup = await ctx.db.prepare('select id from categories where jenis=? and nama=?').bind(jenis, nama).first();
  if (dup) throw logic.httpError(409, `Kategori "${nama}" sudah ada.`);
  await ctx.db.prepare('insert into categories (jenis, nama, saldo_normal, arus_kas) values (?,?,?,?)').bind(jenis, nama, saldo, arusKas).run();
  await ctx.audit('category.create', 'categories', nama, null, { jenis, nama, saldo, arusKas });
  return `Kategori ${JENIS_KAT[jenis]} "${nama}" ditambahkan.`;
}

async function updateCategory(ctx, d) {
  const id = Number(d.id);
  const old = await ctx.db.prepare('select * from categories where id=?').bind(id).first();
  if (!old) throw logic.httpError(404, 'Kategori tidak ditemukan.');
  const { jenis, nama, saldo, arusKas } = validKat({
    ...d, jenis: d.jenis || old.jenis, saldoNormal: d.saldoNormal || old.saldo_normal,
    arusKas: d.arusKas === undefined ? old.arus_kas : d.arusKas,
  });
  const dup = await ctx.db.prepare('select id from categories where jenis=? and nama=? and id<>?').bind(jenis, nama, id).first();
  if (dup) throw logic.httpError(409, `Kategori "${nama}" sudah ada.`);
  await ctx.db.prepare('update categories set jenis=?, nama=?, saldo_normal=?, arus_kas=? where id=?').bind(jenis, nama, saldo, arusKas, id).run();
  // transaksi lama menyimpan nama kategori sebagai teks: ikut diganti agar laporan tidak terpecah
  await ctx.db.prepare('update ledger set kategori=? where kategori=? and jenis=?').bind(nama, old.nama, old.jenis).run();
  await ctx.audit('category.update', 'categories', id, { jenis: old.jenis, nama: old.nama }, { jenis, nama });
  return `Kategori "${nama}" diperbarui.`;
}

async function deleteCategory(ctx, d) {
  const id = Number(d.id);
  const old = await ctx.db.prepare('select * from categories where id=?').bind(id).first();
  if (!old) throw logic.httpError(404, 'Kategori tidak ditemukan.');
  const dipakai = await ctx.db.prepare('select count(*) as n from ledger where kategori=? and jenis=?').bind(old.nama, old.jenis).first();
  if (dipakai.n) {
    await ctx.db.prepare('update categories set aktif=0 where id=?').bind(id).run();
    return `Kategori "${old.nama}" sudah dipakai ${dipakai.n} transaksi, jadi dinonaktifkan (riwayat tetap utuh).`;
  }
  await ctx.db.prepare('delete from categories where id=?').bind(id).run();
  await ctx.audit('category.delete', 'categories', id, { jenis: old.jenis, nama: old.nama }, null);
  return `Kategori "${old.nama}" dihapus.`;
}

function validUser(d, isNew) {
  const username = String(d.username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw logic.httpError(400, 'Username 3-32 karakter: huruf kecil, angka, titik, garis bawah, atau strip.');
  const role = String(d.role || 'staff');
  // master hanya boleh dibuat oleh master (dijaga di AUTHZ), di sini cukup divalidasi nilainya
  if (!['master', 'admin', 'staff'].includes(role)) throw logic.httpError(400, 'Role harus master, admin, atau staff.');
  const fullname = String(d.fullname || '').trim().slice(0, 120) || username;
  const password = d.password === undefined || d.password === null ? undefined : String(d.password);
  if (isNew && (!password || password.length < 8)) throw logic.httpError(400, 'Password minimal 8 karakter.');
  if (!isNew && password && password.length < 8) throw logic.httpError(400, 'Password minimal 8 karakter.');
  if (password && password.length > 200) throw logic.httpError(400, 'Password maksimal 200 karakter.');
  // No. HP WAJIB: ia identitas tunggal login lintas kost. Akun baru tanpa HP ditolak;
  // akun lama tanpa HP masih boleh login sementara (supaya tidak terkunci massal),
  // tetapi setiap penyimpanan lewat menu User wajib menyertakan HP.
  let hp = undefined;
  if (d.hp !== undefined && d.hp !== null && String(d.hp).trim() !== '') {
    hp = logic.normalHpLogin(d.hp);
    if (!hp) throw logic.httpError(400, 'Nomor HP tidak valid. Contoh: 081234567890.');
  }
  if (isNew && !hp) throw logic.httpError(400, 'Nomor HP wajib diisi (dipakai untuk login).');
  const hpHapus = !isNew && d.hp !== undefined && hp === undefined;
  return { username, role, fullname, password, hp, hpHapus };
}

async function addUser(ctx, d) {
  const { username, role, fullname, password, hp } = validUser(d, true);
  const dup = await ctx.env.DB.prepare('select id from users where username=? and kost=?').bind(username, ctx.kost).first();
  if (dup) throw logic.httpError(409, `Username "${username}" sudah dipakai di kost ini. Nama yang sama boleh dipakai di kost lain.`);
  // Nomor HP adalah identitas login: harus unik.
  if (hp) {
    const hpDipakai = await ctx.env.DB.prepare('select username, kost, must_change_password from users where hp=?').bind(hp).first();
    if (hpDipakai) {
      const akunIni = await ctx.env.DB.prepare('select username from users where hp=? and kost=?').bind(hp, ctx.kost).first();
      // Akun yang belum pernah dipakai (password awal belum diganti) adalah sisa percobaan
      // pembuatan akun sebelumnya, bukan orang lain: izinkan dibuat ulang di kost ini.
      const belumDipakai = hpDipakai.must_change_password === 1 || hpDipakai.must_change_password === true;
      if (!akunIni && !belumDipakai) {
        throw logic.httpError(409, `Nomor HP ini sudah dipakai akun "${hpDipakai.username}" di kost lain. Satu akun bisa mengelola banyak kost — minta master mendaftarkannya, jangan buat akun kedua.`);
      }
      if (!akunIni && belumDipakai) {
        throw logic.httpError(409, `Nomor HP ini sudah terdaftar sebagai "${hpDipakai.username}" (belum pernah dipakai). Minta master mendaftarkan nomor ini ke kost, atau hapus akun itu dari daftar pengguna.`);
      }
    }
  }
  const hash = await logic.hashPassword(password);
  // Password yang dibuatkan admin adalah password awal: pemilik akun wajib menggantinya
  // saat login pertama (dijaga juga di API, bukan hanya di UI).
  const idBaru = 'usr_' + crypto.randomUUID().slice(0, 8);
  // user baru selalu milik kost yang sedang aktif (master pun membuat admin untuk kost aktif)
  await ctx.env.DB.prepare('insert into users (id, username, fullname, role, password_hash, aktif, must_change_password, kost, hp) values (?,?,?,?,?,1,1,?,?)')
    .bind(idBaru, username, fullname, role, hash, ctx.kost, hp || null).run();
  await ctx.env.DB.prepare('insert or ignore into akses_kost (user_id, kost) values (?,?)').bind(idBaru, ctx.kost).run();
  await ctx.audit('user.create', 'users', username, null, { username, role });
  return `Pengguna ${username} (${role}) dibuat. Pemilik akun wajib mengganti password saat login pertama.`;
}

async function updateUser(ctx, d) {
  const id = String(d.id || '');
  const old = await ctx.env.DB.prepare('select * from users where id=?').bind(id).first();
  if (!old) throw logic.httpError(404, 'Pengguna tidak ditemukan.');
  const base = { ...d, username: d.username || old.username, role: d.role || old.role, fullname: d.fullname || old.fullname };
  const { username, role, fullname, password, hp, hpHapus } = validUser(base, false);
  // HP adalah identitas login, jadi akun lama yang belum punya HP wajib melengkapinya
  // saat disimpan (pilihan A) — tidak boleh dibiarkan kosong maupun dihapus.
  if (!hp) throw logic.httpError(400, 'Nomor HP wajib diisi (dipakai untuk login).');
  if (hp) {
    const hpDipakai = await ctx.env.DB.prepare('select username from users where hp=? and id<>?').bind(hp, id).first();
    if (hpDipakai) throw logic.httpError(409, `Nomor HP ini sudah dipakai akun "${hpDipakai.username}".`);
  }
  const aktif = d.aktif === undefined ? old.aktif : (d.aktif ? 1 : 0);
  // jangan sampai tidak ada admin aktif yang tersisa
  if (old.role === 'admin' && (role !== 'admin' || !aktif)) {
    const admins = await ctx.env.DB.prepare("select count(*) as n from users where role='admin' and aktif=1 and id<>?").bind(id).first();
    if (!admins.n) throw logic.httpError(409, 'Minimal harus ada satu admin aktif.');
  }
  if (old.id === ctx.user.id && !aktif) throw logic.httpError(409, 'Tidak bisa menonaktifkan akun yang sedang dipakai.');
  const dup = await ctx.env.DB.prepare('select id from users where username=? and kost=? and id<>?').bind(username, old.kost, id).first();
  if (dup) throw logic.httpError(409, `Username "${username}" sudah dipakai di kost ini.`);
  // hpBaru: nilai final kolom hp. HP wajib, jadi tidak ada lagi keadaan "hapus nomor".
  const hpBaru = hp;
  // Sandi hanya di-hash bila benar-benar diisi: string kosong berarti "jangan ubah sandi",
  // bukan "ubah sandi menjadi hash kosong" (dulu ini membuat akun tak bisa login).
  if (password) {
    await ctx.env.DB.prepare('update users set username=?, fullname=?, role=?, aktif=?, hp=coalesce(?, hp), password_hash=?, must_change_password=1 where id=?')
      .bind(username, fullname, role, aktif, hpBaru === undefined ? null : hpBaru, await logic.hashPassword(password), id).run();
    await ctx.env.DB.prepare('delete from sessions where user_id=? and token_hash<>?').bind(id, sesiHashOf(ctx)).run();
  } else {
    await ctx.env.DB.prepare('update users set username=?, fullname=?, role=?, aktif=?, hp=coalesce(?, hp) where id=?')
      .bind(username, fullname, role, aktif, hpBaru === undefined ? null : hpBaru, id).run();
  }
  if (!aktif) await ctx.env.DB.prepare('delete from sessions where user_id=?').bind(id).run();
  await ctx.audit('user.update', 'users', id, { username: old.username, role: old.role, aktif: old.aktif, hp: old.hp }, { username, role, aktif, hp: hpBaru === undefined ? old.hp : hpBaru });
  return `Pengguna ${username} diperbarui.`;
}

const sesiHashOf = (ctx) => (ctx && ctx.user && ctx.user.token_hash) || '';

async function deleteUser(ctx, d) {
  // users & sessions adalah tabel GLOBAL (tidak per kost) — langsung ke env.DB.
  // Kalau lewat ctx.db (pembungkus multitenan), query ini akan mencoba memakai kolom kost
  // yang tidak ada pada tabel users sehingga gagal 500.
  const id = String(d.id || '');
  const old = await ctx.env.DB.prepare('select * from users where id=?').bind(id).first();
  if (!old) throw logic.httpError(404, 'Pengguna tidak ditemukan.');
  if (old.id === ctx.user.id) throw logic.httpError(409, 'Tidak bisa menghapus akun yang sedang dipakai.');
  if (['admin', 'master'].includes(old.role)) {
    const admins = await ctx.env.DB.prepare("select count(*) as n from users where role=? and aktif=1 and kost=? and id<>?").bind(old.role, old.kost, id).first();
    if (!admins.n) throw logic.httpError(409, 'Minimal harus ada satu admin aktif.');
  }
  // akun yang punya jejak transaksi hanya dinonaktifkan supaya audit tetap utuh
  const jejak = await ctx.env.DB.prepare('select (select count(*) from payments where created_by=?) + (select count(*) from ledger where created_by=?) as n')
    .bind(id, id).first();
  await ctx.env.DB.prepare('delete from sessions where user_id=?').bind(id).run();
  if (jejak.n) {
    await ctx.env.DB.prepare('update users set aktif=0 where id=?').bind(id).run();
    await ctx.audit('user.deactivate', 'users', id, { username: old.username }, null);
    return `Pengguna ${old.username} dinonaktifkan (punya riwayat transaksi, tidak dihapus).`;
  }
  await ctx.env.DB.prepare('delete from users where id=?').bind(id).run();
  await ctx.env.DB.prepare('delete from akses_kost where user_id=?').bind(id).run().catch(() => {});
  await ctx.audit('user.delete', 'users', id, { username: old.username, role: old.role }, null);
  return `Pengguna ${old.username} dihapus.`;
}


// =====================================================================
// MULTITENAN — helper & endpoint
// =====================================================================

/** Ambil detail kost (dipakai layar login & UI sebagai branding). */
async function ambilKost(env, kunci) {
  const k = String(kunci || 'kost-hade');
  try {
    const r = await env.DB.prepare('select kunci, nama_app, kota, tagline, logo_kunci from kosts where kunci=?').bind(k).first();
    if (!r) return { kunci: k, namaApp: 'Kost Hade', kota: '', tagline: '', logoKunci: null };
    return { kunci: r.kunci, namaApp: r.nama_app, kota: r.kota || '', tagline: r.tagline || '', logoKunci: r.logo_kunci || null };
  } catch (e) {
    // migrasi belum jalan: aplikasi tetap berjalan sebagai satu kost
    return { kunci: k, namaApp: 'Kost Hade', kota: 'Purwokerto', tagline: 'Guesthouse Management Premium', logoKunci: null };
  }
}

/** Ambil baris kost; kembalikan kosong bila kost tidak ada (bukan nama bawaan). */
async function cariBarisKost(env, kunci) {
  try {
    return await env.DB.prepare('select kunci, nama_app from kosts where kunci=?').bind(String(kunci || '')).first();
  } catch (e) { return null; }
}

/** Nama aplikasi -> kunci unik. "Kost Hade" -> "kost-hade"; dipakai sebagai kunci data. */
function slugKost(nama) {
  const s = String(nama || '').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return s || '';
}

/** Cek apakah akun boleh membuka kost tertentu (master: semua). */
async function bolehKost(env, user, kunci) {
  if (user.role === 'master') return true;
  if (!kunci) return false;
  if (user.kost === kunci) return true;
  try {
    const r = await env.DB.prepare('select 1 as ada from akses_kost where user_id=? and kost=?').bind(user.id, kunci).first();
    return !!r;
  } catch (e) { return user.kost === kunci; }
}

/** Simpan/perbarui parameter kost. Nama aplikasi hanya boleh diisi saat pembuatan. */
async function simpanParameter(ctx, data, kunciKost) {
  const db = ctx.env.DB;            // kosts = tabel global (bukan per kost)
  const kota = String(data.kota || '').trim().slice(0, 80);
  const tagline = String(data.tagline || '').trim().slice(0, 120);
  const nama = String(data.namaApp || '').trim().slice(0, 60);
  const lama = await db.prepare('select * from kosts where kunci=?').bind(kunciKost).first();
  if (!lama) throw logic.httpError(404, 'Kost tidak ditemukan.');
  // Nama aplikasi adalah kunci data: mengubahnya akan memutus seluruh data lama.
  if (nama && nama.toLowerCase() !== String(lama.nama_app).toLowerCase()) {
    throw logic.httpError(409, 'Nama aplikasi tidak bisa diubah setelah dibuat (menjadi kunci data). Buat kost baru bila perlu nama lain.');
  }
  await db.prepare('update kosts set kota=?, tagline=? where kunci=?')
    .bind(kota, tagline, kunciKost).run();
  await ctx.audit('kost.parameter', 'kosts', kunciKost, { kota: lama.kota, tagline: lama.tagline }, { kota, tagline });
  return 'Parameter aplikasi disimpan.';
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const secure = (env.COOKIE_SECURE ?? 'true') !== 'false';
    const today = logic.todayISO();
    const api = url.pathname.startsWith('/api/');

    // ---- batas laju (per IP): login paling ketat, tulis lebih ketat dari baca ----
    // Untuk GET cukup satu kuota longgar; POST dipisah per kelompok rute supaya
    // perubahan data, login, dan konfirmasi password tidak saling memakan kuota.
    if (api) {
      const ip = ipKlien(req);
      const jalur = url.pathname === '/api/login' ? 'login'
                  : url.pathname === '/api/password' ? 'sandi'
                  : url.pathname === '/api/action' ? 'tulis'
                  : (req.method === 'POST' ? 'post' : 'baca');
      const maks = jalur === 'login' ? BATAS_LAJU.login
                 : jalur === 'sandi' ? BATAS_LAJU.sandi
                 : jalur === 'baca' ? BATAS_LAJU.baca
                 : BATAS_LAJU.tulis;
      // Penghitung batas laju tidak permanen: isolate Cloudflare berpindah-pindah sehingga
    // hitungan lokal bisa dipakai bergantian. Tiap menit peta dibersihkan agar kuota
    // selalu segar (cukup untuk menahan banjir, tanpa risiko "terkunci selamanya").
    const nowMs = Date.now();
    for (const [k, v] of _hitung) if (nowMs - v.mulai > BATAS_LAJU.jendelaMs) _hitung.delete(k);
    if (!bolehLewat(`laju:${jalur}:${ip}`, maks)) {
        return corsApk(req, jawabApi(req, { error: 'Terlalu banyak permintaan. Coba lagi sebentar.' }, 429,
          { 'retry-after': '60' }));
      }
    }

    // preflight dari APK (halaman file://) — dijawab sebelum autentikasi
    if (req.method === 'OPTIONS' && api) {
      return corsApk(req, new Response(null, { status: 204, headers: kepalaKeamanan(new Headers(), true) }));
    }

    if (api) {
      const res = await tanganiApi(req, env, url, secure, today);
      const h = kepalaKeamanan(new Headers(res.headers), true);
      return corsApk(req, new Response(res.body, { status: res.status, headers: h }));
    }

    // ---- UI: halaman disajikan Worker supaya header keamanan benar-benar terpasang ----
    // Lapisan aset Cloudflare melayani / dan /index.html sendiri (dengan cache + _headers),
    // sehingga header di bawah tidak pernah sampai ke browser. Karena itu index.html
    // disimpan sebagai pub/app.html (bukan nama yang dilayani otomatis) dan disajikan
    // dari sini untuk "/" dan "/index.html".
    if (req.method === 'GET' || req.method === 'HEAD') {
      const hal = SajikanHalaman(env, url);
      if (hal) return hal;
    }

    // Berkas statis lain (d1-adapter.js, ikon, manifest) tetap lewat lapisan aset.
    // Header ditempel pada objek respons apa adanya (jangan dibuat ulang — respons aset
    // bisa berupa stream dan akan kehilangan isinya).
    const res = await env.ASSETS.fetch(req);
    res.headers.set('x-frame-options', 'DENY');
    res.headers.set('x-content-type-options', 'nosniff');
    res.headers.set('referrer-policy', 'same-origin');
    res.headers.set('permissions-policy', 'geolocation=(), camera=(), microphone=()');
    return res;
  },
};

// =====================================================================
// HALAMAN (UI) — disajikan Worker, bukan lapisan aset, agar header aman ikut.
// Berkas sumbernya pub/app.html. Disimpan di memori isolate supaya permintaan
// berikutnya tidak perlu mengambil aset lagi (isolate hidup beberapa menit).
// =====================================================================
const HALAMAN_BERKAS = '/app.html';
let _halaman = null;                                  // { isi, rilisAkhir }

async function bacaHalaman(env, url) {
  // Fetcher aset di wrangler dev mengabaikan host buatan; pakai host permintaan asli,
  // ganti jalurnya ke berkas halaman.
  const asal = url ? url.origin : 'http://aset.internal';
  const res = await env.ASSETS.fetch(`${asal}${HALAMAN_BERKAS}`);
  if (!res.ok) return null;
  const isi = await res.text();
  if (!isi || !/<html/i.test(isi)) return null;
  _halaman = { isi, rilisAkhir: res.headers.get('last-modified') || '' };
  return _halaman;
}

// CSP halaman: skrip/gaya sebaris dipakai oleh index.html, jadi 'unsafe-inline' diperlukan.
// Yang tetap ditutup: frame (anti clickjacking), plugin, dan pengiriman data keluar.
const CSP_HALAMAN = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

async function SajikanHalaman(env, url) {
  const jalur = url.pathname;
  const mauHalaman = jalur === '/' || jalur === '/index.html'
                  || jalur === '/app.html'                       // cegah sumber mentah diakses langsung
                  || jalur === '/manifest.webmanifest';
  if (!mauHalaman) return null;

  if (jalur === '/manifest.webmanifest') {
    return new Response(JSON.stringify({
      name: 'Kost Hade — Manajemen Kost',
      short_name: 'Kost Hade',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#f8fafc',
      theme_color: '#2563eb',
      lang: 'id',
      icons: [
        { src: '/ikon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: '/ikon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    }), {
      headers: kepalaKeamanan(new Headers({ 'content-type': 'application/manifest+json; charset=utf-8' }), false),
    });
  }

  const hal = _halaman || (await bacaHalaman(env, url));
  if (!hal) {
    return new Response('Halaman aplikasi belum tersedia.', {
      status: 500,
      headers: kepalaKeamanan(new Headers({ 'content-type': 'text/plain; charset=utf-8' }), false),
    });
  }
  const h = kepalaKeamanan(new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',                       // selalu revalidasi supaya pembaruan UI cepat sampai
  }), false);
  h.set('content-security-policy', CSP_HALAMAN);
  if (hal.rilisAkhir) h.set('last-modified', hal.rilisAkhir);
  return new Response(hal.isi, { status: 200, headers: h });
}


/** Normalisasi nama pengguna saat login: buang spasi, kecilkan huruf. */
function normalNamaPengguna(x) {
  return String(x || '').trim().toLowerCase();
}

/**
 * Cari akun dari yang diketik pengguna. Bila yang diketik berbentuk email tetapi tidak ada
 * akun dengan email itu, coba bagian sebelum '@' (username klasik). Dengan begitu pengguna
 * bisa memakai email sebagai identitas login tanpa kehilangan akun lama.
 */

/** Buat sesi untuk satu akun dan balas data login (dipakai login normal & pilih-kost). */
async function masukSebagai(env, u, secure, hariSesi, kostDiminta, opsi = {}) {
  // Kost yang dibuka: yang diminta (bila akun memang punya akses), kost induk,
  // atau satu-satunya kost yang terdaftar di akses_kost.
  let kunci = '';
  if (kostDiminta) {
    const izin = await env.DB.prepare(`select kost from akses_kost where user_id=?
                                         union select ? where ? <> ''`).bind(u.id, u.kost, u.kost).all();
    const diminta = String(kostDiminta).trim().toLowerCase();
    const cocok = (izin.results || []).find((r) => r.kost === diminta
      || (diminta.length > 2 && String(r.kost).includes(diminta)
        && (izin.results || []).filter((x) => String(x.kost).includes(diminta)).length === 1));
    kunci = cocok ? cocok.kost : '';
  }
  if (!kunci && u.kost) kunci = u.kost;

  const token = logic.randomToken();
  const exp = new Date(Date.now() + hariSesi * 86400000).toISOString();
  await env.DB.prepare('insert into sessions (token_hash, user_id, expires_at, kost) values (?,?,?,?)')
    .bind(await logic.sha256hex(token), u.id, exp, kunci).run();
  const infoKost = await ambilKost(env, kunci);
  // APK bersama meminta kost yang tidak cocok: kirim juga daftar kost akun supaya
  // aplikasi langsung menampilkan pilihan (tanpa login ulang).
  const balasan = {
    ok: true, token, sesiHari: hariSesi,
    user: { username: u.username, fullname: u.fullname, role: u.role },
    kost: infoKost,
  };
  if (opsi.perluPilih) {
    const pilih = await daftarKostAkun(env, u);
    if (pilih.length > 1) {
      balasan.perluPilihKost = true;
      balasan.daftarKost = pilih;
    }
  }
  return json(balasan, 200, { 'set-cookie': setSesiCookie(token, secure, hariSesi * 86400) });
}

/**
 * Akun yang punya lebih dari satu kost (atau master mendaftarkannya sebagai admin >
 * satu kost) HARUS memilih kost dulu. Tanpa ini, login lewat No. HP langsung masuk ke
 * kost induk tanpa menampilkan pilihan, dan akun bisa tampak "salah kost".
 * Mengembalikan respons `json` bila perlu memilih, selain itu null.
 */
// Daftar kost yang boleh dibuka akun (induk + akses_kost), tanpa duplikat.
async function daftarKostAkun(env, u) {
  const izin = await env.DB.prepare('select kost from akses_kost where user_id=?').bind(u.id).all().catch(() => ({ results: [] }));
  const kunci = [...new Set([...(izin.results || []).map((r) => r.kost).filter(Boolean), u.kost].filter(Boolean))];
  const hasil = [];
  for (const k of kunci) {
    const d = await ambilKost(env, k);
    hasil.push({ kunci: k, namaApp: d.namaApp || k, kota: d.kota || '', tagline: d.tagline || '' });
  }
  return hasil;
}

async function mintaPilihBilaBanyak(env, u, secure, hariSesi) {
  if (u.role === 'master') return null;
  const izin = await env.DB.prepare('select kost from akses_kost where user_id=?').bind(u.id).all();
  const daftar = (izin.results || []).map((r) => r.kost).filter(Boolean);
  if (!daftar.length) daftar.push(u.kost);
  // Akun yang sama bisa terdaftar di users.kost sebagai induk dan di akses_kost:
  // hitung kost unik, supaya akun satu kost tidak dibuatkan pilihan palsu.
  const banyak = [...new Set([...daftar, u.kost].filter(Boolean))];
  if (banyak.length === 1 && !u.akses_diminta) return null;
  if (!banyak.length) return null;

  const info = [];
  for (const k of banyak) {
    const d = await ambilKost(env, k);
    info.push({ kunci: k, namaApp: d.namaApp || k, kota: d.kota || '', tagline: d.tagline || '' });
  }
  const tokenPilih = logic.randomToken();
  const exp = new Date(Date.now() + hariSesi * 86400000).toISOString();
  await env.DB.prepare('insert into sessions (token_hash, user_id, expires_at, kost) values (?,?,?,?)')
    .bind(await logic.sha256hex(tokenPilih), u.id, exp, null).run();
  return json({
    ok: true, perluPilihKost: true, token: tokenPilih,
    user: { username: u.username, fullname: u.fullname, role: u.role },
    daftarKost: info,
  }, 200, { 'set-cookie': setSesiCookie(tokenPilih, secure, hariSesi * 86400) });
}

/**
 * Pesan gagal login yang menjelaskan sebabnya, tanpa membocorkan keberadaan akun.
 * Bila akun memang masih memakai sandi awal (must_change_password) atau sandinya sudah
 * pernah diganti sendiri, pengguna diberi tahu supaya tidak menebak-nebak.
 * Akun yang tidak ditemukan tetap memakai pesan umum yang sama.
 */
async function pesanSandiSalah(env, daftarAkun) {
  const UMUM = 'Kombinasi nama pengguna atau kata sandi tidak sesuai.';
  const akun = (daftarAkun || []).filter(Boolean);
  if (!akun.length) return { error: UMUM };
  const harusGanti = akun.some((a) => a.must_change_password);
  if (harusGanti) {
    return { error: 'Sandi belum sesuai. Akun ini masih memakai sandi awal, jadi sandi lama sudah tidak berlaku — gunakan sandi baru yang sudah diganti, atau minta admin mereset sandi.' };
  }
  // Sandi sudah diganti sendiri: tegaskan sandi awal tidak berlaku lagi.
  return { error: 'Sandi tidak sesuai. Akun ini sudah pernah mengganti sandi, jadi sandi awal tidak berlaku. Hubungi admin bila lupa sandi.' };
}

async function cariAkunLogin(env, diketik, kostDiminta) {
  const d = normalNamaPengguna(diketik);

  // 1) Nomor HP: bentuk apa pun (0812…, +62…, 62…, 812…) dicari dalam bentuk baku.
  //    Bila terlihat seperti HP, JANGAN lanjut mencari username: nomor HP adalah identitas
  //    tunggal (unik global), sehingga tidak mungkin nyasar ke akun kost lain.
  if (logic.miripNomorHp(d)) {
    const hp = logic.normalHpLogin(d);
    if (!hp) return null;
    const akun = await env.DB.prepare('select * from users where hp=? and aktif=1').bind(hp).first();
    return akun || null;
  }

  // 2) Login HANYA lewat No. HP. Kolom yang bukan nomor HP ditolak tanpa mencari
  //    username, supaya nama pengguna tidak bisa dipakai sebagai pintu masuk.
  return null;
}

// ---- Kata kunci kost dari APK bersama (mis. /?kost=kost-melati) ----
// Mengembalikan kunci kost yang cocok bila akun memang punya akses; '' bila tidak
// atau bila kata kuncinya ambigu (beberapa kost cocok).
async function pilihKostSesuaiPetunjuk(env, akun, petunjuk) {
  const p = String(petunjuk || '').trim().toLowerCase();
  if (!p || !akun) return '';
  // Perbandingan kata kunci memakai daftar kost yang ADA di DB: tanpa ini kata ngawur
  // bisa cocok dengan kunci kost miliknya sendiri (mis. "ngawur" ⊂ "kost-kost-ngawur").
  const baris = await cariBarisKost(env, p);
  if (!baris) return '';
  const izin = await daftarKostAkun(env, akun);
  const semua = izin.map((r) => ({ kost: r.kunci, nama_app: r.namaApp }));
  const sama = semua.find((r) => r.kost === baris.kunci);
  if (sama && baris.kunci === p) return sama.kost;   // cocok persis
  if (sama && String(baris.kunci).includes(p)) {
    // kata kunci hanya sebagian dari kunci kost: cari kost yang kuncinya cocok penuh
    const miripKunci = semua.filter((r) => String(r.kost).includes(p));
    if (miripKunci.length === 1) return miripKunci[0].kost;
    return '';                                        // tidak unik: jangan menebak
  }
  if (p.length < 3) return '';
  const mirip = semua.filter((r) => (String(r.kost).includes(p)
    || String(r.nama_app || '').toLowerCase().includes(p)));
  // hanya dipakai bila tidak ambigu (satu kost yang cocok)
  return mirip.length === 1 ? mirip[0].kost : '';
}

async function tanganiApi(req, env, url, secure, today) {

    try {
      // ---------- auth ----------
      if (url.pathname === '/api/login') {
        if (req.method !== 'POST') return json({ error: 'Gunakan POST untuk login.' }, 405);
        const { username, password, kost, ingat } = await req.json().catch(() => ({}));
        const hariSesi = ingat ? SESI_INGAT_HARI : SESI_HARI;
        const uname = String(username || '').trim().toLowerCase();
        // ---- batas percobaan login (anti tebak sandi) ----
        // Dihitung per nama pengguna + alamat IP, jendela 15 menit. Setelah 10 kali gagal,
        // akun dikunci sementara walau sandi akhirnya benar.
        const ip = req.headers.get('cf-connecting-ip') || 'lokal';
        const jendela = "datetime('now','-15 minutes')";
        try {
          const gagal = await env.DB.prepare(
            'select count(*) as n from login_percobaan where username=? and ip=? and berhasil=0 and created_at > datetime(\'now\',\'-15 minutes\')'
          ).bind(uname, ip).first();
          if (gagal && gagal.n >= 10) {
            return json({ error: 'Terlalu banyak percobaan gagal. Coba lagi dalam 15 menit.' }, 429);
          }
        } catch (_) { /* tabel belum ada (migrasi belum jalan): jangan blokir login */ }

        const hasilCari = await cariAkunLogin(env, uname, kost);
        // Kata kunci kost dari APK bersama (?kost=...): user langsung diarahkan ke kost itu
        // kalau memang punya akses. Tanpa kata kunci, tetap memakai kost milik akun.
        const petunjukKost = String(kost || '').trim().toLowerCase();
        let acuanKost = '';   // petunjuk mentah TIDAK dipakai langsung: harus cocok ke akses akun
        if (hasilCari && !hasilCari.__banyak) {
          const pilih = await pilihKostSesuaiPetunjuk(env, hasilCari, petunjukKost);
          if (pilih) acuanKost = pilih;
        }
        // Username yang sama ada di lebih dari satu kost: minta pengguna memilih kost
        // (atau memakai No. HP, yang unik dan langsung menunjuk satu akun).
        if (hasilCari && hasilCari.__banyak) {
          const kandidat = hasilCari.__banyak;
          const cocokSandi = [];
          for (const k of kandidat) {
            if (await logic.verifyPassword(String(password || ''), k.password_hash)) cocokSandi.push(k);
          }
          if (!cocokSandi.length) {
            await env.DB.prepare('insert into login_percobaan (username, ip, berhasil) values (?,?,0)')
              .bind(uname, ip).run().catch(() => {});
            return json(await pesanSandiSalah(env, kandidat), 401);
          }
          const unik = ['admin', 'master'].includes(cocokSandi[0].role) ? cocokSandi : cocokSandi.slice(0, 1);
          if (unik.length === 1) {
            return masukSebagai(env, unik[0], secure, hariSesi, acuanKost);
          }
          // beberapa kost dengan sandi yang sama -> tampilkan pilihan kost
          const daftar = [];
          for (const k of unik) {
            const info = await ambilKost(env, k.kost);
            daftar.push({ kunci: k.kost, namaApp: info.namaApp, kota: info.kota, tagline: info.tagline });
          }
          const tokenPilih = logic.randomToken();
          const expPilih = new Date(Date.now() + hariSesi * 86400000).toISOString();
          await env.DB.prepare('insert into sessions (token_hash, user_id, expires_at, kost) values (?,?,?,?)')
            .bind(await logic.sha256hex(tokenPilih), unik[0].id, expPilih, null).run();
          return json({
            ok: true, perluPilihKost: true, token: tokenPilih,
            user: { username: unik[0].username, fullname: unik[0].fullname, role: unik[0].role },
            daftarKost: daftar,
          }, 200, { 'set-cookie': setSesiCookie(tokenPilih, secure, hariSesi * 86400) });
        }
        const u = hasilCari;
        const cocok = u ? await logic.verifyPassword(String(password || ''), u.password_hash) : false;
        await env.DB.prepare('insert into login_percobaan (username, ip, berhasil) values (?,?,?)')
          .bind(uname, ip, cocok ? 1 : 0).run().catch(() => {});
        if (!cocok) {
          await logic.audit(env, { id: null, username: uname, role: 'sistem' }, 'login.gagal', 'users', uname, null, { ip }).catch(() => {});
          // Login hanya lewat No. HP: kalau yang diketik bukan nomor HP, jelaskan langsung
          // supaya pengguna tidak mengira sandinya salah.
          if (!logic.miripNomorHp(uname)) {
            return json({ error: 'Login hanya bisa memakai No. HP. Masukkan nomor HP yang terdaftar di akun, contoh 081234567890.' }, 400);
          }
          return json(await pesanSandiSalah(env, u ? [u] : []), 401);
        }
        const token = logic.randomToken();
        const exp = new Date(Date.now() + hariSesi * 86400000).toISOString();

        // ---- pilih kost untuk sesi ini ----
        // APK bersama: kata kunci kost (?kost=...) sudah dicocokkan ke akses akun di atas
        // (acuanKost). Bila akun hanya punya satu kost, langsung masuk ke kost itu.
        if (acuanKost && !u.must_change_password) {
          return masukSebagai(env, u, secure, hariSesi, acuanKost);
        }
        // Kata kunci kost dari APK diminta tapi tidak cocok dengan akses akun (atau akun
        // wajib ganti sandi): sementara sesi memakai kost induk akun, lalu aplikasi
        // menampilkan pilihan kost yang sudah tersaring. Pengguna tidak perlu login ulang.
        if (petunjukKost && (!acuanKost || u.must_change_password)) {
          return masukSebagai(env, u, secure, hariSesi, '', { perluPilih: true });
        }

        // Akun yang terdaftar di lebih dari satu kost: wajib memilih dulu, jangan
        // langsung masuk ke kost induk (ini yang membuat HP sama bisa masuk kost lain).
        const pilihDulu = await mintaPilihBilaBanyak(env, u, secure, hariSesi);
        if (pilihDulu) return pilihDulu;

        await env.DB.prepare("delete from sessions where expires_at < datetime('now')").run().catch(() => {});
        await env.DB.prepare("delete from login_percobaan where created_at < datetime('now','-2 days')").run().catch(() => {});
        // Akun satu kost: langsung masuk ke kost itu.
        return masukSebagai(env, u, secure, hariSesi, acuanKost);
      }

      const sesi = await sesiAktif(env, req);

      if (url.pathname === '/api/logout') {
        if (req.method !== 'POST') return json({ error: 'Gunakan POST untuk logout.' }, 405);
        const t = cookieValue(req, 'hade_sesi');
        if (t) await env.DB.prepare('delete from sessions where token_hash=?').bind(await logic.sha256hex(t)).run();
        return json({ ok: true }, 200, { 'set-cookie': setSesiCookie('', secure, 0) });
      }

      if (url.pathname === '/api/session') {
        if (!sesi) return json({ logged_in: false });
        const infoKost = await ambilKost(env, sesi.kost);
        return json({
          logged_in: true,
          user: {
            id: sesi.id, username: sesi.username, fullname: sesi.fullname, role: sesi.role,
            must_change_password: !!sesi.must_change_password, kost: sesi.kost,
          },
          kost: infoKost,
          sesiBerakhir: sesi.expires_at || null,
        });
      }
      // Logo aplikasi bersifat PUBLIK: ditampilkan di layar login sebelum pengguna
      // punya sesi. Aman karena hanya berisi gambar logo, dan kunci harus cocok dengan
      // kost yang disebut (tidak bisa menebak logo kost lain).
      if (url.pathname === '/api/logo' && req.method === 'GET') {
        return sajikanLogo(env, url.searchParams.get('kunci') || '', url.searchParams.get('kost') || 'kost-hade');
      }

      if (!sesi) return json({ error: 'Sesi berakhir. Silakan login ulang.' }, 401);

      // Password awal (dari tools/buat-akun.mjs) wajib diganti sebelum menyentuh data.
      // Tanpa ini, ?view=password cukup dilewati dengan memanggil API lain langsung,
      // sehingga sandi awal tetap bisa dipakai mengelola aplikasi.
      // Pengecualian: /api/pilih-kost. Akun multi-kost yang dibuat master bisa punya
      // password awal; ia harus bisa memilih kost dulu, dan data baru terbuka setelah
      // sandi diganti (semua endpoint data tetap diblokir).
      const bolehTanpaGanti = url.pathname === '/api/password' || url.pathname === '/api/logout'
                           || url.pathname === '/api/session' || url.pathname === '/api/pilih-kost';
      // Master boleh langsung memakai aplikasi walau sandinya baru dibuat admin sistem:
      // akun master bersifat pemilik sistem, dan UI tetap menawarkan ganti sandi.
      // Admin/staff tetap wajib mengganti sandi awal (akun mereka dibuat pihak lain).
      const wajibGanti = sesi.must_change_password && sesi.role !== 'master';
      if (wajibGanti && !bolehTanpaGanti) {
        return json({ error: 'Anda wajib mengganti password terlebih dahulu.', kode: 'ganti_password' }, 403);
      }

      // ---------- ganti password sendiri ----------
      if (url.pathname === '/api/password' && req.method === 'POST') {
        const { lama, baru } = await req.json().catch(() => ({}));
        const u = await env.DB.prepare('select * from users where id=?').bind(sesi.id).first();
        if (!u || !(await logic.verifyPassword(String(lama || ''), u.password_hash)))
          return json({ error: 'Password lama tidak sesuai.' }, 401);
        if (String(baru || '').length < 8) return json({ error: 'Password baru minimal 8 karakter.' }, 400);
        await env.DB.prepare('update users set password_hash=?, must_change_password=0 where id=?')
          .bind(await logic.hashPassword(String(baru)), sesi.id).run();
        await env.DB.prepare('delete from sessions where user_id=? and token_hash<>?')
          .bind(sesi.id, sesi.token_hash).run();
        await logic.audit(env, sesi, 'user.password', 'users', sesi.id, null, null);
        return json({ ok: true, message: 'Password berhasil diganti. Sesi lain sudah dikeluarkan.' });
      }

      // ---------- baca ----------
      if (url.pathname === '/api/bootstrap') {
        const db = dbKost(env.DB, sesi.kost);
        // master melihat ringkasan kost yang sedang aktif; admin hanya kost miliknya
        const [d, ops, cats, us] = await Promise.all([
          dashboard(env, db, sesi.kost), daftarLedger(env.DB, sesi.kost),
          db.prepare('select * from categories where aktif=1 order by jenis, nama').all(),
          env.DB.prepare('select id, username, fullname, role, aktif, created_at, kost, hp from users where kost=? order by username').bind(sesi.kost).all(),
        ]);
        const kategori = { Pengeluaran: [], Pendapatan: [], Neraca: [] };
        (cats.results || []).forEach((c) => {
          const k = c.jenis.charAt(0).toUpperCase() + c.jenis.slice(1);
          (kategori[k] = kategori[k] || []).push({ id: c.id, nama: c.nama, saldoNormal: c.saldo_normal, jenis: k, arusKas: c.arus_kas !== 0 });
        });
        const users = ['admin', 'master'].includes(sesi.role)
          ? (us.results || []).map((u) => ({ id: u.id, username: u.username, nama: u.fullname, fullname: u.fullname, role: u.role, aktif: u.aktif, hp: u.hp || '' }))
          : [];
        return json({ ...d, ops, kategori, users, kost: await ambilKost(env, sesi.kost) });
      }
      // ---------- MULTITENAN: pilih kost, parameter, logo, daftar kost (master) ----------
      if (url.pathname === '/api/pilih-kost' && req.method === 'POST') {
        // Sama seperti pagar wajib-ganti-sandi: master tidak dikunci (lihat catatan di
        // blok `wajibGanti`). Kalau dikunci di sini, master dengan sandi awal tidak bisa
        // memilih kost sehingga tidak pernah bisa masuk aplikasi.
        if (sesi.must_change_password && sesi.role !== 'master') {
          const cekU = await env.DB.prepare('select must_change_password from users where id=?').bind(sesi.id).first();
          if (cekU && cekU.must_change_password) return json({ error: 'Ganti password dulu.' }, 403);
        }
        const { kunci } = await req.json().catch(() => ({}));
        const k = String(kunci || '').trim().toLowerCase();
        if (!k) return json({ error: 'Kode aplikasi wajib dipilih.' }, 400);
        if (!(await bolehKost(env, sesi, k))) return json({ error: 'Akun ini tidak punya akses ke aplikasi tersebut.' }, 403);
        await env.DB.prepare('update sessions set kost=? where token_hash=?').bind(k, sesi.token_hash).run();
        sesi.kost = k;
        return json({ ok: true, kost: await ambilKost(env, k) });
      }

      if (url.pathname === '/api/parameter' && req.method === 'POST') {
        if (!['admin', 'master'].includes(sesi.role)) return json({ error: 'Hanya admin yang boleh mengubah parameter.' }, 403);
        const data = await req.json().catch(() => ({}));
        const ctx = { db: dbKost(env.DB, sesi.kost), user: sesi, env, audit: (a, t, i, l, b) => logic.audit(env, sesi, a, t, i, l, b) };
        const pesan = await simpanParameter(ctx, data, sesi.kost);
        return json({ ok: true, message: pesan, kost: await ambilKost(env, sesi.kost) });
      }

      if (url.pathname === '/api/parameter/logo' && req.method === 'POST') {
        if (!['admin', 'master'].includes(sesi.role)) return json({ error: 'Hanya admin yang boleh mengganti logo.' }, 403);
        return unggahLogo(req, env, sesi);
      }

      if (url.pathname === '/api/master/kost') {
        if (sesi.role !== 'master') return json({ error: 'Hanya master yang boleh melihat semua aplikasi.' }, 403);
        if (req.method === 'GET') {
          const r = await env.DB.prepare(`
            select k.kunci, k.nama_app, k.kota, k.tagline, k.logo_kunci, k.aktif,
                   (select count(*) from users u where u.kost = k.kunci) as jumlah_user,
                   (select count(*) from rooms ro where ro.kost = k.kunci) as jumlah_kamar
              from kosts k order by k.nama_app`).all();
          return json({ daftar: (r.results || []).map((x) => ({
            kunci: x.kunci, namaApp: x.nama_app, kota: x.kota, tagline: x.tagline,
            logoKunci: x.logo_kunci || null, aktif: !!x.aktif,
            jumlahUser: x.jumlah_user, jumlahKamar: x.jumlah_kamar,
          })) });
        }
        if (req.method === 'POST') {
          return buatKost(req, env, sesi);
        }
      }

      // Master mendaftarkan No. HP sebagai admin kost yang sudah ada.
      if (url.pathname === '/api/master/daftar-admin' && req.method === 'POST') {
        if (sesi.role !== 'master') return json({ error: 'Hanya master yang boleh mendaftarkan admin.' }, 403);
        return daftarkanAdmin(req, env, sesi);
      }

      // Master melihat & mencabut akses admin sebuah kost.
      if (url.pathname === '/api/master/akses') {
        if (sesi.role !== 'master') return json({ error: 'Hanya master yang boleh melihat akses.' }, 403);
        const kunci = slugKost(String(url.searchParams.get('kost') || ''));
        if (!kunci) return json({ error: 'kost wajib diisi.' }, 400);
        if (req.method === 'GET') {
          const r = await env.DB.prepare(`select u.id, u.username, u.fullname, u.role, u.hp, u.aktif
                                            from akses_kost a join users u on u.id = a.user_id
                                           where a.kost = ? order by u.username`).bind(kunci).all();
          return json({ daftar: (r.results || []).map((x) => ({
            id: x.id, username: x.username, fullname: x.fullname, role: x.role, hp: x.hp, aktif: !!x.aktif,
          })) });
        }
        if (req.method === 'DELETE') {
          const id = String(url.searchParams.get('id') || '').trim();
          if (!id) return json({ error: 'id wajib diisi.' }, 400);
          const u = await env.DB.prepare('select id, username, kost from users where id=?').bind(id).first();
          if (!u) return json({ error: 'Akun tidak ditemukan.' }, 404);
          if (u.kost === kunci) {
            return json({ error: 'Kost induk akun tidak bisa dicabut. Nonaktifkan akun bila perlu.' }, 400);
          }
          await env.DB.prepare('delete from akses_kost where user_id=? and kost=?').bind(id, kunci).run();
          const sisa = await env.DB.prepare('select count(*) as n from akses_kost where user_id=?').bind(id).first();
          if (sisa && sisa.n <= 1) {
            await env.DB.prepare('update users set akses_diminta=0 where id=?').bind(id).run();
          }
          await logic.audit(env, sesi, 'user.akses.cabut', 'akses_kost', `${id}:${kunci}`, null, null);
          return json({ ok: true, message: `Akses ${u.username} ke kost ini dicabut.` });
        }
      }

      if (url.pathname === '/api/ktp' && req.method === 'POST') return unggahKtp(req, env, sesi);
      if (url.pathname === '/api/bukti' && req.method === 'POST') return unggahBukti(req, env, sesi);
      if (url.pathname.startsWith('/api/bukti/') && req.method === 'GET') {
        // staff dan admin boleh melihat bukti bayar (dokumen transaksi, bukan data pribadi)
        return lihatBukti(env, decodeURIComponent(url.pathname.slice('/api/bukti/'.length)), sesi);
      }
      if (url.pathname.startsWith('/api/ktp/penyewa/')) {
        // URL stabil per penyewa (dipakai tombol "Lihat foto"); kunci R2 tidak pernah dikirim ke browser
        const kode = decodeURIComponent(url.pathname.slice('/api/ktp/penyewa/'.length));
        const t = await env.DB.prepare('select ktp_key from tenants where kode=? or id=?').bind(kode, Number(kode) || -1).first();
        if (!t || !t.ktp_key) return json({ error: 'Penyewa ini belum punya foto KTP.' }, 404);
        return lihatKtp(env, t.ktp_key, sesi);
      }
      if (url.pathname.startsWith('/api/ktp/')) return lihatKtp(env, decodeURIComponent(url.pathname.slice('/api/ktp/'.length)), sesi);
      if (url.pathname === '/api/pengingat') return json(await daftarPengingat(env, dbKost(env.DB, sesi.kost)));
      if (url.pathname === '/api/dashboard') return json(await dashboard(env, dbKost(env.DB, sesi.kost), sesi.kost));
      if (url.pathname === '/api/ops') return json(await daftarLedger(env.DB, sesi.kost));

      // ---------- tulis ----------
      if (url.pathname === '/api/action') {
        if (req.method !== 'POST') return json({ error: 'Gunakan POST untuk aksi.' }, 405);
        const isiAksi = await req.json().catch(() => ({}));
        const action = isiAksi.action;
        const hpAtas = isiAksi.hp;
        let data = isiAksi.data;
        const fn = AKSI[action];
        // Pola lama klien (adapter) mengirim seluruh payload di level atas, bukan di `data`.
        // Dulu hasilnya `data` kosong sehingga aksi "berhasil" tanpa mengubah apa pun.
        if (!data && action && typeof isiAksi === 'object') {
          const { action: _a, data: _d, hp: _h, ...sisa } = isiAksi;
          data = sisa;
        }
        if (!fn) return json({ error: `Aksi "${action}" tidak dikenal.` }, 400);
        if (sesi.must_change_password) {
          return json({ error: 'Anda wajib mengganti password terlebih dahulu.' }, 403);
        }
        if (KEPERLUAN[action] === 'admin' && !['admin', 'master'].includes(sesi.role)) {
          return json({ error: 'Aksi ini hanya untuk admin.' }, 403);
        }
        if (KEPERLUAN[action] === 'master' && sesi.role !== 'master') {
          return json({ error: 'Aksi ini hanya untuk master.' }, 403);
        }
        // Hanya master yang boleh membuat akun master lain.
        if (action === 'users.create' && String((data && data.role) || '') === 'master' && sesi.role !== 'master') {
          return json({ error: 'Hanya master yang boleh membuat akun master.' }, 403);
        }
        const ctx = {
          env, db: dbKost(env.DB, sesi.kost), user: sesi, today, kost: sesi.kost,
          now: () => new Date().toISOString(),
          audit: (aksi, tabel, rowId, lama, baru) => logic.audit(env, sesi, aksi, tabel, rowId, lama, baru),
        };
        // `hp` boleh dikirim di level atas atau di dalam `data` (d1-adapter mengirim dua-duanya).
        if (hpAtas !== undefined) data = { ...(data || {}), hp: hpAtas };
        const msg = await fn(ctx, data || {});
        return json({ ok: true, message: msg });
      }

      return json({ error: 'Rute tidak ditemukan.' }, 404);
    } catch (e) {
      // Sisa baris `users` dari percobaan sebelum index unik per-kost: UNIQUE pada hp
      // tetap menangkapnya. Jawab 409 dengan pesan yang bisa ditindaklanjuti.
      if (e && /UNIQUE constraint failed: users\.hp/i.test(String(e.message || ''))) {
        return json({ error: 'Nomor HP ini sudah terdaftar pada akun di kost lain. Satu nomor dipakai satu akun saja — minta master mendaftarkan nomor ini ke kost.' }, 409);
      }
      const status = e.status || 500;
      if (status >= 500) {
        console.error('[hade]', e.stack || e);
        return json({ error: 'Terjadi kesalahan pada server. Silakan coba lagi.' }, 500);
      }
      // galat 4xx berasal dari validasi (pesan aman); galat lain jangan bocorkan detail internal
      const pesanAman = status >= 500 ? 'Permintaan tidak valid.' : (e.message || 'Permintaan tidak valid.');
      return json({ error: pesanAman }, status);
    }
}
