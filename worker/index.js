// =====================================================================
// Kost Hade — Worker API (Cloudflare Workers + D1)
// Sajikan UI statis dari folder pub/ dan API JSON di /api/*.
// =====================================================================
import * as logic from './logic.js';

const SESI_HARI = 7;
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
    `select s.token_hash, s.expires_at, u.id, u.username, u.fullname, u.role, u.must_change_password
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = ? and u.aktif = 1`
  ).bind(hash).first();
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    await env.DB.prepare('delete from sessions where token_hash = ?').bind(hash).run();
    return null;
  }
  return row;
}

// ---------- pembacaan data ----------
async function dashboard(env) {
  // Query berurutan (bukan Promise.all): batch/beberapa statement paralel di D1 lokal
  // sesekali terbaca sebelum tulisan sebelumnya terlihat, sehingga dashboard menampilkan
  // angka lama walau data sudah tersimpan. Konsistensi lebih penting daripada beberapa ms.
  const rooms = await env.DB.prepare('select * from rooms order by no_kamar').all();
  const tenants = await env.DB.prepare('select * from tenants order by created_at desc').all();
  const bills = await env.DB.prepare("select * from bills where status='belum_bayar' order by jatuh_tempo, id").all();
  // 200 transaksi terakhir: cukup untuk cetak ulang struk beberapa bulan ke belakang
  // (dulu hanya 10 sehingga struk lama tidak bisa dicetak lagi). Arsip lengkap ada di laporan.
  const pays = await env.DB.prepare('select * from payments where voided_at is null order by tgl_bayar desc, id desc limit 200').all();

  // JANGAN memakai view untuk angka kas: di D1 view bisa mengembalikan nilai basi
  // sesaat setelah penulisan (terbukti: modal 5.000.000 baru ditarik kembali muncul lagi).
  // Hitung langsung dari tabel — lebih mahal sedikit, tapi konsisten.
  const ringkas = await env.DB.prepare(`
    select
      (select coalesce(sum(jumlah),0) from payments where voided_at is null) +
      (select coalesce(sum(jumlah),0) from ledger where jenis='pendapatan' and voided_at is null)      as total_pendapatan,
      (select coalesce(sum(jumlah),0) from ledger where jenis='pengeluaran' and voided_at is null)      as total_pengeluaran,
      (select coalesce(sum(jumlah),0) from payments where voided_at is null) +
      (select coalesce(sum(case when l.jenis='pendapatan' then l.jumlah
                                when l.jenis='pengeluaran' then -l.jumlah
                                when l.jenis='neraca' and coalesce(c.saldo_normal,'Debet')='Kredit' then l.jumlah
                                when l.jenis='neraca' then -l.jumlah else 0 end),0)
         from ledger l left join categories c on c.id = l.kategori_id
        where l.voided_at is null and coalesce(c.arus_kas,1)=1)                                        as sisa_kas,
      (select coalesce(sum(case when coalesce(c.saldo_normal,'Debet')='Kredit' then l.jumlah else -l.jumlah end),0)
         from ledger l left join categories c on c.id = l.kategori_id
        where l.jenis='neraca' and l.voided_at is null and coalesce(c.arus_kas,1)=1)                   as modal_neraca,
      (select coalesce(sum(jumlah),0) from payments
         where voided_at is null and tgl_bayar >= date('now','localtime','start of month'))            as pendapatan_bulan_ini,
      (select coalesce(sum(jumlah),0) from bills
         where status='belum_bayar' and jatuh_tempo < date('now','localtime'))                         as tunggakan
  `).first();
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


async function listLedger(env) {
  const r = await env.DB.prepare('select * from ledger where voided_at is null order by tanggal desc, id desc').all();
  return (r.results || []).map((x) => [x.id, x.tanggal, x.jenis.charAt(0).toUpperCase() + x.jenis.slice(1), x.kategori, String(x.jumlah), x.keterangan || '']);
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
async function daftarPengingat(env) {
  const r = await env.DB.prepare(`
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
  'users.create': 'admin',
  'users.update': 'admin',
  'users.delete': 'admin',
};

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
  if (!['admin', 'staff'].includes(role)) throw logic.httpError(400, 'Role harus admin atau staff.');
  const fullname = String(d.fullname || '').trim().slice(0, 120) || username;
  const password = d.password === undefined || d.password === null ? undefined : String(d.password);
  if (isNew && (!password || password.length < 8)) throw logic.httpError(400, 'Password minimal 8 karakter.');
  if (!isNew && password && password.length < 8) throw logic.httpError(400, 'Password minimal 8 karakter.');
  if (password && password.length > 200) throw logic.httpError(400, 'Password maksimal 200 karakter.');
  return { username, role, fullname, password };
}

async function addUser(ctx, d) {
  const { username, role, fullname, password } = validUser(d, true);
  const dup = await ctx.db.prepare('select id from users where username=?').bind(username).first();
  if (dup) throw logic.httpError(409, `Username "${username}" sudah dipakai.`);
  const hash = await logic.hashPassword(password);
  // Password yang dibuatkan admin adalah password awal: pemilik akun wajib menggantinya
  // saat login pertama (dijaga juga di API, bukan hanya di UI).
  await ctx.db.prepare('insert into users (id, username, fullname, role, password_hash, aktif, must_change_password) values (?,?,?,?,?,1,1)')
    .bind('usr_' + crypto.randomUUID().slice(0, 8), username, fullname, role, hash).run();
  await ctx.audit('user.create', 'users', username, null, { username, role });
  return `Pengguna ${username} (${role}) dibuat. Pemilik akun wajib mengganti password saat login pertama.`;
}

async function updateUser(ctx, d) {
  const id = String(d.id || '');
  const old = await ctx.db.prepare('select * from users where id=?').bind(id).first();
  if (!old) throw logic.httpError(404, 'Pengguna tidak ditemukan.');
  const base = { ...d, username: d.username || old.username, role: d.role || old.role, fullname: d.fullname || old.fullname };
  const { username, role, fullname, password } = validUser(base, false);
  const aktif = d.aktif === undefined ? old.aktif : (d.aktif ? 1 : 0);
  // jangan sampai tidak ada admin aktif yang tersisa
  if (old.role === 'admin' && (role !== 'admin' || !aktif)) {
    const admins = await ctx.db.prepare("select count(*) as n from users where role='admin' and aktif=1 and id<>?").bind(id).first();
    if (!admins.n) throw logic.httpError(409, 'Minimal harus ada satu admin aktif.');
  }
  if (old.id === ctx.user.id && !aktif) throw logic.httpError(409, 'Tidak bisa menonaktifkan akun yang sedang dipakai.');
  const dup = await ctx.db.prepare('select id from users where username=? and id<>?').bind(username, id).first();
  if (dup) throw logic.httpError(409, `Username "${username}" sudah dipakai.`);
  if (password) {
    await ctx.db.prepare('update users set username=?, fullname=?, role=?, aktif=?, password_hash=?, must_change_password=1 where id=?')
      .bind(username, fullname, role, aktif, await logic.hashPassword(password), id).run();
    await ctx.db.prepare('delete from sessions where user_id=? and token_hash<>?').bind(id, sesiHashOf(ctx)).run();
  } else {
    await ctx.db.prepare('update users set username=?, fullname=?, role=?, aktif=? where id=?')
      .bind(username, fullname, role, aktif, id).run();
  }
  if (!aktif) await ctx.db.prepare('delete from sessions where user_id=?').bind(id).run();
  await ctx.audit('user.update', 'users', id, { username: old.username, role: old.role, aktif: old.aktif }, { username, role, aktif });
  return `Pengguna ${username} diperbarui.`;
}

const sesiHashOf = (ctx) => (ctx && ctx.user && ctx.user.token_hash) || '';

async function deleteUser(ctx, d) {
  const id = String(d.id || '');
  const old = await ctx.db.prepare('select * from users where id=?').bind(id).first();
  if (!old) throw logic.httpError(404, 'Pengguna tidak ditemukan.');
  if (old.id === ctx.user.id) throw logic.httpError(409, 'Tidak bisa menghapus akun yang sedang dipakai.');
  if (old.role === 'admin') {
    const admins = await ctx.db.prepare("select count(*) as n from users where role='admin' and aktif=1 and id<>?").bind(id).first();
    if (!admins.n) throw logic.httpError(409, 'Minimal harus ada satu admin aktif.');
  }
  // akun yang punya jejak transaksi hanya dinonaktifkan supaya audit tetap utuh
  const jejak = await ctx.db.prepare('select (select count(*) from payments where created_by=?) + (select count(*) from ledger where created_by=?) as n')
    .bind(id, id).first();
  await ctx.db.prepare('delete from sessions where user_id=?').bind(id).run();
  if (jejak.n) {
    await ctx.db.prepare('update users set aktif=0 where id=?').bind(id).run();
    await ctx.audit('user.deactivate', 'users', id, { username: old.username }, null);
    return `Pengguna ${old.username} dinonaktifkan (punya riwayat transaksi, tidak dihapus).`;
  }
  await ctx.db.prepare('delete from users where id=?').bind(id).run();
  await ctx.audit('user.delete', 'users', id, { username: old.username, role: old.role }, null);
  return `Pengguna ${old.username} dihapus.`;
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

    // UI statis. Lapisan aset Cloudflare melayani / dan /index.html lebih dulu (dapur
    // produksi maupun wrangler dev), sehingga Worker hanya menangani berkas lain (mis.
    // /d1-adapter.js). Header keamanan halaman dipasang lewat pub/_headers; untuk berkas
    // yang lewat Worker, header ditempel pada objek respons apa adanya (jangan dibuat ulang —
    // respons aset bisa berupa stream dan akan kehilangan isinya).
    const res = await env.ASSETS.fetch(req);
    res.headers.set('x-frame-options', 'DENY');
    res.headers.set('x-content-type-options', 'nosniff');
    res.headers.set('referrer-policy', 'same-origin');
    res.headers.set('permissions-policy', 'geolocation=(), camera=(), microphone=()');
    return res;
  },
};

async function tanganiApi(req, env, url, secure, today) {

    try {
      // ---------- auth ----------
      if (url.pathname === '/api/login') {
        if (req.method !== 'POST') return json({ error: 'Gunakan POST untuk login.' }, 405);
        const { username, password } = await req.json().catch(() => ({}));
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

        const u = await env.DB.prepare('select * from users where username=? and aktif=1').bind(uname).first();
        const cocok = u ? await logic.verifyPassword(String(password || ''), u.password_hash) : false;
        await env.DB.prepare('insert into login_percobaan (username, ip, berhasil) values (?,?,?)')
          .bind(uname, ip, cocok ? 1 : 0).run().catch(() => {});
        if (!cocok) {
          await logic.audit(env, { id: null, username: uname, role: 'sistem' }, 'login.gagal', 'users', uname, null, { ip }).catch(() => {});
          return json({ error: 'Kombinasi nama pengguna atau kata sandi tidak sesuai.' }, 401);
        }
        const token = logic.randomToken();
        const exp = new Date(Date.now() + SESI_HARI * 86400000).toISOString();
        await env.DB.prepare('insert into sessions (token_hash, user_id, expires_at) values (?,?,?)')
          .bind(await logic.sha256hex(token), u.id, exp).run();
        await env.DB.prepare("delete from sessions where expires_at < datetime('now')").run().catch(() => {});
        await env.DB.prepare("delete from login_percobaan where created_at < datetime('now','-2 days')").run().catch(() => {});
        // `token` hanya dipakai APK (halaman dari file://) yang tidak bisa memakai cookie
        // lintas-asal. Browser biasa tetap memakai cookie HttpOnly dan mengabaikan nilai ini.
        return json({ ok: true, token, user: { username: u.username, fullname: u.fullname, role: u.role } },
          200, { 'set-cookie': setSesiCookie(token, secure) });
      }

      const sesi = await sesiAktif(env, req);

      if (url.pathname === '/api/logout') {
        if (req.method !== 'POST') return json({ error: 'Gunakan POST untuk logout.' }, 405);
        const t = cookieValue(req, 'hade_sesi');
        if (t) await env.DB.prepare('delete from sessions where token_hash=?').bind(await logic.sha256hex(t)).run();
        return json({ ok: true }, 200, { 'set-cookie': setSesiCookie('', secure, 0) });
      }

      if (url.pathname === '/api/session') {
        return sesi ? json({ logged_in: true, user: { id: sesi.id, username: sesi.username, fullname: sesi.fullname, role: sesi.role, must_change_password: !!sesi.must_change_password } })
                    : json({ logged_in: false });
      }
      if (!sesi) return json({ error: 'Sesi berakhir. Silakan login ulang.' }, 401);

      // Password awal (dari tools/buat-akun.mjs) wajib diganti sebelum menyentuh data.
      // Tanpa ini, ?view=password cukup dilewati dengan memanggil API lain langsung,
      // sehingga sandi awal tetap bisa dipakai mengelola aplikasi.
      const bolehTanpaGanti = url.pathname === '/api/password' || url.pathname === '/api/logout'
                           || url.pathname === '/api/session';
      if (sesi.must_change_password && !bolehTanpaGanti) {
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
        const [d, ops, cats, us] = await Promise.all([
          dashboard(env), listLedger(env),
          env.DB.prepare('select * from categories where aktif=1 order by jenis, nama').all(),
          env.DB.prepare('select id, username, fullname, role, aktif, created_at from users order by username').all(),
        ]);
        const kategori = { Pengeluaran: [], Pendapatan: [], Neraca: [] };
        (cats.results || []).forEach((c) => {
          const k = c.jenis.charAt(0).toUpperCase() + c.jenis.slice(1);
          (kategori[k] = kategori[k] || []).push({ id: c.id, nama: c.nama, saldoNormal: c.saldo_normal, jenis: k, arusKas: c.arus_kas !== 0 });
        });
        const users = sesi.role === 'admin'
          ? (us.results || []).map((u) => ({ id: u.id, username: u.username, nama: u.fullname, fullname: u.fullname, role: u.role, aktif: u.aktif }))
          : [];
        return json({ ...d, ops, kategori, users });
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
      if (url.pathname === '/api/pengingat') return json(await daftarPengingat(env));
      if (url.pathname === '/api/dashboard') return json(await dashboard(env));
      if (url.pathname === '/api/ops') return json(await listLedger(env));

      // ---------- tulis ----------
      if (url.pathname === '/api/action') {
        if (req.method !== 'POST') return json({ error: 'Gunakan POST untuk aksi.' }, 405);
        const { action, data } = await req.json().catch(() => ({}));
        const fn = AKSI[action];
        if (!fn) return json({ error: `Aksi "${action}" tidak dikenal.` }, 400);
        if (sesi.must_change_password) {
          return json({ error: 'Anda wajib mengganti password terlebih dahulu.' }, 403);
        }
        if (KEPERLUAN[action] === 'admin' && sesi.role !== 'admin') {
          return json({ error: 'Aksi ini hanya untuk admin.' }, 403);
        }
        const ctx = {
          env, db: env.DB, user: sesi, today,
          now: () => new Date().toISOString(),
          audit: (aksi, tabel, rowId, lama, baru) => logic.audit(env, sesi, aksi, tabel, rowId, lama, baru),
        };
        const msg = await fn(ctx, data || {});
        return json({ ok: true, message: msg });
      }

      return json({ error: 'Rute tidak ditemukan.' }, 404);
    } catch (e) {
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
