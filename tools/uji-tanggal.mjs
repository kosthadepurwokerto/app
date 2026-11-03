import assert from 'node:assert/strict';
import { addMonths } from '../worker/logic.js';

assert.equal(addMonths('2026-10-31', 1), '2026-11-30');
assert.equal(addMonths('2026-10-31', 2), '2026-12-31');
assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
assert.equal(addMonths('2026-01-31', 2), '2026-03-31');
console.log('PASS kalender bulanan mempertahankan tanggal anchor akhir bulan');
