// =====================================================================
// Kost Hade — angka ringkasan (dashboard) PER KOST
//
// Dulu angka kas/tunggakan diambil dari satu query agregat berisi banyak sub-query.
// Query seperti itu tidak bisa difilter otomatis per kost tanpa menyentuh setiap
// sub-query (dan menyentuhnya otomatis berisiko salah tabel). Di sini setiap angka
// dihitung dengan query kecil yang eksplisit memakai `kost = ?`, sehingga mudah
// diaudit dan mustahil mencampur data kost lain.
// =====================================================================

const angka = (baris) => Number(baris && baris.v) || 0;

/**
 * @param {D1Database} db  database ASLI (bukan yang dibungkus dbKost)
 * @param {string} kost    kunci kost
 */
export async function ringkasKost(db, kost) {
  const satu = async (sql) => angka(await db.prepare(sql).bind(kost).first());

  const pembayaran = await satu(
    'select coalesce(sum(jumlah),0) as v from payments where voided_at is null and kost=?');

  const pendapatanLedger = await satu(
    "select coalesce(sum(jumlah),0) as v from ledger where jenis='pendapatan' and voided_at is null and kost=?");

  const totalPengeluaran = await satu(
    "select coalesce(sum(jumlah),0) as v from ledger where jenis='pengeluaran' and voided_at is null and kost=?");

  const pendapatanBulanIni = await satu(
    "select coalesce(sum(jumlah),0) as v from payments where voided_at is null and kost=? and tgl_bayar >= date('now','localtime','start of month')");

  const tunggakan = await satu(
    "select coalesce(sum(jumlah),0) as v from bills where kost=? and status='belum_bayar' and jatuh_tempo < date('now','localtime')");

  // Arus kas ledger: pendapatan - pengeluaran, hanya kategori yang menggerakkan kas.
  const arusKasLedger = await satu(`
    select coalesce(sum(case when l.jenis='pendapatan' then l.jumlah
                             when l.jenis='pengeluaran' then -l.jumlah else 0 end),0) as v
      from ledger l left join categories c on c.id = l.kategori_id
     where l.voided_at is null and l.kost = ? and coalesce(c.arus_kas,1)=1`);

  // Saldo akun neraca (modal pemilik dll): Kredit menambah kas, Debet mengurangi.
  const saldoNeraca = await satu(`
    select coalesce(sum(case when coalesce(c.saldo_normal,'Debet')='Kredit' then l.jumlah else -l.jumlah end),0) as v
      from ledger l left join categories c on c.id = l.kategori_id
     where l.jenis='neraca' and l.voided_at is null and l.kost = ? and coalesce(c.arus_kas,1)=1`);

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
  const r = await db.prepare(
    'select * from ledger where voided_at is null and kost=? order by tanggal desc, id desc').bind(kost).all();
  return (r.results || []).map((x) => [x.id, x.tanggal, x.jenis.charAt(0).toUpperCase() + x.jenis.slice(1), x.kategori, String(x.jumlah), x.keterangan || '']);
}
