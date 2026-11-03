// =====================================================================
// Kost Hade — angka ringkasan (dashboard) PER KOST
//
// Dulu angka kas/tunggakan diambil dari satu query agregat berisi banyak sub-query.
// Query seperti itu tidak bisa difilter otomatis per kost tanpa menyentuh setiap
// sub-query (dan menyentuhnya otomatis berisiko salah tabel). Di sini setiap angka
// dihitung dengan query kecil yang eksplisit memakai syarat kost, sehingga mudah
// diaudit dan mustahil mencampur data kost lain.
//
// `kost` boleh berupa daftar (id baru + slug lama, lihat migrasi 019): syaratnya
// menjadi `kost in (?,?)` sehingga data lama dan data baru sama-sama terhitung.
// =====================================================================

const angka = (baris) => Number(baris && baris.v) || 0;

/** Ubah `kost` (tunggal/daftar) menjadi potongan SQL + argumen. */
function syaratKost(kost, awalan = '') {
  const daftar = (Array.isArray(kost) ? kost : [kost]).filter((k) => k != null && k !== '');
  if (!daftar.length) return { sql: `${awalan}kost is null`, args: [] };
  if (daftar.length === 1) return { sql: `${awalan}kost = ?`, args: [daftar[0]] };
  return { sql: `${awalan}kost in (${daftar.map(() => '?').join(',')})`, args: daftar };
}

/**
 * @param {D1Database} db  database ASLI (bukan yang dibungkus dbKost)
 * @param {string|string[]} kost  kunci kost (boleh daftar: id baru + slug lama)
 */
export async function ringkasKost(db, kost) {
  const k = syaratKost(kost);
  const kl = syaratKost(kost, 'l.');
  const satu = async (sql, args = k.args) => angka(await db.prepare(sql).bind(...args).first());

  const pembayaran = await satu(
    `select coalesce(sum(jumlah),0) as v from payments where voided_at is null and ${k.sql}`);

  const pendapatanLedger = await satu(
    `select coalesce(sum(jumlah),0) as v from ledger where jenis='pendapatan' and voided_at is null and ${k.sql}`);

  const totalPengeluaran = await satu(
    `select coalesce(sum(jumlah),0) as v from ledger where jenis='pengeluaran' and voided_at is null and ${k.sql}`);

  const pendapatanBulanIni = await satu(
    `select coalesce(sum(jumlah),0) as v from payments where voided_at is null and ${k.sql} and tgl_bayar >= date('now','localtime','start of month')`);

  const tunggakan = await satu(
    `select coalesce(sum(jumlah),0) as v from bills where ${k.sql} and status='belum_bayar' and jatuh_tempo < date('now','localtime')`);

  // Arus kas ledger: pendapatan - pengeluaran, hanya kategori yang menggerakkan kas.
  const arusKasLedger = await satu(`
    select coalesce(sum(case when l.jenis='pendapatan' then l.jumlah
                             when l.jenis='pengeluaran' then -l.jumlah else 0 end),0) as v
      from ledger l left join categories c on c.id = l.kategori_id
     where l.voided_at is null and ${kl.sql} and coalesce(c.arus_kas,1)=1`, kl.args);

  // Saldo akun neraca (modal pemilik dll): Kredit menambah kas, Debet mengurangi.
  const saldoNeraca = await satu(`
    select coalesce(sum(case when coalesce(c.saldo_normal,'Debet')='Kredit' then l.jumlah else -l.jumlah end),0) as v
      from ledger l left join categories c on c.id = l.kategori_id
     where l.jenis='neraca' and l.voided_at is null and ${kl.sql} and coalesce(c.arus_kas,1)=1`, kl.args);

  return {
    total_pendapatan: pembayaran + pendapatanLedger,
    total_pengeluaran: totalPengeluaran,
    sisa_kas: pembayaran + arusKasLedger + saldoNeraca,
    modal_neraca: saldoNeraca,
    pendapatan_bulan_ini: pendapatanBulanIni,
    tunggakan,
  };
}

/** Daftar transaksi ledger per kost, bentuk array yang dipakai UI. */
export async function daftarLedger(db, kost) {
  const k = syaratKost(kost);
  const r = await db.prepare(
    `select * from ledger where voided_at is null and ${k.sql} order by tanggal desc, id desc`).bind(...k.args).all();
  return (r.results || []).map((x) => [x.id, x.tanggal, x.jenis.charAt(0).toUpperCase() + x.jenis.slice(1), x.kategori, String(x.jumlah), x.keterangan || '']);
}
