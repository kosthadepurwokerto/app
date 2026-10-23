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
      return d.penyewa.filter((p) => p[5] === 'Aktif').map((p) => ({ nama: p[1], kamar: p[3], tagihan: p[7] || '', tempo: p[6] || '' }));
    },

    getOpsRows: async () => {
      // JANGAN mengosongkan data.dashboard di sini: adapter ini juga dipakai
      // loadDashboard() sesudahnya, dan mengosongkannya memicu muat ulang berantai.
      data.ops = await call('/ops');
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

    gantiPassword: (lama, baru) => call('/password', { lama, baru }),

    // ---------------- KAMAR ----------------
    addRoom: (d) => aksi('rooms.create', d).then((m) => { data.dashboard = null; return m; }),
    editRoom: (d) => aksi('rooms.update', d).then((m) => { data.dashboard = null; return m; }),
    deleteRoom: (roomNo) => aksi('rooms.delete', { noKamar: roomNo }).then((m) => { data.dashboard = null; return m; }),

    // ---------------- PENYEWA ----------------
    addTenant: (d) => aksi('tenants.create', d).then((m) => { data.dashboard = null; return m; }),
    checkoutTenant: (id, kamar) => aksi('tenants.checkout', { id, kamar }).then((m) => { data.dashboard = null; return m; }),
    deleteTenant: (id, kamar) => aksi('tenants.delete', { id, kamar }).then((m) => { data.dashboard = null; return m; }),
    editTenant: (d) => aksi('tenants.update', d).then((m) => { data.dashboard = null; return m; }),

    // ---------------- PEMBAYARAN ----------------
    recordPayment: (d) => aksi('payments.create', d).then((m) => { data.dashboard = null; return m; }),

    // ---------------- LEDGER ----------------
    addOpsTransaction: (d) => aksi('ledger.create', d).then((m) => { data.dashboard = null; return m; }),
    deleteOpsTransaction: (id) => aksi('ledger.void', { id }).then((m) => { data.dashboard = null; return m; }),

    addCategory: (d) => aksi('categories.create', d).then((m) => { data.kategori = null; return m; }),
    editCategory: (d) => aksi('categories.update', d).then((m) => { data.kategori = null; return m; }),
    deleteCategory: (d) => aksi('categories.delete', d).then((m) => { data.kategori = null; return m; }),

    // ---------------- USER ----------------
    getUsers: async () => {
      const b = await muatSemua();            // hanya admin yang menerima daftar user
      if (!b.users || !b.users.length) throw new Error('Daftar pengguna hanya bisa dilihat admin.');
      return b.users;
    },
    addUser: (d) => aksi('users.create', d).then((m) => { data.dashboard = null; return m; }),
    editUser: (d) => aksi('users.update', d).then((m) => { data.dashboard = null; return m; }),
    deleteUser: (id) => aksi('users.delete', { id }).then((m) => { data.dashboard = null; return m; }),

    catatPengingat: (billId) => aksi('pengingat.catat', { billId }),

    // ---------------- FOTO KTP ----------------
    // Unggah ke R2 lewat Worker; yang disimpan di database hanya kunci berkasnya.
    uploadKtp: async (file) => {
      if (!file) return null;
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(API + '/ktp', { method: 'POST', body: fd, credentials: 'same-origin' });
      let payload = null;
      try { payload = await res.json(); } catch (_) { /* bukan JSON */ }
      if (res.status === 401 && typeof window.onSesiBerakhir === 'function') window.onSesiBerakhir();
      if (!res.ok) throw new Error((payload && payload.error) || `Unggah foto gagal (${res.status}).`);
      return payload;                       // { kunci, tipe }
    },
    uploadBukti: async (file) => {
      if (!file) return null;
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(API + '/bukti', { method: 'POST', body: fd, credentials: 'same-origin' });
      let payload = null;
      try { payload = await res.json(); } catch (_) { /* bukan JSON */ }
      if (res.status === 401 && typeof window.onSesiBerakhir === 'function') window.onSesiBerakhir();
      if (!res.ok) throw new Error((payload && payload.error) || `Unggah bukti gagal (${res.status}).`);
      return payload;                       // { kunci, tipe }
    },
    urlBukti: (kunci) => (kunci ? API + '/bukti/' + kunci.split('/').map(encodeURIComponent).join('/') : null),

    urlKtp: (kunci) => (kunci ? API + '/ktp/' + kunci.split('/').map(encodeURIComponent).join('/') : null),

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
