// =====================================================================
// Kost Hade — Adapter Cloudflare D1 (Worker API)
// Menggantikan lapisan lama "google.script.run + localStorage".
// API-nya dipertahankan supaya seluruh UI (index.html) tidak perlu ditulis ulang:
//   google.script.run.withSuccessHandler(cb).withFailureHandler(err).getDashboardData()
// -> panggil /api/*, lalu cb(jsonString).
// =====================================================================
(function () {
  const API = '/api';
  let data = { dashboard: null, ops: null, kategori: null };

  async function call(path, body) {
    const res = await fetch(API + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = null;
    try { payload = await res.json(); } catch (_) { /* balasan bukan JSON */ }
    if (res.status === 401 && path !== '/login') {
      if (typeof window.onSesiBerakhir === 'function') window.onSesiBerakhir();
      throw new Error((payload && payload.error) || 'Sesi berakhir. Silakan login ulang.');
    }
    if (!res.ok) throw new Error((payload && payload.error) || `Server membalas ${res.status}.`);
    return payload;
  }

  const n = (v) => (v === null || v === undefined || v === '' ? 0 : Number(String(v).replace(/[^0-9.-]/g, '')) || 0);
  const aksi = (action, payload) => call('/action', { action, data: payload }).then((r) => r.message);

  async function muatSemua() {
    const b = await call('/bootstrap');
    data.dashboard = b;
    data.ops = b.ops || [];
    data.kategori = b.kategori || null;
    return b;
  }
  const segar = async () => (data.dashboard ? data.dashboard : muatSemua());

  const handlers = {
    // ---------------- SESI ----------------
    getSession: () => call('/session'),

    // ---------------- DASHBOARD ----------------
    getDashboardData: async () => {
      const d = await segar();
      return { ...d, ops: data.ops || [] };
    },
    getDashboard: async () => (await call('/dashboard')),

    getAvailableRooms: async () => {
      const d = await segar();
      return d.kamar.filter((k) => k[4] === 'Tersedia').map((k) => k[0]);
    },

    getActiveTenants: async () => {
      const d = await segar();
      return d.penyewa.filter((p) => p[5] === 'Aktif').map((p) => ({ nama: p[1], kamar: p[3] }));
    },

    getOpsRows: async () => {
      data.ops = await call('/ops');
      data.dashboard = null;
      return data.ops;
    },

    getOpsTransactions: async () => {
      data.ops = await call('/ops');
      return data.ops;
    },

    getCategories: async () => {
      if (!data.kategori) await muatSemua();
      return data.kategori || { Pengeluaran: [], Pendapatan: [], Neraca: [] };
    },

    // ---------------- KAMAR ----------------
    addRoom: (d) => aksi('rooms.create', d).then((m) => { data.dashboard = null; return m; }),
    editRoom: (d) => aksi('rooms.update', d).then((m) => { data.dashboard = null; return m; }),
    deleteRoom: (roomNo) => aksi('rooms.delete', { noKamar: roomNo }).then((m) => { data.dashboard = null; return m; }),

    // ---------------- PENYEWA ----------------
    addTenant: (d) => aksi('tenants.create', d).then((m) => { data.dashboard = null; return m; }),
    checkoutTenant: (id, kamar) => aksi('tenants.checkout', { id, kamar }).then((m) => { data.dashboard = null; return m; }),
    deleteTenant: (id, kamar) => aksi('tenants.delete', { id, kamar }).then((m) => { data.dashboard = null; return m; }),
    editTenant: async () => {
      throw new Error('Edit penyewa belum tersedia di versi D1. Check-out lalu daftarkan ulang bila perlu.');
    },

    // ---------------- PEMBAYARAN ----------------
    recordPayment: (d) => aksi('payments.create', d).then((m) => { data.dashboard = null; return m; }),

    // ---------------- LEDGER ----------------
    addOpsTransaction: (d) => aksi('ledger.create', d).then((m) => { data.dashboard = null; return m; }),
    deleteOpsTransaction: (id) => aksi('ledger.void', { id }).then((m) => { data.dashboard = null; return m; }),

    addCategory: async () => { throw new Error('Kelola kategori lewat database (belum ada di versi D1).'); },
    editCategory: async () => { throw new Error('Kelola kategori lewat database (belum ada di versi D1).'); },
    deleteCategory: async () => { throw new Error('Kelola kategori lewat database (belum ada di versi D1).'); },

    // ---------------- USER ----------------
    getUsers: async () => {
      throw new Error('Daftar pengguna hanya bisa dilihat admin lewat database.');
    },
    addUser: async () => { throw new Error('Buat akun dengan: node tools/buat-akun.mjs <username> <password> admin'); },
    editUser: async () => { throw new Error('Ubah data pengguna lewat database.'); },
    deleteUser: async () => { throw new Error('Akun tidak dihapus demi jejak audit; nonaktifkan (aktif=0).'); },

    // ---------------- cadangan ----------------
    exportAll: async () => ({ exported_at: new Date().toISOString(), ...(await muatSemua()) }),
    _reset: () => { data = { dashboard: null, ops: null, kategori: null }; },
  };

  // ---- jembatan kompatibilitas google.script.run ----
  window.google = { script: { run: {
    withSuccessHandler(h) { this.success = h; return this; },
    withFailureHandler(h) { this.fail = h; return this; },
  } } };
  Object.keys(handlers).forEach((name) => {
    window.google.script.run[name] = function (...args) {
      const success = this.success, failure = this.fail;
      handlers[name](...args).then((res) => {
        if (success) success(JSON.stringify(res === undefined ? null : res));
      }).catch((err) => {
        console.error('[hade]', name, err);
        if (failure) failure(err.message || String(err)); else alert(err.message || String(err));
      });
    };
  });

  window.HADE = {
    ready: true,
    login: (username, password) => call('/login', { username, password }),
    logout: () => call('/logout', {}),
    session: () => call('/session'),
    handlers,
    resetCache: () => handlers._reset(),
  };
})();
