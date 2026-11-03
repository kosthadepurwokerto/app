import assert from 'node:assert/strict';
import { dbKost } from '../worker/db-kost.js';

const calls = [];
const raw = {
  prepare(sql) {
    return {
      bind(...args) {
        calls.push({ sql, args });
        return { run: async () => ({}) };
      },
    };
  },
};

await dbKost(raw, 'kost-hade').prepare(
  'update categories set jenis=?, nama=?, saldo_normal=?, arus_kas=? where id=?'
).bind('pengeluaran', 'Kategori Baru', 'Debet', 1, 7).run();

assert.deepEqual(calls[0].args, ['pengeluaran', 'Kategori Baru', 'Debet', 1, 7, 'kost-hade']);
console.log('PASS db-kost UPDATE mempertahankan urutan parameter edit kategori');
