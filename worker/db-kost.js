// =====================================================================
// KOST HADE — Pembungkus D1 MULTITENAN
//
// Semua logika bisnis memakai `ctx.db` (lihat worker/logic.js). Di sini setiap query
// D1 dibungkus supaya otomatis terikat ke satu kost:
//
//   - `select`            -> ditambah syarat `kost = ?` pada tabel data (rooms, tenants,
//                            bills, payments, ledger, categories, counters)
//   - `insert into <t>`   -> kolom `kost` ditambahkan bila belum ada
//   - `update/delete <t>` -> ditambah syarat `kost = ?` pada WHERE-nya
//   - `batch([...])`      -> setiap statement dibungkus dengan cara yang sama
//
// Pendekatan ini dipilih daripada mengedit 61 pemanggilan query satu per satu:
// kalau ada query baru yang lupa diberi filter, query itu TIDAK akan menemukan tabel
// (dianggap gagal) sehingga kebocoran data antarkost tidak mungkin terjadi diam-diam.
//
// Tabel yang TIDAK pernah difilter (memang global / lintas kost):
//   kosts, akses_kost, users, sessions, login_percobaan, audit_log, ktp_berkas
// =====================================================================

/** Tabel yang datanya dipisah per kost. */
export const TABEL_BERKOST = new Set([
  'rooms', 'tenants', 'bills', 'payments', 'ledger', 'categories', 'counters', 'journal_entries', 'journal_lines',
]);

/** Kata kunci SQL yang menandakan sub-query (untuk mencari "tabel data" pertama). */
const AKHIR_SELEKSI = /\b(where|group\s+by|order\s+by|limit|having|union|left\s+join|inner\s+join|join)\b/i;

/**
 * Menambahkan syarat kost pada klausa WHERE hasil sub-query utama.
 * Hanya menyentuh WHERE pertama di level atas supaya sub-query di dalamnya tidak rusak.
 */
function sisipWhere(sql, tambahan) {
  // WHERE pertama di LEVEL ATAS saja: tanda kurung dilacak supaya sub-query
  // `where id in (select ... where ...)` tidak ikut tersisipi.
  let dalam = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === '(') dalam++;
    else if (c === ')') dalam = Math.max(0, dalam - 1);
    else if (dalam === 0 && /[wW]/.test(c) && /^where\b/i.test(sql.slice(i))) {
      const sisa = sql.slice(i + 5);
      // gabungkan dengan AND, beri tanda kurung pada kondisi asli agar OR tidak mengalahkan filter
      const akhir = akhirWhereAtas(sisa);
      const kondisi = sisa.slice(0, akhir).trim();
      const sesudah = sisa.slice(akhir);
      const pemisah = sesudah && !/^\s/.test(sesudah) ? ' ' : '';
      return `${sql.slice(0, i)}where (${kondisi}) and ${tambahan}${pemisah}${sesudah}`;
    }
  }
  // belum ada WHERE di level atas: sisipkan sebelum GROUP/ORDER/LIMIT pertama (level atas)
  let dalam2 = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === '(') dalam2++;
    else if (c === ')') dalam2 = Math.max(0, dalam2 - 1);
    else if (dalam2 === 0) {
      const sisa = sql.slice(i);
      const m = sisa.match(/^(group\s+by|order\s+by|limit|having|union)\b/i);
      if (m) return `${sql.slice(0, i)}where ${tambahan} ${sql.slice(i)}`;
    }
  }
  return `${sql} where ${tambahan}`;
}

/** Indeks akhir kondisi WHERE (sebelum GROUP/ORDER/LIMIT di level atas). */
function akhirWhereAtas(sisa) {
  let dalam = 0;
  for (let i = 0; i < sisa.length; i++) {
    const c = sisa[i];
    if (c === '(') dalam++;
    else if (c === ')') dalam = Math.max(0, dalam - 1);
    else if (dalam === 0) {
      const m = sisa.slice(i).match(/^(group\s+by|order\s+by|limit|having|union)\b/i);
      if (m) return i;
    }
  }
  return sisa.length;
}

/** Ambil daftar tabel BESERTA aliasnya: `from tenants t join rooms r on ...` -> [{tabel, alias}]. */
function tabelSelect(sql) {
  const hasil = [];
  const re = /\b(?:from|join)\s+([a-z_][a-z0-9_]*)(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/gi;
  let m;
  while ((m = re.exec(sql))) {
    const tabel = m[1].toLowerCase();
    const aliasMentah = (m[2] || '').toLowerCase();
    // kata kunci SQL tidak boleh dianggap alias
    const alias = /^(on|where|join|left|inner|right|outer|group|order|limit|using|set|values)$/.test(aliasMentah)
      ? '' : aliasMentah;
    hasil.push({ tabel, alias });
  }
  return hasil;
}

/** Tabel yang dirujuk query, tapi filter kost cukup diterapkan SATU kali pada tabel utama. */
function tabelBerkost(sql) {
  // Hanya "from" (tabel utama). Tabel pada join ikut terfilter lewat syarat di tabel utama
  // (relasi lewat id), dan menambahkan `alias.kost` pada join justru berbahaya: query
  // agregat seperti dashboard memakai sub-query `from payments ...` sehingga `kost`
  // tanpa kualifikasi tidak jelas milik tabel mana.
  const hasil = [];
  const re = /\bfrom\s+([a-z_][a-z0-9_]*)(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/gi;
  let m;
  while ((m = re.exec(sql))) {
    const tabel = m[1].toLowerCase();
    const aliasMentah = (m[2] || '').toLowerCase();
    const alias = /^(on|where|join|left|inner|right|outer|group|order|limit|using|set|values|\))$/.test(aliasMentah)
      ? '' : aliasMentah;
    if (TABEL_BERKOST.has(tabel)) hasil.push({ tabel, alias });
  }
  return { berkost: hasil };
}


/**
 * Bungkus satu pernyataan SQL agar terikat ke `kost`.
 * @param {string} sqlAsli
 * @param {string|string[]} kost  satu nilai, atau daftar nilai (id baru + slug lama).
 *   Bila daftar, syaratnya `kost in (?,?)` sehingga data lama (slug) dan data baru
 *   (id angka) sama-sama terbaca — lihat migrasi 019.
 * @returns {{sql: string, args: any[], tambah: number}} SQL baru + argumen tambahan (dibuang dari pemanggil lama).
 */
export function bungkusSql(sqlAsli, kost) {
  const sql = String(sqlAsli);
  const rendah = sql.toLowerCase();
  const daftar = Array.isArray(kost) ? [...new Set(kost.filter((k) => k !== null && k !== undefined && String(k) !== ''))] : [kost];
  if (!daftar.length) return { sql, args: [], tambah: 0 };
  const tanda = `(${daftar.map(() => '?').join(',')})`;
  const kondisiKost = (awalan) => (daftar.length === 1
    ? `${awalan}kost = ?`
    : `${awalan}kost in ${tanda}`);
  const argsKost = () => (daftar.length === 1 ? [daftar[0]] : daftar.map((k) => k));

  // ---- INSERT ... INTO tabel ----
  // Hanya INSERT polos yang dibungkus. `insert or ignore/replace ... select` tidak boleh
  // disentuh: penambahan kolom pada daftar kolom akan menggeser pasangan VALUES/SELECT-nya.
  const ins = rendah.match(/^\s*insert\s+into\s+([a-z_][a-z0-9_]*)/);
  if (ins && TABEL_BERKOST.has(ins[1])) {
    const tabel = ins[1];
    // Kolom: cari kurung pertama setelah nama tabel
    const buka = sql.indexOf('(', ins[0].length - 1);
    const tutup = sql.indexOf(')', buka);
    if (buka === -1 || tutup === -1) return { sql, args: [], tambah: 0 };
    const kolom = sql.slice(buka + 1, tutup);
    // Penulisan selalu memakai SATU nilai: nilai pertama (id baru bila ada).
    // Kolom kost sudah ditulis pemanggil: nilainya diisi kunci tulis (id baru) oleh dbKost().
    if (/\bkost\b/.test(kolom.toLowerCase())) return { sql, args: [], tambah: 0 };
    const baru = `${sql.slice(0, tutup)}, kost${sql.slice(tutup)}`;
    // nilai: (?,?,?) -> (?,?,?,?)
    const posValues = /values\s*\(([^)]*)\)/i.exec(baru);
    if (!posValues) return { sql: baru, args: [] };
    const isiBaru = baru.slice(0, posValues.index + posValues[0].lastIndexOf(')')) + ', ?' +
                    baru.slice(posValues.index + posValues[0].lastIndexOf(')'));
    return { sql: isiBaru, args: [daftar[0]], tambah: 1 };
  }

  // ---- UPDATE tabel SET ... WHERE ----
  const upd = rendah.match(/^\s*update\s+([a-z_][a-z0-9_]*)/);
  if (upd && TABEL_BERKOST.has(upd[1])) {
    return { sql: sisipWhere(sql, kondisiKost('')), args: argsKost(), tambah: argsKost().length };
  }

  // ---- DELETE FROM tabel WHERE ----
  const del = rendah.match(/^\s*delete\s+from\s+([a-z_][a-z0-9_]*)/);
  if (del && TABEL_BERKOST.has(del[1])) {
    return { sql: sisipWhere(sql, kondisiKost('')), args: argsKost(), tambah: argsKost().length };
  }

  // ---- SELECT ... ----
  if (/^\s*select\b/i.test(sql)) {
    const { berkost } = tabelBerkost(sql);
    if (!berkost.length) return { sql, args: [], tambah: 0 };
    // Semua tabel berkost di level atas ikut difilter. Tanpa ini, join dua tabel (mis.
    // `from tenants t join rooms r`) hanya terfilter satu sisi: nama penyewa milik kost
    // lain bisa muncul di `Tidak ada tagihan terbuka untuk <nama>` walau datanya terpisah.
    // Daftar lengkap ditaruh di kurung supaya `a.kost in (...) and b.kost in (...)`
    // tidak salah dikelompokkan.
    const saringan = berkost.map((x) => `(${kondisiKost(x.alias ? `${x.alias}.` : '')})`);
    const args = berkost.flatMap(() => argsKost());
    return { sql: sisipWhere(sql, saringan.join(' and ')), args, tambah: args.length };
  }

  return { sql, args: [], tambah: 0 };
}

/**
 * Bungkus objek D1 (prepare/batch) sehingga kost selalu ikut.
 * @param {D1Database} db
 * @param {string|string[]} kost  kunci kost aktif (boleh daftar: id baru + slug lama)
 * @param {{ tulis?: string }} opsi
 *   `tulis` = nilai yang ditulis ke kolom kost (id baru, migrasi 019). Saat MENULIS,
 *   syarat kost milik pemanggil (mis. `kost = ?` pada insert users) diisi nilai ini.
 *   Saat MEMBACA, daftar lengkap tetap dipakai agar data lama (slug) ikut terbaca.
 */
export function dbKost(db, kost, { tulis } = {}) {
  const daftar = (Array.isArray(kost) ? kost.filter(Boolean) : (kost ? [kost] : [])).filter((k) => String(k) !== '');
  if (!daftar.length) return db;                     // tanpa kost = perilaku lama (mis. migrasi)
  const kunciTulis = tulis != null && String(tulis) !== '' ? String(tulis) : daftar[0];

  const prepare = (sql) => {
    const { sql: s2, args, tambah } = bungkusSql(sql, daftar);
    const stmt = db.prepare(s2);
    // Placeholder `kost = ?` milik pemanggil (di luar yang ditambahkan bungkusSql) diisi kunciTulis.
    // Hanya bila pemanggil memang mengirim nilai untuk kolom kost (lihat catatan di bungkusSql:
    // INSERT ke tabel berkost dengan kolom kost yang sudah ditulis sendiri tidak menambah argumen).
    const posisiKost = [];
    if (tambah > 0) {
      s2.replace(/\bkost\s*=\s*\?/gi, (m, off) => {
        posisiKost.push((s2.slice(0, off).match(/\?/g) || []).length - 1);
        return m;
      });
    }
    const ikat = (nilai) => {
      const hasil = [];
      const jml = nilai.length + (tambah || 0);
      for (let j = 0; j < jml; j += 1) {
        if (posisiKost.includes(j)) hasil.push(kunciTulis);
        else if (j < nilai.length) hasil.push(nilai[j]);
        else hasil.push(args[j - nilai.length] ?? kunciTulis);
      }
      return stmt.bind(...hasil);
    };
    return {
      _st: stmt,
      bind: (...nilai) => prepareSetelah(ikat(nilai)),
      first: (...nilai) => (nilai.length ? ikat(nilai) : stmt.bind(...args)).first(),
      all: (...nilai) => (nilai.length ? ikat(nilai) : stmt.bind(...args)).all(),
      run: (...nilai) => (nilai.length ? ikat(nilai) : stmt.bind(...args)).run(),
    };
  };

  return {
    prepare,
    batch: async (l) => {
      // Statement ter-wrap milik dbKost() sudah menyisipkan kost sendiri — pakai apa adanya.
      // Statement MENTAH (db.prepare() biasa, tanpa filter kost) di sini akan membuat tulis/baca
      // menembus batas kost, jadi langsung ditolak: pemanggil wajib memakai dbKost().prepare().
      const siapDaftar = (l || []).map((s) => {
        if (s && s._st) return s._st;
        throw new Error('db-kost: batch() hanya menerima statement dari dbKost().prepare() — statement mentah tidak terfilter kost.');
      });
      return db.batch(siapDaftar);
    },
    exec: (sql) => db.exec(sql),
    dump: (...a) => db.dump(...a),
  };
}

/** Objek statement yang sudah ter-bind: tetap mendukung .first/.all/.run dan bisa dipakai di batch. */
function prepareSetelah(terikat) {
  return {
    _st: terikat,
    bind: () => prepareSetelah(terikat),
    first: () => terikat.first(),
    all: () => terikat.all(),
    run: () => terikat.run(),
  };
}
