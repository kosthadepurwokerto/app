// Professional, printable Hadekost documents. Operational template, not legal advice.
// Layout mengikuti berkas kontrak.html milik user (kop KH | Kost Hade, pasal, Lampiran A/B/C).
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const rupiah = (v) => 'Rp ' + Number(v || 0).toLocaleString('id-ID');
const tanggal = (v) => { const s = String(v || ''); const d = new Date(`${s.slice(0,10)}T00:00:00`); return Number.isNaN(d.getTime()) ? esc(v) : d.toLocaleDateString('id-ID', { day:'2-digit', month:'long', year:'numeric' }); };
const val = (v, fallback = '-') => esc(v || fallback);
const namaKost = (d) => val(d.kost?.nama, 'Kost Hade');
// Nama penyewa sering diinput huruf kecil / kapital acak; dokumen memakai kapital di awal kata
// tanpa mengubah huruf lain (gelar seperti "S.Pd" tetap utuh). Hanya tampilan, DB tak diubah.
const namaPenyewa = (d) => esc(String(d.penyewa?.nama || '-').replace(/(^|[\s.])(\p{Ll})/gu, (m, a, b) => a + b.toUpperCase()));

const base = (title, body, d) => `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
body{font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:800px;margin:0 auto;padding:40px 20px}
.header{text-align:center;margin-bottom:30px;border-bottom:3px solid #2c3e50;padding-bottom:15px}
.header h1{margin:0;color:#2c3e50;font-size:24px}
.header p{margin:5px 0 0 0;font-style:italic;color:#555}
h2{text-align:center;font-size:18px;text-transform:uppercase;margin-bottom:5px}
.doc-number{text-align:center;font-weight:bold;margin-bottom:30px}
h3{font-size:16px;color:#2c3e50;border-bottom:1px solid #ccc;padding-bottom:5px;margin-top:30px}
p{text-align:justify}
table{width:100%;border-collapse:collapse;margin:15px 0}
th,td{border:1px solid #000;padding:10px;text-align:left;vertical-align:top}
th{background-color:#f2f2f2}
.signature-section{display:flex;justify-content:space-between;margin-top:50px;text-align:center}
.signature-box{width:40%}
.signature-name{margin-top:80px;font-weight:bold;text-decoration:underline}
.page-break{page-break-before:always;margin-top:50px;border-top:2px dashed #ccc;padding-top:30px}
.notes{font-style:italic;font-size:14px;color:#666}
@page{size:A4;margin:20mm}
@media print{body{max-width:none;padding:0}.page-break{border-top:0}}
@media(max-width:600px){body{padding:20px 15px}.signature-section{gap:15px}.signature-box{width:45%}}
</style></head><body><div class="header"><h1>KH | ${namaKost(d)}</h1><p>Guesthouse Management · ${val(d.kost?.kota, 'PURWOKERTO').toUpperCase()}</p></div>${body}</body></html>`;

const identitas = (d) => `<h3>IDENTITAS PIHAK</h3><ul>
<li><strong>Pihak Pertama (Pengelola):</strong> ${namaKost(d)}</li>
<li><strong>Pihak Kedua (Penyewa):</strong> ${namaPenyewa(d)}</li>
<li><strong>Nomor WhatsApp:</strong> ${val(d.penyewa?.hp)}</li>
<li><strong>Unit Sewa:</strong> Kamar ${val(d.kamar)}</li></ul>`;

const tandaTangan = (d, kiri='Pihak Pertama (Pengelola)', kanan='Pihak Kedua (Penyewa)') => `<div class="signature-section">
<div class="signature-box"><p>${esc(kiri)}</p><p class="signature-name">${namaKost(d)}</p></div>
<div class="signature-box"><p>${esc(kanan)}</p><p class="signature-name">${namaPenyewa(d)}</p></div></div>`;

const tglTtd = (d) => tanggal(d.tanggalTtd || d.kontrak?.berakhir || d.tanggal);
const jatuhTempo = (d) => val(d.kontrak?.jatuhTempo, String(d.kontrak?.mulai || '').slice(8, 10) || '-');

// Satu badan dokumen per jenis. Paket kontrak menyambung keempatnya dengan page-break.
const bagian = {
  'perjanjian-sewa': (d) => `<h2>PERJANJIAN SEWA KAMAR</h2>
<div class="doc-number">Nomor Dokumen: ${val(d.kontrak?.nomor)}</div>
<p>Pada hari ini, para pihak yang bertanda tangan di bawah ini menyatakan sepakat untuk mengikatkan diri dalam Perjanjian Sewa Kamar dengan rincian data pihak dan ketentuan sebagai berikut:</p>
${identitas(d)}
<h3>KETENTUAN PERJANJIAN</h3>
<p><strong>Pasal 1 · Objek dan Jangka Waktu</strong><br>
Pengelola menyewakan Kamar ${val(d.kamar)} kepada Penyewa untuk keperluan hunian pribadi. Masa sewa disepakati berlaku mulai tanggal <strong>${tanggal(d.kontrak?.mulai)}</strong> sampai dengan <strong>${tanggal(d.kontrak?.berakhir)}</strong>.</p>
<p><strong>Pasal 2 · Nilai Sewa dan Jaminan</strong><br>
Penyewa sepakat untuk membayarkan biaya sewa kepada Pengelola dengan rincian sebagai berikut:</p>
<table><tr><th>Komponen Biaya</th><th>Nilai</th></tr>
<tr><td>Harga Sewa Bulanan</td><td>${rupiah(d.kontrak?.harga)}</td></tr>
<tr><td>Deposit Jaminan</td><td>${rupiah(d.kontrak?.deposit)}</td></tr></table>
<p><strong>Pasal 3 · Hak dan Kewajiban</strong></p>
<ol>
<li><strong>Kewajiban Penyewa:</strong> Membayar biaya sewa tepat waktu, menjaga kebersihan kamar dan fasilitas umum, mematuhi seluruh tata tertib yang berlaku, serta melaporkan segera apabila terdapat kerusakan fasilitas.</li>
<li><strong>Kewajiban Pengelola:</strong> Menyediakan akses hunian dan fasilitas sesuai dengan kesepakatan, serta menangani kebutuhan operasional dan perbaikan secara wajar.</li>
</ol>
<p><strong>Pasal 4 · Penggunaan Kamar dan Fasilitas</strong><br>
Kamar disewa secara eksklusif sebagai hunian pribadi Penyewa. Segala ketentuan terkait penerimaan tamu, penggunaan fasilitas bersama, pemakaian utilitas (listrik/air), pemeliharaan, serta larangan-larangan diatur secara rinci dalam <strong>Lampiran A</strong>.</p>
<p><strong>Pasal 5 · Kerusakan dan Inventaris</strong><br>
Kondisi awal kamar dan inventaris di dalamnya dicatat secara rinci dalam <strong>Lampiran B</strong>. Setiap bentuk kerusakan atau kehilangan yang terjadi di luar batas pemakaian wajar (<em>wear and tear</em>) akan menjadi tanggung jawab Penyewa dan dapat diperhitungkan dalam penyelesaian deposit atau penagihan langsung berdasarkan hasil pemeriksaan.</p>
<p><strong>Pasal 6 · Pengakhiran dan Checkout</strong><br>
Setiap perpanjangan, perubahan, perpindahan kamar, atau pengakhiran kontrak wajib dilaporkan dan dicatat oleh Pengelola. Pada saat proses <em>checkout</em>, Pengelola akan melakukan pemeriksaan kondisi kamar, penyelesaian seluruh tagihan tertunggak, serta perhitungan pengembalian deposit sebagaimana diatur dalam <strong>Lampiran C</strong>.</p>
<p class="notes">*Lampiran A, B, dan C merupakan satu kesatuan dan bagian yang tidak terpisahkan dari perjanjian ini.</p>
<p>Ditandatangani pada tanggal <strong>${tglTtd(d)}</strong>,</p>
${tandaTangan(d)}`,

  'tata-tertib': (d) => `<h3>LAMPIRAN A — TATA TERTIB KOST</h3>
<p><strong>Berlaku untuk:</strong> Kamar ${val(d.kamar)} · ${namaPenyewa(d)}</p>
<ol>
<li><strong>Kenyamanan Bersama:</strong> Penyewa wajib menjaga ketenangan, kebersihan, keamanan, dan kenyamanan seluruh penghuni lain di lingkungan kost.</li>
<li><strong>Aturan Tamu:</strong> Menerima tamu dan aktivitas menginap harus mengikuti jam operasional serta prosedur yang telah ditetapkan oleh pihak Pengelola.</li>
<li><strong>Larangan Aktivitas Ilegal:</strong> Dilarang keras menggunakan kamar untuk kegiatan yang melanggar hukum, norma asusila, atau aktivitas yang berpotensi mengganggu ketertiban lingkungan sekitar.</li>
<li><strong>Fasilitas:</strong> Dilarang memindahkan, mengubah, atau merusak fasilitas properti tanpa persetujuan tertulis dari Pengelola.</li>
<li><strong>Penggunaan Utilitas:</strong> Penggunaan fasilitas listrik, air, jaringan internet, area parkir, dan ruang bersama wajib mengikuti kebijakan standar kost yang berlaku.</li>
<li><strong>Laporan Kerusakan:</strong> Setiap kerusakan atau kehilangan barang inventaris wajib segera dilaporkan. Biaya penggantian atau perbaikan yang sah dapat ditagihkan langsung atau diperhitungkan pada saat penyelesaian deposit.</li>
<li><strong>Perubahan Aturan:</strong> Setiap perubahan tata tertib akan diberitahukan secara resmi oleh Pengelola dan akan dicatat apabila memengaruhi hak serta kewajiban Penyewa.</li>
</ol>
<p class="notes">Penyewa dengan ini menyatakan telah membaca, memahami, dan menyetujui seluruh tata tertib di atas.</p>`,

  'inventaris-kamar': (d) => `<h3>LAMPIRAN B — INVENTARIS DAN KONDISI KAMAR</h3>
<p><strong>Pemeriksaan saat serah terima masuk (Kamar ${val(d.kamar)})</strong></p>
<table>
<tr><th>No.</th><th>Barang / Fasilitas</th><th>Jumlah</th><th>Kondisi Awal</th><th>Catatan Tambahan</th></tr>
${(d.inventaris || [['Kasur','1','Baik','-'],['Lemari','1','Baik','-'],['Meja dan Kursi','1 set','Baik','-'],['Kunci Kamar','2','Baik','-']]).map((x,i) => `<tr><td>${i+1}</td><td>${val(x[0])}</td><td>${val(x[1])}</td><td>${val(x[2])}</td><td>${val(x[3])}</td></tr>`).join('\n')}
</table>
<p><strong>Meteran Utilitas (Saat Masuk):</strong></p>
<ul>
<li>Meter Listrik Awal: ${val(d.meter?.listrik, '_________')}</li>
<li>Meter Air Awal: ${val(d.meter?.air, '_________')}</li>
</ul>
<p><strong>Catatan Kondisi Umum:</strong><br>
_________________________________________________________________________________</p>
<p class="notes">(Dokumentasikan foto kondisi kamar pada saat serah terima bila diperlukan sebagai bukti fisik).</p>`,

  'rincian-sewa-deposit': (d) => `<h3>LAMPIRAN C — RINCIAN SEWA DAN DEPOSIT</h3>
<p><strong>Ringkasan Komersial Kontrak (Kamar ${val(d.kamar)})</strong></p>
<table>
<tr><th>Komponen</th><th>Rincian Kesepakatan</th></tr>
<tr><td><strong>Periode Kontrak</strong></td><td>${tanggal(d.kontrak?.mulai)} – ${tanggal(d.kontrak?.berakhir)}</td></tr>
<tr><td><strong>Harga Sewa</strong></td><td>${rupiah(d.kontrak?.harga)} / bulan</td></tr>
<tr><td><strong>Jatuh Tempo Pembayaran</strong></td><td>Setiap tanggal ${jatuhTempo(d)}</td></tr>
<tr><td><strong>Deposit Jaminan</strong></td><td>${rupiah(d.kontrak?.deposit)}</td></tr>
<tr><td><strong>Biaya Tambahan</strong></td><td>${val(d.kontrak?.biayaTambahan, 'Dikenakan sesuai pemakaian dan kesepakatan tertulis.')}</td></tr>
<tr><td><strong>Ketentuan Pengembalian Deposit</strong></td><td>Dikembalikan selambat-lambatnya setelah <em>checkout</em>, pemeriksaan final kamar, dan penyelesaian seluruh kewajiban atau denda yang sah.</td></tr>
</table>`,

  'tagihan-sewa': (d) => `<h2>TAGIHAN SEWA</h2><div class="doc-number">Periode ${val(d.tagihan?.periode)}</div>${identitas(d)}
<table><tr><th>Jatuh tempo</th><td>${tanggal(d.tagihan?.jatuhTempo)}</td></tr><tr><th>Status</th><td>${val(d.tagihan?.status === 'lunas' ? 'LUNAS' : 'BELUM LUNAS')}</td></tr><tr><th>Total</th><td>${rupiah(d.tagihan?.jumlah)}</td></tr></table>`,

  'surat-tunggakan': (d) => `<h2>PEMBERITAHUAN TUNGGAKAN</h2><div class="doc-number">Nomor Dokumen: ${val(d.kontrak?.nomor)}</div>${identitas(d)}
<p>Berikut tagihan yang tercatat belum diselesaikan:</p>
<table><tr><th>Periode</th><th>Jatuh tempo</th><th>Jumlah</th></tr>${(d.tunggakan || []).map(x => `<tr><td>${val(x.periode)}</td><td>${tanggal(x.jatuhTempo)}</td><td>${rupiah(x.jumlah)}</td></tr>`).join('')}</table>`,

  'kuitansi-pembayaran': (d) => `<h2>KUITANSI PEMBAYARAN</h2><div class="doc-number">Nomor: ${val(d.pembayaran?.nomor)}</div>${identitas(d)}
<table><tr><th>Tanggal</th><td>${tanggal(d.pembayaran?.tanggal)}</td></tr><tr><th>Keterangan</th><td>${val(d.pembayaran?.keterangan)}</td></tr><tr><th>Total dibayar</th><td>${rupiah(d.pembayaran?.jumlah)}</td></tr></table>
${tandaTangan(d, 'Penerima', 'Pembayar')}`,

  'berita-acara-checkout': (d) => `<h2>BERITA ACARA CHECK-OUT</h2><div class="doc-number">Nomor Dokumen: ${val(d.kontrak?.nomor)}</div>${identitas(d)}
<p>Pada tanggal <strong>${tanggal(d.checkout?.tanggal || d.tanggal)}</strong>, dilakukan pemeriksaan dan penyerahan kembali kamar kepada Pengelola.</p>
<table><tr><th>Kondisi kamar</th><td>${val(d.checkout?.kondisi, 'Sesuai pemeriksaan bersama')}</td></tr><tr><th>Meter/utilitas</th><td>${val(d.checkout?.meter)}</td></tr><tr><th>Tunggakan</th><td>${rupiah(d.checkout?.tunggakan)}</td></tr><tr><th>Deposit dikembalikan</th><td>${rupiah(d.checkout?.depositKembali)}</td></tr></table>
${tandaTangan(d)}`,

  'pengembalian-deposit': (d) => `<h2>BUKTI PENGEMBALIAN DEPOSIT</h2><div class="doc-number">Nomor Dokumen: ${val(d.kontrak?.nomor)}</div>${identitas(d)}
<table><tr><th>Deposit awal</th><td>${rupiah(d.deposit?.awal)}</td></tr><tr><th>Potongan</th><td>${rupiah(d.deposit?.potongan)}</td></tr><tr><th>Alasan</th><td>${val(d.deposit?.alasan)}</td></tr><tr><th>Dikembalikan</th><td>${rupiah(d.deposit?.kembali)}</td></tr></table>
${tandaTangan(d)}`,
};

const PAKET = ['perjanjian-sewa', 'tata-tertib', 'inventaris-kamar', 'rincian-sewa-deposit'];
const judul = { 'perjanjian-sewa': 'Perjanjian Sewa Kamar', 'tata-tertib': 'Tata Tertib Kost', 'inventaris-kamar': 'Inventaris Kamar', 'rincian-sewa-deposit': 'Rincian Sewa dan Deposit', 'paket-kontrak': 'Paket Kontrak', 'tagihan-sewa': 'Tagihan Sewa', 'surat-tunggakan': 'Surat Tunggakan', 'kuitansi-pembayaran': 'Kuitansi Pembayaran', 'berita-acara-checkout': 'Berita Acara Check-out', 'pengembalian-deposit': 'Pengembalian Deposit' };

// Teks template yang bisa disunting pemilik lewat tab Template pada menu Kontrak.
// Berisi HTML badan perjanjian dengan {{penanda}}; kop dan gayanya dari `base`.
export const DEFAULT_TEMPLATE = `<h2>PERJANJIAN SEWA KAMAR</h2>
<div class="doc-number">Nomor Dokumen: {{nomor}}</div>
<p>Pada hari ini, para pihak yang bertanda tangan di bawah ini menyatakan sepakat untuk mengikatkan diri dalam Perjanjian Sewa Kamar dengan rincian data pihak dan ketentuan sebagai berikut:</p>
<h3>IDENTITAS PIHAK</h3><ul>
<li><strong>Pihak Pertama (Pengelola):</strong> {{pengelola}}</li>
<li><strong>Pihak Kedua (Penyewa):</strong> {{penyewa}}</li>
<li><strong>Nomor WhatsApp:</strong> {{whatsapp}}</li>
<li><strong>Unit Sewa:</strong> Kamar {{kamar}}</li></ul>
<h3>KETENTUAN PERJANJIAN</h3>
<p><strong>Pasal 1 · Objek dan Jangka Waktu</strong><br>
Pengelola menyewakan Kamar {{kamar}} kepada Penyewa untuk keperluan hunian pribadi. Masa sewa disepakati berlaku mulai tanggal <strong>{{mulai}}</strong> sampai dengan <strong>{{berakhir}}</strong>.</p>
<p><strong>Pasal 2 · Nilai Sewa dan Jaminan</strong><br>
Penyewa sepakat untuk membayarkan biaya sewa kepada Pengelola dengan rincian sebagai berikut:</p>
<table><tr><th>Komponen Biaya</th><th>Nilai</th></tr>
<tr><td>Harga Sewa Bulanan</td><td>{{harga}}</td></tr>
<tr><td>Deposit Jaminan</td><td>{{deposit}}</td></tr></table>
<p><strong>Pasal 3 · Hak dan Kewajiban</strong></p>
<ol>
<li><strong>Kewajiban Penyewa:</strong> Membayar biaya sewa tepat waktu, menjaga kebersihan kamar dan fasilitas umum, mematuhi seluruh tata tertib yang berlaku, serta melaporkan segera apabila terdapat kerusakan fasilitas.</li>
<li><strong>Kewajiban Pengelola:</strong> Menyediakan akses hunian dan fasilitas sesuai dengan kesepakatan, serta menangani kebutuhan operasional dan perbaikan secara wajar.</li>
</ol>
<p><strong>Pasal 4 · Penggunaan Kamar dan Fasilitas</strong><br>
Kamar disewa secara eksklusif sebagai hunian pribadi Penyewa. Segala ketentuan terkait penerimaan tamu, penggunaan fasilitas bersama, pemakaian utilitas (listrik/air), pemeliharaan, serta larangan-larangan diatur secara rinci dalam <strong>Lampiran A</strong>.</p>
<p><strong>Pasal 5 · Kerusakan dan Inventaris</strong><br>
Kondisi awal kamar dan inventaris di dalamnya dicatat secara rinci dalam <strong>Lampiran B</strong>. Setiap bentuk kerusakan atau kehilangan yang terjadi di luar batas pemakaian wajar (<em>wear and tear</em>) akan menjadi tanggung jawab Penyewa dan dapat diperhitungkan dalam penyelesaian deposit atau penagihan langsung berdasarkan hasil pemeriksaan.</p>
<p><strong>Pasal 6 · Pengakhiran dan Checkout</strong><br>
Setiap perpanjangan, perubahan, perpindahan kamar, atau pengakhiran kontrak wajib dilaporkan dan dicatat oleh Pengelola. Pada saat proses <em>checkout</em>, Pengelola akan melakukan pemeriksaan kondisi kamar, penyelesaian seluruh tagihan tertunggak, serta perhitungan pengembalian deposit sebagaimana diatur dalam <strong>Lampiran C</strong>.</p>
<p class="notes">*Lampiran A, B, dan C merupakan satu kesatuan dan bagian yang tidak terpisahkan dari perjanjian ini.</p>
<p>Ditandatangani pada tanggal <strong>{{tanggal_ttd}}</strong>,</p>
<div class="signature-section">
<div class="signature-box"><p>Pihak Pertama (Pengelola)</p><p class="signature-name">{{pengelola}}</p></div>
<div class="signature-box"><p>Pihak Kedua (Penyewa)</p><p class="signature-name">{{penyewa}}</p></div></div>`;

export const PLACEHOLDER = ['pengelola','penyewa','whatsapp','kamar','nomor','mulai','berakhir','harga','deposit','jatuh_tempo','tanggal_ttd'];

const nilaiPenanda = (d) => ({
  pengelola: namaKost(d), penyewa: namaPenyewa(d), whatsapp: val(d.penyewa?.hp),
  kamar: val(d.kamar), nomor: val(d.kontrak?.nomor),
  mulai: tanggal(d.kontrak?.mulai), berakhir: tanggal(d.kontrak?.berakhir),
  harga: rupiah(d.kontrak?.harga), deposit: rupiah(d.kontrak?.deposit),
  jatuh_tempo: jatuhTempo(d), tanggal_ttd: tglTtd(d),
});

// Nilai penanda sudah di-escape saat dibentuk; teks template sendiri dipercaya (diisi admin).
const isiTemplate = (tpl, d) => {
  const v = nilaiPenanda(d);
  return String(tpl).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => (k.toLowerCase() in v ? v[k.toLowerCase()] : m));
};

export const validDocumentType = (type) => Object.hasOwn(judul, type);
export function renderDocument(type, data = {}, opsi = {}) {
  if (!validDocumentType(type)) throw new Error('Jenis dokumen tidak dikenal.');
  const khusus = opsi.template ? isiTemplate(opsi.template, data) : null;
  if (type === 'paket-kontrak') {
    const halaman = PAKET.map((t) => (t === 'perjanjian-sewa' && khusus) ? khusus : bagian[t](data));
    return base(judul[type], halaman.join('<div class="page-break"></div>'), data);
  }
  if (type === 'perjanjian-sewa' && khusus) return base(judul[type], khusus, data);
  return base(judul[type], bagian[type](data), data);
}
export const DOCUMENT_TYPES = Object.keys(judul);
