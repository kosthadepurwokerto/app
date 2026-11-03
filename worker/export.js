/**
 * Modul Export (Hasil kerja DeepSeek V4.1 Flash)
 * Digunakan untuk mengekspor data ke format CSV yang kompatibel dengan Excel.
 */

export async function exportLedgerCsv(db, kost) {
  const { results } = await db
    .prepare(
      'SELECT tanggal, jenis, kategori, keterangan, jumlah FROM ledger WHERE kost = ? AND voided_at IS NULL ORDER BY tanggal DESC, id DESC'
    )
    .bind(kost)
    .all();

  // Membungkus setiap sel dengan tanda kutip untuk menangani koma dan baris baru
  // Spreadsheet programs execute cells that begin with formula/control chars.
  const cell = (v) => {
    const text = String(v ?? '');
    const safe = /^[\s]*[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };

  // Header CSV
  const header = 'Tanggal,Jenis,Kategori,Keterangan,Jumlah';

  // Baris data
  const rows = results.map((r) =>
    [r.tanggal, r.jenis, r.kategori, r.keterangan, r.jumlah].map(cell).join(',')
  );

  // Gabungkan dengan baris baru (CRLF agar lebih bersahabat dengan Excel Windows)
  return [header, ...rows].join('\r\n');
}
