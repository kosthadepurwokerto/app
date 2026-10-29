
    // Data cache & status navigasi
    let cachedData = null;
    let loadingTimeout;
    let selectedRoomFilter = 'semua';
    let selectedOpsFilter = 'Semua';
    let activeReportTab = 'rugi-laba';
    
    // Status sesi: user yang masuk dan kost aktif (multitenan)
    let activeUser = null;
    let activeKost = null;      // { kunci, namaApp, kota, tagline, logoKunci }
    let usersList = [];
    let daftarKostPilih = [];   // isi modal pilih kost saat login
    
    // Custom Callback Placeholder for Confirmation Modal Actions
    let modalConfirmCallback = null;

    // Escape SEMUA data dari server sebelum masuk innerHTML (nama penyewa, keterangan, dsb.
    // bisa berisi <script> atau tanda kutip yang merusak onclick).
    function esc(v) {
      return String(v === null || v === undefined ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    // Angka rupiah dengan format Indonesia yang konsisten
    const rp = (v) => 'Rp ' + Number(String(v === null || v === undefined ? 0 : v).replace(/[^0-9-]/g, '') || 0).toLocaleString('id-ID');

    // Aksi tabel memakai data-* + satu listener (bukan onclick inline) supaya nama berkutip
    // seperti O'Brien tidak mematikan tombol dan tidak bisa menyuntik JS.
    window.__aksi = {};
    function daftarAksi(id, fn) { window.__aksi[id] = fn; }
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-aksi]');
      if (!el) return;
      const fn = window.__aksi[el.getAttribute('data-aksi')];
      if (!fn) return;
      e.preventDefault();
      fn(el.dataset);
    });

    // Categories structure loaded dynamically
    let categoryOptions = {
      Pengeluaran: [],
      Pendapatan: [],
      Neraca: []
    };

    // Muat kategori lalu ISI ulang dropdown langsung (dulu memanggil refreshCategorySelect
    // yang tidak ada -> form transaksi bisa berakhir tanpa opsi sama sekali).
    function refreshCategoryOptions(selesai) {
      if (!window.HADE) return Promise.resolve();
      return HADE.handlers.getCategories().then(data => {
        categoryOptions = data;
        isiKategoriTransaksi();
        if (typeof selesai === 'function') selesai();
      }).catch(err => console.warn('[hade] kategori', err));
    }

    function isiKategoriTransaksi() {
      const select = document.getElementById('trans-kategori');
      const jenisEl = document.getElementById('trans-jenis');
      if (!select || !jenisEl) return;
      // nilai <select> = "Pengeluaran"/"Pendapatan"/"Neraca" (kunci categoryOptions)
      const daftar = categoryOptions[jenisEl.value] || [];
      select.innerHTML = daftar.length
        ? daftar.map(cat => `<option value="${esc(cat.nama)}">${esc(cat.nama)} (${cat.saldoNormal === 'Debet' ? 'D' : 'K'})</option>`).join('')
        : '<option value="">-- Tidak ada kategori --</option>';
    }

    // Kategori dimuat setelah login (lihat handleLoginSubmit) — sebelum login endpoint ini 401.

    /** Link khusus kost: /?kost=kost-melati langsung memilih kost itu.
     *  Kolom kode hanya ditampilkan bila tautan memang membawa kata kunci kost. */
    function bacaKostDariUrl() {
      try {
        const p = new URLSearchParams(location.search);
        const k = (p.get('kost') || p.get('app') || '').trim();
        if (!k) return '';
        sessionStorage.setItem('hade_kost_url', k);
        return k;
      } catch (e) { return ''; }
    }

    function togglePasswordVisibility() {
      const passwordInput = document.getElementById('login-password');
      const icon = document.getElementById('toggle-password-icon');
      if (passwordInput.type === 'password') {
        passwordInput.type = 'text';
        icon.className = 'fas fa-eye-slash';
      } else {
        passwordInput.type = 'password';
        icon.className = 'fas fa-eye';
      }
    }

    // =====================================================================
    // SESI & MULTITENAN
    // - Token disimpan di localStorage 'hade_token' lalu dikirim lewat header
    //   'x-sesi-apk' (mekanisme yang sama dengan APK Android). d1-adapter.js tidak diubah:
    //   sebelum handler adapter dipanggil, window.HADE_TOKEN disetel dan callApiJson()
    //   membacanya dari sumber yang sama.
    // - Branding (nama aplikasi, kota, tagline, logo) mengikuti kost aktif.
    // =====================================================================
    const KUNCI_TOKEN = 'hade_token';

    function bacaToken() {
      try { return localStorage.getItem(KUNCI_TOKEN) || null; } catch (e) { return null; }
    }
    function simpanToken(token) {
      try {
        if (token) localStorage.setItem(KUNCI_TOKEN, token);
        else localStorage.removeItem(KUNCI_TOKEN);
      } catch (e) { /* Mode privat / WebView ketat: sesi tetap jalan lewat cookie */ }
    }
    /** Setel token sebelum handler adapter dipanggil + bersihkan cache datanya. */
    function siapkanToken() {
      window.HADE_TOKEN = bacaToken() || '';
    }
    // Dipanggil juga oleh jembatan adapter (lihat akhir berkas) sebelum tiap handler.
    window.__siapkanToken = siapkanToken;
    function headerSesi(extra) {
      const h = Object.assign({}, extra || {});
      const token = bacaToken();
      if (token) h['x-sesi-apk'] = token;
      return h;
    }
    /**
     * Panggil API langsung (bukan lewat adapter). Dipakai untuk rute multitenan yang
     * belum ada di d1-adapter.js: /login, /pilih-kost, /parameter, /parameter/logo,
     * /master/kost. Adapter tetap dipakai untuk semua data operasional.
     */
    async function callApiJson(path, body, metode) {
      let method = metode || (body === undefined ? 'GET' : 'POST');
      const res = await fetch('/api' + path, {
        method,
        headers: method === 'GET' ? headerSesi({}) : headerSesi({ 'content-type': 'application/json' }),
        credentials: 'same-origin',
        body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body),
      });
      let payload = null;
      try { payload = await res.json(); } catch (e) { /* balasan bukan JSON */ }
      if (!res.ok) {
        const err = new Error((payload && payload.error) || `Server membalas ${res.status}.`);
        err.status = res.status;
        throw err;
      }
      return payload;
    }

    /** Tangkap token dari balasan login/sesi (bisa di d.token atau d.data.token). */
    function ambilToken(hasil) {
      if (!hasil) return null;
      const t = hasil.token || (hasil.data && hasil.data.token);
      return t || null;
    }

    /** "Hade Kost 2" -> "hade-kost-2" (kode aplikasi untuk pilihan login). */
    function kunciDariNama(nama) {
      return String(nama || '').toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }

    function isMaster() { return !!(activeUser && (activeUser.role === 'master' || activeUser.role === 'Master')); }
    function isAdminAtauMaster() {
      if (!activeUser) return false;
      const r = String(activeUser.role || '').toLowerCase();
      return r === 'admin' || r === 'master' || r === 'administrator';
    }

    // ---------------- BRANDING ----------------
    /** Terapkan identitas kost ke layar login dan header aplikasi. */
    function terapkanBranding(kost) {
      // kost kosong -> pakai teks bawaan halaman
      const k = kost && (kost.kunci || kost.namaApp) ? kost : null;
      const namaApp = (k && k.namaApp) || 'Kost Hade';
      const kota = k && k.kota ? String(k.kota) : '';
      const tagline = (k && k.tagline) || 'Guesthouse Management Premium';

      // CATATAN: jangan pernah menulis el.style.display di sini. body.className berganti
      // setelah branding diterapkan, dan inline style akan mengalahkan aturan role di CSS.
      const setTeks = (id, teks) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerText = teks;
        el.classList.toggle('hidden', !teks);
      };
      setTeks('login-nama-app', namaApp);
      setTeks('login-kota', kota.toUpperCase());
      setTeks('login-tagline', tagline);
      setTeks('header-nama-app', namaApp);
      setTeks('header-kota', kota.toUpperCase());
      // Tagline hanya di layar lebar supaya header sidebar HP tetap ringkas
      const hTag = document.getElementById('header-tagline');
      if (hTag) {
        hTag.innerText = tagline;
        hTag.classList.toggle('hidden', !tagline);
        hTag.classList.toggle('md:block', !!tagline);
      }
      if (!kota) {
        const hk = document.getElementById('header-kota');
        if (hk) hk.innerText = '';
        const lk = document.getElementById('login-kota');
        if (lk) lk.classList.add('hidden');
      }

      // Logo: /api/logo butuh kunci logo DAN kunci kost (kunci kost tetap disertakan;
      // server yang hanya butuh salah satunya tetap bisa melayani karena sisanya diabaikan).
      // Cadangan memakai ikon lokal — TIDAK memanggil layanan luar, karena kalau layanan itu
      // diblokir img.onerror berantai terus dan logo akhirnya hanya teks alt.
      const CADANGAN_LOGO = '/ikon-192.png';
      const urlLogo = k && k.logoKunci
        ? '/api/logo?kunci=' + encodeURIComponent(k.logoKunci)
          + (k.kunci ? '&kost=' + encodeURIComponent(k.kunci) : '')
        : null;
      ['login-logo', 'header-logo'].forEach((id) => {
        const img = document.getElementById(id);
        if (!img) return;
        img.onerror = function () { this.onerror = null; this.src = CADANGAN_LOGO; };
        if (urlLogo) {
          img.src = urlLogo;
        } else {
          // Belum ada logo di server: pakai logo bawaan berkas lokal
          img.src = 'logo-hade.jpg';
        }
      });

      // Judul tab browser
      document.title = namaApp + ' — ' + tagline;

      // Pratinjau di menu Parameter
      const prev = document.getElementById('param-logo-preview');
      if (prev) prev.src = urlLogo || '';
      const info = document.getElementById('param-info-kost');
      if (info && k) {
        info.innerText = 'Kost aktif: ' + namaApp + ' (' + (k.kunci || '-') + ')'
          + (kota ? ' — ' + kota : '');
      }
    }

    // ---------------- LOGIN ----------------
    /**
     * POST /api/login. Body menyertakan `kost` (kode/nama aplikasi) bila diisi.
     * Rute ini dipanggil langsung (bukan lewat HADE.login) supaya field `kost` ikut terkirim
     * tanpa mengubah d1-adapter.js.
     */
    function loginAkun(username, password, kodeKost, ingat) {
      const badan = { username, password, ingat: !!ingat };
      if (kodeKost) badan.kost = kodeKost;
      return callApiJson('/login', badan);
    }

    function setTombolLogin(sibuk) {
      const btn = document.querySelector('#form-login button[type="submit"]');
      if (!btn) return;
      btn.disabled = !!sibuk;
      btn.innerHTML = sibuk
        ? '<i class="fas fa-circle-notch fa-spin"></i> Memverifikasi...'
        : '<i class="fas fa-sign-in-alt"></i> Masuk Sistem';
    }

    function handleLoginSubmit(event) {
      // Form ini hanya boleh dikirim lewat tombol submit / Enter — bukan dari peristiwa
      // `input` (dulu: mendeteksi autofill). Bug nyata: setiap karakter yang diketik di kolom
      // No. HP naik ke <form> sebagai `input`, lalu handler global memperlakukannya sebagai
      // submit → API dipanggil dengan nomor setengah jadi ("0") → modal "Akses Ditolak"
      // muncul sebelum pengguna menekan tombol Masuk.
      if (event && event.type && event.type !== 'submit') {
        // Jangan react ke klik yang naik dari kontrol isian (checkbox, tombol, dsb.):
        // event itu bukan submit form. preventDefault() di sini membuat checkbox "ingat saya"
        // tidak bisa dicentang/dibuang. Hanya event submit yang diproses.
        return;
      }
      if (event && event.cancelable) event.preventDefault();
      const elU = document.getElementById('login-username');
      const elP = document.getElementById('login-password');
      if (!elU || !elP) return false;
      const uName = (elU.value || '').trim();
      const pWord = elP.value || '';
      if (!uName && !pWord) {
        setTombolLogin(false);
        return false;
      }
      // Tanpa nomor HP sama sekali (mis. sandi terisi autofill, kolom nomor masih kosong):
      // beri tahu sekali, jangan kirim ke API.
      if (!uName) {
        setTombolLogin(false);
        elU.focus();
        elU.classList.add('ring-2', 'ring-rose-400');
        setTimeout(() => elU.classList.remove('ring-2', 'ring-rose-400'), 2000);
        showCustomAlert('Nomor HP Kosong', 'Isi No. HP yang terdaftar lebih dulu, contoh 081234567890.', false);
        return false;
      }
      // Sudah ada isinya tapi belum tampak seperti nomor HP: tandai kolomnya, tetap kirim
      // supaya pesan dari server (yang tahu aturan persisnya) tetap tampil.
      if (!hampirNomorHp(uName)) {
        elU.classList.add('ring-2', 'ring-rose-400');
        setTimeout(() => elU.classList.remove('ring-2', 'ring-rose-400'), 2000);
      }
      // Kost TIDAK lagi wajib diketik: utamakan kolom (bila dibuka), lalu ?kost= dari tautan.
      // Kalau kosong, server memakai kost milik akun (username unik).
      const kodeKost = ((document.getElementById('login-kost') || {}).value || '').trim()
        || sessionStorage.getItem('hade_kost_url') || '';

      setTombolLogin(true);

      // Token lama jangan ikut terkirim saat login akun lain
      simpanToken(null);
      window.HADE_TOKEN = '';
      if (window.HADE) window.HADE.resetCache();

      const ingat = !!(document.getElementById('login-ingat') || {}).checked;
      loginAkun(uName, pWord, kodeKost || null, ingat)
        .then((hasil) => {
          const token = ambilToken(hasil);
          if (token) { simpanToken(token); window.HADE_TOKEN = token; }
          if (hasil && hasil.perluPilihKost) {
            // Akun ada di beberapa kost: pilih dulu, baru buka sesi
            daftarKostPilih = hasil.daftarKost || [];
            tampilkanPilihKost(daftarKostPilih);
            return false;
          }
          return lanjutSetelahLogin();
        })
        .catch(err => {
          window.HADE_TOKEN = '';
          showCustomAlert("Akses Ditolak", err.message || "Login gagal.", false);
        })
        .finally(() => setTombolLogin(false));
    }

    /**
     * Cek longgar: apakah isian ini "sedang diketik sebagai nomor HP"?
     * Dipakai hanya untuk mencegah kiriman ke server saat kolom belum berisi apa pun.
     * Validasi ketat tetap di server (logic.miripNomorHp) — format diterima di sini harus
     * mencakup semua bentuk yang diterima server: 0812…, 62812…, +62 812…, 0812-3456-7890.
     */
    function hampirNomorHp(nilai) {
      const t = String(nilai || '').replace(/[\s\-().]/g, '');
      return /^(\+?62|0)8\d{6,}$/.test(t);
    }

    /** Ambil sesi (user + kost), terapkan branding, masuk aplikasi. */
    function lanjutSetelahLogin() {
      return HADE.session()
        .then(sess => {
          if (!sess || !sess.logged_in) throw new Error('Akun belum memiliki profil. Hubungi admin.');
          const token = ambilToken(sess);
          if (token) simpanToken(token);
          // Password awal wajib diganti sebelum masuk aplikasi (dijaga juga oleh API).
          // Admin/staff wajib mengganti sandi awal. Master (pemilik sistem) langsung masuk —
          // sesuai aturan API: akun master tidak dikunci oleh sandi awal, dan tetap bisa
          // mengganti sandi lewat menu akun.
          if (sess.user && sess.user.must_change_password && sess.user.role !== 'master') {
            return tuntutGantiPassword(sess.user);
          }
          masukAplikasi(sess);
          return true;
        });
    }

    /** Tampilkan aplikasi untuk sesi yang sudah sah. */
    function masukAplikasi(sess) {
      activeUser = sess.user;
      activeKost = sess.kost || null;
      usersList = [sess.user];
      terapkanBranding(activeKost);
      document.getElementById('login-screen').classList.add('hidden');
      document.getElementById('app-container').classList.remove('hidden');
      document.getElementById('app-container').classList.add('flex');
      tutupPilihKost();
      applyUserRoleUI();
      refreshCategoryOptions();
      showSection('dashboard', document.querySelector('#sidebar-nav button'));
    }

    // ---------------- PILIH KOST ----------------
    function tampilkanPilihKost(daftar) {
      const wadah = document.getElementById('daftar-pilih-kost');
      const modal = document.getElementById('modal-pilih-kost');
      const isi = daftar || [];
      wadah.innerHTML = isi.length
        ? isi.map((k, i) => {
            const ket = [k.kota, k.tagline].filter(Boolean).join(' • ');
            return `<button type="button" data-aksi="pilih-kost" data-kunci="${esc(k.kunci || '')}" data-idx="${i}"
              class="w-full text-left px-4 py-3 rounded-xl border border-slate-200 hover:border-blue-400 hover:bg-blue-50 transition flex items-center justify-between gap-3">
              <span class="min-w-0">
                <span class="block text-sm font-bold text-slate-800 truncate">${esc(k.namaApp || k.kunci || '-')}</span>
                <span class="block text-[10px] text-slate-400 truncate">${esc(ket || k.kunci || '')}</span>
              </span>
              <i class="fas fa-chevron-right text-xs text-slate-400"></i>
            </button>`;
          }).join('')
        : '<p class="text-xs text-slate-400 text-center py-4">Belum ada kost yang bisa dipilih.</p>';
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      setTombolLogin(false);
    }

    function tutupPilihKost() {
      const modal = document.getElementById('modal-pilih-kost');
      if (!modal) return;
      modal.classList.remove('flex');
      modal.classList.add('hidden');
    }

    function batalkanPilihKost() {
      tutupPilihKost();
      daftarKostPilih = [];
      simpanToken(null);
      window.HADE_TOKEN = '';
      if (window.HADE) window.HADE.logout().catch(() => {});
      setTombolLogin(false);
    }

    /** Klik salah satu kost di modal -> set kost aktif sesi -> masuk aplikasi. */
    async function pilihKostLaluMasuk(kunci) {
      if (!kunci) return;
      showLoading(true);
      try {
        // /api/pilih-kost hanya POST; token sesi ikut lewat header x-sesi-apk
        const hasil = await callApiJson('/pilih-kost', { kunci });
        const token = ambilToken(hasil);
        if (token) { simpanToken(token); window.HADE_TOKEN = token; }

        daftarKostPilih = [];
        if (window.HADE) window.HADE.resetCache();
        cachedData = null;
        await lanjutSetelahLogin();      // bila masih wajib ganti password, error dilempar ke catch
      } catch (err) {
        showCustomAlert("Gagal Masuk", (err && err.message) || 'Kost gagal dipilih.', false);
      } finally {
        showLoading(false);
      }
    }
    daftarAksi('pilih-kost', (d) => pilihKostLaluMasuk(d.kunci));

    /**
     * Password awal (dibuat admin / tools/buat-akun.mjs) wajib diganti saat login pertama.
     * Mengembalikan Promise yang selesai setelah password berhasil diganti, sehingga alur
     * login bisa menunggu; bila pengguna membatalkan, sesi diakhiri (logout).
     */
    function tuntutGantiPassword(user) {
      return new Promise((resolve, reject) => {
        const baru = window.prompt(`Halo ${user.fullname || user.username}.\nPassword awal Anda wajib diganti sebelum memakai aplikasi.\n\nMasukkan password baru (minimal 8 karakter):`);
        if (baru === null) {
          HADE.logout().catch(() => {});
          reject(new Error('Password belum diganti. Login dibatalkan.'));
          return;
        }
        if (String(baru).length < 8) {
          HADE.logout().catch(() => {});
          reject(new Error('Password baru minimal 8 karakter. Silakan login ulang.'));
          return;
        }
        const ulang = window.prompt('Ulangi password baru:');
        if (ulang !== baru) {
          HADE.logout().catch(() => {});
          reject(new Error('Ulangi password tidak sama. Silakan login ulang.'));
          return;
        }
        // Password awal tidak diketahui pengguna? Ia baru saja memakainya untuk login,
        // tapi agar tidak menahannya, minta password lama sekali lagi bila perlu.
        const lama = window.prompt('Masukkan password awal (yang baru saja dipakai):');
        if (lama === null) {
          HADE.logout().catch(() => {});
          reject(new Error('Password belum diganti. Login dibatalkan.'));
          return;
        }
        HADE.handlers.gantiPassword(lama, baru)
          .then((r) => {
            showCustomAlert('Password Diganti', (r && r.message) || 'Password berhasil diganti. Silakan masuk lagi.', true);
            HADE.logout().catch(() => {});
            reject(new Error('Password berhasil diganti. Silakan login ulang.'));
          })
          .catch((e) => reject(new Error((e && e.message) || 'Password gagal diganti.')));
      });
    }

    function handleLogout() {
      if (window.HADE) { HADE.logout().catch(() => {}); HADE.resetCache(); }
      cachedData = null;
      activeUser = null;
      usersList = [];
      // Token multitenan ikut dibuang supaya sesi berikutnya memakai akun/kost baru
      simpanToken(null);
      window.HADE_TOKEN = '';
      document.getElementById('form-login').reset();
      document.getElementById('login-password').type = 'password';
      document.getElementById('toggle-password-icon').className = 'fas fa-eye';
      document.getElementById('login-screen').classList.remove('hidden');
      document.getElementById('app-container').classList.add('hidden');
      document.getElementById('app-container').classList.remove('flex');
    }


    // USER SESSIONS MANAGEMENT & INITIALIZATION
    /** Tulis status ke layar login supaya pengguna tahu aplikasi terhenti di mana. */
    /** Aktifkan mode aman HANYA bila CSS Tailwind lokal gagal dimuat.
     *  Dulu deteksinya memakai variabel global dari CDN Tailwind. Sejak Tailwind dibangun
     *  lokal, CDN sudah tidak dipakai — pemeriksaan lama selalu menganggap Tailwind tidak
     *  ada, sehingga mode aman aktif terus dan #login-screen dipaksa position:static
     *  (kartu login terdorong ke bawah, layar tampak putih kosong).
     *  Pemeriksaan sengaja memakai kelas KHUSUS di elemen sementara: kelas yang dipakai
     *  Tailwind tidak boleh ditimpa aturan display di blok <style> halaman ini. */
    function tailwindSiap() {
      let probe = null;
      try {
        probe = document.createElement('div');
        probe.className = 'hidden probe-ui-hade';
        document.body.appendChild(probe);
        if (getComputedStyle(probe).display !== 'none') return false;   // .hidden tidak berlaku
        probe.className = 'probe-ui-hade-fleks';
        return getComputedStyle(probe).display === 'flex';              // Tailwind.css termuat?
      } catch (e) {
        return false;
      } finally {
        if (probe && probe.parentNode) probe.parentNode.removeChild(probe);
      }
    }
    function pasangModeAman() {
      document.body.classList.toggle('tanpa-tailwind', !tailwindSiap());
    }
    if (document.readyState !== 'loading') pasangModeAman();
    else document.addEventListener('DOMContentLoaded', pasangModeAman);

    function statusLanjut(teks) {
      const el = document.getElementById('status-lanjut');
      if (el) el.innerText = teks;
    }

    function initUserSession() {
      statusLanjut('Menghubungkan ke server…');
      // Tautan khusus kost: /?kost=kost-melati -> kolom kode langsung terisi & terlihat
      const kostUrl = bacaKostDariUrl();
      if (kostUrl) {
        const g = document.getElementById('grup-login-kost');
        const i = document.getElementById('login-kost');
        if (g) g.classList.remove('hidden');
        if (i) i.value = kostUrl;
      }
      if (!tailwindSiap()) { pasangModeAman(); statusLanjut('Tampilan sederhana (berkas tampilan tidak termuat). Menghubungkan…'); }
      if (!window.HADE) {
        statusLanjut('Komponen aplikasi tidak termuat (d1-adapter.js). Muat ulang halaman.');
        document.getElementById('login-setup-hint').classList.remove('hidden');
        document.getElementById('login-screen').classList.remove('hidden');
        document.getElementById('app-container').classList.add('hidden');
        document.getElementById('app-container').classList.remove('flex');
        return;
      }
      HADE.session().then(sess => {
        statusLanjut(sess && sess.logged_in ? 'Memuat data…' : 'Server siap. Silakan masuk.');
        // Token dari sesi terbaru disimpan (berguna setelah APK/pindah tab)
        const tokenBaru = ambilToken(sess);
        if (tokenBaru) { simpanToken(tokenBaru); window.HADE_TOKEN = tokenBaru; }
        if (!sess || !sess.logged_in) {
          // Belum masuk: tampilkan branding kost aktif bila server sudah menentukannya
          terapkanBranding(sess && sess.kost);
          document.getElementById('login-screen').classList.remove('hidden');
          document.getElementById('app-container').classList.add('hidden');
          document.getElementById('app-container').classList.remove('flex');
          return;
        }
        siapkanToken();
        masukAplikasi(sess);
        loadDashboard();
      }).catch(err => {
        console.warn('[hade] sesi', err);
        statusLanjut('Tidak bisa menghubungi server. Periksa internet lalu muat ulang.');
        document.getElementById('login-screen').classList.remove('hidden');
        document.getElementById('app-container').classList.add('hidden');
      });

    }

    // Apply permissions dynamically on the UI
    // Tiga tingkat: user (operasional), admin (kost), master (semua kost).
    // Kelas pada <body> dipakai CSS untuk menyembunyikan menu:
    //   .role-user   -> menu User/Parameter/Reset/Kost tersembunyi
    //   .role-admin  -> Parameter & User terlihat, Reset & Kost tersembunyi
    //   .role-master -> semua menu terlihat
    function applyUserRoleUI() {
      const body = document.body;
      const role = String((activeUser && activeUser.role) || '').toLowerCase();
      const isMasterRole = role === 'master';
      const isAdminRole = role === 'admin' || role === 'administrator';
      const isUser = !isMasterRole && !isAdminRole;
      const kelasDasar = 'bg-slate-50 text-slate-800 overflow-hidden h-screen w-screen m-0 p-0 flex flex-col md:flex-row';

      // Toggle root role class
      body.className = kelasDasar + (isMasterRole ? ' role-master' : (isAdminRole ? ' role-admin' : ' role-user'));

      const labelRole = isMasterRole ? 'Master Sistem' : (isAdminRole ? 'Administrator' : 'User Operasional');
      // Update sidebar session details
      document.getElementById('user-display-name').innerText = activeUser.fullname;
      document.getElementById('user-display-role').innerText = labelRole;
      document.getElementById('user-display-icon').className = isUser
        ? 'fas fa-user-circle text-xs text-blue-500'
        : 'fas fa-user-shield text-xs text-rose-500';

      // Pisahkan tombol ganti user (simulasi lama) — sekarang hanya info akun + logout
      const switcherContainer = document.getElementById('quick-user-options');
      switcherContainer.innerHTML = `
        <div class="px-3 py-2 text-xs font-semibold text-slate-600">
          <div class="truncate">${activeUser.fullname}</div>
          <div class="text-[10px] text-slate-400">@${esc(activeUser.username || '-')} • ${esc(labelRole)}</div>
        </div>
        <button data-h="openGantiPassword" class="w-full text-left px-3 py-2 rounded-lg hover:bg-blue-50 text-blue-600 flex items-center gap-2 text-xs font-semibold transition">
          <i class="fas fa-key text-[10px]"></i> Ganti Password
        </button>
        <button data-h="handleLogout" class="w-full text-left px-3 py-2 rounded-lg hover:bg-rose-50 text-rose-600 flex items-center gap-2 text-xs font-semibold transition">
          <i class="fas fa-sign-out-alt text-[10px]"></i> Keluar / Logout
        </button>`;
    }

    // Ganti password sendiri (dulu tidak ada jalan sama sekali selain sentuh database)
    async function openGantiPassword() {
      const lama = window.prompt('Password saat ini:');
      if (lama === null) return;
      const baru = window.prompt('Password baru (minimal 8 karakter):');
      if (baru === null) return;
      if (String(baru).length < 8) { showCustomAlert('Password Terlalu Pendek', 'Password baru minimal 8 karakter.', false); return; }
      const ulang = window.prompt('Ulangi password baru:');
      if (ulang !== baru) { showCustomAlert('Tidak Cocok', 'Ulangi password tidak sama.', false); return; }
      showLoading(true);
      try {
        const r = await HADE.handlers.gantiPassword(lama, baru);
        showCustomAlert('Berhasil', r.message || 'Password diganti.', true);
      } catch (err) {
        showCustomAlert('Gagal', err.message || 'Password gagal diganti.', false);
      } finally { showLoading(false); }
    }

    // Pemetaan tombol tabel -> fungsi yang sudah ada
    daftarAksi('bukti', (d) => {
      const url = HADE.handlers.urlBukti(d.bukti);
      if (url) window.open(url, '_blank', 'noopener');
    });
    daftarAksi('struk', (d) => viewReceipt(d.tgl, d.nama, d.kamar, Number(d.jumlah || 0), d.ket, d.struk || d.no));
    daftarAksi('edit-kamar', (d) => openEditRoomModal(d.no, d.tipe, d.bulanan, d.harian));
    daftarAksi('hapus-kamar', (d) => promptDeleteRoom(d.no, d.status));
    daftarAksi('edit-penyewa', (d) => openEditTenantModal(d.kode, d.nama, d.hp, d.kamar, d.masuk, d.status, d.tempo));
    daftarAksi('hapus-penyewa', (d) => promptDeleteTenant(d.kode, d.nama, d.kamar, d.status));
    daftarAksi('checkout', (d) => promptTenantCheckout(d.kode, d.nama, d.kamar));
    daftarAksi('pindah-kamar', (d) => bukaPindahKamar(d.kode, d.nama, d.kamar));
    daftarAksi('bayar-cepat', (d) => quickPayPort(d.nama, d.kamar));
    daftarAksi('void-ledger', (d) => promptDeleteOpsTransaction(d.id, d.ket));
    daftarAksi('wa-pengingat', (d) => kirimPengingatWa(d.bill));
    daftarAksi('edit-user', (d) => startEditUser(d.id, d.username, d.fullname, d.role, d.hp));
    daftarAksi('hapus-user', (d) => promptDeleteUser(d.id, d.fullname, d.username));
    daftarAksi('edit-kategori', (d) => startEditCategory(d.id, d.jenis, d.nama, d.saldo));
    daftarAksi('hapus-kategori', (d) => promptDeleteCategory(d.id, d.nama));

    // Toggle simulator user sessions menu
    function toggleUserDropdown(event) {
      event.stopPropagation();
      const dropdown = document.getElementById('quick-user-dropdown');
      const chevron = document.getElementById('user-display-chevron');
      dropdown.classList.toggle('hidden');
      chevron.classList.toggle('rotate-180');
    }

    // Close dropdowns on outer click
    document.addEventListener('click', () => {
      const dropdown = document.getElementById('quick-user-dropdown');
      const chevron = document.getElementById('user-display-chevron');
      if (dropdown && !dropdown.classList.contains('hidden')) {
        dropdown.classList.add('hidden');
        chevron.classList.remove('rotate-180');
      }
    });

    // Ganti user tanpa otentikasi DIHAPUS — ini celah eskalasi privilege (siapa pun bisa jadi Admin).


    // Sesi berakhir di tengah pemakaian -> kembali ke layar login
    window.onSesiBerakhir = () => {
      cachedData = null;
      activeUser = null;
      activeKost = null;
      simpanToken(null);          // token multitenan sudah tidak berlaku
      window.HADE_TOKEN = '';
      document.getElementById('login-screen').classList.remove('hidden');
      document.getElementById('app-container').classList.add('hidden');
      showCustomAlert("Sesi Berakhir", "Anda sudah keluar atau sesi habis. Silakan login ulang.", false);
    };

    // Inisialisasi sesi; tunggu DOM siap bila skrip berjalan terlalu awal
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initUserSession);
    } else {
      initUserSession();
    }

    // CUSTOM ALERT SYSTEM WITH SUCCESS/ERROR/CONFIRM FLAVORS
    function showCustomAlert(title, message, isSuccess = true, isConfirm = false, onConfirm = null) {
      const modal = document.getElementById('custom-modal');
      const icon = document.getElementById('modal-icon');
      const tElement = document.getElementById('modal-title');
      const mElement = document.getElementById('modal-message');
      const decor = document.getElementById('modal-decor');
      const cancelBtn = document.getElementById('modal-cancel-btn');
      const confirmBtn = document.getElementById('modal-confirm-btn');

      tElement.innerText = title;
      mElement.innerText = message;
      modalConfirmCallback = onConfirm;

      if (isConfirm) {
        decor.className = "absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-blue-600 to-rose-600";
        icon.className = "w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl bg-blue-50 text-blue-500 border border-blue-100 shadow-inner";
        icon.innerHTML = '<i class="fas fa-exclamation-triangle text-rose-500"></i>';
        cancelBtn.classList.remove('hidden');
        confirmBtn.className = "flex-1 bg-gradient-to-r from-blue-600 to-rose-600 text-white py-3 px-4 rounded-xl font-bold hover:from-blue-700 hover:to-rose-700 transition shadow-lg shadow-blue-500/20";
        confirmBtn.innerText = "Konfirmasi";
      } else if (isSuccess) {
        decor.className = "absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-emerald-500 to-teal-500";
        icon.className = "w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl bg-emerald-50 text-emerald-600 border border-emerald-100 shadow-inner";
        icon.innerHTML = '<i class="fas fa-check-circle"></i>';
        cancelBtn.classList.add('hidden');
        confirmBtn.className = "flex-1 bg-slate-800 text-white py-3 px-4 rounded-xl font-bold hover:bg-slate-900 transition";
        confirmBtn.innerText = "OK";
      } else {
        decor.className = "absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-rose-500 to-rose-600";
        icon.className = "w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl bg-rose-50 text-rose-500 border border-rose-100 shadow-inner";
        icon.innerHTML = '<i class="fas fa-times-circle"></i>';
        cancelBtn.classList.add('hidden');
        confirmBtn.className = "flex-1 bg-slate-800 text-white py-3 px-4 rounded-xl font-bold hover:bg-slate-900 transition";
        confirmBtn.innerText = "OK";
      }

      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }

    function closeModal() {
      const modal = document.getElementById('custom-modal');
      modal.classList.remove('flex');
      modal.classList.add('hidden');
      // tombol Batal / X WAJIB membatalkan aksi — dulu callback tetap tersimpan dan
      // ikut jalan saat tombol OK modal berikutnya diklik.
      modalConfirmCallback = null;
    }

    // Modal Confirmation Execution Hook
    // Satu-satunya jalur klik OK. Jangan menambah data-h="closeModal()" pada tombol ini:
    // closeModal() mengosongkan callback lebih dulu sehingga aksi (checkout, hapus, dst) tidak pernah jalan.
    document.getElementById('modal-confirm-btn').addEventListener('click', () => {
      const cb = modalConfirmCallback;
      modalConfirmCallback = null;
      closeModal();
      if (typeof cb === 'function') {
        try { cb(); } catch (err) { handleError(err); }
      }
    });

    function showLoading(show) { 
      const loader = document.getElementById('loading');
      if (show) {
        loader.classList.remove('hidden');
        clearTimeout(loadingTimeout);
        loadingTimeout = setTimeout(() => {
          if (!loader.classList.contains('hidden')) {
            loader.classList.add('hidden');
            showCustomAlert("Koneksi Lambat", "Server lambat merespons. Periksa koneksi internet Anda, lalu coba lagi.", false);
          }
        }, 12000);
      } else {
        loader.classList.add('hidden');
        clearTimeout(loadingTimeout);
      }
    }

    function handleError(e) {
      showLoading(false);
      // jembatan HADE meneruskan pesan galat sebagai string biasa, bukan objek Error
      const pesan = e && e.message ? e.message : String(e === undefined || e === null ? 'Terjadi kesalahan.' : e);
      showCustomAlert("Gagal", pesan, false);
    }

    function toggleRoomForm() { 
      document.getElementById('room-form-container').classList.toggle('hidden'); 
    }

    // POPULATE CATEGORY DROPDOWN DYNAMICALLY
    function handleTransTypeChange() {
      // isi dari cache dulu (sinkron), baru segarkan dari server di belakang
      isiKategoriTransaksi();
      const kunci = document.getElementById('trans-jenis').value;
      if (!(categoryOptions[kunci] || []).length) refreshCategoryOptions();
    }

    // SUB-TAB TRANS-OPS SWITCHER
    function switchOpsSubTab(subTab) {
      document.getElementById('subops-ledger-container').classList.add('hidden');
      document.getElementById('subops-kategorisasi-container').classList.add('hidden');
      
      document.getElementById('tab-subops-ledger').className = "flex-1 py-2.5 text-xs font-extrabold text-slate-500 hover:text-slate-800 rounded-xl transition-all";
      document.getElementById('tab-subops-kategorisasi').className = "flex-1 py-2.5 text-xs font-extrabold text-slate-500 hover:text-slate-800 rounded-xl transition-all";

      if (subTab === 'ledger') {
        document.getElementById('subops-ledger-container').classList.remove('hidden');
        document.getElementById('tab-subops-ledger').className = "flex-1 py-2.5 text-xs font-extrabold rounded-xl bg-gradient-to-r from-blue-600 to-rose-600 text-white shadow-md transition-all";
        loadLedgerData();
      } else if (subTab === 'kategorisasi') {
        document.getElementById('subops-kategorisasi-container').classList.remove('hidden');
        document.getElementById('tab-subops-kategorisasi').className = "flex-1 py-2.5 text-xs font-extrabold rounded-xl bg-gradient-to-r from-blue-600 to-rose-600 text-white shadow-md transition-all";
        loadCategoriesData();
      }
    }

    function showSection(sectionId, btn) {
      // Penjaga akses per role: sesudah login menu memang sudah disembunyikan CSS,
      // tetapi pemanggilan langsung (mis. dari tombol lain) tetap harus ditolak.
      if (!activeUser) return;
      if (sectionId === 'reset' && !isMaster()) {
        showCustomAlert("Akses Ditolak", "Menu Reset hanya tersedia untuk akun master.", false);
        return;
      }
      if (sectionId === 'kost' && !isMaster()) {
        showCustomAlert("Akses Ditolak", "Menu Kost hanya tersedia untuk akun master.", false);
        return;
      }
      if ((sectionId === 'user' || sectionId === 'parameter') && !isAdminAtauMaster()) {
        showCustomAlert("Akses Ditolak", "Maaf, User Operasional tidak diberikan izin mengakses modul manajemen sensitif.", false);
        return;
      }

      document.querySelectorAll('.content-section').forEach(s => s.classList.add('hidden'));
      document.getElementById('sec-' + sectionId).classList.remove('hidden');
      
      document.querySelectorAll('#sidebar-nav button').forEach(b => b.classList.remove('nav-btn-active'));
      if(btn) btn.classList.add('nav-btn-active');
      
      // Auto-load related dependencies based on selection
      if(sectionId === 'penyewa') {
        loadAvailableRooms();
        loadAllTenantsList();
      }
      if(sectionId === 'pembayaran') {
        muatPengingat();
        const tgl = document.getElementById('input-tgl-pembayaran');
        if (tgl && !tgl.value) tgl.value = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD lokal
        loadActiveTenants();
        loadPaymentsHistory();
      }
      if(sectionId === 'transaksi-ops') {
        // Default values for Transaction page
        document.getElementById('trans-tanggal').value = new Date().toISOString().split('T')[0];
        switchOpsSubTab('ledger');
        handleTransTypeChange();
      }
      if(sectionId === 'dashboard') {
        loadDashboard();
      }
      if(sectionId === 'kamar') {
        loadDashboard(); // Refresh kamar structure
      }
      if(sectionId === 'laporan') {
        generateSelectedReport();
      }
      if(sectionId === 'user') {
        loadUsersData();
      }
      if(sectionId === 'parameter') {
        isiFormParameter();
      }
      if(sectionId === 'kost') {
        muatDaftarKost();
      }
    }

    function syncData() {
      cachedData = null;
      loadDashboard();
      showCustomAlert("Sinkronisasi Sukses", "Data terbaru sudah dimuat.", true);
    }

    function loadDashboard() {
      if (cachedData) {
        renderDashboard(cachedData);
        return;
      }
      showLoading(true);
      google.script.run
        .withFailureHandler(handleError)
        .withSuccessHandler(responseString => {
          cachedData = JSON.parse(responseString);
          cachedData.ops = window.__hadeOps || [];      // [id,tgl,jenis,kategori,jumlah,ket]
          renderDashboard(cachedData);
          showLoading(false);
        }).getDashboardData();
      // muat transaksi ledger lengkap untuk laporan (bentuk array sesuai server)
      if (window.HADE) {
        HADE.handlers.getOpsRows().then(rows => {
          window.__hadeOps = (rows || []).map(r => [r[0], r[1], r[2], r[3], String(r[4]), r[5] || '']);
          if (cachedData) { cachedData.ops = window.__hadeOps; }
        }).catch(err => console.warn('[hade] ledger', err));
      }
    }

    // FINANCIAL REPORTS TAB SWITCHER & CALCULATOR
    function switchReportTab(reportType) {
      activeReportTab = reportType;
      
      document.querySelectorAll('#sec-laporan button[id^="tab-rep-"]').forEach(btn => {
        btn.classList.remove('bg-gradient-to-r', 'from-blue-600', 'to-rose-600', 'text-white', 'shadow-md');
        btn.classList.add('text-slate-500', 'hover:text-slate-800');
      });
      
      const activeBtn = document.getElementById('tab-rep-' + reportType);
      if (activeBtn) {
        activeBtn.classList.remove('text-slate-500', 'hover:text-slate-800');
        activeBtn.classList.add('bg-gradient-to-r', 'from-blue-600', 'to-rose-600', 'text-white', 'shadow-md');
      }
      generateSelectedReport();
    }

    // Date parsing helper to extract standard JavaScript Date Month and Year indices
    function parseDateObj(dateStr) {
      if (!dateStr) return { month: 0, year: 0 };
      let dParts = [];
      if (dateStr.includes('/')) {
        dParts = dateStr.split('/');
        return { month: parseInt(dParts[1]) || 0, year: parseInt(dParts[2]) || 0 };
      } else if (dateStr.includes('-')) {
        dParts = dateStr.split('-');
        if (dParts[0].length === 4) {
          // YYYY-MM-DD
          return { month: parseInt(dParts[1]) || 0, year: parseInt(dParts[0]) || 0 };
        } else {
          // DD-MM-YYYY
          return { month: parseInt(dParts[1]) || 0, year: parseInt(dParts[2]) || 0 };
        }
      }
      return { month: 0, year: 0 };
    }

    function generateSelectedReport() {
      const selMonth = parseInt(document.getElementById('filter-laporan-bulan').value);
      const selYear = parseInt(document.getElementById('filter-laporan-tahun').value);
      const targetDiv = document.getElementById('financial-report-content');

      if (!cachedData) {
        // buka menu Laporan langsung setelah login: muat dulu, lalu render ulang
        targetDiv.innerHTML = '<div class="py-16 text-center text-slate-400 text-sm italic">Memuat data laporan…</div>';
        loadDashboard();
        return;
      }

      // Array dari server: [id, tanggal, jenis, kategori, jumlah, keterangan]
      const tenantPayments = cachedData.transaksi || [];
      const opsTransactions = cachedData.ops || [];
      const rooms = cachedData.kamar || [];
      const tenants = cachedData.penyewa || [];

      // MONTH NAMES ARRAY
      const indonesianMonths = [
        "Januari", "Februari", "Maret", "April", "Mei", "Juni",
        "Juli", "Agustus", "September", "Oktober", "November", "Desember"
      ];

      // FILTER DATA FOR THE SELECTED MONTH & YEAR
      const monthlyTenantPayments = tenantPayments.filter(p => {
        const parsed = parseDateObj(p[0]);
        return parsed.month === selMonth && parsed.year === selYear;
      });

      const monthlyOps = opsTransactions.filter(o => {
        const parsed = parseDateObj(o[1]);
        return parsed.month === selMonth && parsed.year === selYear;
      });

      // CALCULATE ACCUMULATED HISTORICAL CASH BALANCES (for starting balance metrics)
      let cumulativeCashPrior = 0;
      
      // Tenant payments prior
      tenantPayments.forEach(p => {
        const parsed = parseDateObj(p[0]);
        const paymentDate = new Date(parsed.year, parsed.month - 1, 1);
        const targetDate = new Date(selYear, selMonth - 1, 1);
        if (paymentDate < targetDate) {
          cumulativeCashPrior += (Number(String(p[3]).replace(/[^0-9]/g, '')) || 0);
        }
      });

      // Ops ledger prior
      opsTransactions.forEach(o => {
        const parsed = parseDateObj(o[1]);
        const opsDate = new Date(parsed.year, parsed.month - 1, 1);
        const targetDate = new Date(selYear, selMonth - 1, 1);
        if (opsDate < targetDate) cumulativeCashPrior += dampakKas(o);
      });

      // Calculate totals for active selected month
      const activeMonthlyRentIncome = monthlyTenantPayments.reduce((acc, curr) => acc + (Number(String(curr[3]).replace(/[^0-9]/g, '')) || 0), 0);
      const activeMonthlyOpsIncome = monthlyOps.filter(o => o[2] === 'Pendapatan').reduce((acc, curr) => acc + (Number(curr[4]) || 0), 0);
      const activeMonthlyOpsExpenses = monthlyOps.filter(o => o[2] === 'Pengeluaran').reduce((acc, curr) => acc + (Number(curr[4]) || 0), 0);
      
      // Monthly Neraca cash-flow additions
      let activeMonthlyNeracaInflow = 0;
      let activeMonthlyNeracaOutflow = 0;
      monthlyOps.filter(o => o[2] === 'Neraca').forEach(o => {
        const d = dampakKas(o);
        if (d > 0) activeMonthlyNeracaInflow += d;
        else if (d < 0) activeMonthlyNeracaOutflow += -d;
      });

      const totalMonthlyIncome = activeMonthlyRentIncome + activeMonthlyOpsIncome;
      const netMonthlyIncome = totalMonthlyIncome - activeMonthlyOpsExpenses;

      // Total Cashflow for current month
      const totalMonthlyInflow = activeMonthlyRentIncome + activeMonthlyOpsIncome + activeMonthlyNeracaInflow;
      const totalMonthlyOutflow = activeMonthlyOpsExpenses + activeMonthlyNeracaOutflow;
      const netMonthlyCashFlow = totalMonthlyInflow - totalMonthlyOutflow;

      // Cumulative Cash up to END of current month
      const cumulativeCashEnd = cumulativeCashPrior + netMonthlyCashFlow;

      if (activeReportTab === 'rugi-laba') {
        // --- 1. LAPORAN RUGI LABA ---
        // Group Expenses by Categories — dari transaksi itu sendiri, supaya kategori baru
        // (yang belum ada di cache) tetap muncul di barisnya sendiri, bukan dilempar ke "Lain-lain".
        const expenseGroups = {};
        categoryOptions.Pengeluaran.forEach(cat => expenseGroups[cat.nama] = 0);
        monthlyOps.filter(o => o[2] === 'Pengeluaran').forEach(o => {
          const nama = o[3] || 'Biaya Lain-lain';
          expenseGroups[nama] = (expenseGroups[nama] || 0) + (Number(o[4]) || 0);
        });
        // sembunyikan baris kategori bernilai 0
        Object.keys(expenseGroups).forEach(k => { if (!expenseGroups[k]) delete expenseGroups[k]; });

        targetDiv.innerHTML = `
          <div class="text-center mb-8 border-b border-slate-100 pb-6">
            <h3 class="font-extrabold text-slate-900 text-xl">Laporan Laba Rugi Bulanan</h3>
            <p class="text-xs text-rose-500 font-extrabold uppercase tracking-widest mt-1">Kost Hade Exclusive</p>
            <p class="text-sm text-slate-500 mt-2 font-medium">Periode: ${indonesianMonths[selMonth - 1]} ${selYear}</p>
          </div>

          <div class="space-y-6 text-sm">
            <!-- PENDAPATAN SECTION -->
            <div>
              <h4 class="font-bold text-slate-900 border-b border-slate-300 pb-1 mb-3 uppercase tracking-wider text-xs">I. Pendapatan Operasional</h4>
              <div class="flex justify-between py-2 px-2 hover:bg-slate-50 transition rounded-lg">
                <span class="text-slate-600 font-medium">Pendapatan Sewa Kamar</span>
                <span class="font-bold text-slate-900">${rp(activeMonthlyRentIncome)}</span>
              </div>
              <div class="flex justify-between py-2 px-2 hover:bg-slate-50 transition rounded-lg border-b border-slate-100">
                <span class="text-slate-600 font-medium">Pendapatan Lain-lain (Auxiliary)</span>
                <span class="font-bold text-slate-900">${rp(activeMonthlyOpsIncome)}</span>
              </div>
              <div class="flex justify-between py-3 px-2 bg-emerald-50 text-emerald-800 rounded-xl font-extrabold mt-3">
                <span>TOTAL PENDAPATAN</span>
                <span>${rp(totalMonthlyIncome)}</span>
              </div>
            </div>

            <!-- BEBAN / BIAYA SECTION -->
            <div>
              <h4 class="font-bold text-slate-900 border-b border-slate-300 pb-1 mb-3 uppercase tracking-wider text-xs">II. Beban Operasional</h4>
              <div class="space-y-1">
                ${Object.entries(expenseGroups).map(([cat, val]) => `
                  <div class="flex justify-between py-1.5 px-2 hover:bg-slate-50 transition rounded-lg">
                    <span class="text-slate-500">${cat}</span>
                    <span class="font-semibold text-slate-800">${rp(val)}</span>
                  </div>
                `).join('')}
              </div>
              <div class="flex justify-between py-3 px-2 bg-rose-50 text-rose-800 rounded-xl font-extrabold mt-4">
                <span>TOTAL BEBAN OPERASIONAL</span>
                <span>${rp(activeMonthlyOpsExpenses)}</span>
              </div>
            </div>

            <!-- NET INCOME SUMMARY -->
            <div class="pt-4 border-t border-slate-300">
              <div class="flex justify-between py-4 px-3 ${netMonthlyIncome >= 0 ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white' : 'bg-rose-600 text-white'} rounded-2xl font-black text-base shadow-md">
                <span>LABA (RUGI) BERSIH</span>
                <span class="double-underline text-lg">${rp(netMonthlyIncome)}</span>
              </div>
            </div>
          </div>
        `;
      } else if (activeReportTab === 'arus-kas') {
        // --- 2. LAPORAN ARUS KAS ---
        targetDiv.innerHTML = `
          <div class="text-center mb-8 border-b border-slate-100 pb-6">
            <h3 class="font-extrabold text-slate-900 text-xl">Laporan Arus Kas Bulanan</h3>
            <p class="text-xs text-rose-500 font-extrabold uppercase tracking-widest mt-1">Kost Hade Exclusive</p>
            <p class="text-sm text-slate-500 mt-2 font-medium">Periode: ${indonesianMonths[selMonth - 1]} ${selYear}</p>
          </div>

          <div class="space-y-6 text-sm">
            <!-- ARUS MASUK -->
            <div>
              <h4 class="font-bold text-slate-900 border-b border-slate-300 pb-1 mb-3 uppercase tracking-wider text-xs">Arus Kas Masuk (Inflow)</h4>
              <div class="flex justify-between py-2 px-2 hover:bg-slate-50 transition rounded-lg">
                <span class="text-slate-600 font-medium">Penerimaan Pembayaran Sewa Kamar</span>
                <span class="font-semibold text-slate-800">${rp(activeMonthlyRentIncome)}</span>
              </div>
              <div class="flex justify-between py-2 px-2 hover:bg-slate-50 transition rounded-lg">
                <span class="text-slate-600 font-medium">Penerimaan Pendapatan Lain-lain</span>
                <span class="font-semibold text-slate-800">${rp(activeMonthlyOpsIncome)}</span>
              </div>
              ${activeMonthlyNeracaInflow > 0 ? `
              <div class="flex justify-between py-2 px-2 hover:bg-slate-50 transition rounded-lg text-blue-600">
                <span class="font-medium">Penerimaan Modal / Deposit (Neraca)</span>
                <span class="font-semibold">${rp(activeMonthlyNeracaInflow)}</span>
              </div>` : ''}
              <div class="flex justify-between py-2 px-2 font-bold text-emerald-600 border-t border-slate-100 mt-2">
                <span>Subtotal Kas Masuk</span>
                <span>${rp(totalMonthlyInflow)}</span>
              </div>
            </div>

            <!-- ARUS KELUAR -->
            <div>
              <h4 class="font-bold text-slate-900 border-b border-slate-300 pb-1 mb-3 uppercase tracking-wider text-xs">Arus Kas Keluar (Outflow)</h4>
              <div class="flex justify-between py-2 px-2 hover:bg-slate-50 transition rounded-lg">
                <span class="text-slate-600 font-medium">Pembayaran Beban Operasional Bulanan</span>
                <span class="font-semibold text-rose-600">${rp(activeMonthlyOpsExpenses)}</span>
              </div>
              ${activeMonthlyNeracaOutflow > 0 ? `
              <div class="flex justify-between py-2 px-2 hover:bg-slate-50 transition rounded-lg text-rose-500">
                <span class="font-medium">Pembelian Aset / Prive / Refund (Neraca)</span>
                <span class="font-semibold">${rp(activeMonthlyNeracaOutflow)}</span>
              </div>` : ''}
              <div class="flex justify-between py-2 px-2 font-bold text-rose-600 border-t border-slate-100 mt-2">
                <span>Subtotal Kas Keluar</span>
                <span>${rp(totalMonthlyOutflow)}</span>
              </div>
            </div>

            <!-- SINKRONISASI KAS AWAL DAN AKHIR -->
            <div>
              <h4 class="font-bold text-slate-900 border-b border-slate-300 pb-1 mb-3 uppercase tracking-wider text-xs">Konsolidasi Kas Berkala</h4>
              
              <div class="space-y-2 pt-2">
                <div class="flex justify-between py-2 px-2 bg-slate-50 rounded-lg">
                  <span class="text-slate-500 font-medium">Arus Kas Bersih (Kenaikan / Penurunan Kas)</span>
                  <span class="font-bold ${netMonthlyCashFlow >= 0 ? 'text-emerald-600' : 'text-rose-600'}">
                    ${rp(netMonthlyCashFlow)}
                  </span>
                </div>
                
                <div class="flex justify-between py-2 px-2 hover:bg-slate-50 transition rounded-lg">
                  <span class="text-slate-500">Saldo Kas Awal Periode</span>
                  <span class="font-semibold text-slate-800">${rp(cumulativeCashPrior)}</span>
                </div>

                <div class="flex justify-between py-3.5 px-3 bg-slate-800 text-white rounded-xl font-bold text-sm">
                  <span>SALDO KAS AKHIR PERIODE</span>
                  <span class="double-underline">${rp(cumulativeCashEnd)}</span>
                </div>
              </div>
            </div>
          </div>
        `;
      } else if (activeReportTab === 'neraca') {
        // --- 3. LAPORAN NERACA (BALANCE SHEET) ---
        // Base starting values
        let assetLandBuildingVal = 1200000000; // 1.2 Billion IDR Base Land & Building Valuation
        let accumulatedDepreciation = -50000000; // Accumulated Depreciation 50m IDR
        const activeTenantsCount = tenants.filter(p => p[5] === 'Aktif').length;
        let depositLiabilities = activeTenantsCount * 500000;
        let startingEquityCapital = 1100000000; // Owner Capital 1.1 Billion IDR

        // Dynamic adjustment based on all historical Neraca transactions up to the target date
        opsTransactions.forEach(o => {
          const parsed = parseDateObj(o[1]);
          const oDate = new Date(parsed.year, parsed.month - 1, 1);
          const targetDate = new Date(selYear, selMonth - 1, 1);
          
          if (oDate <= targetDate && o[2] === 'Neraca') {
            // Pengelompokan neraca sebelumnya memakai daftar nama tetap sehingga kategori buatan
            // pengguna (mis. "Pinjaman Bank") hilang dari aset/kewajiban. Sekarang dikenali dari
            // kata kunci, dan apa pun yang tidak dikenali tetap masuk lewat selisih (retained earnings)
            // sehingga persamaan Aset = Kewajiban + Ekuitas tetap seimbang.
            const val = Number(o[4]) || 0;
            const nama = String(o[3] || '').toLowerCase();
            const kredit = infoKategori('Neraca', o[3]).kredit;
            if (/penyusutan|depresiasi/.test(nama)) {
              accumulatedDepreciation -= val;               // menambah akumulasi penyusutan (aset turun)
            } else if (kredit) {
              // saldo normal kredit: modal / pinjaman / deposito jaminan
              if (/deposit|jaminan/.test(nama)) depositLiabilities += val;
              else startingEquityCapital += val;
            } else {
              // saldo normal debet: aset bertambah, prive/penarikan mengurangi ekuitas
              if (/prive|penarikan|pengembalian/.test(nama)) startingEquityCapital -= val;
              else assetLandBuildingVal += val;
            }
          }
        });

        const netFixedAssets = assetLandBuildingVal + accumulatedDepreciation;
        const totalAssets = cumulativeCashEnd + netFixedAssets;

        // Balance Equation: Equity = Assets - Liabilities
        const retainedEarnings = totalAssets - depositLiabilities - startingEquityCapital;
        const totalEquity = startingEquityCapital + retainedEarnings;
        const totalLiabilitiesEquity = depositLiabilities + totalEquity;

        targetDiv.innerHTML = `
          <div class="text-center mb-8 border-b border-slate-100 pb-6">
            <h3 class="font-extrabold text-slate-900 text-xl">Laporan Posisi Keuangan (Neraca)</h3>
            <p class="text-xs text-rose-500 font-extrabold uppercase tracking-widest mt-1">Kost Hade Exclusive</p>
            <p class="text-sm text-slate-500 mt-2 font-medium">Periode: S.d ${indonesianMonths[selMonth - 1]} ${selYear}</p>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-8 text-sm">
            <!-- ASSETS SIDE -->
            <div class="space-y-4">
              <h4 class="font-bold text-slate-900 border-b border-slate-300 pb-1.5 uppercase tracking-wider text-xs">SISI AKTIVA (ASET)</h4>
              
              <!-- ASET LANCAR -->
              <div>
                <p class="font-bold text-slate-500 text-[10px] uppercase mb-2">A. Aset Lancar</p>
                <div class="flex justify-between py-1.5 px-2 hover:bg-slate-50 transition rounded-lg">
                  <span>Kas dan Setara Kas</span>
                  <span class="font-semibold text-slate-800">${rp(cumulativeCashEnd)}</span>
                </div>
                <div class="flex justify-between py-1.5 px-2 font-bold text-slate-700 border-t border-dashed border-slate-100 mt-1">
                  <span>Total Aset Lancar</span>
                  <span>${rp(cumulativeCashEnd)}</span>
                </div>
              </div>

              <!-- ASET TETAP -->
              <div>
                <p class="font-bold text-slate-500 text-[10px] uppercase mb-2">B. Aset Tetap</p>
                <div class="flex justify-between py-1.5 px-2 hover:bg-slate-50 transition rounded-lg">
                  <span>Bangunan & Inventaris Guesthouse</span>
                  <span class="font-semibold text-slate-800">${rp(assetLandBuildingVal)}</span>
                </div>
                <div class="flex justify-between py-1.5 px-2 hover:bg-slate-50 transition rounded-lg text-rose-600">
                  <span>Akumulasi Penyusutan Aset Tetap</span>
                  <span class="font-semibold">${rp(accumulatedDepreciation)}</span>
                </div>
                <div class="flex justify-between py-1.5 px-2 font-bold text-slate-700 border-t border-dashed border-slate-100 mt-1">
                  <span>Total Aset Tetap (Net)</span>
                  <span>${rp(netFixedAssets)}</span>
                </div>
              </div>

              <div class="flex justify-between py-3 px-3 bg-blue-50 text-blue-900 rounded-xl font-extrabold text-sm border border-blue-100">
                <span>TOTAL AKTIVA (ASET)</span>
                <span>${rp(totalAssets)}</span>
              </div>
            </div>

            <!-- LIABILITIES & EQUITY SIDE -->
            <div class="space-y-4">
              <h4 class="font-bold text-slate-900 border-b border-slate-300 pb-1.5 uppercase tracking-wider text-xs">SISI PASIVA (KEWAJIBAN & EKUITAS)</h4>
              
              <!-- LIABILITIES -->
              <div>
                <p class="font-bold text-slate-500 text-[10px] uppercase mb-2">A. Kewajiban Jangka Pendek</p>
                <div class="flex justify-between py-1.5 px-2 hover:bg-slate-50 transition rounded-lg">
                  <span>Kewajiban Deposit Jaminan Penghuni</span>
                  <span class="font-semibold text-slate-800">${rp(depositLiabilities)}</span>
                </div>
                <div class="flex justify-between py-1.5 px-2 font-bold text-slate-700 border-t border-dashed border-slate-100 mt-1">
                  <span>Total Kewajiban</span>
                  <span>${rp(depositLiabilities)}</span>
                </div>
              </div>

              <!-- OWNER EQUITY -->
              <div>
                <p class="font-bold text-slate-500 text-[10px] uppercase mb-2">B. Ekuitas Pemilik</p>
                <div class="flex justify-between py-1.5 px-2 hover:bg-slate-50 transition rounded-lg">
                  <span>Modal Disetor Pemilik</span>
                  <span class="font-semibold text-slate-800">${rp(startingEquityCapital)}</span>
                </div>
                <div class="flex justify-between py-1.5 px-2 hover:bg-slate-50 transition rounded-lg">
                  <span>Laba Ditahan & Berjalan</span>
                  <span class="font-semibold text-slate-800">${rp(retainedEarnings)}</span>
                </div>
                <div class="flex justify-between py-1.5 px-2 font-bold text-slate-700 border-t border-dashed border-slate-100 mt-1">
                  <span>Total Ekuitas</span>
                  <span>${rp(totalEquity)}</span>
                </div>
              </div>

              <div class="flex justify-between py-3 px-3 bg-emerald-50 text-emerald-900 rounded-xl font-extrabold text-sm border border-emerald-100">
                <span>TOTAL PASIVA (KEWAJIBAN & EKUITAS)</span>
                <span>${rp(totalLiabilitiesEquity)}</span>
              </div>
            </div>
          </div>

          <!-- BALANCED INDICATOR: dihitung, bukan dicap begitu saja -->
          <div class="mt-8 flex justify-center">
            ${Math.abs(totalAssets - totalLiabilitiesEquity) < 1 ? `
            <span class="px-4 py-1.5 bg-emerald-100 text-emerald-800 border border-emerald-200 rounded-full font-black text-xs tracking-widest flex items-center gap-2 uppercase">
              <i class="fas fa-check-double"></i> Neraca seimbang
            </span>` : `
            <span class="px-4 py-1.5 bg-rose-100 text-rose-800 border border-rose-200 rounded-full font-black text-xs tracking-widest flex items-center gap-2 uppercase">
              <i class="fas fa-triangle-exclamation"></i> Selisih ${(totalAssets - totalLiabilitiesEquity).toLocaleString('id-ID')}
            </span>`}
          </div>
        `;
      }
    }

    // PRINT INDIVIDUAL REPORTS TEMPLATES FLUIDLY
    function printFinancialReport() {
      const printContents = document.getElementById('financial-report-content').innerHTML;
      const printWindow = window.open('', '_blank');
      printWindow.document.write(`
        <html>
          <head>
            <title>Cetak Laporan Keuangan Kost Hade</title>
            <style>
              body { 
                font-family: 'Courier New', Courier, monospace; 
                padding: 40px; 
                font-size: 13px; 
                color: #000; 
                background: #fff; 
              }
              .text-center { text-align: center; }
              .border-b { border-bottom: 1px solid #ccc; }
              .pb-6 { padding-bottom: 20px; }
              .mb-8 { margin-bottom: 30px; }
              .space-y-6 > div { margin-bottom: 25px; }
              .font-bold { font-weight: bold; }
              .font-extrabold { font-weight: 800; }
              .text-xl { font-size: 20px; }
              .text-xs { font-size: 11px; }
              .flex { display: flex; justify-content: space-between; }
              .py-2 { padding-top: 6px; padding-bottom: 6px; }
              .py-3 { padding-top: 10px; padding-bottom: 10px; }
              .bg-emerald-50, .bg-rose-50, .bg-slate-50, .bg-blue-50 { background-color: #fafafa !important; border: 1px solid #000; padding: 10px; }
              .double-underline { 
                border-bottom: 3px double #000; 
              }
              .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; }
              .border-t { border-top: 1px solid #000; }
            </style>
          </head>
          <body onload="window.print(); window.close();">
            ${printContents}
          </body>
        </html>
      `);
      printWindow.document.close();
    }

    // RENDERS LIVE DYNAMIC LEASE BILLING ALERT BOXES
    function renderBillingAlerts(penyewaList) {
      const container = document.getElementById('billing-alerts-container');
      const listElement = document.getElementById('billing-alerts-list');
      listElement.innerHTML = '';

      let hasAlerts = false;
      const today = new Date();
      today.setHours(0,0,0,0);

      penyewaList.forEach(p => {
        // Only trigger alerts for active tenants
        if (p[5] !== 'Aktif') return;

        // p[6] stores 'jatuhTempo' in format 'YYYY-MM-DD'
        const dueStr = p[6];
        if (!dueStr) return;

        const dueDate = new Date(dueStr);
        dueDate.setHours(0,0,0,0);

        // Difference in time
        const diffTime = dueDate.getTime() - today.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        if (diffDays < 0) {
          // Overdue (Menunggak)
          hasAlerts = true;
          const lateDays = Math.abs(diffDays);
          listElement.innerHTML += `
            <div class="flex items-center justify-between p-4 rounded-2xl bg-rose-50 border border-rose-100 animate-fade-in">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-rose-500 flex items-center justify-center text-white shrink-0 shadow-md shadow-rose-500/10">
                  <i class="fas fa-exclamation-triangle"></i>
                </div>
                <div>
                  <h4 class="font-extrabold text-slate-900 text-xs md:text-sm">${esc(p[1])} <span class="px-2 py-0.5 rounded bg-rose-100 text-rose-700 text-[9px] font-black uppercase">${esc(p[3])}</span></h4>
                  <p class="text-[11px] text-rose-600 font-bold mt-0.5"><i class="far fa-clock mr-1"></i>Status: Menunggak ${lateDays} Hari (Batas: ${dueStr})</p>
                </div>
              </div>
              <button data-aksi="bayar-cepat" data-nama="${esc(p[1])}" data-kamar="${esc(p[3])}" class="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white font-extrabold text-[10px] uppercase tracking-wider rounded-xl transition shadow-sm">
                Catat Bayar
              </button>
            </div>
          `;
        } else if (diffDays <= 5) {
          // Closing due date (Mendekati Jatuh Tempo)
          hasAlerts = true;
          listElement.innerHTML += `
            <div class="flex items-center justify-between p-4 rounded-2xl bg-amber-50 border border-amber-100 animate-fade-in">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-amber-500 flex items-center justify-center text-white shrink-0 shadow-md shadow-amber-500/10">
                  <i class="fas fa-bell"></i>
                </div>
                <div>
                  <h4 class="font-extrabold text-slate-900 text-xs md:text-sm">${esc(p[1])} <span class="px-2 py-0.5 rounded bg-amber-100 text-amber-700 text-[9px] font-black uppercase">${esc(p[3])}</span></h4>
                  <p class="text-[11px] text-amber-600 font-bold mt-0.5"><i class="far fa-hourglass mr-1"></i>Jatuh Tempo: Sisa ${diffDays} Hari (Batas: ${dueStr})</p>
                </div>
              </div>
              <button data-aksi="bayar-cepat" data-nama="${esc(p[1])}" data-kamar="${esc(p[3])}" class="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white font-extrabold text-[10px] uppercase tracking-wider rounded-xl transition shadow-sm">
                Catat Bayar
              </button>
            </div>
          `;
        }
      });

      if (hasAlerts) {
        container.classList.remove('hidden');
      } else {
        container.classList.add('hidden');
      }
    }

    // PORT TO QUICK PAYMENT SCENE
    function quickPayPort(tenantName, targetRoom) {
      showSection('pembayaran', document.querySelectorAll('#sidebar-nav button')[3]);
      setTimeout(() => {
        const selectPenyewa = document.getElementById('select-penyewa');
        for (let i = 0; i < selectPenyewa.options.length; i++) {
          if (selectPenyewa.options[i].value === tenantName) {
            selectPenyewa.selectedIndex = i;
            break;
          }
        }
        handlePenyewaChange();
      }, 300);
    }

    function renderDashboard(data) {
      document.getElementById('stat-total-kamar').innerText = data.stats.totalKamar;
      document.getElementById('stat-kamar-terisi').innerText = data.stats.kamarTerisi;
      document.getElementById('stat-total-penyewa').innerText = data.stats.totalPenyewa;
      
      // Sisa Saldo Kas (Net Profit)
      document.getElementById('stat-pendapatan').innerText = rp(data.stats.sisaKas);
      
      // Unified financial summary panel updates
      document.getElementById('sum-total-pendapatan').innerText = rp(data.stats.totalPendapatan);
      document.getElementById('sum-total-pengeluaran').innerText = rp(data.stats.totalPengeluaran);
      
      // Calculate & update occupancy percentages & bars
      const rawPercentage = data.stats.totalKamar > 0 ? (data.stats.kamarTerisi / data.stats.totalKamar) * 100 : 0;
      const roundedPercentage = Math.round(rawPercentage);
      document.getElementById('occupancy-bar').style.width = roundedPercentage + "%";
      document.getElementById('occupancy-percentage').innerText = roundedPercentage + "%";

      // Render Billing/Arrears Alert banners dynamically
      renderBillingAlerts(data.penyewa);

      // Render Dashboard Transaction Table
      const tbody = document.getElementById('table-transaksi');
      if (data.transaksi.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="py-8 text-center text-slate-400 text-sm italic">Belum ada riwayat transaksi pembayaran digital.</td></tr>`;
      } else {
        tbody.innerHTML = data.transaksi.map((t, idx) => {
          let angkaBersih = String(t[3]).replace(/[^0-9]/g, '');
          return `
            <tr class="hover:bg-slate-50 transition border-b border-slate-100 last:border-0 text-slate-700">
              <td class="py-3 px-6 text-center font-bold text-slate-400 text-xs">${idx + 1}</td>
              <td class="py-3 px-4 text-xs text-slate-500 whitespace-nowrap">${esc(t[0])}</td>
              <td class="py-3 px-4 font-bold text-xs md:text-sm text-slate-900">${esc(t[1])}</td>
              <td class="py-3 px-4"><span class="bg-blue-50 text-blue-600 border border-blue-100 px-2.5 py-0.5 rounded text-[10px] font-black uppercase tracking-tight">${esc(t[2])}</span></td>
              <td class="py-3 px-4 text-emerald-600 font-extrabold text-xs md:text-sm whitespace-nowrap">${rp(angkaBersih)}</td>
              <td class="py-3 px-4 text-xs text-slate-500 max-w-[180px] truncate" title="${esc(t[4])}">${esc(t[4])}</td>
              <td class="py-3 px-6 text-center">
              ${t[6] ? `<button data-aksi="bukti" data-bukti="${esc(t[6])}" title="Lihat bukti bayar" class="text-emerald-500 hover:text-emerald-700 transition p-2 hover:bg-emerald-50 rounded-lg mr-1"><i class="fas fa-paperclip text-xs"></i></button>` : ''}
                <button data-aksi="struk" data-tgl="${esc(t[0])}" data-nama="${esc(t[1])}" data-kamar="${esc(t[2])}" data-jumlah="${angkaBersih}" data-ket="${esc(t[4])}" data-no="${esc(t[5] || '')}" data-struk="${esc(String(t[4]).match(/STR-[0-9]{8}-[0-9]{3}/) ? String(t[4]).match(/STR-[0-9]{8}-[0-9]{3}/)[0] : '')}" class="w-8 h-8 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 hover:text-rose-600 flex items-center justify-center mx-auto transition shadow-sm" title="Lihat Struk">
                  <i class="fas fa-file-invoice text-xs"></i>
                </button>
              </td>
            </tr>
          `;
        }).join('');
      }
      
      // Render Room Grids
      renderRoomCards(data.kamar);
    }

    function renderRoomCards(kamarList) {
      const grid = document.getElementById('grid-kamar');
      
      // Filter the UI list according to chosen filter
      const filtered = kamarList.filter(k => {
        if (selectedRoomFilter === 'semua') return true;
        return k[4] === selectedRoomFilter;
      });

      if (filtered.length === 0) {
        grid.innerHTML = `<div class="col-span-full py-16 text-center bg-white border border-slate-100 rounded-3xl text-slate-400 text-sm italic"><i class="fas fa-door-closed text-3xl mb-3 block text-slate-300"></i>Tidak ada unit suite dalam kriteria penyaringan ini.</div>`;
        return;
      }

      grid.innerHTML = filtered.map(k => {
        let bulananClean = String(k[2]).replace(/[^0-9]/g, '');
        let harianClean = String(k[3]).replace(/[^0-9]/g, '');
        const isOccupied = k[4] === 'Terisi';
        
        return `
          <div class="bg-white p-5 rounded-2xl shadow-sm border-t-4 ${isOccupied ? 'border-t-blue-500' : 'border-t-rose-500'} transition duration-250 hover:shadow-md flex flex-col justify-between h-52 premium-card border border-slate-100">
            <div>
              <div class="flex justify-between items-center mb-3">
                <span class="text-xl font-black text-slate-800">${esc(k[0])}</span>
                <span class="px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest ${isOccupied ? 'bg-blue-50 text-blue-600 border border-blue-100' : 'bg-rose-50 text-rose-600 border border-rose-100'}">${k[4]}</span>
              </div>
              <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">${esc(k[1])}</p>
              <div class="space-y-1">
                <p class="text-xs font-semibold text-slate-500">Bln: <span class="text-rose-600 font-extrabold text-sm">${rp(bulananClean)}</span></p>
                <p class="text-xs font-semibold text-slate-500">Har: <span class="text-blue-600 font-extrabold text-sm">${rp(harianClean)}</span></p>
              </div>
            </div>
            <div class="pt-3 border-t border-slate-100 text-xs flex justify-between items-center mt-3">
              <div class="flex-1 min-w-0 pr-2">
                ${isOccupied 
                  ? `<p class="text-slate-600 font-semibold truncate" title="${esc(k[5])}"><i class="fas fa-user-circle mr-1.5 text-blue-500"></i>${esc(k[5])}</p>` 
                  : `<span class="text-rose-500 italic font-medium"><i class="fas fa-check-circle mr-1 text-rose-500"></i> Siap Disewa</span>`}
              </div>
              <div class="flex gap-1.5 shrink-0">
                <button data-aksi="edit-kamar" data-no="${esc(k[0])}" data-tipe="${esc(k[1])}" data-bulanan="${esc(k[2])}" data-harian="${esc(k[3])}" class="w-11 h-11 md:w-8 md:h-8 bg-slate-50 hover:bg-blue-50 text-slate-400 hover:text-blue-600 rounded-lg flex items-center justify-center transition border border-slate-100" title="Edit Kamar">
                  <i class="fas fa-edit text-[10px]"></i>
                </button>
                <button data-aksi="hapus-kamar" data-no="${esc(k[0])}" data-status="${esc(k[4])}" class="w-11 h-11 md:w-8 md:h-8 bg-slate-50 hover:bg-rose-50 text-slate-400 hover:text-rose-600 rounded-lg flex items-center justify-center transition border border-slate-100 btn-delete-action" title="Hapus Kamar">
                  <i class="fas fa-trash-alt text-[10px]"></i>
                </button>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }

    function filterRoomCards(type) {
      selectedRoomFilter = type;
      document.querySelectorAll('#sec-kamar button[id^="btn-filter-"]').forEach(btn => {
        btn.classList.remove('bg-gradient-to-r', 'from-blue-600', 'to-rose-600', 'text-white', 'shadow-md');
        btn.classList.add('text-slate-500', 'hover:text-slate-800');
      });
      const activeBtn = document.getElementById('btn-filter-' + type.toLowerCase());
      if (activeBtn) {
        activeBtn.classList.remove('text-slate-500', 'hover:text-slate-800');
        activeBtn.classList.add('bg-gradient-to-r', 'from-blue-600', 'to-rose-600', 'text-white', 'shadow-md');
      }
      if (cachedData) renderRoomCards(cachedData.kamar);
    }

    function loadAvailableRooms() {
      if (cachedData) {
        const rooms = cachedData.kamar.filter(k => k[4] === 'Tersedia').map(k => k[0]);
        renderAvailableRooms(rooms);
        return;
      }
      showLoading(true);
      google.script.run
        .withFailureHandler(handleError)
        .withSuccessHandler(responseString => {
          const rooms = JSON.parse(responseString);
          renderAvailableRooms(rooms);
          showLoading(false);
        }).getAvailableRooms();
    }

    function renderAvailableRooms(rooms) {
      const select = document.getElementById('select-kamar');
      select.innerHTML = rooms.length > 0 
        ? '<option value="">-- Pilih Kamar --</option>' + rooms.map(r => `<option value="${r}">${r}</option>`).join('') 
        : '<option value="">Semua Kamar Terisi</option>';
    }

    // LOAD ALL TENANTS LIST FOR TENANT TAB
    function loadAllTenantsList() {
      if (cachedData) {
        renderTenantsList(cachedData.penyewa);
        return;
      }
      showLoading(true);
      google.script.run
        .withFailureHandler(handleError)
        .withSuccessHandler(responseString => {
          const data = JSON.parse(responseString);
          renderTenantsList(data.penyewa);
          showLoading(false);
        }).getDashboardData();
    }

    function renderTenantsList(tenants) {
      const tbody = document.getElementById('table-penyewa-list');
      if (!tenants || tenants.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-12 text-center text-slate-400 text-sm italic">Belum ada penyewa yang terdaftar.</td></tr>`;
        return;
      }

      tbody.innerHTML = tenants.map(p => {
        const statusActive = p[5] === 'Aktif';
        // Clean telephone for WA links
        let cleanHp = String(p[2]).trim().replace(/[^0-9]/g, '');
        if (cleanHp.startsWith('0')) {
          cleanHp = '62' + cleanHp.slice(1);
        }
        
        // Custom Rent Reminder Text for WhatsApp
        const waText = encodeURIComponent(`Halo ${p[1]},\nKami ingin menginformasikan terkait tagihan sewa bulanan Anda untuk Unit Kamar ${p[3]}. Pembayaran dapat segera diselesaikan melaui transfer atau tunai. Terima kasih.\n- Admin Kost Hade`);
        const waLink = `https://wa.me/${cleanHp}?text=${waText}`;

        return `
          <tr class="hover:bg-slate-50 transition border-b border-slate-100 last:border-0 text-slate-700 text-xs md:text-sm">
            <td class="py-4 px-6">
              <div class="flex items-center gap-2.5">
                <div class="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center font-bold text-slate-500 text-[10px] shrink-0 border border-slate-100">
                  ${esc(p[0].substring(0, 5))}
                </div>
                <div>
                  <p class="font-extrabold text-slate-900 leading-tight">${esc(p[1])}</p>
                  <p class="text-[9px] text-slate-400 font-mono mt-0.5 flex items-center gap-1.5">
                    ${esc(p[0])}
                    ${p[12] === 'wa' ? '<span class="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 border border-emerald-100 font-bold text-[8px] tracking-wider">VIA WA</span>' : ''}
                  </p>
                </div>
              </div>
            </td>
            <td class="py-4 px-4">
              <span class="px-2.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-100 font-black text-[10px] uppercase">${esc(p[3])}</span>
            </td>
            <td class="py-4 px-4 font-medium text-slate-500">${esc(p[2])}</td>
            <td class="py-4 px-4 font-medium text-slate-400">
              <div>${esc(p[4])}</div>
              ${p[6] ? `<div class="text-[9px] text-rose-500 font-bold mt-0.5">Tempo: ${esc(p[6])}</div>` : ''}
            </td>
            <td class="py-4 px-4">
              <span class="px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${statusActive ? 'bg-emerald-50 text-emerald-600 border border-emerald-100' : 'bg-slate-100 text-slate-400 border border-slate-200'}">
                ${esc(p[5])}
              </span>
            </td>
            <td class="py-4 px-6">
              <div class="flex items-center justify-center gap-1.5">
                <a href="${waLink}" target="_blank" rel="noopener" class="w-11 h-11 md:w-8 md:h-8 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-600 border border-emerald-100 flex items-center justify-center transition" title="Kirim Pengingat WA">
                  <i class="fab fa-whatsapp text-xs"></i>
                </a>
                <button data-aksi="edit-penyewa" data-kode="${esc(p[0])}" data-nama="${esc(p[1])}" data-hp="${esc(p[2])}" data-kamar="${esc(p[3])}" data-masuk="${esc(p[4])}" data-status="${esc(p[5])}" data-tempo="${esc(p[6] || '')}" class="w-11 h-11 md:w-8 md:h-8 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-600 border border-blue-100 flex items-center justify-center transition" title="Edit Penyewa">
                  <i class="fas fa-edit text-[10px]"></i>
                </button>
                <button data-aksi="hapus-penyewa" data-kode="${esc(p[0])}" data-nama="${esc(p[1])}" data-kamar="${esc(p[3])}" data-status="${esc(p[5])}" class="w-11 h-11 md:w-8 md:h-8 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 border border-red-100 flex items-center justify-center transition btn-delete-action" title="Hapus Penyewa">
                  <i class="fas fa-trash-alt text-[10px]"></i>
                </button>
                ${statusActive ? `
                  <button data-aksi="pindah-kamar" data-kode="${esc(p[0])}" data-nama="${esc(p[1])}" data-kamar="${esc(p[3])}" class="w-11 h-11 md:w-8 md:h-8 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-600 border border-indigo-100 flex items-center justify-center transition" title="Pindah Kamar">
                    <i class="fas fa-right-left text-[10px]"></i>
                  </button>
                  <button data-aksi="checkout" data-kode="${esc(p[0])}" data-nama="${esc(p[1])}" data-kamar="${esc(p[3])}" class="px-2 py-1 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-100 text-[9px] font-black tracking-widest uppercase transition btn-delete-action" title="Keluarkan Penyewa / Check-out">
                    Checkout
                  </button>
                ` : ''}
              </div>
            </td>
          </tr>
        `;
      }).join('');
    }

    function filterTenants() {
      const q = document.getElementById('tenant-search').value.toLowerCase().trim();
      if (!cachedData) return;
      const filtered = cachedData.penyewa.filter(p => {
        return p[1].toLowerCase().includes(q) || p[3].toLowerCase().includes(q) || p[2].toLowerCase().includes(q);
      });
      renderTenantsList(filtered);
    }

    function loadActiveTenants() {
      if (cachedData) {
        // sertakan nominal tagihan (p[7]) & jatuh tempo supaya form bayar bisa mengisi angka yang benar
        const tenants = cachedData.penyewa.filter(p => p[5] === 'Aktif')
          .map(p => ({ nama: p[1], kamar: p[3], tagihan: p[7] || '', tempo: p[6] || '' }));
        renderActiveTenants(tenants);
        return;
      }
      showLoading(true);
      google.script.run
        .withFailureHandler(handleError)
        .withSuccessHandler(responseString => {
          const tenants = JSON.parse(responseString);
          renderActiveTenants(tenants);
          showLoading(false);
        }).getActiveTenants();
    }

    function renderActiveTenants(tenants) {
      const select = document.getElementById('select-penyewa');
      select.innerHTML = tenants.length > 0 
        ? '<option value="">-- Pilih Penyewa --</option>' + tenants.map(t => `<option value="${esc(t.nama)}" data-kamar="${esc(t.kamar)}" data-tagihan="${esc(t.tagihan || '')}" data-tempo="${esc(t.tempo || '')}">${esc(t.nama)} (${esc(t.kamar)})</option>`).join('') 
        : '<option value="">Tidak ada penyewa aktif</option>';
    }

    function handlePenyewaChange() {
      const select = document.getElementById('select-penyewa');
      const selectedOption = select.options[select.selectedIndex];
      const kamarInput = document.getElementById('input-kamar-pembayaran');
      if (selectedOption && selectedOption.value !== "") {
        kamarInput.value = selectedOption.getAttribute('data-kamar') || '';
        const tgl = document.getElementById('input-tgl-pembayaran');
        if (tgl && !tgl.value) tgl.value = new Date().toLocaleDateString('en-CA');
        calculateBilling();
      } else {
        kamarInput.value = "";
      }
    }

    // HANDLES SWITCHING TYPE TO REDETERMINE DURATION LABELS
    function handleTipeSewaChange() {
      const type = document.getElementById('select-tipe-sewa').value;
      const label = document.getElementById('label-durasi-sewa');
      if (type === 'Bulanan') {
        label.innerText = 'Jumlah Bulan Sewa';
      } else {
        label.innerText = 'Jumlah Hari Sewa';
      }
      calculateBilling();
    }

    // 31 Jan + 1 bulan -> 28/29 Feb (Date.setMonth langsung meluber ke 3 Maret)
    function addBulan(iso, bulan) {
      const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
      const total = y * 12 + (m - 1) + bulan;
      const ny = Math.floor(total / 12), nm = (total % 12) + 1;
      const akhir = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
      const pad = (v) => String(v).padStart(2, '0');
      return `${ny}-${pad(nm)}-${pad(Math.min(d, akhir))}`;
    }

    // AUTO CALCULATE DATES AND CASH INFLOW ESTIMATES FOR RENTS
    function calculateBilling() {
      const select = document.getElementById('select-penyewa');
      const selectedOption = select.options[select.selectedIndex];
      const type = document.getElementById('select-tipe-sewa').value;
      const durasi = parseInt(document.getElementById('input-durasi-sewa').value) || 1;
      const inputJumlah = document.getElementById('input-jumlah-pembayaran');
      const inputJatuhTempo = document.getElementById('input-jatuh-tempo');
      const inputKeterangan = document.getElementById('input-keterangan-pembayaran');
      const tglBayarStr = document.getElementById('input-tgl-pembayaran').value;

      if (!selectedOption || selectedOption.value === "") return;

      const kamarNo = selectedOption.getAttribute('data-kamar');
      // Server hanya menerima nominal yang SAMA dengan tagihan terbuka, jadi form menampilkan
      // tagihan itu (dulu memakai harga kamar/harian -> ditolak 409 saat menyimpan).
      // nominal = tagihan per bulan × jumlah bulan (server memvalidasi total = N × tagihan)
      const perBulan = Number(selectedOption.getAttribute('data-tagihan') || 0);
      inputJumlah.value = perBulan * (type === 'Bulanan' ? durasi : 1);
      // Jatuh tempo = tagihan nyata dari server (bukan hitungan sendiri dari tanggal bayar)
      const formattedDate = selectedOption.getAttribute('data-tempo') || addBulan(tglBayarStr || new Date().toLocaleDateString('en-CA'), durasi);
      inputJatuhTempo.value = formattedDate;

      // Populate auto description helper
      inputKeterangan.value = `Pembayaran Sewa ${type} Kamar ${kamarNo}${type === 'Bulanan' && durasi > 1 ? ` — ${durasi} bulan` : ''} - s.d. ${formattedDate}`;
    }

    // LOAD EXPANDED PAYMENTS LOG FOR DETAILED LOGS TAB
    function loadPaymentsHistory() {
      if (cachedData) {
        renderPaymentsHistory(cachedData.transaksi);
        return;
      }
      showLoading(true);
      google.script.run
        .withFailureHandler(handleError)
        .withSuccessHandler(responseString => {
          const data = JSON.parse(responseString);
          renderPaymentsHistory(data.transaksi);
          showLoading(false);
        }).getDashboardData();
    }

    function renderPaymentsHistory(payments) {
      const tbody = document.getElementById('table-pembayaran-history');
      if (!payments || payments.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-12 text-center text-slate-400 text-sm italic">Belum ada pembayaran keuangan tercatat.</td></tr>`;
        return;
      }

      tbody.innerHTML = payments.map(t => {
        let angkaBersih = String(t[3]).replace(/[^0-9]/g, '');
        return `
          <tr class="hover:bg-slate-50 transition border-b border-slate-100 last:border-0 text-slate-700 text-xs md:text-sm">
            <td class="py-4 px-6 text-slate-500 whitespace-nowrap">${t[0]}</td>
            <td class="py-4 px-4 font-bold text-slate-900">${t[1]}</td>
            <td class="py-4 px-4">
              <span class="px-2.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-100 text-[10px] font-black uppercase">${esc(t[2])}</span>
            </td>
            <td class="py-4 px-4 font-extrabold text-emerald-600">${rp(angkaBersih)}</td>
            <td class="py-4 px-4 text-slate-500 font-medium">${esc(t[4])}</td>
            <td class="py-4 px-6 text-center">
              ${t[6] ? `<button data-aksi="bukti" data-bukti="${esc(t[6])}" title="Lihat bukti bayar" class="text-emerald-500 hover:text-emerald-700 transition p-2 hover:bg-emerald-50 rounded-lg mr-1"><i class="fas fa-paperclip text-xs"></i></button>` : ''}
              <button data-aksi="struk" data-tgl="${esc(t[0])}" data-nama="${esc(t[1])}" data-kamar="${esc(t[2])}" data-jumlah="${angkaBersih}" data-ket="${esc(t[4])}" data-no="${esc(t[5] || '')}" data-struk="${esc(String(t[4]).match(/STR-[0-9]{8}-[0-9]{3}/) ? String(t[4]).match(/STR-[0-9]{8}-[0-9]{3}/)[0] : '')}" class="w-8 h-8 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-600 border border-blue-200 flex items-center justify-center mx-auto transition shadow-sm" title="Lihat/Print Struk">
                <i class="fas fa-file-invoice text-xs"></i>
              </button>
            </td>
          </tr>
        `;
      }).join('');
    }

    // ================= ATURAN KAS & NERACA (sumber tunggal) =================
    // Server menghitung sisa kas dari categories.saldo_normal: Kredit (+), Debet (-),
    // dan kategori dengan arus_kas = 0 (mis. Penyusutan) tidak menggerakkan kas.
    // Laporan DULU memakai daftar nama kategori tetap sehingga kategori baru tidak dihitung.
    function petaKategori() {
      const k = (cachedData && cachedData.kategori) || {};
      const map = {};
      ['Pendapatan', 'Pengeluaran', 'Neraca'].forEach((j) => {
        (k[j] || []).forEach((c) => { map[j + '|' + c.nama] = c; });
      });
      return map;
    }
    function infoKategori(jenis, nama) {
      const c = petaKategori()[String(jenis) + '|' + String(nama)];
      const kredit = c ? String(c.saldoNormal || 'Debet') === 'Kredit' : false;
      const arusKas = c ? c.arusKas !== false : true;
      return { kredit, arusKas, ada: !!c };
    }
    // dampak arus kas: pendapatan +, pengeluaran -, neraca mengikuti saldo normal
    function dampakKas(o) {
      const val = Number(o[4]) || 0;
      const j = o[2];
      if (j === 'Pendapatan') return val;
      if (j === 'Pengeluaran') return -val;
      if (j === 'Neraca') {
        const info = infoKategori(j, o[3]);
        if (!info.arusKas) return 0;
        return info.kredit ? val : -val;
      }
      return 0;
    }

    // ================= IMPOR PENYEWA DARI WHATSAPP =================
    // Penyewa mengirim data + foto KTP lewat WhatsApp; petugas cukup menempel pesannya.
    function bukaImporWa() {
      const sel = document.getElementById('wa-kamar');
      const kamar = (cachedData && cachedData.kamar || []).filter((k) => k[4] === 'Tersedia').map((k) => k[0]);
      sel.innerHTML = kamar.length
        ? '<option value="">-- Pilih Kamar --</option>' + kamar.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')
        : '<option value="">Semua kamar terisi</option>';
      document.getElementById('wa-teks').value = '';
      ['wa-nama', 'wa-hp', 'wa-kontak', 'wa-hpdarurat'].forEach((id) => { document.getElementById(id).value = ''; });
      document.getElementById('wa-tgl').value = new Date().toLocaleDateString('en-CA');
      document.getElementById('wa-ktp').value = '';
      const m = document.getElementById('impor-wa-modal');
      m.classList.remove('hidden'); m.classList.add('flex');
    }

    function tutupImporWa() {
      const m = document.getElementById('impor-wa-modal');
      m.classList.remove('flex'); m.classList.add('hidden');
    }

    // ===== Undang calon penyewa lewat WhatsApp (satu alur, tanpa prompt tersembunyi) =====
    const TEKS_UNDANGAN = 'Halo, terima kasih tertarik tinggal di Kost Hade.\n\nUntuk pendaftaran, mohon kirim data berikut ya:\n1. Nama lengkap\n2. Nomor WhatsApp\n3. Kontak darurat (nama)\n4. HP kontak darurat\n5. Tanggal rencana masuk\n6. Foto KTP\n\nCukup balas pesan ini. Terima kasih.\n- Admin Kost Hade';

    function bukaUndangWa() {
      const m = document.getElementById('undang-wa-modal');
      document.getElementById('undang-hp').value = '';
      document.getElementById('undang-teks').value = TEKS_UNDANGAN;
      document.getElementById('undang-kirim').disabled = true;
      m.classList.remove('hidden'); m.classList.add('flex');
      setTimeout(() => document.getElementById('undang-hp').focus(), 120);
    }
    function tutupUndangWa() {
      const m = document.getElementById('undang-wa-modal');
      m.classList.remove('flex'); m.classList.add('hidden');
    }
    function ubahTeksUndangan() {
      document.getElementById('undang-kirim').disabled = !document.getElementById('undang-hp').value.replace(/[^0-9]/g, '');
    }
    function bukaWaUndangan() {
      const nomor = document.getElementById('undang-hp').value.replace(/[^0-9]/g, '').replace(/^0/, '62').replace(/^8/, '628');
      const teks = document.getElementById('undang-teks').value;
      if (!nomor) { showCustomAlert('Nomor Belum Diisi', 'Isi nomor WhatsApp calon penyewa dulu.', false); return; }
      window.open(`https://wa.me/${nomor}?text=${encodeURIComponent(teks)}`, '_blank');
      tutupUndangWa();
    }
    async function salinTeksUndangan() {
      const teks = document.getElementById('undang-teks').value;
      try {
        await navigator.clipboard.writeText(teks);
        showCustomAlert('Teks Disalin', 'Tempel teks ini di WhatsApp mana pun, lalu kirim.', true);
      } catch (err) {
        // clipboard diblokir browser: pilih teksnya supaya bisa di-copy manual
        const ta = document.getElementById('undang-teks');
        ta.focus(); ta.select();
        showCustomAlert('Salin Manual', 'Teks sudah diblok. Tekan Ctrl+C (atau salin dari menu HP) untuk menyalin.', true);
      }
    }

    const LABEL_WA = {
      nama: /^(nama|nama lengkap|nama penyewa)\b/i,
      hp: /^(hp|no hp|nomor hp|whatsapp|wa|telp|telepon|no wa)\b/i,
      kamar: /^(kamar|no kamar|nomor kamar|unit)\b/i,
      tgl: /^(tanggal|tgl|tgl masuk|tanggal masuk|mulai|mulai sewa)\b/i,
      kontak: /^(kontak darurat|nama kontak darurat|darurat|keluarga)\b/i,
      hpdarurat: /^(hp darurat|no hp darurat|nomor darurat|telp darurat|hp kontak darurat)\b/i,
    };

    function normTglWa(s) {
      const t = String(s).trim();
      let m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
      if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
      const bulan = { januari:1, februari:2, maret:3, april:4, mei:5, juni:6, juli:7, agustus:8, september:9, oktober:10, november:11, desember:12 };
      m = t.toLowerCase().match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/);
      if (m && bulan[m[2]]) return `${m[3]}-${String(bulan[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      return '';
    }

    // Urai pesan bebas. Urutan kerja:
    //  1) pola "Label: nilai" / "Label = nilai" / "Label - nilai"
    //  2) sisanya ditebak per baris: tanggal, nomor HP, nomor kamar
    //  3) kalau nama belum ada, ambil dari kalimat pembuka ("saya Siti Aminah")
    // Semua nilai normalisasi ke bentuk yang diterima server (HP 0xxx, tanggal YYYY-MM-DD).
    function uraiPesan(teks) {
      const hasil = { nama: '', hp: '', kamar: '', tgl: '', kontak: '', hpdarurat: '' };
      const baris = String(teks || '').split(/\r?\n/).map((b) => b.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
      const sisa = [];

      const cocokLabel = (label) => Object.keys(LABEL_WA).find((k) => LABEL_WA[k].test(label));

      baris.forEach((b) => {
        const m = b.match(/^([A-Za-z .]{2,30})\s*[:=]\s*(.+)$/) || b.match(/^([A-Za-z .]{2,30})\s+-\s+(.+)$/);
        if (!m) { sisa.push(b); return; }
        const label = m[1].trim().toLowerCase();
        const nilai = m[2].trim();
        let kunci = cocokLabel(label);
        // "hp darurat" harus dicek sebelum "hp"
        if (kunci === 'hp' && /darurat|kontak|keluarga|wali/i.test(label)) kunci = null;

        if (kunci === 'kontak') {
          // "Kontak darurat: Ibu Ratna - 0813..." / "Ibu Ratna (0813...)"
          const kurung = nilai.match(/^(.*?)\s*[\(\[]\s*([+0-9][0-9\s-]{7,})\s*[\)\]]\s*$/);
          const pisah = kurung || nilai.match(/^(.*?)[\s\-,(]+([+0-9][0-9\s-]{7,})$/) || nilai.match(/^(.*?)\s+-\s+([+0-9][0-9\s-]{7,})$/);
          if (pisah) { hasil.kontak = pisah[1].replace(/[,(]\s*$/, '').trim(); hasil.hpdarurat = pisah[2].replace(/[^0-9+]/g, ''); }
          else hasil.kontak = nilai;
          return;
        }
        if (kunci === 'tgl') { hasil.tgl = normTglWa(nilai); return; }
        if (kunci === 'hpdarurat') { hasil.hpdarurat = nilai.replace(/[^0-9+]/g, ''); return; }
        if (kunci === 'hp') { hasil.hp = nilai.replace(/[^0-9+]/g, ''); return; }
        if (kunci === 'kamar') { const k = nilai.match(/([0-9]{1,4}[A-Za-z]?)/); if (k) hasil.kamar = k[1].toUpperCase(); return; }
        if (kunci === 'nama') { hasil.nama = nilai.replace(/\s*[,.]$/, ''); return; }
        sisa.push(b);
      });

      sisa.forEach((b) => {
        if (!hasil.tgl) { const t = normTglWa(b.replace(/^(tgl|tanggal|mulai|masuk)[:\s]*/i, '')); if (t) { hasil.tgl = t; return; } }
        if (!hasil.hpdarurat) {
          const d = b.match(/(?:hp|telp|telepon)\s*darurat\s*[:\-]?\s*([+0-9][0-9\s-]{7,})/i);
          if (d) { hasil.hpdarurat = d[1].replace(/[^0-9+]/g, ''); return; }
        }
        if (!hasil.hp) { const hp = b.match(/(?:\+62|62|0)8[0-9\s-]{7,13}/); if (hp) { hasil.hp = hp[0].replace(/[^0-9+]/g, ''); return; } }
        if (!hasil.kamar) { const k = b.match(/kamar\s*(?:no\.?|nomor)?\s*[:\-]?\s*([0-9]{1,4}[A-Za-z]?)/i); if (k) { hasil.kamar = k[1].toUpperCase(); return; } }
        if (!hasil.nama) {
          const n = b.match(/(?:saya|nama saya|aku|namaku)\s+([A-Za-z][A-Za-z .'’]{2,50})/i);
          if (n) { hasil.nama = n[1].trim().replace(/\s+(mau|ingin|yang|untuk)$/i, ''); return; }
        }
      });

      // cerita satu paragraf ("Saya ingin sewa kamar 601 mulai 20/12/2026. Nama saya Andi...")
      if (!hasil.kamar || !hasil.tgl || !hasil.nama) {
        const teksSemua = String(teks || '').replace(/\n/g, ' ');
        if (!hasil.kamar) { const k = teksSemua.match(/kamar\s*(?:no\.?|nomor)?\s*[:\-]?\s*([0-9]{1,4}[A-Za-z]?)/i); if (k) hasil.kamar = k[1].toUpperCase(); }
        if (!hasil.tgl) {
          const t = teksSemua.match(/(\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{1,2}\s+[A-Za-z]+\s+\d{4})/);
          if (t) hasil.tgl = normTglWa(t[1]);
        }
        if (!hasil.nama) {
          const n = teksSemua.match(/(?:nama saya|namaku|saya)\s+([A-Za-z][A-Za-z .'’]{2,50}?)(?=[,.]|\s+(?:ingin|mau|wa|whatsapp|hp|yg|yang)|$)/i);
          if (n) hasil.nama = n[1].trim();
        }
      }
      // tanggal yang masih berbentuk teks ("5 Desember 2026") dirapikan
      if (hasil.tgl && !/^\d{4}-\d{2}-\d{2}$/.test(hasil.tgl)) hasil.tgl = normTglWa(hasil.tgl) || '';
      // nomor HP: 62xxx -> 0xxx supaya seragam
      const rapikanHp = (v) => String(v || '').replace(/[^0-9+]/g, '').replace(/^\+?62/, '0').replace(/^\+/, '');
      hasil.hp = rapikanHp(hasil.hp);
      hasil.hpdarurat = rapikanHp(hasil.hpdarurat);
      return hasil;
    }

    function uraiPesanWa() {
      const h = uraiPesan(document.getElementById('wa-teks').value);
      const isi = (id, v) => { if (v) document.getElementById(id).value = v; };
      isi('wa-nama', h.nama); isi('wa-hp', h.hp); isi('wa-kontak', h.kontak);
      isi('wa-hpdarurat', h.hpdarurat); isi('wa-tgl', h.tgl);
      if (h.kamar) {
        const sel = document.getElementById('wa-kamar');
        if ([...sel.options].some((o) => o.value === h.kamar)) sel.value = h.kamar;
      }
      const kosong = [];
      if (!document.getElementById('wa-nama').value) kosong.push('nama');
      if (!document.getElementById('wa-hp').value) kosong.push('no HP');
      if (!document.getElementById('wa-kamar').value) kosong.push('kamar');
      showCustomAlert(kosong.length ? 'Perlu Dilengkapi' : 'Data Terbaca', kosong.length ? `Terbaca sebagian. Isi manual: ${kosong.join(', ')}.` : 'Semua data utama terbaca. Periksa lalu simpan.', kosong.length === 0);
    }

    async function simpanImporWa() {
      const nama = document.getElementById('wa-nama').value.trim();
      const hp = document.getElementById('wa-hp').value.trim();
      const kamar = document.getElementById('wa-kamar').value;
      const tgl = document.getElementById('wa-tgl').value;
      if (!nama || !hp || !kamar || !tgl) { showCustomAlert('Belum Lengkap', 'Nama, HP, kamar, dan tanggal masuk wajib diisi.', false); return; }
      showLoading(true);
      try {
        const file = document.getElementById('wa-ktp').files[0];
        let ktp = null;
        if (file) ktp = await HADE.handlers.uploadKtp(await perkecilGambar(file));
        const data = {
          nama, hp, kamar, tglMasuk: tgl,
          kontakDarurat: document.getElementById('wa-kontak').value.trim(),
          hpDarurat: document.getElementById('wa-hpdarurat').value.trim(),
          ktpKey: ktp ? ktp.kunci : '', ktpTipe: ktp ? ktp.tipe : '',
          sumber: 'wa',
        };
        const msg = await HADE.handlers.addTenant(data);
        cachedData = null; HADE.resetCache();
        showLoading(false);
        tutupImporWa();
        showCustomAlert('Tersimpan', msg, true);
        loadAllTenantsList();
      } catch (err) {
        showLoading(false);
        showCustomAlert('Gagal Menyimpan', err.message || String(err), false);
      }
    }

    // ================= PENGINGAT WHATSAPP =================
    // Alur tanpa biaya: aplikasi menyiapkan pesan, WhatsApp dibuka di perangkat Anda,
    // Anda menekan Send. Setelah itu pengingat ditandai terkirim (tidak dikirim dobel).
    let daftarPengingat = [];

    function pesanPengingat(p) {
      const tgl = String(p.jatuhTempo || '').slice(0, 10);
      const nominal = rp(p.jumlah);
      const kapan = p.terlambat > 0
        ? `sudah melewati jatuh tempo ${p.terlambat} hari`
        : (p.terlambat === 0 ? 'jatuh tempo hari ini' : `jatuh tempo ${Math.abs(p.terlambat)} hari lagi`);
      return `Halo ${p.nama},\n\nIni pengingat dari Kost Hade untuk tagihan sewa Kamar ${p.kamar} sebesar ${nominal} (${kapan}, tanggal ${tgl}).\n\nMohon diselesaikan agar penghunian tetap lancar. Bila sudah transfer, mohon balas pesan ini dengan bukti transfer. Terima kasih.\n\n- Admin Kost Hade`;
    }

    function linkWa(hp, pesan) {
      let nomor = String(hp || '').replace(/[^0-9]/g, '');
      if (nomor.startsWith('0')) nomor = '62' + nomor.slice(1);
      if (!nomor) return null;
      return `https://wa.me/${nomor}?text=${encodeURIComponent(pesan)}`;
    }

    async function muatPengingat() {
      const tbody = document.getElementById('table-pengingat');
      try {
        const r = await fetch('/api/pengingat', { credentials: 'same-origin' });
        if (!r.ok) throw new Error('Gagal memuat daftar pengingat.');
        daftarPengingat = await r.json();
      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-rose-500 text-sm">${esc(err.message)}</td></tr>`;
        return;
      }
      const kartu = document.getElementById('pengingat-kartu');
      const btnSemua = document.getElementById('btn-kirim-semua');
      const perluKirim = daftarPengingat.filter((p) => !p.sudahDiingatkan && p.hp).length;
      if (btnSemua) {
        btnSemua.disabled = perluKirim === 0;
        btnSemua.title = perluKirim === 0 ? 'Tidak ada tagihan yang perlu diingatkan' : `Kirim ke ${perluKirim} penyewa`;
      }
      if (!daftarPengingat.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-emerald-600 text-sm font-bold">Semua tagihan sudah lunas 🎉</td></tr>`;
        kartu.innerHTML = `<div class="py-8 text-center text-emerald-600 text-sm font-bold">Semua tagihan sudah lunas 🎉</div>`;
        return;
      }
      tbody.innerHTML = daftarPengingat.map((p) => {
        const lewat = p.terlambat > 0;
        const badge = 'inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wide border whitespace-nowrap';
        // semua status memakai bentuk badge yang sama (dulu "H-13" tampil sebagai bentuk lain)
        const status = p.sudahDiingatkan
          ? `<span class="${badge} bg-emerald-50 text-emerald-700 border-emerald-100">Sudah diingatkan</span>`
          : (lewat
              ? `<span class="${badge} bg-rose-50 text-rose-700 border-rose-100">Terlambat ${p.terlambat} hari</span>`
              : `<span class="${badge} bg-amber-50 text-amber-700 border-amber-100">${p.terlambat === 0 ? 'Jatuh tempo hari ini' : 'H-' + Math.abs(p.terlambat)}</span>`);
        return `
          <tr class="hover:bg-slate-50 transition text-slate-700 text-xs md:text-sm">
            <td class="py-3 px-5">
              <div class="font-bold text-slate-900 truncate max-w-[180px]">${esc(p.nama)}</div>
              <div class="text-[9px] text-slate-400 font-mono">${esc(p.kode)}</div>
            </td>
            <td class="py-3 px-4"><span class="px-2 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-100 font-black text-[10px]">${esc(p.kamar)}</span></td>
            <td class="py-3 px-4 whitespace-nowrap text-slate-500">${esc(String(p.jatuhTempo).slice(0, 10))}</td>
            <td class="py-3 px-4 font-extrabold text-slate-800 whitespace-nowrap text-right">${rp(p.jumlah)}</td>
            <td class="py-3 px-4 text-center">${status}</td>
            <td class="py-3 px-5 text-center whitespace-nowrap">
              ${p.hp
                ? `<button data-aksi="wa-pengingat" data-bill="${esc(p.billId)}" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[10px] uppercase tracking-wide transition"><i class="fab fa-whatsapp"></i>Kirim</button>`
                : `<button type="button" disabled class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 text-slate-400 border border-slate-200 font-bold text-[10px] uppercase tracking-wide cursor-not-allowed" title="Isi nomor WhatsApp penyewa di menu Penyewa"><i class="fab fa-whatsapp"></i>Tanpa HP</button>`}
            </td>
          </tr>`;
      }).join('');

      // versi seluler: satu kartu per penyewa
      kartu.innerHTML = daftarPengingat.map((p) => {
        const badge = 'inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wide border whitespace-nowrap';
        const status = p.sudahDiingatkan
          ? `<span class="${badge} bg-emerald-50 text-emerald-700 border-emerald-100">Sudah diingatkan</span>`
          : (p.terlambat > 0
              ? `<span class="${badge} bg-rose-50 text-rose-700 border-rose-100">Terlambat ${p.terlambat} hari</span>`
              : `<span class="${badge} bg-amber-50 text-amber-700 border-amber-100">${p.terlambat === 0 ? 'Jatuh tempo hari ini' : 'H-' + Math.abs(p.terlambat)}</span>`);
        return `
          <div class="p-4">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="font-extrabold text-slate-900 text-sm truncate">${esc(p.nama)}</div>
                <div class="text-[10px] text-slate-400 font-mono mt-0.5">${esc(p.kode)} · Kamar ${esc(p.kamar)}</div>
              </div>
              ${status}
            </div>
            <div class="flex items-end justify-between gap-3 mt-3">
              <div>
                <div class="text-[10px] text-slate-400 uppercase font-bold tracking-wider">Tagihan</div>
                <div class="font-extrabold text-slate-800 text-sm">${rp(p.jumlah)}</div>
                <div class="text-[10px] text-slate-400 mt-0.5">Jatuh tempo ${esc(String(p.jatuhTempo).slice(0, 10))}</div>
              </div>
              ${p.hp
                ? `<button data-aksi="wa-pengingat" data-bill="${esc(p.billId)}" class="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[10px] uppercase tracking-wide transition shrink-0"><i class="fab fa-whatsapp"></i>Kirim</button>`
                : `<span class="px-3 py-2 rounded-lg bg-slate-100 text-slate-400 border border-slate-200 font-bold text-[10px] uppercase tracking-wide">Tanpa HP</span>`}
            </div>
          </div>`;
      }).join('');
    }

    // buka WhatsApp + tandai terkirim
    function kirimPengingatWa(billId) {
      const p = daftarPengingat.find((x) => String(x.billId) === String(billId));
      if (!p) return;
      const tautan = linkWa(p.hp, pesanPengingat(p));
      if (!tautan) { showCustomAlert('HP Kosong', 'Isi nomor WhatsApp penyewa lebih dulu di menu Penyewa.', false); return; }
      window.open(tautan, '_blank', 'noopener');
      HADE.handlers.catatPengingat(billId).then(() => muatPengingat()).catch((err) => console.warn('[hade] pengingat', err));
    }

    function kirimSemuaPengingat() {
      const belum = daftarPengingat.filter((p) => !p.sudahDiingatkan && p.hp);
      if (!belum.length) { showCustomAlert('Tidak Ada', 'Semua tagihan sudah diingatkan atau belum ada HP.', false); return; }
      showCustomAlert('Buka Pengingat', `Membuka ${belum.length} percakapan WhatsApp. Browser biasanya memblokir banyak tab sekaligus — buka beberapa pada satu waktu?`, true, true, () => {
        belum.slice(0, 5).forEach((p, i) => setTimeout(() => kirimPengingatWa(p.billId), i * 800));
        if (belum.length > 5) showCustomAlert('Sisa Antrian', `${belum.length - 5} penyewa lagi belum dibuka. Klik kirim per baris setelah ini.`, true);
      });
    }

    function filterPayments() {
      const q = document.getElementById('payment-search').value.toLowerCase().trim();
      if (!cachedData) return;
      const filtered = cachedData.transaksi.filter(t => {
        return t[1].toLowerCase().includes(q) || t[2].toLowerCase().includes(q) || t[4].toLowerCase().includes(q);
      });
      renderPaymentsHistory(filtered);
    }

    // AUTOMATIC DEFAULT PRICING & TYPE HANDLERS
    // Saran harga hanya untuk kamar yang BELUM ada di database. Kalau nomor kamar sudah terdaftar,
    // jangan sentuh isian (dulu mengetik ulang nomor saat edit diam-diam mengubah harga kamar).
    function saranHargaKamar(no, room) {
      if (!/^\d+$/.test(no) || !room) return;
      const sudahAda = (cachedData && cachedData.kamar || []).some(k => k[0] === no);
      if (sudahAda) return;
      const deluxe = ['106', '107'].includes(no);
      room.tipe.value = deluxe ? 'Deluxe' : 'Standar';
      room.bulanan.value = deluxe ? 1250000 : 1100000;
      room.harian.value = 100000;
    }

    document.querySelector('input[name="noKamar"]').addEventListener('input', function() {
      saranHargaKamar(this.value.trim(), {
        tipe: document.querySelector('input[name="tipe"]'),
        bulanan: document.querySelector('input[name="hargaBulanan"]'),
        harian: document.querySelector('input[name="hargaHarian"]'),
      });
    });

    // (Auto-isi harga saat edit DIHAPUS: mengetik nomor kamar tidak boleh mengubah tipe/harga
    // yang sudah tersimpan — harga hanya berubah bila diisi manual di form edit.)

    // OPEN & CLOSE EDIT TENANT MODAL
    function openEditTenantModal(id, nama, hp, kamar, tglMasuk, status, jatuhTempo) {
      document.getElementById('edit-tenant-id').value = id;
      document.getElementById('edit-tenant-nama').value = nama;
      document.getElementById('edit-tenant-hp').value = hp;
      document.getElementById('edit-tenant-old-kamar').value = kamar;
      document.getElementById('edit-tenant-tglmasuk').value = tglMasuk;
      document.getElementById('edit-tenant-status').value = (String(status).toLowerCase() === 'keluar') ? 'keluar' : 'aktif';
      document.getElementById('edit-tenant-tempo').value = jatuhTempo;
      const p = (cachedData && cachedData.penyewa || []).find(x => x[0] === id) || [];
      document.getElementById('edit-tenant-kontak').value = p[9] || '';
      document.getElementById('edit-tenant-hpdarurat').value = p[10] || '';
      ktpEditTerpilih = null;
      document.getElementById('edit-input-ktp').value = '';
      document.getElementById('edit-ktp-info').innerHTML = p[11] === 'ada'
        ? '<span class="text-emerald-600 font-bold">Foto KTP sudah tersimpan.</span> <a class="text-blue-600 underline font-bold" target="_blank" rel="noopener" href="' + esc('/api/ktp/penyewa/' + encodeURIComponent(p[0])) + '">Lihat foto</a>'
        : '<span class="text-rose-500 font-bold">Belum ada foto KTP.</span>';

      const select = document.getElementById('edit-tenant-kamar');
      select.innerHTML = `<option value="${kamar}">${kamar}</option>`;
      if (cachedData) {
        const availableRooms = cachedData.kamar.filter(k => k[4] === 'Tersedia').map(k => k[0]);
        availableRooms.forEach(r => {
          if (r !== kamar) {
            select.innerHTML += `<option value="${r}">${r}</option>`;
          }
        });
      }

      const modal = document.getElementById('edit-tenant-modal');
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }

    function closeEditTenantModal() {
      const modal = document.getElementById('edit-tenant-modal');
      modal.classList.remove('flex');
      modal.classList.add('hidden');
    }

    // ---- PINDAH KAMAR ----
    // Beda dengan "Pindah Suite Kamar" di modal edit (yang berlaku hari ini juga):
    // di sini tanggal pindah bisa dipilih, termasuk akhir bulan (terjadwal).
    function bukaPindahKamar(kode, nama, kamarAsal) {
      document.getElementById('pindah-kamar-id').value = kode;
      document.getElementById('pindah-kamar-asal').value = kamarAsal;
      const sel = document.getElementById('pindah-kamar-tujuan');
      const daftar = ((cachedData && cachedData.kamar) || [])
        .filter((k) => ['Tersedia', 'tersedia'].includes(k[4]) && k[0] !== kamarAsal)
        .map((k) => k[0]);
      sel.innerHTML = daftar.length
        ? daftar.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')
        : '<option value="">(tidak ada kamar kosong)</option>';
      const tgl = document.getElementById('pindah-kamar-tanggal');
      tgl.value = new Date().toLocaleDateString('en-CA');
      tgl.min = new Date().toLocaleDateString('en-CA');
      document.getElementById('pindah-kamar-info').innerHTML =
        `<b>${esc(nama)}</b> — kamar sekarang <b>${esc(kamarAsal || '-')}</b>.`
        + (daftar.length ? '' : ' <span class="text-rose-600 font-bold">Semua kamar lain terisi; kosongkan dulu satu kamar.</span>');
      document.getElementById('pindah-kamar-simpan').disabled = !daftar.length;
      document.getElementById('pindah-kamar-simpan').classList.toggle('opacity-40', !daftar.length);
      const modal = document.getElementById('pindah-kamar-modal');
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }

    function closePindahKamarModal() {
      const modal = document.getElementById('pindah-kamar-modal');
      modal.classList.remove('flex');
      modal.classList.add('hidden');
    }

    (function () {
      const tombol = document.getElementById('pindah-kamar-simpan');
      if (!tombol) return;
      tombol.onclick = function () {
        const id = document.getElementById('pindah-kamar-id').value;
        const kamar = document.getElementById('pindah-kamar-tujuan').value;
        const tanggal = document.getElementById('pindah-kamar-tanggal').value;
        if (!kamar) { showCustomAlert('Kamar Kosong', 'Belum ada kamar tujuan yang bisa dipilih.', false); return; }
        if (!tanggal) { showCustomAlert('Tanggal Kosong', 'Isi tanggal mulai pindah kamar.', false); return; }
        tombol.disabled = true;
        showLoading(true);
        google.script.run.withFailureHandler((err) => {
          tombol.disabled = false;
          showLoading(false);
          handleError(err);
        }).withSuccessHandler((msg) => {
          tombol.disabled = false;
          showLoading(false);
          closePindahKamarModal();
          showCustomAlert('Berhasil', msg, true);
          loadAllTenantsList();
        }).pindahKamar({ id, kamar, tanggal });
      };
    })();

    // OPEN & CLOSE EDIT MODAL
    function openEditRoomModal(noKamar, tipe, hargaBulanan, hargaHarian) {
      document.getElementById('edit-old-noKamar').value = noKamar;
      document.getElementById('edit-noKamar').value = noKamar;
      document.getElementById('edit-tipe').value = tipe;
      document.getElementById('edit-hargaBulanan').value = hargaBulanan;
      document.getElementById('edit-hargaHarian').value = hargaHarian;

      const modal = document.getElementById('edit-room-modal');
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }

    function closeEditRoomModal() {
      const modal = document.getElementById('edit-room-modal');
      modal.classList.remove('flex');
      modal.classList.add('hidden');
    }

    // OPERATIONAL LEDGER METHODS
    function loadLedgerData() {
      showLoading(true);
      google.script.run
        .withFailureHandler(handleError)
        .withSuccessHandler(responseString => {
          const ledgerList = JSON.parse(responseString);
          renderLedgerTable(ledgerList);
          showLoading(false);
        }).getOpsTransactions();
    }

    function renderLedgerTable(items) {
      const tbody = document.getElementById('table-ops-ledger');
      
      // Filter the list depending on selected filter button
      const filtered = items.filter(item => {
        if (selectedOpsFilter === 'Semua') return true;
        return item[2] === selectedOpsFilter;
      });

      if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-12 text-center text-slate-400 text-sm italic">Buku ledger operasional masih kosong.</td></tr>`;
        return;
      }

      tbody.innerHTML = filtered.map(item => {
        let isIncome = item[2] === 'Pendapatan';
        let displaySign = '-';
        let colorClass = 'bg-rose-50 text-rose-600 border border-rose-100';
        let textCol = 'text-rose-600';
        
        if (item[2] === 'Pendapatan') {
          isIncome = true;
          displaySign = '+';
          colorClass = 'bg-emerald-50 text-emerald-600 border border-emerald-100';
          textCol = 'text-emerald-600';
        } else if (item[2] === 'Pengeluaran') {
          isIncome = false;
          displaySign = '-';
          colorClass = 'bg-rose-50 text-rose-600 border border-rose-100';
          textCol = 'text-rose-600';
        } else if (item[2] === 'Neraca') {
          colorClass = 'bg-blue-50 text-blue-600 border border-blue-100';
          const dNeraca = dampakKas(item);
          if (dNeraca > 0) {
            isIncome = true;
            displaySign = '+';
            textCol = 'text-emerald-600';
          } else if (dNeraca < 0) {
            isIncome = false;
            displaySign = '-';
            textCol = 'text-rose-600';
          } else {
            // Penyusutan Aset Tetap (Non-cash)
            displaySign = '';
            textCol = 'text-slate-500';
          }
        }

        return `
          <tr class="hover:bg-slate-50 transition border-b border-slate-100 last:border-0 text-slate-700 text-xs md:text-sm">
            <td class="py-4 px-6 text-slate-500 font-medium whitespace-nowrap">${item[1]}</td>
            <td class="py-4 px-4">
              <span class="px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider ${colorClass}">
                ${item[2]}
              </span>
            </td>
            <td class="py-4 px-4 font-bold text-slate-800">${esc(item[3])}</td>
            <td class="py-4 px-4 font-extrabold ${textCol} whitespace-nowrap">
              ${displaySign} ${rp(item[4])}
            </td>
            <td class="py-4 px-4 text-slate-500 font-medium max-w-[200px] truncate" title="${esc(item[5])}">${esc(item[5])}</td>
            <td class="py-4 px-6 text-center">
              <button data-aksi="void-ledger" data-id="${esc(item[0])}" data-ket="${esc(item[5])}" class="w-11 h-11 md:w-8 md:h-8 rounded-lg bg-red-50 hover:bg-red-100 text-red-500 border border-red-100 flex items-center justify-center mx-auto transition btn-delete-action" title="Hapus Transaksi">
                <i class="fas fa-trash-alt text-[10px]"></i>
              </button>
            </td>
          </tr>
        `;
      }).join('');
    }

    function filterOpsLedger(type) {
      selectedOpsFilter = type;
      document.querySelectorAll('#sec-transaksi-ops button[id^="btn-ops-"]').forEach(btn => {
        btn.className = "px-3 py-1.5 text-xs font-bold rounded-lg text-slate-500 hover:text-slate-800 transition";
      });
      const activeMap = { Semua: 'all', Pendapatan: 'income', Pengeluaran: 'expense', Neraca: 'neraca' };
      const activeBtn = document.getElementById('btn-ops-' + activeMap[type]);
      if (activeBtn) {
        activeBtn.className = "px-3 py-1.5 text-xs font-bold rounded-lg bg-gradient-to-r from-blue-600 to-rose-600 text-white shadow-md transition";
      }
      loadLedgerData();
    }

    function filterLedgerData() {
      const q = document.getElementById('ops-search').value.toLowerCase().trim();
      google.script.run
        .withFailureHandler(handleError)
        .withSuccessHandler(responseString => {
          const items = JSON.parse(responseString);
          const filtered = items.filter(item => {
            return item[3].toLowerCase().includes(q) || item[5].toLowerCase().includes(q);
          });
          renderLedgerTable(filtered);
        }).getOpsTransactions();
    }

    function promptDeleteOpsTransaction(id, desc) {
      showCustomAlert(
        "Hapus Transaksi?",
        `Apakah Anda yakin ingin menghapus pencatatan transaksi "${desc}" dari buku ledger? Tindakan ini akan mengoreksi ulang kas laporan keuangan secara permanen.`,
        false,
        true,
        () => {
          showLoading(true);
          google.script.run
            .withFailureHandler(handleError)
            .withSuccessHandler(msg => {
              cachedData = null; // force reload dashboard calculations
              showLoading(false);
              showCustomAlert("Berhasil Dihapus", msg, true);
              loadLedgerData();
            }).deleteOpsTransaction(id);
        }
      );
    }

    // USER MAINTENANCE FUNCTIONS (CRUD)
    function loadUsersData() {
      showLoading(true);
      google.script.run
        .withFailureHandler(handleError)
        .withSuccessHandler(responseString => {
          usersList = JSON.parse(responseString);
          renderUsersTable(usersList);
          showLoading(false);
        }).getUsers();
    }

    function renderUsersTable(items) {
      const tbody = document.getElementById('table-user-list');
      if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="py-12 text-center text-slate-400 text-sm italic">Belum ada pengguna terdaftar.</td></tr>`;
        return;
      }

      tbody.innerHTML = items.map(u => {
        const isAdmin = u.role === 'admin' || u.role === 'Administrator';
        return `
          <tr class="hover:bg-slate-50 transition border-b border-slate-100 last:border-0 text-slate-700 text-xs md:text-sm">
            <td class="py-4 px-6 font-bold text-slate-800">${esc(u.username)}</td>
            <td class="py-4 px-4 font-semibold">${esc(u.fullname)}</td>
            <td class="py-4 px-4">${u.hp ? esc(u.hp) : '<span class="text-slate-300">—</span>'}</td>
            <td class="py-4 px-4">
              <span class="px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider ${isAdmin ? 'bg-rose-50 text-rose-600 border border-rose-100' : 'bg-blue-50 text-blue-600 border border-blue-100'}">
                ${u.role}
              </span>
            </td>
            <td class="py-4 px-6 text-center">
              <div class="flex items-center justify-center gap-1.5">
                ${u.aktif === 0 ? '<span class="text-[9px] font-black text-slate-400 uppercase">Nonaktif</span>' : ''}
                <button data-aksi="edit-user" data-id="${esc(u.id)}" data-username="${esc(u.username)}" data-fullname="${esc(u.fullname)}" data-role="${esc(u.role)}" data-hp="${esc(u.hp || '')}" class="w-11 h-11 md:w-8 md:h-8 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-600 border border-blue-100 flex items-center justify-center transition" title="Ubah Pengguna">
                  <i class="fas fa-edit text-[10px]"></i>
                </button>
                <button data-aksi="hapus-user" data-id="${esc(u.id)}" data-fullname="${esc(u.fullname)}" data-username="${esc(u.username)}" class="w-11 h-11 md:w-8 md:h-8 rounded-lg bg-red-50 hover:bg-red-100 text-red-500 border border-red-100 flex items-center justify-center transition btn-delete-action" title="Hapus Pengguna">
                  <i class="fas fa-trash-alt text-[10px]"></i>
                </button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    }

    function filterUsersTable() {
      const q = document.getElementById('user-search').value.toLowerCase().trim();
      const filtered = usersList.filter(u => {
        return u.username.toLowerCase().includes(q) || u.fullname.toLowerCase().includes(q);
      });
      renderUsersTable(filtered);
    }

    function startEditUser(id, username, fullname, role, hp) {
      document.getElementById('user-edit-id').value = id;
      document.getElementById('user-username').value = username;
      const elHp = document.getElementById('user-hp'); if (elHp) elHp.value = hp || '';
      document.getElementById('user-fullname').value = fullname;
      document.getElementById('user-password').value = '';
      document.getElementById('user-password').required = false;
      document.getElementById('user-password').placeholder = 'Kosongkan bila tidak diganti';
      // Role master tetap ditampilkan apa adanya (hanya master yang bisa memilihnya)
      const roleAktif = String(role || '').toLowerCase();
      document.getElementById('user-role').value =
        roleAktif === 'admin' ? 'admin' : (roleAktif === 'master' ? 'master' : 'staff');

      document.getElementById('user-form-title').innerText = "Ubah Pengguna";
      document.getElementById('user-form-desc').innerText = "Sesuaikan kata sandi, nama, atau wewenang";
      document.getElementById('btn-save-user').innerHTML = '<i class="fas fa-check-circle"></i> Simpan Perubahan';
      document.getElementById('btn-cancel-edit-user').classList.remove('hidden');
    }

    function cancelEditUser() {
      document.getElementById('user-edit-id').value = "";
      document.getElementById('form-user').reset();
      document.getElementById('user-password').required = true;
      document.getElementById('user-password').placeholder = '••••••••';

      document.getElementById('user-form-title').innerText = "Tambah Pengguna";
      document.getElementById('user-form-desc').innerText = "Daftarkan operator atau admin baru ke database";
      document.getElementById('btn-save-user').innerHTML = '<i class="fas fa-check"></i> Simpan User';
      document.getElementById('btn-cancel-edit-user').classList.add('hidden');
    }

    function promptDeleteUser(id, fullname, username) {
      // SECURITY VERIFICATIONS
      if (id === activeUser.id) {
        showCustomAlert("Aksi Ditolak", "Anda tidak diperkenankan menghapus akun sendiri yang sedang digunakan dalam sesi aktif ini.", false);
        return;
      }

      const adminCount = usersList.filter(u => u.role === 'Administrator').length;
      const targetUser = usersList.find(u => u.id === id);
      if (targetUser && targetUser.role === 'Administrator' && adminCount <= 1) {
        showCustomAlert("Proteksi Sistem", "Aksi gagal. Sistem wajib mempertahankan minimal satu akun level Administrator untuk mencegah penguncian sistem (system lockout).", false);
        return;
      }

      showCustomAlert(
        "Hapus Pengguna?",
        `Apakah Anda yakin ingin menghapus user "${fullname}" (@${username})? Akun ini tidak akan dapat digunakan lagi untuk mengelola guesthouse.`,
        false,
        true,
        () => {
          showLoading(true);
          google.script.run
            .withFailureHandler(handleError)
            .withSuccessHandler(msg => {
              showLoading(false);
              showCustomAlert("Berhasil Dihapus", msg, true);
              loadUsersData();
            }).deleteUser(id);
        }
      );
    }

    // CATEGORY CRUD LOGICS
    function loadCategoriesData() {
      showLoading(true);
      google.script.run
        .withFailureHandler(handleError)
        .withSuccessHandler(responseString => {
          const data = JSON.parse(responseString);
          categoryOptions = data;

          let flatCategories = [];
          Object.keys(data).forEach(jenis => {
            data[jenis].forEach((catObj, index) => {
              flatCategories.push({
                id: catObj.id,
                jenis: jenis,
                nama: catObj.nama,
                saldoNormal: catObj.saldoNormal,
                arusKas: catObj.arusKas,
                originalIndex: index
              });
            });
          });
          renderCategoriesTable(flatCategories);
          showLoading(false);
        }).getCategories();
    }

    function renderCategoriesTable(items) {
      const tbody = document.getElementById('table-category-list');
      if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="py-12 text-center text-slate-400 text-sm italic">Belum ada kategori terdaftar.</td></tr>`;
        return;
      }

      tbody.innerHTML = items.map((item, idx) => {
        let badgeColor = "bg-rose-50 text-rose-600 border border-rose-100";
        if (item.jenis === "Pendapatan") badgeColor = "bg-emerald-50 text-emerald-600 border border-emerald-100";
        if (item.jenis === "Neraca") badgeColor = "bg-blue-50 text-blue-600 border border-blue-100";

        let snBadge = item.saldoNormal === "Debet" ? "bg-sky-50 text-sky-700 border border-sky-100" : "bg-amber-50 text-amber-700 border border-amber-100";

        return `
          <tr class="hover:bg-slate-50 transition border-b border-slate-100 last:border-0 text-slate-700 text-xs md:text-sm">
            <td class="py-4 px-6 text-center font-bold text-slate-400">${idx + 1}</td>
            <td class="py-4 px-4">
              <span class="px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider ${badgeColor}">
                ${item.jenis}
              </span>
            </td>
            <td class="py-4 px-4 font-bold text-slate-800">${esc(item.nama)}</td>
            <td class="py-4 px-4 text-center">
              <span class="px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider ${snBadge}">
                ${item.saldoNormal}
              </span>
            </td>
            <td class="py-4 px-6 text-center">
              <div class="flex items-center justify-center gap-1.5">
                <button data-aksi="edit-kategori" data-id="${esc(item.id)}" data-jenis="${esc(item.jenis)}" data-nama="${esc(item.nama)}" data-saldo="${esc(item.saldoNormal)}" class="w-11 h-11 md:w-8 md:h-8 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-600 border border-blue-100 flex items-center justify-center transition" title="Edit Kategori">
                  <i class="fas fa-edit text-[10px]"></i>
                </button>
                <button data-aksi="hapus-kategori" data-id="${esc(item.id)}" data-nama="${esc(item.nama)}" class="w-11 h-11 md:w-8 md:h-8 rounded-lg bg-red-50 hover:bg-red-100 text-red-500 border border-red-100 flex items-center justify-center transition btn-delete-action" title="Hapus Kategori">
                  <i class="fas fa-trash-alt text-[10px]"></i>
                </button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    }

    function filterCategoriesTable() {
      const q = document.getElementById('category-search').value.toLowerCase().trim();
      refreshCategoryOptions();
      let flatCategories = [];
      Object.keys(categoryOptions).forEach(jenis => {
        categoryOptions[jenis].forEach((catObj, index) => {
          if (jenis.toLowerCase().includes(q) || catObj.nama.toLowerCase().includes(q) || catObj.saldoNormal.toLowerCase().includes(q)) {
            flatCategories.push({ id: catObj.id, jenis: jenis, nama: catObj.nama, saldoNormal: catObj.saldoNormal, arusKas: catObj.arusKas, originalIndex: index });
          }
        });
      });
      renderCategoriesTable(flatCategories);
    }

    function startEditCategory(id, jenis, nama, saldoNormal) {
      document.getElementById('category-edit-id').value = String(id);
      document.getElementById('category-jenis').value = jenis;
      document.getElementById('category-nama').value = nama;
      document.getElementById('category-saldoNormal').value = saldoNormal || "Debet";

      document.getElementById('category-form-title').innerText = "Edit Kategori";
      document.getElementById('category-form-desc').innerText = "Ubah pemetaan akun atau nama kategori";
      document.getElementById('btn-save-category').innerHTML = '<i class="fas fa-check-circle"></i> Simpan Perubahan';
      document.getElementById('btn-cancel-edit-category').classList.remove('hidden');
    }

    function cancelEditCategory() {
      document.getElementById('category-edit-id').value = "";
      document.getElementById('form-kategori').reset();

      document.getElementById('category-form-title').innerText = "Kelola Kategori";
      document.getElementById('category-form-desc').innerText = "Atur pengelompokan jenis akun akuntansi guesthouse";
      document.getElementById('btn-save-category').innerHTML = '<i class="fas fa-plus-circle"></i> Simpan Kategori';
      document.getElementById('btn-cancel-edit-category').classList.add('hidden');
    }

    function promptDeleteCategory(id, nama) {
      showCustomAlert(
        "Hapus Kategori?",
        `Apakah Anda yakin ingin menghapus kategori "${nama}"? Bila sudah dipakai transaksi, kategori hanya dinonaktifkan agar laporan lama tetap utuh.`,
        false,
        true,
        () => {
          showLoading(true);
          google.script.run
            .withFailureHandler(handleError)
            .withSuccessHandler(msg => {
              cachedData = null; // force reload reports cache
              showLoading(false);
              showCustomAlert("Berhasil Dihapus", msg, true);
              loadCategoriesData();
              refreshCategoryOptions();
            }).deleteCategory({ id: id });
        }
      );
    }

    // SUBMISSIONS
    document.getElementById('form-user').onsubmit = function(e) {
      e.preventDefault();
      const editId = document.getElementById('user-edit-id').value;
      const username = document.getElementById('user-username').value.trim().toLowerCase();
      const fullname = document.getElementById('user-fullname').value.trim();
      const password = document.getElementById('user-password').value;
      const role = document.getElementById('user-role').value;
      // No. HP wajib: ini identitas login. Cek di klien supaya pesannya jelas,
      // server tetap memvalidasi ulang.
      const hpIsi = (document.getElementById('user-hp') || {}).value || '';
      if (!hpIsi.trim()) {
        showCustomAlert('Perhatian', 'No. HP wajib diisi — nomor ini dipakai untuk login.', false);
        return;
      }
      showLoading(true);
      if (editId) {
        google.script.run
          .withFailureHandler(handleError)
          .withSuccessHandler(msg => {
            showLoading(false);
            showCustomAlert("Sukses", msg, true);
            cancelEditUser();
            loadUsersData();
            // If editing current user, reload active session
            if (editId === activeUser.id) {
              activeUser = { ...activeUser, username, fullname, role: role === 'admin' ? 'admin' : 'staff' };
              applyUserRoleUI();
            }
          }).editUser({ id: editId, username, fullname, password: password || undefined, role, hp: (document.getElementById('user-hp') || {}).value || '' });
      } else {
        google.script.run
          .withFailureHandler(handleError)
          .withSuccessHandler(msg => {
            showLoading(false);
            showCustomAlert("Sukses", msg, true);
            this.reset();
            loadUsersData();
          }).addUser({ username, fullname, password, role, hp: (document.getElementById('user-hp') || {}).value || '' });
      }
    };

    document.getElementById('form-kategori').onsubmit = function(e) {
      e.preventDefault();
      showLoading(true);
      const editId = document.getElementById('category-edit-id').value;
      const jenis = document.getElementById('category-jenis').value;
      const nama = document.getElementById('category-nama').value.trim();
      const saldoNormal = document.getElementById('category-saldoNormal').value;

      if (editId) {
        // UPDATE MODE (id asli dari database)
        google.script.run
          .withFailureHandler(handleError)
          .withSuccessHandler(msg => {
            cachedData = null;
            showLoading(false);
            showCustomAlert("Sukses", msg, true);
            cancelEditCategory();
            loadCategoriesData();
            refreshCategoryOptions();
          }).editCategory({ id: Number(editId), jenis: jenis, nama: nama, saldoNormal: saldoNormal });
      } else {
        // CREATE MODE
        google.script.run
          .withFailureHandler(handleError)
          .withSuccessHandler(msg => {
            cachedData = null;
            showLoading(false);
            showCustomAlert("Sukses", msg, true);
            this.reset();
            loadCategoriesData();
            refreshCategoryOptions();
          }).addCategory({ jenis: jenis, nama: nama, saldoNormal: saldoNormal });
      }
    };

    document.getElementById('form-transaksi').onsubmit = function(e) {
      e.preventDefault();
      showLoading(true);
      google.script.run
        .withFailureHandler(handleError)
        .withSuccessHandler(msg => {
          cachedData = null;
          showLoading(false);
          showCustomAlert("Sukses", msg, true);
          this.reset();
          document.getElementById('trans-tanggal').value = new Date().toISOString().split('T')[0];
          handleTransTypeChange();
          loadLedgerData();
        }).addOpsTransaction({
          jenis: this.jenis.value,
          tanggal: this.tanggal.value,
          kategori: this.kategori.value,
          jumlah: this.jumlah.value,
          keterangan: this.keterangan.value
        });
    };

    document.getElementById('form-kamar').onsubmit = function(e) {
      e.preventDefault(); 
      showLoading(true);
      google.script.run.withFailureHandler(handleError).withSuccessHandler(msg => {
        cachedData = null; 
        showLoading(false); 
        showCustomAlert("Sukses", msg, true); 
        this.reset(); 
        this.tipe.value = 'Standar';
        this.hargaBulanan.value = 1100000;
        this.hargaHarian.value = 100000;
        toggleRoomForm(); 
        loadDashboard();
      }).addRoom({
        noKamar: this.noKamar.value, 
        tipe: this.tipe.value, 
        hargaBulanan: this.hargaBulanan.value,
        hargaHarian: this.hargaHarian.value
      });
    };

    document.getElementById('form-edit-kamar').onsubmit = function(e) {
      e.preventDefault();
      showLoading(true);
      const oldNoKamar = document.getElementById('edit-old-noKamar').value;
      const noKamar = document.getElementById('edit-noKamar').value;
      const tipe = document.getElementById('edit-tipe').value;
      const hargaBulanan = document.getElementById('edit-hargaBulanan').value;
      const hargaHarian = document.getElementById('edit-hargaHarian').value;

      google.script.run.withFailureHandler(handleError).withSuccessHandler(msg => {
        cachedData = null;
        showLoading(false);
        closeEditRoomModal();
        showCustomAlert("Sukses", msg, true);
        loadDashboard();
      }).editRoom({
        oldNoKamar: oldNoKamar,
        noKamar: noKamar,
        tipe: tipe,
        hargaBulanan: hargaBulanan,
        hargaHarian: hargaHarian
      });
    };

    let ktpEditTerpilih = null;
    document.getElementById('edit-input-ktp').addEventListener('change', function () {
      const f = this.files && this.files[0];
      if (!f) return;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) { showCustomAlert('Format Salah', 'Foto KTP harus JPG, PNG, atau WEBP.', false); this.value = ''; return; }
      if (f.size > 5 * 1024 * 1024) { showCustomAlert('Terlalu Besar', 'Ukuran foto maksimal 5 MB.', false); this.value = ''; return; }
      document.getElementById('edit-ktp-info').innerHTML = '<span class="text-blue-600 font-bold">' + esc(f.name) + ' — diunggah saat disimpan</span>';
    });

    document.getElementById('form-edit-penyewa').onsubmit = async function(e) {
      e.preventDefault();
      showLoading(true);
      try {
        const file = document.getElementById('edit-input-ktp').files[0];
        if (file) ktpEditTerpilih = await HADE.handlers.uploadKtp(await perkecilGambar(file));
      } catch (err) {
        showLoading(false);
        showCustomAlert('Gagal Mengunggah', err.message || String(err), false);
        return;
      }
      showLoading(true);
      const id = document.getElementById('edit-tenant-id').value;
      const nama = document.getElementById('edit-tenant-nama').value;
      const hp = document.getElementById('edit-tenant-hp').value;
      const oldKamar = document.getElementById('edit-tenant-old-kamar').value;
      const kamar = document.getElementById('edit-tenant-kamar').value;
      const tglMasuk = document.getElementById('edit-tenant-tglmasuk').value;
      const status = document.getElementById('edit-tenant-status').value;

      // kirim HANYA field yang diubah: server membaca nilai kosong sebagai "hapus",
      // jadi mengirim '' untuk field yang tidak disentuh akan menghapus data lama.
      const asal = (cachedData && cachedData.penyewa || []).find((p) => p[0] === id) || [];
      const kontakNow = document.getElementById('edit-tenant-kontak').value.trim();
      const hpDaruratNow = document.getElementById('edit-tenant-hpdarurat').value.trim();
      const payload = { id, nama, hp, kamar, tglMasuk, status };
      if (kontakNow !== (asal[9] || '')) payload.kontakDarurat = kontakNow;
      if (hpDaruratNow !== (asal[10] || '')) payload.hpDarurat = hpDaruratNow;
      if (ktpEditTerpilih) { payload.ktpKey = ktpEditTerpilih.kunci; payload.ktpTipe = ktpEditTerpilih.tipe; }
      google.script.run.withFailureHandler(handleError).withSuccessHandler(msg => {
        cachedData = null;
        showLoading(false);
        closeEditTenantModal();
        showCustomAlert("Sukses", msg, true);
        loadAllTenantsList();
      }).editTenant(payload);
      return;
    };

    // Foto KTP: pratinjau lokal + unggah saat form disimpan.
    // Foto diperkecil dulu di browser (maks sisi 1600px, JPEG 0,82) supaya hemat kuota
    // dan tetap muat bila disimpan di D1 (batas baris ~2 MB).
    let ktpTerpilih = null;          // { kunci, tipe } hasil unggah
    let ktpPratinjauUrl = null;

    function perkecilGambar(file, maksSisi = 1600, kualitas = 0.82) {
      return new Promise((resolve) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
          URL.revokeObjectURL(url);
          const skala = Math.min(1, maksSisi / Math.max(img.width, img.height));
          const w = Math.round(img.width * skala), h = Math.round(img.height * skala);
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          canvas.toBlob((blob) => {
            if (!blob) { resolve(file); return; }
            resolve(new File([blob], 'ktp.jpg', { type: 'image/jpeg' }));
          }, 'image/jpeg', kualitas);
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
        img.src = url;
      });
    }

    document.getElementById('input-ktp').addEventListener('change', function () {
      const f = this.files && this.files[0];
      hapusPratinjauKtp(true);
      if (!f) return;
      const izin = ['image/jpeg', 'image/png', 'image/webp'];
      if (!izin.includes(f.type)) { showCustomAlert('Format Salah', 'Foto KTP harus JPG, PNG, atau WEBP.', false); this.value = ''; return; }
      if (f.size > 5 * 1024 * 1024) { showCustomAlert('Terlalu Besar', 'Ukuran foto maksimal 5 MB.', false); this.value = ''; return; }
      ktpPratinjauUrl = URL.createObjectURL(f);
      document.getElementById('ktp-img').src = ktpPratinjauUrl;
      document.getElementById('ktp-status').innerText = f.name + ' — diunggah saat disimpan';
      document.getElementById('ktp-preview').classList.remove('hidden');
    });

    function hapusPratinjauKtp(pertahankanFile) {
      ktpTerpilih = null;
      if (ktpPratinjauUrl) { URL.revokeObjectURL(ktpPratinjauUrl); ktpPratinjauUrl = null; }
      document.getElementById('ktp-preview').classList.add('hidden');
      if (!pertahankanFile) document.getElementById('input-ktp').value = '';
    }

    // tanggal check-in tidak boleh di masa depan (server menolak, tapi form sebaiknya mencegah lebih dulu)
    (function () {
      const el = document.querySelector('#form-penyewa [name="tglMasuk"]');
      if (el) el.max = new Date().toLocaleDateString('en-CA');
      const el2 = document.getElementById('input-tgl-pembayaran');
      if (el2) el2.max = new Date().toLocaleDateString('en-CA');
    })();

    // --- tanggal mulai tagihan: default mengikuti tanggal check-in ---
    function perbaruiInfoTagihan() {
      const masuk = document.getElementById('form-penyewa').tglMasuk.value;
      const mulaiEl = document.getElementById('input-mulai-tagihan');
      const penuh = document.getElementById('select-hari-penuh').value !== '0';
      if (!mulaiEl.dataset.diubah) mulaiEl.value = masuk || '';
      const info = document.getElementById('info-prorata');
      const kamarNo = document.getElementById('form-penyewa').kamar.value;
      const kamar = ((cachedData && cachedData.kamar) || []).find((k) => k[0] === kamarNo);
      const harga = kamar ? Number(kamar[2]) || 0 : 0;
      const tgl = mulaiEl.value;
      if (!harga || !tgl) { info.innerText = 'Pilih kamar untuk melihat nominal bulan pertama.'; return; }
      if (penuh) { info.innerText = `Nominal bulan pertama ${rp(harga)} (satu bulan penuh).`; return; }
      const [y, m, d] = tgl.split('-').map(Number);
      const hariBulan = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const sisa = hariBulan - d + 1;
      const nilai = Math.min(harga, Math.max(1000, Math.round((harga * sisa) / hariBulan / 1000) * 1000));
      info.innerText = `Prorata ${sisa} dari ${hariBulan} hari = ${rp(nilai)} (dibulatkan ke ribuan).`;
    }

    ['tglMasuk', 'kamar'].forEach((n) => {
      const el = document.querySelector(`#form-penyewa [name="${n}"]`);
      if (el) el.addEventListener('change', perbaruiInfoTagihan);
    });
    document.getElementById('input-mulai-tagihan').addEventListener('change', function () { this.dataset.diubah = '1'; perbaruiInfoTagihan(); });
    document.getElementById('select-hari-penuh').addEventListener('change', perbaruiInfoTagihan);

    document.getElementById('form-penyewa').onsubmit = async function(e) {
      e.preventDefault();
      const form = this;
      showLoading(true);
      try {
        // unggah foto lebih dulu; penyewa hanya disimpan bila foto berhasil
        const file = document.getElementById('input-ktp').files[0];
        if (file) {
          document.getElementById('ktp-status').innerText = 'Menyiapkan & mengunggah foto KTP…';
          const kecil = await perkecilGambar(file);
          ktpTerpilih = await HADE.handlers.uploadKtp(kecil);
        }
        const data = {
          nama: form.nama.value, hp: form.hp.value, kamar: form.kamar.value, tglMasuk: form.tglMasuk.value,
          mulaiTagihan: document.getElementById('input-mulai-tagihan').value || '',
          hariPenuh: document.getElementById('select-hari-penuh').value !== '0',
          kontakDarurat: form.kontakDarurat.value, hpDarurat: form.hpDarurat.value,
          ktpKey: ktpTerpilih ? ktpTerpilih.kunci : '', ktpTipe: ktpTerpilih ? ktpTerpilih.tipe : '',
        };
        google.script.run.withFailureHandler(handleError).withSuccessHandler(msg => {
          cachedData = null;
          showLoading(false);
          showCustomAlert("Sukses", msg, true);
          form.reset();
          const mt = document.getElementById('input-mulai-tagihan');
          mt.value = ''; delete mt.dataset.diubah;
          document.getElementById('select-hari-penuh').value = '1';
          hapusPratinjauKtp(true);
          showSection('dashboard', document.querySelector('#sidebar-nav button'));
        }).addTenant(data);
      } catch (err) {
        showLoading(false);
        showCustomAlert('Gagal Menyimpan', err.message || String(err), false);
      }
    };

    function resetBuktiBayar() {
      document.getElementById('input-bukti-bayar').value = '';
      const box = document.getElementById('bukti-pratinjau-box');
      box.innerHTML = '<span class="text-slate-400">Belum ada berkas</span>';
    }
    document.getElementById('input-bukti-bayar').addEventListener('change', function () {
      const f = this.files[0];
      const box = document.getElementById('bukti-pratinjau-box');
      if (!f) { resetBuktiBayar(); return; }
      if (f.type === 'application/pdf') {
        // nama berkas bisa berisi markup -> wajib di-escape (dulu <img onerror> di nama PDF tereksekusi)
        box.innerHTML = '<div class="text-center px-2"><i class="fas fa-file-pdf text-rose-500 text-lg"></i><div class="text-[10px] text-slate-500 truncate">' + esc(f.name) + '</div></div>';
        return;
      }
      const url = URL.createObjectURL(f);
      box.innerHTML = '<img src="' + url + '" class="h-full w-full object-cover">';
    });

    document.getElementById('form-pembayaran').onsubmit = async function(e) {
      e.preventDefault(); 
      const form = this;
      const fileBukti = document.getElementById('input-bukti-bayar').files[0];
      showLoading(true);
      let buktiKey = '';
      try {
        if (fileBukti) {
          // foto diperkecil dulu (PDF tidak disentuh) agar unggahan cepat & hemat kuota
          const berkas = fileBukti.type === 'application/pdf' ? fileBukti : await perkecilGambar(fileBukti);
          const up = await HADE.handlers.uploadBukti(berkas);
          buktiKey = (up && up.kunci) || '';
        }
      } catch (err) {
        showLoading(false);
        showCustomAlert('Gagal Unggah Bukti', err.message || String(err), false);
        return;
      }
      google.script.run.withFailureHandler(handleError).withSuccessHandler(msg => {
        cachedData = null; 
        showLoading(false); 
        showCustomAlert("Sukses", msg, true); 
        form.reset();
        resetBuktiBayar();
        showSection('dashboard', document.querySelector('#sidebar-nav button'));
      }).recordPayment({
        nama: this.nama.value, 
        kamar: this.kamar.value, 
        // jumlah bulan yang dibayar sekaligus (1 = biasa/bulanan, 3 = tiga bulan, 12 = setahun)
        bulan: Number(document.getElementById('input-durasi-sewa').value) || 1,
        tipeSewa: document.getElementById('select-tipe-sewa').value,
        buktiKey: buktiKey,
        jumlah: this.jumlah.value, 
        tanggal: document.getElementById('input-tgl-pembayaran').value,
        keterangan: this.keterangan.value
      });
    };

    // DIGITAL RECEIPT ACTIONS
    function viewReceipt(tgl, nama, kamar, jumlah, keterangan, nomorStruk) {
      document.getElementById('rcp-tgl').innerText = tgl;
      // nomor struk asli dari database (STR-YYYYMMDD-NNN); dulu dicetak nomor acak INV-xxxxxx
      const m = String(keterangan || '').match(/STR-\d{8}-\d{3}/);
      document.getElementById('rcp-id').innerText = String((m && m[0]) || nomorStruk || '-');
      document.getElementById('rcp-nama').innerText = nama;
      document.getElementById('rcp-kamar').innerText = kamar;
      document.getElementById('rcp-ket').innerText = keterangan;
      document.getElementById('rcp-total').innerText = rp(jumlah);

      const modal = document.getElementById('receipt-modal');
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }

    function closeReceiptModal() {
      const modal = document.getElementById('receipt-modal');
      modal.classList.remove('flex');
      modal.classList.add('hidden');
    }

    // Cetak lewat area cetak di dokumen yang sama (tanpa popup): di HP popup sering diblokir
    // dan dulu tombol Cetak tampak "tidak terjadi apa-apa".
    function cetakArea(idArea) {
      const area = document.getElementById(idArea);
      if (!area) { showCustomAlert('Gagal Cetak', 'Isi yang mau dicetak tidak ditemukan.', false); return; }
      document.body.classList.add('mode-cetak');
      area.classList.add('area-cetak');
      const bersihkan = () => {
        document.body.classList.remove('mode-cetak');
        area.classList.remove('area-cetak');
        window.removeEventListener('afterprint', bersihkan);
      };
      window.addEventListener('afterprint', bersihkan);
      try {
        window.print();
      } catch (err) {
        bersihkan();
        showCustomAlert('Gagal Cetak', 'Perangkat tidak mendukung cetak langsung. Coba dari menu peramban.', false);
      }
      // pengaman untuk peramban yang tidak memicu afterprint
      setTimeout(bersihkan, 60000);
    }

    function printReceipt() {
      cetakArea('receipt-print-area');
      return;
      // (jalur popup lama dipertahankan di bawah hanya sebagai rujukan)
      const printContents = document.getElementById('receipt-print-area').innerHTML;
      const printWindow = window.open('', '_blank');
      printWindow.document.write(`
        <html>
          <head>
            <title>Cetak Receipt Kost Hade Premium</title>
            <style>
              body { font-family: 'Plus Jakarta Sans', sans-serif; padding: 20px; font-size: 13px; color: #000; background: #fff; }
              .text-center { text-align: center; }
              .pb-4 { padding-bottom: 12px; }
              .border-b { border-bottom: 1px dashed #000; }
              .py-4 { padding-top: 12px; padding-bottom: 12px; }
              .space-y-2 > div { display: flex; justify-content: space-between; margin-bottom: 4px; }
              .font-bold { font-weight: bold; }
              .text-xl { font-size: 18px; }
              .mt-4 { margin-top: 15px; }
            </style>
          </head>
          <body onload="window.print(); window.close();">
            ${printContents}
          </body>
        </html>
      `);
      printWindow.document.close();
    }

    // INTERACTIVE CHECKOUT ACTION PROMPTER
    function promptTenantCheckout(tenantId, name, roomNo) {
      showCustomAlert(
        "Keluarkan Penyewa?",
        `Apakah Anda yakin ingin mengakhiri kontrak sewa ${name} di Suite ${roomNo}? Kamar ini akan dikosongkan dan siap dipasarkan kembali.`,
        false,
        true,
        () => {
          showLoading(true);
          google.script.run
            .withFailureHandler(handleError)
            .withSuccessHandler(msg => {
              cachedData = null;
              showLoading(false);
              showCustomAlert("Proses Selesai", msg, true);
              loadAllTenantsList(); // Reload view
            }).checkoutTenant(tenantId, roomNo);
        }
      );
    }

    // PROMPT DELETE TENANT DIRECTLY FROM TABLE
    function promptDeleteTenant(tenantId, name, roomNo, status) {
      let extraWarn = status === 'Aktif' ? ` Penyewa saat ini aktif menghuni Kamar ${roomNo}. Menghapus penyewa akan mengosongkan kamar tersebut.` : "";
      showCustomAlert(
        "Hapus Penyewa?",
        `Apakah Anda yakin ingin menghapus data penyewa ${name} secara permanen dari arsip database?${extraWarn}`,
        false,
        true,
        () => {
          showLoading(true);
          google.script.run
            .withFailureHandler(handleError)
            .withSuccessHandler(msg => {
              cachedData = null;
              showLoading(false);
              showCustomAlert("Berhasil Dihapus", msg, true);
              loadAllTenantsList();
            }).deleteTenant(tenantId, roomNo);
        }
      );
    }

    // =====================================================================
    // MENU PARAMETER (admin & master) — identitas kost + logo
    // =====================================================================
    /** Isi form Parameter dari kost aktif. Nama aplikasi dikunci bila sudah ada. */
    function isiFormParameter() {
      const k = activeKost || {};
      const namaEl = document.getElementById('param-nama-app');
      const kotaEl = document.getElementById('param-kota');
      const tagEl = document.getElementById('param-tagline');
      const hint = document.getElementById('param-nama-hint');
      if (!namaEl) return;
      namaEl.value = k.namaApp || '';
      kotaEl.value = k.kota || '';
      tagEl.value = k.tagline || '';
      // Nama aplikasi tidak boleh diubah setelah dibuat (dijaga juga oleh API)
      namaEl.readOnly = true;
      namaEl.classList.add('text-slate-500', 'cursor-not-allowed');
      if (hint) hint.innerText = k.namaApp
        ? 'Nama aplikasi tidak bisa diubah setelah dibuat.'
        : 'Nama aplikasi wajib diisi sekali dan tidak bisa diubah setelahnya.';
      terapkanBranding(activeKost);
    }

    /** Simpan kota/tagline (nama aplikasi ikut dikirim tetapi tidak bisa berubah). */
    async function simpanParameter(event) {
      if (event) event.preventDefault();
      const btn = document.getElementById('btn-simpan-parameter');
      const namaApp = document.getElementById('param-nama-app').value.trim();
      const kota = document.getElementById('param-kota').value.trim();
      const tagline = document.getElementById('param-tagline').value.trim();
      if (!namaApp) { showCustomAlert('Belum Lengkap', 'Nama aplikasi wajib diisi.', false); return; }
      if (btn) btn.disabled = true;
      showLoading(true);
      try {
        await callApiJson('/parameter', { namaApp, kota, tagline });
        // Perbarui branding lokal tanpa perlu login ulang
        activeKost = Object.assign({}, activeKost || {}, { namaApp, kota, tagline });
        terapkanBranding(activeKost);
        showCustomAlert('Tersimpan', 'Parameter aplikasi berhasil disimpan.', true);
      } catch (err) {
        showCustomAlert('Gagal Menyimpan', (err && err.message) || 'Parameter gagal disimpan.', false);
      } finally {
        showLoading(false);
        if (btn) btn.disabled = false;
      }
    }

    /** Unggah logo ke /api/parameter/logo lalu terapkan sebagai branding. */
    async function unggahLogo() {
      const input = document.getElementById('param-logo-file');
      const file = input && input.files && input.files[0];
      if (!file) { showCustomAlert('Belum Ada Berkas', 'Pilih berkas gambar logo terlebih dahulu.', false); return; }
      if (file.size > 2 * 1024 * 1024) {
        showCustomAlert('Berkas Terlalu Besar', 'Ukuran logo maksimal 2 MB.', false);
        return;
      }
      const btn = document.getElementById('btn-unggah-logo');
      if (btn) btn.disabled = true;
      showLoading(true);
      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch('/api/parameter/logo', {
          method: 'POST',
          headers: headerSesi({}),          // JANGAN set content-type: boundary FormData dibuat browser
          credentials: 'same-origin',
          body: fd,
        });
        let hasil = null;
        try { hasil = await res.json(); } catch (e) { /* bukan JSON */ }
        if (!res.ok) throw new Error((hasil && hasil.error) || `Unggah logo gagal (${res.status}).`);
        // Respons bisa berisi kunci logo langsung, atau dibaca ulang lewat /api/session
        let kunciLogo = hasil && (hasil.kunci || hasil.logoKunci || (hasil.kost && hasil.kost.logoKunci));
        try {
          const sesi = await callApiJson('/session');
          if (sesi && sesi.kost) {
            activeKost = sesi.kost;
            kunciLogo = kunciLogo || sesi.kost.logoKunci;
          }
        } catch (e) { /* sesi opsional */ }
        if (kunciLogo && activeKost) activeKost.logoKunci = kunciLogo;
        terapkanBranding(activeKost);
        if (input) input.value = '';
        showCustomAlert('Logo Diperbarui', 'Logo aplikasi berhasil diunggah.', true);
      } catch (err) {
        showCustomAlert('Gagal Unggah', (err && err.message) || 'Logo gagal diunggah.', false);
      } finally {
        showLoading(false);
        if (btn) btn.disabled = false;
      }
    }

    // =====================================================================
    // MENU KOST (khusus master) — daftar semua kost & tambah kost baru
    // =====================================================================
    async function muatDaftarKost() {
      const tbody = document.getElementById('table-daftar-kost');
      if (!tbody) return;
      tbody.innerHTML = `<tr><td colspan="5" class="py-10 text-center text-slate-400 text-xs italic">Memuat daftar kost…</td></tr>`;
      try {
        const hasil = await callApiJson('/master/kost');
        // API membalas { daftar: [...] }; terima juga bentuk lain agar tidak kosong diam-diam
        // (dulu daftar tampil "Belum ada kost" padahal server mengirim data).
        const daftar = Array.isArray(hasil) ? hasil
          : (Array.isArray(hasil && hasil.daftar) ? hasil.daftar
          : (Array.isArray(hasil && hasil.daftarKost) ? hasil.daftarKost
          : (Array.isArray(hasil && hasil.data) ? hasil.data : [])));
        if (!daftar.length) {
          tbody.innerHTML = `<tr><td colspan="5" class="py-10 text-center text-slate-400 text-xs italic">Belum ada kost terdaftar.</td></tr>`;
          return;
        }
        const kunciAktif = (activeKost && activeKost.kunci) || '';
        tbody.innerHTML = daftar.map((k) => {
          const aktif = k.kunci === kunciAktif;
          return `
            <tr class="hover:bg-slate-50 transition border-b border-slate-100 last:border-0 text-slate-700 text-xs md:text-sm${aktif ? ' bg-blue-50/40' : ''}">
              <td class="py-4 px-6">
                <div class="font-bold text-slate-800">${esc(k.namaApp || k.kunci || '-')}</div>
                <div class="text-[10px] text-slate-400">${esc(k.kunci || '')}${aktif ? ' • sedang aktif' : ''}</div>
              </td>
              <td class="py-4 px-4">${esc(k.kota || '-')}</td>
              <td class="py-4 px-4 text-center font-semibold">${esc(k.jumlahUser === undefined || k.jumlahUser === null ? '-' : k.jumlahUser)}</td>
              <td class="py-4 px-4 text-center font-semibold">${esc(k.jumlahKamar === undefined || k.jumlahKamar === null ? '-' : k.jumlahKamar)}</td>
              <td class="py-4 px-6 text-center">
                <button data-aksi="masuk-kost" data-kunci="${esc(k.kunci || '')}" data-nama="${esc(k.namaApp || k.kunci || '')}" class="px-3 py-2 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-600 border border-blue-100 font-bold text-[11px] transition">
                  <i class="fas fa-sign-in-alt mr-1"></i> Masuk sebagai kost ini
                </button>
                <button data-aksi="atur-admin-kost" data-kunci="${esc(k.kunci || '')}" data-nama="${esc(k.namaApp || k.kunci || '')}" class="ml-1 px-3 py-2 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-600 border border-emerald-100 font-bold text-[11px] transition">
                  <i class="fas fa-user-shield mr-1"></i> Admin
                </button>
              </td>
            </tr>`;
        }).join('');
      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="5" class="py-10 text-center text-rose-500 text-xs italic">${esc((err && err.message) || 'Gagal memuat daftar kost.')}</td></tr>`;
      }
    }

    /** Pindah kost aktif lalu muat ulang seluruh aplikasi. */
    function masukSebagaiKost(kunci, nama) {
      if (!kunci) return;
      showCustomAlert(
        'Masuk Sebagai Kost Ini?',
        `Data yang tampil akan berganti ke "${nama || kunci}". Halaman akan dimuat ulang.`,
        false, true,
        async () => {
          showLoading(true);
          try {
            const hasil = await callApiJson('/pilih-kost', { kunci });
            const token = ambilToken(hasil);
            if (token) { simpanToken(token); window.HADE_TOKEN = token; }
            if (window.HADE) window.HADE.resetCache();
            location.reload();
          } catch (err) {
            showLoading(false);
            showCustomAlert('Gagal', (err && err.message) || 'Kost gagal dipilih.', false);
          }
        }
      );
    }
    daftarAksi('masuk-kost', (d) => masukSebagaiKost(d.kunci, d.nama));
    daftarAksi('atur-admin-kost', (d) => bukaModalAdminKost(d.kunci, d.nama));
    daftarAksi('cabut-admin-kost', (d) => cabutAdminKost(d.id, d.username));

    // Master: kelola admin sebuah kost (satu No. HP boleh jadi admin banyak kost).
    let adminKostAktif = { kunci: '', nama: '' };

    function bukaModalAdminKost(kunci, nama) {
      if (!kunci) return;
      adminKostAktif = { kunci, nama: nama || kunci };
      document.getElementById('admin-kost-judul').innerText = nama || kunci;
      document.getElementById('admin-kost-hp').value = '';
      document.getElementById('admin-kost-username').value = '';
      document.getElementById('admin-kost-password').value = '';
      const m = document.getElementById('modal-admin-kost');
      m.classList.remove('hidden');
      m.classList.add('flex');
      muatAdminKost();
    }

    function tutupModalAdminKost() {
      const m = document.getElementById('modal-admin-kost');
      if (!m) return;
      m.classList.add('hidden');
      m.classList.remove('flex');
    }

    async function muatAdminKost() {
      const box = document.getElementById('admin-kost-daftar');
      if (!box || !adminKostAktif.kunci) return;
      box.innerHTML = `<p class="text-xs italic text-slate-400">Memuat admin…</p>`;
      try {
        const hasil = await callApiJson('/master/akses?kost=' + encodeURIComponent(adminKostAktif.kunci));
        const daftar = (hasil && Array.isArray(hasil.daftar)) ? hasil.daftar : [];
        if (!daftar.length) {
          box.innerHTML = `<p class="text-xs italic text-slate-400">Belum ada admin terdaftar di kost ini.</p>`;
          return;
        }
        box.innerHTML = daftar.map((u) => `
          <div class="flex items-center justify-between gap-2 p-3 rounded-xl border border-slate-100 bg-slate-50">
            <div class="min-w-0">
              <div class="font-bold text-slate-800 truncate">${esc(u.fullname || u.username)} <span class="text-[10px] uppercase text-slate-400">${esc(u.role || '')}</span></div>
              <div class="text-[11px] text-slate-500 truncate">${esc(u.username)}${u.hp ? ' • ' + esc(u.hp) : ' • tanpa No. HP'}</div>
            </div>
            <button data-aksi="cabut-admin-kost" data-id="${esc(u.id)}" data-username="${esc(u.username)}" class="shrink-0 px-2.5 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-100 font-bold text-[11px]">
              <i class="fas fa-user-minus"></i>
            </button>
          </div>`).join('');
      } catch (err) {
        box.innerHTML = `<p class="text-xs italic text-rose-500">${esc((err && err.message) || 'Gagal memuat admin.')}</p>`;
      }
    }

    async function simpanAdminKost() {
      const hp = (document.getElementById('admin-kost-hp').value || '').trim();
      const username = (document.getElementById('admin-kost-username').value || '').trim().toLowerCase();
      const password = document.getElementById('admin-kost-password').value || '';
      if (!hp) { showCustomAlert('Belum Lengkap', 'Isi No. HP admin yang mau didaftarkan.', false); return; }
      if (username && password.length < 8) { showCustomAlert('Password Terlalu Pendek', 'Password awal minimal 8 karakter.', false); return; }
      if (!username && !password) { /* akun lama: cukup HP */ }
      const btn = document.getElementById('btn-admin-kost-simpan');
      if (btn) btn.disabled = true;
      try {
        const hasil = await callApiJson('/master/daftar-admin', { kunci: adminKostAktif.kunci, hp, username, password });
        showCustomAlert(hasil && hasil.sudahTerdaftar ? 'Sudah Terdaftar' : 'Admin Didaftarkan',
          (hasil && hasil.message) || 'Admin berhasil didaftarkan.', true);
        document.getElementById('admin-kost-hp').value = '';
        document.getElementById('admin-kost-username').value = '';
        document.getElementById('admin-kost-password').value = '';
        muatAdminKost();
        muatDaftarKost();
      } catch (err) {
        showCustomAlert('Gagal Mendaftarkan', (err && err.message) || 'Admin gagal didaftarkan.', false);
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    function cabutAdminKost(id, username) {
      if (!id) return;
      showCustomAlert('Cabut Akses Admin?', `Akun ${username} tidak lagi bisa membuka kost ini. Datanya tidak dihapus.`, false, true, async () => {
        try {
          const data = await callApiJson('/master/akses?kost=' + encodeURIComponent(adminKostAktif.kunci) + '&id=' + encodeURIComponent(id), undefined, 'DELETE');
          showCustomAlert('Akses Dicabut', data.message || 'Akses dicabut.', true);
          muatAdminKost();
          muatDaftarKost();
        } catch (err) {
          showCustomAlert('Gagal', (err && err.message) || 'Akses gagal dicabut.', false);
        }
      });
    }

    /** Master membuat kost baru + akun admin pertamanya. */
    async function simpanKostBaru(event) {
      if (event) event.preventDefault();
      const namaApp = document.getElementById('kost-nama-app').value.trim();
      const kota = document.getElementById('kost-kota').value.trim();
      const tagline = document.getElementById('kost-tagline').value.trim();
      const hp = (document.getElementById('kost-admin-hp') || {}).value ? document.getElementById('kost-admin-hp').value.trim() : '';
      const username = document.getElementById('kost-admin-username').value.trim().toLowerCase();
      const password = document.getElementById('kost-admin-password').value;
      const fullname = document.getElementById('kost-admin-fullname').value.trim();
      if (!namaApp) { showCustomAlert('Belum Lengkap', 'Nama aplikasi wajib diisi.', false); return; }
      if (!hp && !username) { showCustomAlert('Belum Lengkap', 'Isi No. HP admin, atau username admin bila admin tidak memakai nomor HP.', false); return; }
      if (!hp && String(password || '').length < 8) { showCustomAlert('Password Terlalu Pendek', 'Password admin minimal 8 karakter.', false); return; }
      const btn = document.getElementById('btn-tambah-kost');
      if (btn) btn.disabled = true;
      showLoading(true);
      try {
        const hasil = await callApiJson('/master/kost', {
          namaApp, kota, tagline, hp, username, password,
          fullname: fullname || ('Administrator ' + namaApp),
        });
        document.getElementById('form-kost-baru').reset();
        showCustomAlert('Kost Dibuat', (hasil && hasil.message) || `Kost "${namaApp}" berhasil dibuat.`, true);
        muatDaftarKost();
      } catch (err) {
        showCustomAlert('Gagal Membuat Kost', (err && err.message) || 'Kost gagal dibuat.', false);
      } finally {
        showLoading(false);
        if (btn) btn.disabled = false;
      }
    }

    // DATABASE WIPING AND RECONCILIATION LOGICS
    // Reset aplikasi DIHAPUS: sebelumnya tombol ini menulis localStorage (data baru hilang di semua HP).
    // Reset data produksi harus lewat Supabase (SQL / backup), bukan tombol di browser.

    // INTERACTIVE DELETE ROOM PROMPTER
    function promptDeleteRoom(roomNo, status) {
      const alertMsg = status === 'Terisi' 
        ? `Unit Kamar ${roomNo} sedang TERISI. Menghapus kamar ini juga akan berdampak pada penyewa aktif di dalamnya. Apakah Anda yakin ingin mematikan / menghapus secara permanen?`
        : `Apakah Anda yakin ingin menghapus Unit Kamar ${roomNo} secara permanen dari Kost Hade?`;

      showCustomAlert(
        "Hapus Unit Kamar?",
        alertMsg,
        false,
        true,
        () => {
          showLoading(true);
          google.script.run
            .withFailureHandler(handleError)
            .withSuccessHandler(msg => {
              cachedData = null;
              showLoading(false);
              showCustomAlert("Berhasil Dihapus", msg, true);
              loadDashboard(); // Reload current view
            }).deleteRoom(roomNo);
        }
      );
    }

    // =======================================================
    // DETEKSI JALUR & EMULASI FULLY INTERAKTIF UNTUK PREVIEW
    // =======================================================
    // (Blok emulator localStorage dihapus — backend sekarang D1 lewat d1-adapter.js)

    // Filter laporan default = bulan berjalan (dulu selalu "Mei" karena selected di HTML)
    (function initFilterLaporan() {
      const d = new Date();
      const bln = document.getElementById('filter-laporan-bulan');
      const thn = document.getElementById('filter-laporan-tahun');
      if (bln) bln.value = String(d.getMonth() + 1);
      if (thn) {
        if (![...thn.options].some(o => o.value === String(d.getFullYear()))) {
          thn.insertAdjacentHTML('beforeend', `<option value="${d.getFullYear()}">${d.getFullYear()}</option>`);
        }
        thn.value = String(d.getFullYear());
      }
    })();

    // Sesi sudah diinisialisasi lebih awal (initUserSession); window.onload kedua di sini
    // dihapus supaya /api/session tidak dipanggil dua kali saat halaman dibuka.

/* ---- Dipakai oleh atribut data-h di HTML; sengaja dibuka ke window. ---- */
try { window.batalkanPilihKost = batalkanPilihKost; } catch (e) {}
try { window.bukaImporWa = bukaImporWa; } catch (e) {}
try { window.bukaPindahKamar = bukaPindahKamar; } catch (e) {}
try { window.bukaUndangWa = bukaUndangWa; } catch (e) {}
try { window.bukaWaUndangan = bukaWaUndangan; } catch (e) {}
try { window.calculateBilling = calculateBilling; } catch (e) {}
try { window.cancelEditCategory = cancelEditCategory; } catch (e) {}
try { window.cancelEditUser = cancelEditUser; } catch (e) {}
try { window.closeEditRoomModal = closeEditRoomModal; } catch (e) {}
try { window.closeEditTenantModal = closeEditTenantModal; } catch (e) {}
try { window.closePindahKamarModal = closePindahKamarModal; } catch (e) {}
try { window.closeModal = closeModal; } catch (e) {}
try { window.closeReceiptModal = closeReceiptModal; } catch (e) {}
try { window.filterCategoriesTable = filterCategoriesTable; } catch (e) {}
try { window.filterLedgerData = filterLedgerData; } catch (e) {}
try { window.filterOpsLedger = filterOpsLedger; } catch (e) {}
try { window.filterPayments = filterPayments; } catch (e) {}
try { window.filterRoomCards = filterRoomCards; } catch (e) {}
try { window.filterTenants = filterTenants; } catch (e) {}
try { window.filterUsersTable = filterUsersTable; } catch (e) {}
try { window.generateSelectedReport = generateSelectedReport; } catch (e) {}
try { window.handleLoginSubmit = handleLoginSubmit; } catch (e) {}
try { window.handlePenyewaChange = handlePenyewaChange; } catch (e) {}
try { window.handleTipeSewaChange = handleTipeSewaChange; } catch (e) {}
try { window.handleTransTypeChange = handleTransTypeChange; } catch (e) {}
try { window.hapusPratinjauKtp = hapusPratinjauKtp; } catch (e) {}
try { window.kirimSemuaPengingat = kirimSemuaPengingat; } catch (e) {}
try { window.muatDaftarKost = muatDaftarKost; } catch (e) {}
try { window.muatPengingat = muatPengingat; } catch (e) {}
try { window.printFinancialReport = printFinancialReport; } catch (e) {}
try { window.printReceipt = printReceipt; } catch (e) {}
try { window.salinTeksUndangan = salinTeksUndangan; } catch (e) {}
try { window.showLoading = showLoading; } catch (e) {}
try { window.showSection = showSection; } catch (e) {}
try { window.simpanAdminKost = simpanAdminKost; } catch (e) {}
try { window.simpanImporWa = simpanImporWa; } catch (e) {}
try { window.simpanKostBaru = simpanKostBaru; } catch (e) {}
try { window.simpanParameter = simpanParameter; } catch (e) {}
try { window.switchOpsSubTab = switchOpsSubTab; } catch (e) {}
try { window.switchReportTab = switchReportTab; } catch (e) {}
try { window.syncData = syncData; } catch (e) {}
try { window.togglePasswordVisibility = togglePasswordVisibility; } catch (e) {}
try { window.toggleRoomForm = toggleRoomForm; } catch (e) {}
try { window.toggleUserDropdown = toggleUserDropdown; } catch (e) {}
try { window.tutupImporWa = tutupImporWa; } catch (e) {}
try { window.tutupModalAdminKost = tutupModalAdminKost; } catch (e) {}
try { window.tutupUndangWa = tutupUndangWa; } catch (e) {}
try { window.ubahTeksUndangan = ubahTeksUndangan; } catch (e) {}
try { window.unggahLogo = unggahLogo; } catch (e) {}
try { window.uraiPesanWa = uraiPesanWa; } catch (e) {}

/* ---- Aksi di HTML (dulu atribut onclick/onsubmit/... sebaris).
   data-h berisi nama fungsi saja (contoh: data-h="showSection" data-h-arg='["kamar"]'),
   sehingga pelaksanaan tidak butuh eval/new Function: CSP cukup 'self'.
   `this` di dalam fungsi menunjuk elemen yang memicu aksi. ---- */
var AKSI = {
  'batalkanPilihKost': batalkanPilihKost, 'bukaImporWa': bukaImporWa,
  'bukaPindahKamar': bukaPindahKamar, 'bukaUndangWa': bukaUndangWa, 'bukaWaUndangan': bukaWaUndangan,
  'calculateBilling': calculateBilling, 'cancelEditCategory': cancelEditCategory,
  'cancelEditUser': cancelEditUser, 'closeEditRoomModal': closeEditRoomModal,
  'closeEditTenantModal': closeEditTenantModal, 'closePindahKamarModal': closePindahKamarModal, 'closeModal': closeModal,
  'closeReceiptModal': closeReceiptModal, 'filterCategoriesTable': filterCategoriesTable,
  'filterLedgerData': filterLedgerData, 'filterOpsLedger': filterOpsLedger,
  'filterPayments': filterPayments, 'filterRoomCards': filterRoomCards,
  'filterTenants': filterTenants, 'filterUsersTable': filterUsersTable,
  'generateSelectedReport': generateSelectedReport, 'handleLoginSubmit': handleLoginSubmit,
  'handleLogout': handleLogout, 'handlePenyewaChange': handlePenyewaChange,
  'handleTipeSewaChange': handleTipeSewaChange, 'handleTransTypeChange': handleTransTypeChange,
  'hapusPratinjauKtp': hapusPratinjauKtp, 'kirimSemuaPengingat': kirimSemuaPengingat,
  'muatDaftarKost': muatDaftarKost, 'muatPengingat': muatPengingat,
  'openGantiPassword': openGantiPassword, 'printFinancialReport': printFinancialReport,
  'printReceipt': printReceipt, 'salinTeksUndangan': salinTeksUndangan,
  'showLoading': showLoading, 'showSection': showSection,
  'simpanAdminKost': simpanAdminKost, 'simpanImporWa': simpanImporWa,
  'simpanKostBaru': simpanKostBaru, 'simpanParameter': simpanParameter,
  'switchOpsSubTab': switchOpsSubTab, 'switchReportTab': switchReportTab,
  'syncData': syncData, 'togglePasswordVisibility': togglePasswordVisibility,
  'toggleRoomForm': toggleRoomForm, 'toggleUserDropdown': toggleUserDropdown,
  'tutupImporWa': tutupImporWa, 'tutupModalAdminKost': tutupModalAdminKost,
  'tutupUndangWa': tutupUndangWa, 'ubahTeksUndangan': ubahTeksUndangan,
  'unggahLogo': unggahLogo, 'uraiPesanWa': uraiPesanWa
};
// Peta fungsi -> nama untuk pemanggilan dari HTML (data-h="filterOpsLedger" data-h-arg='"Pendapatan"')
function aksiDariNama(nama) {
  if (Object.prototype.hasOwnProperty.call(AKSI, nama)) return AKSI[nama];
  return (typeof window !== 'undefined' && typeof window[nama] === 'function') ? window[nama] : null;
}
function atr(el, nama) {
  return el && el.getAttribute ? el.getAttribute(nama) : null;
}
function argAksi(el) {
  var mentah = atr(el, 'data-h-arg');
  if (!mentah) return [];
  try {
    var a = JSON.parse(mentah);
    return Array.isArray(a) ? a : [a];
  } catch (err) { return []; }
}
// Naik dari satu elemen (bisa berupa node teks/ikon) ke elemen terdekat ber-atribut data-h.
function cariAksi(titik) {
  var el = titik;
  while (el && el.nodeType !== 1) el = el.parentNode;
  while (el && el.nodeType === 1) {
    if (atr(el, 'data-h') !== null) return el;
    el = el.parentElement;
  }
  return null;
}
function jalankanAksi(el, jenis, event) {
  var nama = atr(el, 'data-h');
  var fn = aksiDariNama(nama);
  if (typeof fn !== 'function') {
    if (window.console) console.warn('Aksi tidak dikenal:', nama);
    return;
  }
  var args = argAksi(el);
  var nav = atr(el, 'data-h-nav');
  // data-h-nav: tombol di bilah bawah ponsel; penanda aktif dipasang pada tombol sidebar
  if (nav) {
    var target = document.querySelector('#sidebar-nav [data-h-arg=\'["' + nav + '"]\']') || el;
    args = [args[0], target];
  } else if (atr(el, 'data-h-self') !== null) {
    args.push(el);
  }
  if (nama === 'showLoading') {
    args = [atr(el, 'data-h-arg') === 'true'];
  } else if (jenis === 'submit' || jenis === 'input' || jenis === 'change' || fn.length > args.length) {
    args = args.concat([event]).slice(0, Math.max(fn.length, args.length + 1));
  }
  fn.apply(el, args);
}
document.addEventListener('click', function (e) {
  var el = cariAksi(e.target);
  if (!el) return;
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  jalankanAksi(el, 'click', e);
}, false);
// Hanya form/submit yang dipetakan ke handler. `input`/`change` sengaja TIDAK dipetakan:
// keduanya naik (bubble) dari kolom isian ke <form data-h="...">, sehingga setiap karakter
// yang diketik ikut memicu handler form (bug: login terkirim setengah jadi, checkbox mati).
['submit'].forEach(function (jenis) {
  document.addEventListener(jenis, function (e) {
    var el = cariAksi(e.target);
    if (!el) return;
    if (jenis === 'submit') e.preventDefault();
    jalankanAksi(el, jenis, e);
  }, jenis === 'submit' ? true : false);
});
document.addEventListener('error', function (e) {
  var t = e.target;
  if (t && t.nodeType === 1 && atr(t, 'data-h') !== null) t.src = atr(t, 'data-h');
}, true);
