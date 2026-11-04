import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../pub/app.js', import.meta.url), 'utf8');
assert.match(source, /function startEditCategory\([\s\S]*?category-nama[\s\S]*?scrollIntoView/, 'edit kategori harus mengembalikan form ke viewport mobile');
assert.match(source, /getElementById\('category-nama'\)[\s\S]*?\.focus\(/, 'edit kategori harus memfokuskan nama kategori');
console.log('PASS edit kategori mengarahkan form ke viewport mobile dan fokus ke nama');
