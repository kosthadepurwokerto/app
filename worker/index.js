// =====================================================================
// Kost Hade — Worker API (Cloudflare Workers + D1)
// Sajikan UI statis dari folder pub/ dan API JSON di /api/*.
// =====================================================================
import * as logic from './logic.js';

const SESI_HARI = 7;
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

function cookieValue(req, name) {
  const raw = req.headers.get('cookie') || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function setSesiCookie(token, secure, maxAge = SESI_HARI * 86400) {
  return `hade_sesi=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` + (secure ? '; Secure' : '');
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
  const [rooms, tenants, bills, d, pays] = await Promise.all([
    env.DB.prepare('select * from rooms order by no_kamar').all(),
    env.DB.prepare('select * from tenants order by created_at desc').all(),
    env.DB.prepare("select * from bills where status='belum_bayar' order by jatuh_tempo").all(),
    env.DB.prepare('select * from v_dashboard').first(),
    env.DB.prepare('select * from payments where voided_at is null order by tgl_bayar desc, id desc limit 10').all(),
  ]);
  const roomMap = {};
  const aktif = (tenants.results || []).filter((t) => t.status === 'aktif');
  (rooms.results || []).forEach((r) => { roomMap[r.id] = r.no_kamar; });
  const label = (s) => ({ terisi: 'Terisi', perbaikan: 'Perbaikan' }[s] || 'Tersedia');
  const bulanIni = new Date().toISOString().slice(0, 8) + '01';

  return {
    stats: {
      totalKamar: d.total_kamar, kamarTerisi: d.kamar_terisi, kamarTersedia: d.kamar_tersedia,
      totalPenyewa: d.penyewa_aktif,
      totalPendapatan: d.total_sewa + d.total_pendapatan_ops,
      totalPengeluaran: d.total_pengeluaran,
      sisaKas: d.total_sewa + d.total_pendapatan_ops - d.total_pengeluaran,
      pendapatanBulanIni: (pays.results || []).filter((p) => p.tgl_bayar >= bulanIni).reduce((a, p) => a + p.jumlah, 0),
      tunggakan: d.tunggakan,
    },
    kamar: (rooms.results || []).map((r) => {
      const t = aktif.find((x) => x.kamar_id === r.id);
      return [r.no_kamar, r.tipe, String(r.harga_bulanan), String(r.harga_harian), label(r.status), t ? t.nama : ''];
    }),
    penyewa: (tenants.results || []).map((t) => {
      const b = (bills.results || []).find((x) => x.tenant_id === t.id);
      return [t.kode, t.nama, t.hp || '', roomMap[t.kamar_id] || '', t.tgl_masuk,
              t.status === 'aktif' ? 'Aktif' : 'Keluar', b ? b.jatuh_tempo : ''];
    }),
    transaksi: (pays.results || []).map((p) => [p.tgl_bayar, (tenants.results || []).find((t) => t.id === p.tenant_id)?.nama || '-',
      roomMap[(tenants.results || []).find((t) => t.id === p.tenant_id)?.kamar_id] || '', String(p.jumlah),
      (p.keterangan || '') + ' • ' + p.nomor_struk]),
  };
}

async function listLedger(env) {
  const r = await env.DB.prepare('select * from ledger where voided_at is null order by tanggal desc, id desc').all();
  return (r.results || []).map((x) => [x.id, x.tanggal, x.jenis.charAt(0).toUpperCase() + x.jenis.slice(1), x.kategori, String(x.jumlah), x.keterangan || '']);
}

// ---------- rute ----------
const AKSI = {
  'tenants.create': logic.createTenant,
  'tenants.checkout': (ctx, d) => logic.checkoutTenant(ctx, d.id, d.kamar),
  'tenants.delete': (ctx, d) => logic.deleteTenant(ctx, d.id, d.kamar),
  'payments.create': logic.recordPayment,
  'ledger.create': addLedger,
  'ledger.void': (ctx, d) => logic.voidOpsTransaction(ctx, d.id),
  'rooms.create': addRoom,
  'rooms.update': updateRoom,
  'rooms.delete': deleteRoom,
};

async function addLedger(ctx, d) {
  // UI lama mengirim jenis berkapital: "Pengeluaran" -> normalisasi
  return logic.addOpsTransaction(ctx, { ...d, jenis: String(d.jenis || '').toLowerCase() });
}

async function addRoom(ctx, d) {
  const no = String(d.noKamar || '').trim();
  if (!no) throw logic.httpError(400, 'Nomor kamar wajib diisi.');
  const dup = await ctx.db.prepare('select id from rooms where no_kamar=?').bind(no).first();
  if (dup) throw logic.httpError(409, `Unit Kamar ${no} sudah terdaftar.`);
  await ctx.db.prepare('insert into rooms (no_kamar, tipe, harga_bulanan, harga_harian, status) values (?,?,?,?,?)')
    .bind(no, d.tipe || 'Standar', logic.num(d.hargaBulanan), logic.num(d.hargaHarian), 'tersedia').run();
  return `Kamar ${no} (${d.tipe}) berhasil ditambahkan.`;
}

async function updateRoom(ctx, d) {
  const oldNo = String(d.oldNoKamar || '').trim(), newNo = String(d.noKamar || '').trim();
  const r = await ctx.db.prepare('select * from rooms where no_kamar=?').bind(oldNo).first();
  if (!r) throw logic.httpError(404, `Kamar ${oldNo} tidak ditemukan.`);
  if (newNo !== oldNo) {
    const dup = await ctx.db.prepare('select id from rooms where no_kamar=?').bind(newNo).first();
    if (dup) throw logic.httpError(409, `Unit Kamar ${newNo} sudah terdaftar.`);
  }
  await ctx.db.prepare('update rooms set no_kamar=?, tipe=?, harga_bulanan=?, harga_harian=? where id=?')
    .bind(newNo, d.tipe, logic.num(d.hargaBulanan), logic.num(d.hargaHarian), r.id).run();
  return `Kamar ${newNo} berhasil diperbarui.`;
}

async function deleteRoom(ctx, d) {
  const r = await ctx.db.prepare('select * from rooms where no_kamar=?').bind(d.noKamar).first();
  if (!r) throw logic.httpError(404, `Kamar ${d.noKamar} tidak ditemukan.`);
  const aktif = await ctx.db.prepare("select count(*) as n from tenants where kamar_id=? and status='aktif'").bind(r.id).first();
  if (aktif.n) throw logic.httpError(409, `Kamar ${d.noKamar} masih memiliki penyewa aktif. Check-out dulu.`);
  await ctx.db.prepare('delete from rooms where id=?').bind(r.id).run();
  return `Unit Kamar ${d.noKamar} telah dihapus.`;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const secure = (env.COOKIE_SECURE ?? 'true') !== 'false';

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(req);                    // UI statis (index.html)
    }

    try {
      // ---------- auth ----------
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const { username, password } = await req.json().catch(() => ({}));
        const u = await env.DB.prepare('select * from users where username=? and aktif=1')
          .bind(String(username || '').trim().toLowerCase()).first();
        if (!u || !(await logic.verifyPassword(String(password || ''), u.password_hash)))
          return json({ error: 'Kombinasi nama pengguna atau kata sandi tidak sesuai.' }, 401);
        const token = logic.randomToken();
        const exp = new Date(Date.now() + SESI_HARI * 86400000).toISOString();
        await env.DB.prepare('insert into sessions (token_hash, user_id, expires_at) values (?,?,?)')
          .bind(await logic.sha256hex(token), u.id, exp).run();
        return json({ ok: true, user: { username: u.username, fullname: u.fullname, role: u.role } },
          200, { 'set-cookie': setSesiCookie(token, secure) });
      }
      if (url.pathname === '/api/logout') {
        const t = cookieValue(req, 'hade_sesi');
        if (t) await env.DB.prepare('delete from sessions where token_hash=?').bind(await logic.sha256hex(t)).run();
        return json({ ok: true }, 200, { 'set-cookie': setSesiCookie('', secure, 0) });
      }

      const sesi = await sesiAktif(env, req);
      if (url.pathname === '/api/session') {
        return sesi ? json({ logged_in: true, user: { id: sesi.id, username: sesi.username, fullname: sesi.fullname, role: sesi.role, must_change_password: !!sesi.must_change_password } })
                    : json({ logged_in: false });
      }
      if (!sesi) return json({ error: 'Sesi berakhir. Silakan login ulang.' }, 401);

      // ---------- baca ----------
      if (url.pathname === '/api/bootstrap') {
        const [d, ops, cats] = await Promise.all([dashboard(env), listLedger(env), env.DB.prepare('select * from categories where aktif=1 order by nama').all()]);
        const kategori = { Pengeluaran: [], Pendapatan: [], Neraca: [] };
        (cats.results || []).forEach((c) => {
          const k = c.jenis.charAt(0).toUpperCase() + c.jenis.slice(1);
          (kategori[k] = kategori[k] || []).push({ nama: c.nama, saldoNormal: c.saldo_normal });
        });
        return json({ ...d, ops, kategori });
      }
      if (url.pathname === '/api/dashboard') return json(await dashboard(env));
      if (url.pathname === '/api/ops') return json(await listLedger(env));

      // ---------- tulis ----------
      if (url.pathname === '/api/action' && req.method === 'POST') {
        const { action, data } = await req.json().catch(() => ({}));
        const fn = AKSI[action];
        if (!fn) return json({ error: `Aksi "${action}" tidak dikenal.` }, 400);
        const ctx = {
          env, db: env.DB, user: sesi,
          today: logic.todayISO(), now: () => new Date().toISOString(),
          audit: async () => {},                       // trigger DB sudah mencatat
        };
        const msg = await fn(ctx, data || {});
        return json({ ok: true, message: msg });
      }

      return json({ error: 'Rute tidak ditemukan.' }, 404);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error('[hade]', e.stack || e);
      return json({ error: e.message || 'Terjadi kesalahan pada server.' }, status);
    }
  },
};
