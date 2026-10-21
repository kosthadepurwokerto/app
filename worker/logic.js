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
  let m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);      // 21/10/2026
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);                 // 2026-10-21[T...]
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
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

// ---------- aksi bisnis ----------
// ctx: { db (D1), user, audit(aksi, tabel, rowId, lama, baru), now() }
export async function createTenant(ctx, data) {
  const nama = String(data.nama || '').trim();
  if (nama.length < 2) throw httpError(400, 'Nama penyewa minimal 2 karakter.');
  const tglMasuk = toISODate(data.tglMasuk);
  if (!tglMasuk) throw httpError(400, 'Tanggal check-in tidak valid.');
  if (tglMasuk > ctx.today) throw httpError(400, 'Tanggal check-in tidak boleh di masa depan.');
  const noKamar = String(data.kamar || '').trim();
  const room = await ctx.db.prepare('select * from rooms where no_kamar = ?').bind(noKamar).first();
  if (!room) throw httpError(404, `Kamar ${noKamar} tidak ditemukan.`);
  if (room.status !== 'tersedia') throw httpError(409, `Kamar ${noKamar} tidak tersedia (status: ${room.status}).`);
  if (num(room.harga_bulanan) <= 0) throw httpError(400, `Harga bulanan kamar ${noKamar} belum diisi.`);

  const seq = await ctx.db.prepare("select coalesce(max(cast(substr(kode,5) as integer)),0)+1 as n from tenants").first();
  const kode = 'TEN-' + String(seq.n).padStart(4, '0');
  const ins = await ctx.db.prepare(
    'insert into tenants (kode, nama, hp, kamar_id, tgl_masuk, status) values (?,?,?,?,?,?)'
  ).bind(kode, nama, normPhone(data.hp), room.id, tglMasuk, 'aktif').run();
  const tenantId = ins.meta.last_row_id;

  await ctx.db.prepare('insert into bills (tenant_id, periode, jatuh_tempo, jumlah, status) values (?,?,?,?,?)')
    .bind(tenantId, bulanPeriode(tglMasuk), addMonths(tglMasuk, 1), num(room.harga_bulanan), 'belum_bayar').run();
  await ctx.db.prepare("update rooms set status='terisi' where id=?").bind(room.id).run();
  await ctx.audit('create_tenant', 'tenants', tenantId, null, { kode, nama, kamar: noKamar });

  return `Registrasi ${nama} di Kamar ${noKamar} berhasil (${kode}). Tagihan ${rupiah(room.harga_bulanan)} jatuh tempo ${addMonths(tglMasuk, 1)}.`;
}

export async function recordPayment(ctx, data) {
  const jumlah = num(data.jumlah);
  if (jumlah <= 0) throw httpError(400, 'Nominal pembayaran harus lebih dari 0.');
  const tgl = toISODate(data.tanggal) || ctx.today;
  if (tgl > ctx.today) throw httpError(400, 'Tanggal pembayaran tidak boleh di masa depan.');
  const noKamar = String(data.kamar || '').trim();

  const tenant = await ctx.db.prepare(
    `select t.*, r.no_kamar from tenants t left join rooms r on r.id = t.kamar_id
     where t.status='aktif' and (? = '' or r.no_kamar = ?)
     order by case when r.no_kamar = ? then 0 else 1 end;`
  ).bind(noKamar, noKamar, noKamar).all();
  let t = (tenant.results || []).find((x) => x.no_kamar === noKamar)
       || (tenant.results || []).find((x) => x.nama.toLowerCase() === String(data.nama || '').toLowerCase());
  if (!t) throw httpError(404, `Penyewa aktif di kamar ${noKamar} tidak ditemukan.`);

  const bill = await ctx.db.prepare(
    "select * from bills where tenant_id=? and status='belum_bayar' order by jatuh_tempo limit 1"
  ).bind(t.id).first();
  if (!bill) throw httpError(409, `Tidak ada tagihan terbuka untuk ${t.nama}. Tagihan dibuat otomatis saat registrasi atau setelah pembayaran lunas.`);
  if (num(bill.jumlah) !== jumlah)
    throw httpError(409, `Nominal bayar ${rupiah(jumlah)} tidak sama dengan tagihan ${rupiah(bill.jumlah)} (jatuh tempo ${bill.jatuh_tempo}).`);

  const cnt = await ctx.db.prepare('select count(*) as n from payments where tgl_bayar=?').bind(tgl).first();
  const nomor = `STR-${tgl.replace(/-/g, '')}-${String(cnt.n + 1).padStart(3, '0')}`;

  await ctx.db.prepare(
    'insert into payments (nomor_struk, bill_id, tenant_id, tgl_bayar, jumlah, keterangan, created_by) values (?,?,?,?,?,?,?)'
  ).bind(nomor, bill.id, t.id, tgl, jumlah, String(data.keterangan || ''), ctx.user.id).run();
  await ctx.db.prepare("update bills set status='lunas' where id=?").bind(bill.id).run();

  const nextJt = addMonths(String(bill.jatuh_tempo).slice(0, 10), 1);
  const nextPeriode = bulanPeriode(nextJt);
  const dup = await ctx.db.prepare('select id from bills where tenant_id=? and periode=?').bind(t.id, nextPeriode).first();
  if (!dup) {
    await ctx.db.prepare('insert into bills (tenant_id, periode, jatuh_tempo, jumlah, status) values (?,?,?,?,?)')
      .bind(t.id, nextPeriode, nextJt, bill.jumlah, 'belum_bayar').run();
  }
  await ctx.audit('payment', 'payments', nomor, null, { nomor, jumlah, tgl, tenant: t.kode });
  return `Pembayaran ${rupiah(jumlah)} dibukukan (${nomor}). Tagihan berikutnya jatuh tempo ${nextJt}.`;
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
  const cat = await ctx.db.prepare('select * from categories where jenis=? and nama=?').bind(jenis, nama).first();
  const ins = await ctx.db.prepare(
    'insert into ledger (tanggal, jenis, kategori_id, kategori, jumlah, keterangan, created_by) values (?,?,?,?,?,?,?)'
  ).bind(tgl, jenis, cat ? cat.id : null, nama, jumlah, String(data.keterangan || ''), ctx.user.id).run();
  await ctx.audit('ledger', 'ledger', ins.meta.last_row_id, null, { jenis, nama, jumlah, tgl });
  return `Transaksi ${jenis} "${data.keterangan || nama}" berhasil dicatat.`;
}

export async function voidOpsTransaction(ctx, id) {
  const row = await ctx.db.prepare('select * from ledger where id=?').bind(id).first();
  if (!row) throw httpError(404, 'Transaksi tidak ditemukan.');
  if (row.voided_at) throw httpError(409, 'Transaksi ini sudah dibatalkan.');
  await ctx.db.prepare("update ledger set voided_at=? where id=?").bind(ctx.now(), id).run();
  return 'Transaksi dibatalkan. Data tetap tersimpan untuk audit.';
}

export async function checkoutTenant(ctx, tenantId, roomNo) {
  const t = await ctx.db.prepare('select * from tenants where kode=? or id=?').bind(tenantId, tenantId).first();
  if (!t) throw httpError(404, 'Penyewa tidak ditemukan.');
  if (t.status === 'keluar') throw httpError(409, 'Penyewa ini sudah check-out.');
  await ctx.db.prepare("update tenants set status='keluar', tgl_keluar=? where id=?").bind(ctx.today, t.id).run();
  const room = await ctx.db.prepare('select * from rooms where no_kamar=?').bind(roomNo).first();
  const rest = await ctx.db.prepare("select count(*) as n from tenants where kamar_id=? and status='aktif'").bind(room ? room.id : -1).first();
  if (room && !rest.n) await ctx.db.prepare("update rooms set status='tersedia' where id=?").bind(room.id).run();
  const sisa = await ctx.db.prepare("select coalesce(sum(jumlah),0) as s from bills where tenant_id=? and status='belum_bayar'").bind(t.id).first();
  await ctx.audit('checkout', 'tenants', t.id, { status: 'aktif' }, { status: 'keluar' });
  return `Check-out selesai. Kamar ${roomNo} kini kosong.` + (sisa.s ? ` Catatan: masih ada tagihan belum lunas ${rupiah(sisa.s)}.` : '');
}

export async function deleteTenant(ctx, tenantId, roomNo) {
  const t = await ctx.db.prepare('select * from tenants where kode=? or id=?').bind(tenantId, tenantId).first();
  if (!t) throw httpError(404, 'Penyewa tidak ditemukan.');
  const pays = await ctx.db.prepare('select count(*) as n from payments where tenant_id=?').bind(t.id).first();
  if (pays.n) throw httpError(409, 'Penyewa ini punya riwayat pembayaran dan tidak bisa dihapus. Gunakan Check-out supaya riwayat keuangan tetap utuh.');
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
