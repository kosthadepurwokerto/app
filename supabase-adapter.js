// =====================================================================
// Kost Hade — Adapter Supabase
// Menggantikan lapisan "google.script.run + localStorage" lama.
// API-nya sengaja dipertahankan supaya seluruh UI (index.html) tidak perlu ditulis ulang:
//   google.script.run.withSuccessHandler(cb).withFailureHandler(err).getDashboardData()
// -> jalankan query Supabase, lalu panggil cb(jsonString).
// =====================================================================
(function () {
  const CFG = window.HADE_SUPABASE || {};
  const url = (CFG.url || '').replace(/\/$/, '');
  const key = CFG.anonKey || '';
  const TABLE = {
    rooms: 'rooms', tenants: 'tenants', payments: 'payments',
    ledger: 'ledger', bills: 'bills', categories: 'categories', profiles: 'profiles',
  };
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url) && key.length > 20 && !/^GANTI/.test(key);
  const sb = configured && window.supabase ? window.supabase.createClient(url, key) : null;

  function fail(msg) { return Promise.reject(new Error(msg)); }
  function must() { if (!sb) throw new Error('Supabase belum dikonfigurasi. Isi config.js (url + anon key).'); return sb; }
  const n = (v) => (v === null || v === undefined || v === '' ? 0 : Number(String(v).replace(/[^0-9.-]/g, '')) || 0);
  const d = (v) => (v ? String(v).slice(0, 10) : null);

  // ---- format tanggal satu standar: YYYY-MM-DD (sebelumnya campuran id-ID & ISO) ----
  function toISODate(input) {
    if (!input) return null;
    if (input instanceof Date) return input.toISOString().slice(0, 10);
    const s = String(input).trim();
    let m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    const dt = new Date(s);
    return isNaN(dt) ? null : dt.toISOString().slice(0, 10);
  }
  function addMonths(iso, months) {
    // hitung kalender murni: JANGAN pakai toISOString() (tergeser timezone)
    const [y, m, d] = iso.split('-').map(Number);
    const total = (y * 12 + (m - 1)) + months;
    const ny = Math.floor(total / 12), nm = total % 12 + 1;
    const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    const nd = Math.min(d, lastDay);            // 31 Jan + 1 bln -> 28/29 Feb
    const p = (x) => String(x).padStart(2, '0');
    return `${ny}-${p(nm)}-${p(nd)}`;
  }
  function todayISO() {
    const t = new Date();
    const p = (x) => String(x).padStart(2, '0');
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
  }
  const rp = (v) => 'Rp ' + Number(v || 0).toLocaleString('id-ID');

  async function q(builder) {
    const { data, error } = await builder;
    if (error) throw new Error(error.message || String(error));
    return data;
  }

  async function currentProfile() {
    const { data: { user } } = await must().auth.getUser();
    if (!user) throw new Error('Sesi berakhir, silakan login ulang.');
    const rows = await q(sb.from('profiles').select('*').eq('id', user.id).limit(1));
    if (!rows.length) throw new Error('Akun belum memiliki profil. Hubungi admin.');
    return rows[0];
  }

  async function roomMap() {
    const rooms = await q(sb.from('rooms').select('*').order('no_kamar'));
    const map = {}; rooms.forEach(r => { map[r.id] = r; });
    return { rooms, map };
  }

  // Data mentah untuk mode offline / ekspor
  async function exportAll() {
    const [rooms, tenants, bills, payments, ledger, categories] = await Promise.all([
      q(sb.from('rooms').select('*').order('no_kamar')),
      q(sb.from('tenants').select('*').order('created_at')),
      q(sb.from('bills').select('*')),
      q(sb.from('payments').select('*')),
      q(sb.from('ledger').select('*')),
      q(sb.from('categories').select('*')),
    ]);
    return { exported_at: new Date().toISOString(), rooms, tenants, bills, payments, ledger, categories };
  }

  const handlers = {
    // ---------------- SESI ----------------
    getSession: async () => {
      if (!sb) return { logged_in: false };
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return { logged_in: false };
      const p = await currentProfile();
      return { logged_in: true, user: { id: p.id, username: p.username, fullname: p.fullname, role: p.role } };
    },

    // ---------------- DASHBOARD ----------------
    getDashboardData: async () => {
      const [{ rooms, map }, tenants, dRow, pays, bils] = await Promise.all([
        roomMap(),
        q(sb.from('tenants').select('*').order('created_at', { ascending: false })),
        q(sb.from('v_dashboard').select('*').limit(1)),
        q(sb.from('payments').select('*').is('voided_at', null).order('tgl_bayar', { ascending: false }).limit(300)),
        q(sb.from('bills').select('*').neq('status', 'lunas').order('jatuh_tempo')),
      ]);
      const s = dRow[0] || {};
      const monthStart = todayISO().slice(0, 8) + '01';
      const pendapatanBulanIni =
        pays.filter(p => p.tgl_bayar >= monthStart).reduce((a, p) => a + n(p.jumlah), 0);

      return {
        stats: {
          totalKamar: s.total_kamar || 0,
          kamarTerisi: s.kamar_terisi || 0,
          kamarTersedia: s.kamar_tersedia || 0,
          totalPenyewa: s.penyewa_aktif || 0,
          totalPendapatan: n(s.total_sewa) + n(s.total_pendapatan_ops),
          totalPengeluaran: n(s.total_pengeluaran),
          sisaKas: n(s.total_sewa) + n(s.total_pendapatan_ops) - n(s.total_pengeluaran),
          pendapatanBulanIni,
          tunggakan: n(s.tunggakan),
        },
        // kamar: [no, tipe, hargaBulanan, hargaHarian, status, namaPenyewa]
        kamar: rooms.map(r => {
          const t = tenants.find(x => x.kamar_id === r.id && x.status === 'aktif');
          const label = r.status === 'terisi' ? 'Terisi' : r.status === 'perbaikan' ? 'Perbaikan' : 'Tersedia';
          return [r.no_kamar, r.tipe, String(r.harga_bulanan), String(r.harga_harian), label, t ? t.nama : ''];
        }),
        // penyewa: [kode, nama, hp, noKamar, tglMasuk, status, jatuhTempo]
        penyewa: tenants.map(t => {
          const b = bils.filter(x => x.tenant_id === t.id).sort((a, z) => a.jatuh_tempo.localeCompare(z.jatuh_tempo))[0];
          const st = t.status === 'aktif' ? 'Aktif' : 'Keluar';
          return [t.kode, t.nama, t.hp || '', map[t.kamar_id]?.no_kamar || '',
                  t.tgl_masuk, st, b ? b.jatuh_tempo : ''];
        }),
        // transaksi: [tanggal, nama, kamar, jumlah, keterangan]
        transaksi: pays.slice(0, 10).map(p => {
          const t = tenants.find(x => x.id === p.tenant_id);
          return [p.tgl_bayar, t ? t.nama : '-', map[t?.kamar_id]?.no_kamar || '', String(p.jumlah),
                  (p.keterangan || '') + (p.nomor_struk ? ' • ' + p.nomor_struk : '')];
        }),
      };
    },

    getAvailableRooms: async () => {
      const rooms = await q(sb.from('rooms').select('no_kamar').eq('status', 'tersedia').order('no_kamar'));
      return rooms.map(r => r.no_kamar);
    },

    getActiveTenants: async () => {
      const [{ map }, tenants] = await Promise.all([
        roomMap(), q(sb.from('tenants').select('*').eq('status', 'aktif')),
      ]);
      return tenants.map(t => ({ nama: t.nama, kamar: map[t.kamar_id]?.no_kamar || '' }));
    },

    // versi mentah (tanpa stringify) untuk pemakaian internal
    getOpsRows: async () => {
      return q(sb.from('ledger').select('*').is('voided_at', null).order('tanggal', { ascending: false }));
    },

    getOpsTransactions: async () => {
      const rows = await q(sb.from('ledger').select('*').is('voided_at', null).order('tanggal', { ascending: false }));
      return rows.map(r => [r.id, r.tanggal, r.jenis.charAt(0).toUpperCase() + r.jenis.slice(1), r.kategori, String(r.jumlah), r.keterangan || '']);
    },

    getCategories: async () => {
      const rows = await q(sb.from('categories').select('*').eq('aktif', true).order('nama'));
      const out = { Pengeluaran: [], Pendapatan: [], Neraca: [] };
      rows.forEach(r => {
        const k = r.jenis.charAt(0).toUpperCase() + r.jenis.slice(1);
        (out[k] = out[k] || []).push({ nama: r.nama, saldoNormal: r.saldo_normal });
      });
      return out;
    },

    // ---------------- KAMAR ----------------
    addRoom: async (data) => {
      const no = String(data.noKamar || '').trim();
      if (!no) throw new Error('Nomor kamar wajib diisi.');
      const dup = await q(sb.from('rooms').select('id').eq('no_kamar', no));
      if (dup.length) throw new Error(`Unit Kamar dengan nomor ${no} sudah terdaftar!`);
      if (n(data.hargaBulanan) < 0 || n(data.hargaHarian) < 0) throw new Error('Harga tidak boleh negatif.');
      await q(sb.from('rooms').insert({
        no_kamar: no, tipe: data.tipe || 'Standar',
        harga_bulanan: n(data.hargaBulanan), harga_harian: n(data.hargaHarian), status: 'tersedia',
      }));
      return `Kamar ${no} (${data.tipe}) berhasil ditambahkan!`;
    },

    editRoom: async (data) => {
      const oldNo = String(data.oldNoKamar || '').trim();
      const newNo = String(data.noKamar || '').trim();
      const rooms = await q(sb.from('rooms').select('*').eq('no_kamar', oldNo));
      if (!rooms.length) throw new Error(`Kamar ${oldNo} tidak ditemukan.`);
      if (newNo !== oldNo) {
        const dup = await q(sb.from('rooms').select('id').eq('no_kamar', newNo));
        if (dup.length) throw new Error(`Unit Kamar dengan nomor ${newNo} sudah terdaftar!`);
      }
      await q(sb.from('rooms').update({
        no_kamar: newNo, tipe: data.tipe,
        harga_bulanan: n(data.hargaBulanan), harga_harian: n(data.hargaHarian),
      }).eq('id', rooms[0].id));
      return `Kamar ${newNo} berhasil diperbarui!`;
    },

    deleteRoom: async (roomNo) => {
      const rooms = await q(sb.from('rooms').select('*').eq('no_kamar', roomNo));
      if (!rooms.length) throw new Error(`Kamar ${roomNo} tidak ditemukan.`);
      const r = rooms[0];
      if (r.status === 'terisi') throw new Error(`Kamar ${roomNo} masih terisi. Check-out penyewa dulu sebelum menghapus.`);
      const active = await q(sb.from('tenants').select('id').eq('kamar_id', r.id).eq('status', 'aktif'));
      if (active.length) throw new Error(`Kamar ${roomNo} masih memiliki penyewa aktif.`);
      await q(sb.from('rooms').delete().eq('id', r.id));
      return `Unit Kamar ${roomNo} telah dihapus permanen.`;
    },

    // ---------------- PENYEWA ----------------
    addTenant: async (data) => {
      const nama = String(data.nama || '').trim();
      if (nama.length < 2) throw new Error('Nama penyewa minimal 2 karakter.');
      const tglMasuk = toISODate(data.tglMasuk) || todayISO();
      if (tglMasuk > todayISO()) throw new Error('Tanggal check-in tidak boleh di masa depan.');
      const rooms = await q(sb.from('rooms').select('*').eq('no_kamar', data.kamar));
      if (!rooms.length) throw new Error(`Kamar ${data.kamar} tidak ditemukan.`);
      const room = rooms[0];
      if (room.status !== 'tersedia') throw new Error(`Kamar ${data.kamar} tidak tersedia (status: ${room.status}).`);
      if (n(room.harga_bulanan) <= 0) throw new Error(`Harga bulanan kamar ${data.kamar} belum diisi. Lengkapi data kamar dulu.`);

      const kode = await q(sb.rpc('next_tenant_code'));
      const ins = await q(sb.from('tenants').insert({
        kode, nama, hp: String(data.hp || '').replace(/[^0-9+]/g, ''),
        kamar_id: room.id, tgl_masuk: tglMasuk, status: 'aktif',
      }).select().limit(1));
      const tenant = ins[0];

      // tagihan pertama + jatuh tempo = tgl masuk + 1 bulan
      const periode = tglMasuk.slice(0, 8) + '01';
      await q(sb.from('bills').insert({
        tenant_id: tenant.id, periode, jatuh_tempo: addMonths(tglMasuk, 1),
        jumlah: n(room.harga_bulanan), status: 'belum_bayar',
      }));
      await q(sb.from('rooms').update({ status: 'terisi' }).eq('id', room.id));

      return `Registrasi ${nama} di Kamar ${data.kamar} berhasil. Tagihan ${rp(room.harga_bulanan)} jatuh tempo ${addMonths(tglMasuk, 1)}.`;
    },

    editTenant: async (data) => {
      const tenants = await q(sb.from('tenants').select('*').eq('kode', data.id));
      const rows = tenants.length ? tenants : await q(sb.from('tenants').select('*').eq('id', data.id));
      if (!rows.length) throw new Error('Penyewa tidak ditemukan.');
      const t = rows[0];
      const roomsAll = await q(sb.from('rooms').select('*'));
      const newRoom = roomsAll.find(r => r.no_kamar === data.kamar);
      if (!newRoom) throw new Error(`Kamar ${data.kamar} tidak ditemukan.`);
      if (newRoom.id !== t.kamar_id && newRoom.status !== 'tersedia')
        throw new Error(`Kamar ${data.kamar} sudah terisi penyewa lain.`);

      const keluar = data.status === 'Keluar';
      if (keluar !== (t.status === 'keluar')) {
        await q(sb.from('tenants').update({
          status: keluar ? 'keluar' : 'aktif', tgl_keluar: keluar ? todayISO() : null,
        }).eq('id', t.id));
      }
      await q(sb.from('tenants').update({
        nama: data.nama, hp: String(data.hp || '').replace(/[^0-9+]/g, ''),
        kamar_id: keluar ? t.kamar_id : newRoom.id,
        tgl_masuk: toISODate(data.tglMasuk) || t.tgl_masuk,
      }).eq('id', t.id));

      // sinkronkan status kamar
      if (t.kamar_id && t.kamar_id !== newRoom.id) {
        const still = await q(sb.from('tenants').select('id').eq('kamar_id', t.kamar_id).eq('status', 'aktif'));
        if (!still.length) await q(sb.from('rooms').update({ status: 'tersedia' }).eq('id', t.kamar_id));
      }
      if (!keluar) await q(sb.from('rooms').update({ status: 'terisi' }).eq('id', newRoom.id));

      // jatuh tempo manual (opsional) — validasi tanggal
      if (data.jatuhTempo) {
        const jt = toISODate(data.jatuhTempo);
        if (!jt) throw new Error('Format jatuh tempo tidak valid (gunakan YYYY-MM-DD).');
        const bills = await q(sb.from('bills').select('*').eq('tenant_id', t.id).neq('status', 'lunas').order('jatuh_tempo'));
        if (bills.length) await q(sb.from('bills').update({ jatuh_tempo: jt }).eq('id', bills[0].id));
        else await q(sb.from('bills').insert({ tenant_id: t.id, periode: jt.slice(0, 8) + '01', jatuh_tempo: jt, jumlah: 1, status: 'belum_bayar' }));
      }
      return `Data penyewa ${data.nama} berhasil diperbarui!`;
    },

    checkoutTenant: async (tenantId, roomNo) => {
      const rows = await q(sb.from('tenants').select('*').eq('kode', tenantId));
      const t = rows[0] || (await q(sb.from('tenants').select('*').eq('id', tenantId)))[0];
      if (!t) throw new Error('Penyewa tidak ditemukan.');
      await q(sb.from('tenants').update({ status: 'keluar', tgl_keluar: todayISO() }).eq('id', t.id));
      const rooms = await q(sb.from('rooms').select('*').eq('no_kamar', roomNo));
      if (rooms.length) await q(sb.from('rooms').update({ status: 'tersedia' }).eq('id', rooms[0].id));
      const sisa = await q(sb.from('bills').select('id,jumlah').eq('tenant_id', t.id).neq('status', 'lunas'));
      const sisaTotal = sisa.reduce((a, b) => a + n(b.jumlah), 0);
      return `Check-out selesai. Kamar ${roomNo} kini kosong.` +
             (sisaTotal ? ` Catatan: masih ada tagihan belum lunas ${rp(sisaTotal)}.` : '');
    },

    deleteTenant: async (tenantId, roomNo) => {
      const rows = await q(sb.from('tenants').select('*').eq('kode', tenantId));
      const t = rows[0] || (await q(sb.from('tenants').select('*').eq('id', tenantId)))[0];
      if (!t) throw new Error('Penyewa tidak ditemukan.');
      const pays = await q(sb.from('payments').select('id').eq('tenant_id', t.id));
      if (pays.length) throw new Error('Penyewa ini punya riwayat pembayaran dan tidak bisa dihapus. Gunakan Check-out supaya riwayat keuangan tetap utuh.');
      await q(sb.from('tenants').delete().eq('id', t.id));
      const rooms = await q(sb.from('rooms').select('*').eq('no_kamar', roomNo));
      if (rooms.length) {
        const still = await q(sb.from('tenants').select('id').eq('kamar_id', rooms[0].id).eq('status', 'aktif'));
        if (!still.length) await q(sb.from('rooms').update({ status: 'tersedia' }).eq('id', rooms[0].id));
      }
      return `Penyewa ${t.nama} telah dihapus permanen.`;
    },

    // ---------------- PEMBAYARAN ----------------
    recordPayment: async (data) => {
      const jumlah = n(data.jumlah);
      if (jumlah <= 0) throw new Error('Nominal pembayaran harus lebih dari 0.');
      const tgl = toISODate(data.tanggal) || todayISO();
      if (tgl > todayISO()) throw new Error('Tanggal pembayaran tidak boleh di masa depan.');

      const bills = await q(sb.from('bills').select('*').eq('status', 'belum_bayar'));
      const byName = bills.filter(b => String(b.jumlah) === String(jumlah));

      // cari penyewa aktif: utamakan kamar (unik), nama hanya cadangan
      const [{ map }, tenants] = await Promise.all([
        roomMap(), q(sb.from('tenants').select('*').eq('status', 'aktif')),
      ]);
      const tenant = tenants.find(t => (map[t.kamar_id]?.no_kamar || '') === data.kamar)
        || tenants.find(t => String(t.nama || '').toLowerCase() === String(data.nama || '').toLowerCase());
      if (!tenant) throw new Error(`Penyewa aktif di kamar ${data.kamar} tidak ditemukan.`);
      const bill = bills.find(b => b.tenant_id === tenant.id) || byName[0] || null;

      if (!bill) throw new Error(`Tidak ada tagihan terbuka untuk ${tenant.nama} di kamar ${data.kamar}. Catat tagihan dulu di menu Penyewa.`);
      if (n(bill.jumlah) !== jumlah) throw new Error(`Nominal bayar (${rp(jumlah)}) tidak sama dengan tagihan ${rp(bill.jumlah)}.`);

      const nomor = await q(sb.rpc('next_receipt_no'));
      await q(sb.from('payments').insert({
        nomor_struk: nomor, bill_id: bill.id, tenant_id: tenant.id,
        tgl_bayar: tgl, jumlah, keterangan: data.keterangan || '', created_by: (await currentProfile()).id,
      }));
      await q(sb.from('bills').update({ status: 'lunas' }).eq('id', bill.id));

      let nextJt = data.jatuhTempo ? toISODate(data.jatuhTempo) : addMonths(String(bill.jatuh_tempo).slice(0,10), 1);
      if (!nextJt) throw new Error('Format jatuh tempo tidak valid.');
      const nextPeriode = nextJt.slice(0, 8) + '01';
      const dup = await q(sb.from('bills').select('id').eq('tenant_id', tenant.id).eq('periode', nextPeriode));
      if (!dup.length) await q(sb.from('bills').insert({
        tenant_id: tenant.id, periode: nextPeriode, jatuh_tempo: nextJt,
        jumlah: bill.jumlah, status: 'belum_bayar',
      }));

      return `Pembayaran ${rp(jumlah)} berhasil dibukukan (${nomor}). Tagihan berikutnya jatuh tempo ${nextJt}.`;
    },

    // ---------------- LEDGER ----------------
    addOpsTransaction: async (data) => {
      const jumlah = n(data.jumlah);
      if (jumlah <= 0) throw new Error('Nominal transaksi harus lebih dari 0.');
      const jenisMap = { pendapatan: 'pendapatan', pengeluaran: 'pengeluaran', neraca: 'neraca' };
      const jenis = jenisMap[String(data.jenis || '').toLowerCase()];
      if (!jenis) throw new Error(`Jenis transaksi "${data.jenis}" tidak dikenal.`);
      if (toISODate(data.tanggal) > todayISO()) throw new Error('Tanggal transaksi tidak boleh di masa depan.');
      const nama = String(data.kategori || '').trim();
      if (!nama) throw new Error('Kategori wajib dipilih.');
      const cats = await q(sb.from('categories').select('id,nama').eq('jenis', jenis).eq('nama', nama));
      const now = await currentProfile();
      await q(sb.from('ledger').insert({
        tanggal: toISODate(data.tanggal) || todayISO(), jenis,
        kategori_id: cats[0] ? cats[0].id : null, kategori: nama,
        jumlah, keterangan: data.keterangan || '', created_by: now.id,
      }));
      return `Transaksi ${data.jenis} "${data.keterangan || nama}" berhasil dicatat ke Ledger!`;
    },

    deleteOpsTransaction: async (id) => {
      await q(sb.from('ledger').update({ voided_at: new Date().toISOString() }).eq('id', id));
      return 'Transaksi dibatalkan (data tetap tersimpan untuk audit).';
    },

    deleteCategory: async (data) => {
      const cats = await q(sb.from('categories').select('id').eq('jenis', String(data.jenis).toLowerCase()).eq('nama', data.nama));
      if (!cats.length) throw new Error('Kategori tidak ditemukan.');
      await q(sb.from('categories').update({ aktif: false }).eq('id', cats[0].id));
      return `Kategori "${data.nama}" dinonaktifkan. Riwayat transaksi tetap utuh.`;
    },

    // ---------------- USER ----------------
    getUsers: async () => {
      const rows = await q(sb.from('profiles').select('id,username,fullname,role').order('username'));
      return rows.map(r => ({ id: r.id, username: r.username, fullname: r.fullname, role: r.role === 'admin' ? 'Administrator' : 'User', password: '********' }));
    },

    // Pembuatan akun memerlukan service-role key -> jalankan lewat Supabase (Edge Function/Dashboard).
    addUser: async () => { throw new Error('Akun baru dibuat lewat Supabase Auth (Dashboard → Authentication → Users, atau Edge Function admin). Tambahkan profilnya di tabel profiles.'); },
    editUser: async (u) => {
      await q(sb.from('profiles').update({
        username: u.username, fullname: u.fullname,
        role: String(u.role).toLowerCase().startsWith('admin') ? 'admin' : 'staff',
      }).eq('id', u.id));
      return `Data user "${u.fullname}" berhasil diperbarui.`;
    },
    deleteUser: async (id) => { throw new Error('Akun tidak bisa dihapus dari aplikasi demi jejak audit. Nonaktifkan lewat Supabase Auth.'); },

    exportAll,
    _toISODate: toISODate,
    _addMonths: addMonths,
  };

  // ---- jembatan kompatibilitas google.script.run ----
  window.google = { script: { run: {
    withSuccessHandler(h) { this.success = h; return this; },
    withFailureHandler(h) { this.fail = h; return this; },
  } } };
  Object.keys(handlers).forEach(name => {
    window.google.script.run[name] = function (...args) {
      const success = this.success, failure = this.fail;
      handlers[name](...args).then(res => {
        if (success) success(typeof res === 'string' || Array.isArray(res) || typeof res === 'boolean' || typeof res === 'number'
          ? JSON.stringify(res) : JSON.stringify(res));
      }).catch(err => {
        console.error('[hade]', name, err);
        if (failure) failure(err.message || String(err)); else alert(err.message || String(err));
      });
    };
  });

  // ---- API baru (dipakai bertahap) ----
  window.HADE = { sb, handlers, exportAll, toISODate, addMonths, rp, currentProfile, tables: TABLE };
})();
