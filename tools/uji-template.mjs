import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderDocument, validDocumentType } from '../worker/templates.js';

const data = {
  kost: { nama: 'Kost Hade', kota: 'Purwokerto', hp: '081234567890' },
  penyewa: { nama: 'Budi <S.' , hp: '0812' },
  kamar: 'A-01',
  kontrak: { nomor: 'KON-0001', mulai: '2026-11-01', berakhir: '2027-10-31', harga: 1500000, deposit: 1500000, jatuhTempo: '01' },
  pembayaran: { nomor: 'STR-20261101-001', tanggal: '2026-11-01', jumlah: 1500000, keterangan: 'Sewa November' },
  tagihan: { periode: '2026-11', jatuhTempo: '2026-11-10', jumlah: 1500000, status: 'belum_bayar' },
  tanggalTtd: '2026-11-01',
};

assert.equal(validDocumentType('kuitansi-pembayaran'), true);
assert.equal(validDocumentType('tidak-ada'), false);
const html = renderDocument('kuitansi-pembayaran', data);
assert.match(html, /Kuitansi Pembayaran/);
assert.match(html, /Budi &lt;S\./);
assert.doesNotMatch(html, /<S\./);
assert.match(html, /Rp\s*1\.500\.000/);
for (const type of ['perjanjian-sewa', 'tata-tertib', 'inventaris-kamar', 'rincian-sewa-deposit', 'paket-kontrak', 'tagihan-sewa', 'surat-tunggakan', 'berita-acara-checkout', 'pengembalian-deposit']) {
  assert.match(renderDocument(type, data), /<!doctype html>/i);
}

// Paket = 4 bagian berurutan dengan 3 pemisah halaman, kop hanya sekali.
const paket = renderDocument('paket-kontrak', data);
assert.equal((paket.match(/class="page-break"/g) || []).length, 3);
assert.equal((paket.match(/KH \|/g) || []).length, 1);
const urut = ['PERJANJIAN SEWA KAMAR', 'LAMPIRAN A — TATA TERTIB KOST', 'LAMPIRAN B — INVENTARIS DAN KONDISI KAMAR', 'LAMPIRAN C — RINCIAN SEWA DAN DEPOSIT'];
let pos = -1;
for (const judul of urut) { const i = paket.indexOf(judul); assert.ok(i > pos, `urutan ${judul}`); pos = i; }
assert.doesNotMatch(paket, /<script/i);

// Nama penyewa huruf kecil -> kapital di awal kata; gelar & nama berhuruf besar tetap utuh.
const hurufKecil = renderDocument('perjanjian-sewa', { ...data, penyewa: { nama: 'achmad abi rochidi, s.pd.', hp: '0812' } });
assert.match(hurufKecil, /Achmad Abi Rochidi, S\.Pd\./);
assert.doesNotMatch(hurufKecil, /achmad abi rochidi/);
assert.match(renderDocument('perjanjian-sewa', { ...data, penyewa: { nama: 'Hj. SITI Aminah', hp: '0812' } }), /Hj\. SITI Aminah/);

// Teks paket harus sama persis dengan berkas acuan user (kontrak.html), per baris.
const teks = (h) => h
  .replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|li|tr|td|th|h1|h2|h3|div|ul|ol|table)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t\u00a0]+/g, ' ').trim().split('\n').map((s) => s.trim()).filter(Boolean);
const acuan = teks(readFileSync(new URL('../db/acuan-kontrak.html', import.meta.url), 'utf8'));
const hasil = teks(renderDocument('paket-kontrak', {
  kost: { nama: 'Kost Hade', kota: 'Purwokerto' },
  penyewa: { nama: 'Achmad Abi Rochidi', hp: '085733847442' },
  kamar: '110',
  kontrak: { nomor: 'KON-56193501', mulai: '2026-10-15', berakhir: '2026-11-05', harga: 1100000, deposit: 0, jatuhTempo: '15' },
  tanggalTtd: '2026-11-05',
}));
assert.deepEqual(hasil, acuan);

console.log('template tests passed');
