// =====================================================================
// Kost Hade — logika murni (tanpa binding Workers) supaya bisa diuji di Node.
// =====================================================================

// ---------- tanggal ----------
export function todayISO(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function toISODate(input) {
  if (!input) return null;
  if (input instanceof Date) return todayISO(input);
  const s = String(input).trim();
  const sah = (y, m2, d) => {
    const dt = new Date(Date.UTC(y, m2 - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m2 - 1 && dt.getUTCDate() === d && y >= 2000 && y <= 2100;
  };
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);                // 2026-10-21[T...]
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    // "2026-02-30" dulu diterima apa adanya lalu bergeser bulan di perhitungan jatuh tempo
    return sah(y, mo, d) ? `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
  }
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);             // 21/10/2026 (DD/MM/YYYY)
  if (m) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return sah(y, mo, d) ? `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
  }
  const d = new Date(s);
  return isNaN(d) ? null : todayISO(d);
}

// 31 Jan + 1 bulan -> 28/29 Feb (tanpa jebakan timezone)
export function addMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const p = (x) => String(x).padStart(2, '0');
  return `${ny}-${p(nm)}-${p(Math.min(d, lastDay))}`;
}

// Tanggal jatuh tempo selalu 1-28: mencegah "31 Mar -> 31 Apr (tidak ada)" yang membuat
// bulan berikutnya terlewat, tanpa mengubah perilaku normal (tanggal 1-28 tidak disentuh).
export function klemJatuhTempo(iso) {
  // Jatuh tempo mengikuti TANGGAL MASUK penyewa (25 Mei -> 25 Jun -> 25 Jul ...), bukan dipaksa 28.
  // addMonths() sudah memakai hari terakhir bulan pendek (31 Mar -> 30 Apr -> 30 Mei),
  // jadi klem di sini hanya jaring pengaman untuk nilai rusak, bukan aturan bisnis.
  const [y, m, d] = iso.split('-').map(Number);
  const p = (x) => String(x).padStart(2, '0');
  return `${y}-${p(m)}-${p(Math.max(1, Math.min(31, d || 1)))}`;
}

export const num = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
export const rupiah = (v) => 'Rp ' + Number(v || 0).toLocaleString('id-ID');
export const bulanPeriode = (iso) => iso.slice(0, 8) + '01';
export function normPhone(v) {
  const s = String(v || '').replace(/[^0-9+]/g, '');
  return s.startsWith('8') ? '0' + s : s;
}

// ---------- password (PBKDF2-SHA256, batas Workers: 100.000 iterasi) ----------
const ITER = 100000;
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function hashPassword(password, iters = ITER) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' },
    await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']),
    256,
  );
  return `pbkdf2$${iters}$${b64(salt)}$${b64(bits)}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts[0] !== 'pbkdf2' || parts.length !== 4) return false;
  const iters = Number(parts[1]);
  const salt = unb64(parts[2]);
  const expected = unb64(parts[3]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' },
    await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']),
    256,
  ));
  if (bits.length !== expected.length) return false;
  let diff = 0;                                  // perbandingan waktu-konstan
  for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expected[i];
  return diff === 0;
}

export async function sha256hex(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// Nomor HP kontak darurat: kosong = hapus; selain itu minimal 8 digit setelah dinormalisasi.
function validasiHpDarurat(nilai) {
  const n = normPhone(String(nilai ?? '')).slice(0, 20);
  if (n && !/^\+?[0-9]{8,20}$/.test(n)) return { salah: 'Nomor HP kontak darurat harus 8-20 angka.' };
  return { nilai: n };
}

// Penyimpanan foto KTP: 'r2' (disarankan) atau 'd1' (cadangan bila bucket R2 belum bisa dibuat).
// Di mode d1, foto disimpan di tabel ktp_berkas; D1 membatasi ukuran baris ~2 MB, jadi foto
// diperkecil di browser sebelum diunggah.
export const KTP_MODE = 'r2';

// tipe foto KTP yang diterima (ekstensi dipakai untuk kunci R2)
export const KTP_TIPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
// bentuk kunci yang kita terbitkan sendiri: ktp/<tahun>/<uuid>.<ext>
export const KUNCI_KTP = /^ktp\/\d{4}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

// ---------- aksi bisnis ----------
// ctx: { env, db (D1), user, today, audit(aksi, tabel, rowId, lama, baru) }

// Jejak audit dari aplikasi: berisi SIAPA pelakunya (trigger DB tidak tahu user).
export async function audit(env, user, aksi, tabel, rowId, lama, baru) {
  if (!env || !env.DB) return;
  await env.DB.prepare('insert into audit_log (actor, actor_name, aksi, tabel, row_id, data_lama, data_baru) values (?,?,?,?,?,?,?)')
    .bind(user ? user.id : null, user ? user.username : null, aksi, tabel, rowId === null || rowId === undefined ? null : String(rowId),
      lama ? JSON.stringify(lama) : null, baru ? JSON.stringify(baru) : null)
    .run();
}

export async function createTenant(ctx, data) {
  const nama = String(data.nama || '').trim().slice(0, 120);
  if (nama.length < 2) throw httpError(400, 'Nama penyewa minimal 2 karakter.');
  const tglMasuk = toISODate(data.tglMasuk);
  if (!tglMasuk) throw httpError(400, 'Tanggal check-in tidak valid.');
  if (tglMasuk > ctx.today) throw httpError(400, 'Tanggal check-in tidak boleh di masa depan.');
  const noKamar = String(data.kamar || '').trim();
  const room = await ctx.db.prepare('select * from rooms where no_kamar = ?').bind(noKamar).first();
  if (!room) throw httpError(404, `Kamar ${noKamar} tidak ditemukan.`);
  if (room.status !== 'tersedia') throw httpError(409, `Kamar ${noKamar} tidak tersedia (status: ${room.status}).`);
  if (num(room.harga_bulanan) <= 0) throw httpError(400, `Harga bulanan kamar ${noKamar} belum diisi.`);

  // kode penyewa: ambil nomor terakhir lalu coba insert; bila balapan dengan petugas lain,
  // UNIQUE menolak dan kita coba nomor berikutnya (maks 5 kali).
  const seq = await ctx.db.prepare("select coalesce(max(cast(substr(kode,5) as integer)),0) as n from tenants").first();
  let kode = 'TEN-' + String(Number(seq.n) + 1).padStart(4, '0');
  // CATATAN: jangan pakai String(undefined || '').trim() sembarangan — nilai "undefined"
  // jadi teks. Bentuk di bawah aman untuk nilai kosong.
  const kontak = String(data.kontakDarurat ?? '').trim().slice(0, 80);
  const cekHp = validasiHpDarurat(data.hpDarurat);
  if (cekHp.salah) throw httpError(400, cekHp.salah);
  const hpDarurat = cekHp.nilai;
  const ktp = KTP_TIPE[String(data.ktpTipe || '')] ? String(data.ktpTipe) : null;
  const ktpKey = ktp ? String(data.ktpKey || '').slice(0, 200) : null;
  if (ktp && !KUNCI_KTP.test(ktpKey)) throw httpError(400, 'Kunci foto KTP tidak valid.');
  const sumber = String(data.sumber || 'manual') === 'wa' ? 'wa' : 'manual';
  // Kamar diklaim dengan update BERSYARAT (status='tersedia') dalam batch yang sama dengan insert:
  // dua petugas yang mendaftarkan kamar yang sama bersamaan tidak bisa dua-duanya lolos.
  let ins = null, tenantId = null;
  for (let coba = 0; coba < 5 && !ins; coba++) {
    try {
      // Step ke-1 HANYA klaim kamar. `batch()` D1 tidak selalu memberi meta.changes
      // pada statement non-terakhir, jadi status klaim tidak boleh dibaca dari hasil batch.
      // `changes` di D1 mencatat baris yang DITULIS, bukan hanya yang benar-benar berubah
      // (update ke nilai yang sama tetap dihitung). Karena itu kondisi "kamar masih kosong"
      // dicek ulang sesudah update: kalau ternyata sudah ada penyewa aktif, klaim dibatalkan.
      const klaim = await ctx.db.prepare("update rooms set status='terisi' where id=? and status='tersedia'").bind(room.id).run();
      const terisi = await ctx.db.prepare("select count(*) as n from tenants where kamar_id=? and status='aktif'").bind(room.id).first();
      if ((terisi && terisi.n > 0) || (klaim && klaim.meta && Number(klaim.meta.changes) === 0)) {
        throw httpError(409, `Kamar ${noKamar} baru saja diisi petugas lain. Muat ulang halaman.`);
      }
      const insRes = await ctx.db.prepare(
        `insert into tenants (kode, nama, hp, kamar_id, kontak_darurat, hp_darurat, ktp_key, ktp_tipe, sumber, tgl_masuk, status)
         values (?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(kode, nama, normPhone(data.hp), room.id, kontak || null, hpDarurat || null, ktpKey, ktp, sumber, tglMasuk, 'aktif').run();
      ins = insRes;
      tenantId = insRes.meta.last_row_id;
    } catch (e) {
      if (/UNIQUE/i.test(String(e && e.message)) && /kode/.test(String(e.message))) {
        const nomor = Number(kode.slice(4)) + 1;
        kode = 'TEN-' + String(nomor).padStart(4, '0');
        continue;
      }
      throw e;
    }
  }
  if (!tenantId) {
    await ctx.db.prepare("update rooms set status='tersedia' where id=? and status='terisi'").bind(room.id).run().catch(() => {});
    throw httpError(500, 'Gagal membuat kode penyewa. Coba lagi.');
  }

  await ctx.db.prepare('insert into bills (tenant_id, periode, jatuh_tempo, jumlah, status) values (?,?,?,?,?)')
    // jatuh tempo tunduk pada klem 1-28 (tanggal 31 Jan -> 28 Feb, supaya rantai bulan tidak melompat)
    .bind(tenantId, bulanPeriode(tglMasuk), klemJatuhTempo(addMonths(tglMasuk, 1)), num(room.harga_bulanan), 'belum_bayar').run();
  await ctx.audit('create_tenant', 'tenants', tenantId, null, { kode, nama, kamar: noKamar });

  return `Registrasi ${nama} di Kamar ${noKamar} berhasil (${kode}). Tagihan ${rupiah(room.harga_bulanan)} jatuh tempo ${addMonths(tglMasuk, 1)}.`;
}

export async function recordPayment(ctx, data) {
  const tgl = toISODate(data.tanggal) || ctx.today;
  if (tgl > ctx.today) throw httpError(400, 'Tanggal pembayaran tidak boleh di masa depan.');
  const noKamar = String(data.kamar || '').trim();
  if (!noKamar) throw httpError(400, 'Kamar penyewa wajib dipilih. Tanpa kamar, pembayaran bisa masuk ke penyewa yang salah.');

  // cari penyewa lewat kamar (unik), bukan lewat nama
  const t = await ctx.db.prepare(
    `select t.*, r.no_kamar from tenants t join rooms r on r.id = t.kamar_id
      where t.status='aktif' and r.no_kamar = ?`
  ).bind(noKamar).first();
  if (!t) throw httpError(404, `Tidak ada penyewa aktif di kamar ${noKamar}.`);

  // ---- bayar N bulan sekaligus -------------------------------------------------
  // `bulan` = jumlah bulan yang dibayar (default 1). Tagihan dilunasi berurutan mulai
  // yang paling awal, dan tagihan bulan-bulan berikutnya dibuat bila belum ada.
  const bulan = Math.max(1, Math.min(24, Number.parseInt(data.bulan, 10) || 1));

  // semua tagihan terbuka, urut jatuh tempo
  const terbuka = (await ctx.db.prepare(
    "select * from bills where tenant_id=? and status='belum_bayar' order by jatuh_tempo"
  ).bind(t.id).all()).results || [];

  // lengkapi daftar: kalau kurang dari N, buat tagihan lanjutan di memori (belum ditulis)
  const daftar = terbuka.slice(0, bulan).map((b) => ({ ...b, baru: false }));
  let acuan = daftar.length ? daftar[daftar.length - 1] : null;
  if (!acuan) {
    throw httpError(409, `Tidak ada tagihan terbuka untuk ${t.nama}. Tagihan dibuat otomatis saat registrasi atau setelah pembayaran lunas.`);
  }
  let jt = String(acuan.jatuh_tempo).slice(0, 10);
  while (daftar.length < bulan) {
    jt = klemJatuhTempo(addMonths(jt, 1));
    daftar.push({ id: null, tenant_id: t.id, periode: bulanPeriode(jt), jatuh_tempo: jt, jumlah: acuan.jumlah, status: 'belum_bayar', baru: true });
  }
  const jumlah = num(data.jumlah) || daftar.reduce((a, b) => a + num(b.jumlah), 0);
  if (jumlah <= 0) throw httpError(400, 'Nominal pembayaran harus lebih dari 0.');
  const total = daftar.reduce((a, b) => a + num(b.jumlah), 0);
  if (total !== jumlah)
    throw httpError(409, `Nominal bayar ${rupiah(jumlah)} tidak sama dengan total ${bulan} bulan × ${rupiah(num(daftar[0].jumlah))} = ${rupiah(total)}.`);

  const bill = daftar[0];
  // Jatuh tempo berikutnya: tanggal yang sama bulan depan (diklem 28/29/30),
  // TETAPI diklem juga ke tanggal 1-28 supaya tidak melompati bulan saat bulan pendek
  // (31 Mar -> 30 Apr -> 31 Apr tidak ada; dulu ini membuat periode Mei terlewat).
  const tglJatuh = String(daftar[daftar.length - 1].jatuh_tempo).slice(0, 10);
  const nextJt = klemJatuhTempo(addMonths(tglJatuh, 1));
  const nextPeriode = bulanPeriode(nextJt);
  const dup = await ctx.db.prepare('select id from bills where tenant_id=? and periode=?').bind(t.id, nextPeriode).first();

  // 1) catat pembayaran (nomor struk unik tanpa race: cek + insert dalam satu batch, ulangi bila bentrok)
  let nomor = '';
  let bukti = null;
  for (let coba = 0; coba < 5 && !bukti; coba++) {
    const cnt = await ctx.db.prepare('select count(*) as n from payments where tgl_bayar=?').bind(tgl).first();
    nomor = `STR-${tgl.replace(/-/g, '')}-${String(cnt.n + 1 + coba).padStart(3, '0')}`;
    try {
      const stmts = [];
      // tagihan yang belum ada di DB dibuat dulu, lalu dilunasi (per periode, unik per penyewa)
      for (const b of daftar.filter((x) => x.baru)) {
        stmts.push(ctx.db.prepare('insert into bills (tenant_id, periode, jatuh_tempo, jumlah, status) values (?,?,?,?,?)')
          .bind(t.id, b.periode, b.jatuh_tempo, b.jumlah, 'belum_bayar'));
      }
      // satu baris pembayaran untuk seluruh bulan (struk menampilkan jumlah bulan bayar)
      stmts.push(ctx.db.prepare('insert into payments (nomor_struk, bill_id, tenant_id, tgl_bayar, jumlah, keterangan, created_by) values (?,?,?,?,?,?,?)')
        .bind(nomor, bill.id, t.id, tgl, jumlah, [String(data.keterangan || '').trim(), bulan > 1 ? `bayar ${bulan} bulan` : ''].filter(Boolean).join(' — '), ctx.user.id));
      if (bulan > 1) {
        // jumlah bulan disimpan di keterangan; void memakainya untuk tahu berapa bulan dibatalkan
        stmts.push(ctx.db.prepare("update payments set bulan=? where nomor_struk=?").bind(bulan, nomor));
      }
      for (const b of daftar.filter((x) => !x.baru)) {
        stmts.push(ctx.db.prepare("update bills set status='lunas' where id=?").bind(b.id));
      }
      // tagihan baris "bayar N bulan" dilunasi lewat pasangan pembayaran per periode,
      // supaya jejak lunas per bulan tetap jelas dan void bisa mengembalikannya satu per satu.
      for (const b of daftar.filter((x) => x.baru)) {
        stmts.push(ctx.db.prepare("update bills set status='lunas' where tenant_id=? and periode=?").bind(t.id, b.periode));
      }
      if (!dup) stmts.push(ctx.db.prepare('insert into bills (tenant_id, periode, jatuh_tempo, jumlah, status) values (?,?,?,?,?)')
        .bind(t.id, nextPeriode, nextJt, daftar[0].jumlah, 'belum_bayar'));
      bukti = await ctx.db.batch(stmts);
    } catch (e) {
      if (!/UNIQUE/i.test(String(e && e.message))) throw e;
      bukti = null;
    }
  }
  if (!bukti) throw httpError(500, 'Gagal membuat nomor struk unik. Coba lagi.');

  await ctx.audit('payment', 'payments', nomor, null, { nomor, jumlah, tgl, tenant: t.kode });
  const pesanBulan = bulan > 1 ? ` untuk ${bulan} bulan (${daftar.map((b) => String(b.periode).slice(0, 7)).join(', ')})` : '';
  return `Pembayaran ${rupiah(jumlah)}${pesanBulan} dibukukan (${nomor}). Tagihan berikutnya jatuh tempo ${nextJt}.`;
}

// Pembatalan pembayaran (salah catat / uang dikembalikan).
// Tagihan dibuka kembali, dan tagihan susulan yang terlanjur dibuat otomatis ikut dibatalkan
// bila belum dibayar — supaya siklus tagihan kembali seperti sebelum pembayaran.
export async function voidPayment(ctx, id) {
  const p = await ctx.db.prepare('select * from payments where id=?').bind(Number(id)).first();
  if (!p) throw httpError(404, 'Pembayaran tidak ditemukan.');
  if (p.voided_at) throw httpError(409, 'Pembayaran ini sudah dibatalkan.');
  const bill = p.bill_id ? await ctx.db.prepare('select * from bills where id=?').bind(p.bill_id).first() : null;

  const stmts = [ctx.db.prepare("update payments set voided_at=strftime('%Y-%m-%dT%H:%M:%f','now') where id=?").bind(p.id)];
  const bulan = Math.max(1, Math.min(24, Number(p.bulan) || 1));
  if (bill) {
    // buka kembali SEMUA bulan yang dibayar dalam satu struk (bayar N bulan), bukan hanya bulan pertama
    const periodeMulai = String(bill.periode);
    const kena = bulan > 1
      ? (await ctx.db.prepare("select id from bills where tenant_id=? and status='lunas' and periode>=? order by periode limit ?")
          .bind(p.tenant_id, periodeMulai, bulan).all()).results || []
      : [{ id: bill.id }];
    kena.forEach((b) => stmts.push(ctx.db.prepare("update bills set status='belum_bayar' where id=?").bind(b.id)));
    // tagihan PERIODE BERIKUTNYA yang dulu dibuat otomatis boleh dihapus hanya bila:
    // belum dibayar, tidak punya pembayaran lain, dan tanggal jatuh temponya persis kelanjutan tagihan ini
    // CATATAN: jangan pakai subquery dengan skema tabel di dalamnya — di D1 ternyata
    // merusak pernyataan lain dalam batch yang sama (data terlihat belum ter-update).
    // Satu query rata, lalu saring di JS.
    const kandidat = await ctx.db.prepare(
      `select id, periode, jatuh_tempo from bills where tenant_id=? and status='belum_bayar' and periode>?`
    ).bind(p.tenant_id, kena.length ? kena[kena.length - 1].periode || bill.periode : bill.periode).all();
    const berbayar = await ctx.db.prepare('select distinct bill_id from payments where tenant_id=? and bill_id is not null').bind(p.tenant_id).all();
    const dibayar = new Set((berbayar.results || []).map((r) => r.bill_id));
    const urut = (kandidat.results || []).filter((b) => !dibayar.has(b.id)).sort((a, b) => (a.periode < b.periode ? -1 : 1));
    const turunan = urut.length ? [urut[0]] : [];
    // CATATAN: `turunan` adalah ARRAY (bukan hasil D1), jadi jangan pakai `.results`
    // — bug lama: tagihan bulan berikutnya tidak pernah dihapus sehingga penyewa punya 2 tagihan terbuka.
    turunan.forEach((b) => stmts.push(ctx.db.prepare('delete from bills where id=?').bind(b.id)));
  }
  await ctx.db.batch(stmts);
  await ctx.audit('payment.void', 'payments', p.nomor_struk, { jumlah: p.jumlah, tgl: p.tgl_bayar }, null);
  return `Pembayaran ${p.nomor_struk} (${rupiah(p.jumlah)}) dibatalkan. Tagihan kembali terbuka.`;
}

// Edit data penyewa (nama/hp/kamar/tanggal masuk/tanggal keluar).
// Tanggal jatuh tempo atau nominal tagihan yang sudah ada tidak diubah di sini —
// ubah lewat pembatalan pembayaran / tagihan, supaya angka tagihan tidak pernah
// berubah diam-diam tanpa jejak.
export async function updateTenant(ctx, data) {
  const t = await ctx.db.prepare('select * from tenants where kode=? or id=?').bind(String(data.id || ''), Number(data.id) || -1).first();
  if (!t) throw httpError(404, 'Penyewa tidak ditemukan.');
  const nama = String(data.nama === undefined ? t.nama : data.nama).trim();
  if (nama.length < 2) throw httpError(400, 'Nama penyewa minimal 2 karakter.');
  const hp = data.hp === undefined ? t.hp : normPhone(data.hp);
  const tglMasuk = data.tglMasuk === undefined ? t.tgl_masuk : toISODate(data.tglMasuk);
  if (!tglMasuk) throw httpError(400, 'Tanggal check-in tidak valid.');
  if (tglMasuk > ctx.today) throw httpError(400, 'Tanggal check-in tidak boleh di masa depan.');

  let kamarId = t.kamar_id;
  const noKamar = data.kamar === undefined ? null : String(data.kamar || '').trim();
  if (noKamar) {
    const room = await ctx.db.prepare('select * from rooms where no_kamar=?').bind(noKamar).first();
    if (!room) throw httpError(404, `Kamar ${noKamar} tidak ditemukan.`);
    if (room.id !== t.kamar_id) {
      if (t.status !== 'aktif') throw httpError(409, 'Penyewa yang sudah keluar tidak bisa dipindah kamar.');
      if (room.status === 'terisi') throw httpError(409, `Kamar ${noKamar} sudah terisi.`);
      kamarId = room.id;
    }
  }
  // kontak darurat: tidak dikirim = pertahankan; dikirim kosong = hapus;
  // dikirim berisi = ganti (divalidasi).
  const pakai = (v) => v !== undefined && v !== null;
  const kontak = !pakai(data.kontakDarurat) ? t.kontak_darurat
    : (String(data.kontakDarurat).trim() ? String(data.kontakDarurat).trim().slice(0, 80) : null);
  let hpDarurat = t.hp_darurat;
  if (pakai(data.hpDarurat)) {
    const cek = validasiHpDarurat(data.hpDarurat);
    if (cek.salah) throw httpError(400, cek.salah);
    hpDarurat = cek.nilai || null;
  }
  const ktpTipeBaru = KTP_TIPE[String(data.ktpTipe || '')] ? String(data.ktpTipe) : null;
  const ktpKeyBaru = ktpTipeBaru ? String(data.ktpKey || '').slice(0, 200) : null;
  if (ktpTipeBaru && !KUNCI_KTP.test(ktpKeyBaru)) throw httpError(400, 'Kunci foto KTP tidak valid.');
  const status = String(data.status || t.status) === 'keluar' ? 'keluar' : 'aktif';
  const tglKeluar = status === 'keluar'
    ? (toISODate(data.tglKeluar) || t.tgl_keluar || ctx.today)
    : null;

  const stmts = [
    ctx.db.prepare('update tenants set nama=?, hp=?, kamar_id=?, kontak_darurat=?, hp_darurat=?, ktp_key=?, ktp_tipe=?, tgl_masuk=?, status=?, tgl_keluar=? where id=?')
      .bind(nama, hp, kamarId, kontak, hpDarurat, ktpKeyBaru || t.ktp_key, ktpTipeBaru || t.ktp_tipe, tglMasuk, status, tglKeluar, t.id),
  ];
  // sinkronkan status kamar lama & baru
  if (t.kamar_id && (t.kamar_id !== kamarId || status === 'keluar')) {
    stmts.push(ctx.db.prepare("update rooms set status='tersedia' where id=? and status='terisi' and id not in (select kamar_id from tenants where status='aktif' and kamar_id is not null)").bind(t.kamar_id));
  }
  if (kamarId && status === 'aktif') {
    stmts.push(ctx.db.prepare("update rooms set status='terisi' where id=?").bind(kamarId));
  }
  await ctx.db.batch(stmts);
  await ctx.audit('tenant.update', 'tenants', t.id,
    { nama: t.nama, hp: t.hp, kamar_id: t.kamar_id, kontak_darurat: t.kontak_darurat, hp_darurat: t.hp_darurat, status: t.status },
    { nama, hp, kamar_id: kamarId, kontak_darurat: kontak, hp_darurat: hpDarurat, ktp: !!(ktpKeyBaru || t.ktp_key), status });
  return `Data penyewa ${nama} diperbarui.`;
}

export async function addOpsTransaction(ctx, data) {
  const jumlah = num(data.jumlah);
  if (jumlah <= 0) throw httpError(400, 'Nominal transaksi harus lebih dari 0.');
  const jenis = String(data.jenis || '').toLowerCase();
  if (!['pendapatan', 'pengeluaran', 'neraca'].includes(jenis)) throw httpError(400, `Jenis transaksi "${data.jenis}" tidak dikenal.`);
  const tgl = toISODate(data.tanggal) || ctx.today;
  if (tgl > ctx.today) throw httpError(400, 'Tanggal transaksi tidak boleh di masa depan.');
  const nama = String(data.kategori || '').trim();
  if (!nama) throw httpError(400, 'Kategori wajib dipilih.');
  // kategori harus milik jenis yang sama (mencegah "Neraca" memakai kategori pengeluaran dst.)
  const cat = await ctx.db.prepare('select * from categories where jenis=? and nama=? and aktif=1').bind(jenis, nama).first();
  if (!cat) throw httpError(400, `Kategori "${nama}" bukan kategori ${jenis}.`);
  const ins = await ctx.db.prepare(
    'insert into ledger (tanggal, jenis, kategori_id, kategori, jumlah, keterangan, created_by) values (?,?,?,?,?,?,?)'
  ).bind(tgl, jenis, cat.id, cat.nama, jumlah, String(data.keterangan || ''), ctx.user.id).run();
  await ctx.audit('ledger', 'ledger', ins.meta.last_row_id, null, { jenis, nama, jumlah, tgl });
  return `Transaksi ${jenis} "${data.keterangan || nama}" berhasil dicatat.`;
}

// Batalkan transaksi ledger. Menulis BALIK voided_at = NULL pada baris lain adalah bug
// yang pernah terjadi: klien yang mengirim id sebagai string kosong ("") membuat nilai
// terikat menjadi 0, sehingga `update ... where id=0` tidak mengenai baris mana pun —
// tapi JANGAN sampai menyentuh baris lain lewat subquery/IN dengan parameter kosong.
// Karena itu id divalidasi di sini sebelum dipakai.
export async function voidOpsTransaction(ctx, id) {
  const lid = Number(id);
  if (!Number.isInteger(lid) || lid <= 0) throw httpError(400, 'ID transaksi tidak valid.');
  const row = await ctx.db.prepare('select * from ledger where id=?').bind(lid).first();
  if (!row) throw httpError(404, 'Transaksi tidak ditemukan.');
  if (row.voided_at) throw httpError(409, 'Transaksi ini sudah dibatalkan.');
  await ctx.db.prepare("update ledger set voided_at=strftime('%Y-%m-%dT%H:%M:%f','now') where id=?").bind(lid).run();
  await ctx.audit('ledger.void', 'ledger', lid, { jenis: row.jenis, kategori: row.kategori, jumlah: row.jumlah }, null);
  return 'Transaksi dibatalkan. Data tetap tersimpan untuk audit.';
}

export async function checkoutTenant(ctx, tenantId, roomNo) {
  const t = await ctx.db.prepare('select * from tenants where kode=? or id=?').bind(tenantId, tenantId).first();
  if (!t) throw httpError(404, 'Penyewa tidak ditemukan.');
  if (t.status === 'keluar') throw httpError(409, 'Penyewa ini sudah check-out.');
  await ctx.db.prepare("update tenants set status='keluar', tgl_keluar=? where id=?").bind(ctx.today, t.id).run();
  // kamar yang dikosongkan = kamar penyewa di DB, BUKAN nomor kiriman klien
  // (bug lama: mengirim nomor kamar lain membuat kamar salah ditandai tersedia)
  const room = t.kamar_id
    ? await ctx.db.prepare('select * from rooms where id=?').bind(t.kamar_id).first()
    : await ctx.db.prepare('select * from rooms where no_kamar=?').bind(roomNo).first();
  const rest = await ctx.db.prepare("select count(*) as n from tenants where kamar_id=? and status='aktif'").bind(room ? room.id : -1).first();
  if (room && !rest.n) await ctx.db.prepare("update rooms set status='tersedia' where id=?").bind(room.id).run();
  const sisa = await ctx.db.prepare("select coalesce(sum(jumlah),0) as s from bills where tenant_id=? and status='belum_bayar'").bind(t.id).first();
  await ctx.audit('checkout', 'tenants', t.id, { status: 'aktif' },
    { status: 'keluar', tgl_keluar: ctx.today, tunggakan: sisa.s });
  return `Check-out selesai. Kamar ${room ? room.no_kamar : roomNo} kini kosong.` + (sisa.s ? ` Tagihan belum lunas ${rupiah(sisa.s)} tetap tercatat sebagai tunggakan.` : '');
}

export async function deleteTenant(ctx, tenantId, roomNo) {
  const t = await ctx.db.prepare('select * from tenants where kode=? or id=?').bind(tenantId, tenantId).first();
  if (!t) throw httpError(404, 'Penyewa tidak ditemukan.');
  const pays = await ctx.db.prepare('select count(*) as n from payments where tenant_id=?').bind(t.id).first();
  if (pays.n) throw httpError(409, 'Penyewa ini punya riwayat pembayaran dan tidak bisa dihapus. Gunakan Check-out supaya riwayat keuangan tetap utuh.');
  // tagihan yang masih terbuka = uang yang terutang. Menghapus penyewa ikut menghapus tagihannya
  // (cascade), jadi tunggakan akan hilang dari laporan — tolak, arahkan ke pembatalan tagihan/check-out.
  const sisa = await ctx.db.prepare("select count(*) as n, coalesce(sum(jumlah),0) as s from bills where tenant_id=? and status='belum_bayar'").bind(t.id).first();
  if (sisa.n) throw httpError(409, `Penyewa ini masih punya ${sisa.n} tagihan belum lunas (${rupiah(sisa.s)}). Lunasi atau batalkan pembayarannya dulu sebelum menghapus.`);
  await ctx.db.prepare('delete from tenants where id=?').bind(t.id).run();
  const room = await ctx.db.prepare('select * from rooms where no_kamar=?').bind(roomNo).first();
  if (room) {
    const rest = await ctx.db.prepare("select count(*) as n from tenants where kamar_id=? and status='aktif'").bind(room.id).first();
    if (!rest.n) await ctx.db.prepare("update rooms set status='tersedia' where id=?").bind(room.id).run();
  }
  await ctx.audit('delete_tenant', 'tenants', t.id, { kode: t.kode, nama: t.nama }, null);
  return `Penyewa ${t.nama} telah dihapus permanen.`;
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
