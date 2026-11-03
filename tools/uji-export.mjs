import assert from 'node:assert/strict';
import { exportLedgerCsv } from '../worker/export.js';

const rows = [
  { tanggal: '2026-11-02', jenis: 'pengeluaran', kategori: 'Wifi', keterangan: '=HYPERLINK("https://bad")', jumlah: 1500 },
  { tanggal: '2026-11-01', jenis: 'pendapatan', kategori: '+cmd', keterangan: 'normal, quoted "cell"', jumlah: 10 },
];
const db = { prepare(sql) { assert.match(sql, /WHERE kost = \?/); return { bind(kost) { assert.equal(kost,'kost-hade'); return { all: async () => ({results:rows}) }; } }; } };
const csv = await exportLedgerCsv(db, 'kost-hade');
assert.match(csv, /'=HYPERLINK/);
assert.match(csv, /'\+cmd/);
assert.match(csv, /"normal, quoted ""cell"""/);
assert.match(csv, /"1500"/);
console.log('PASS export CSV quotes cells and neutralizes spreadsheet formulas');
