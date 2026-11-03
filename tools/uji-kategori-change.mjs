import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../pub/app.js', import.meta.url), 'utf8');
assert.match(source, /\['submit',\s*'change'\]\.forEach\(function \(jenis\)/, 'delegated dispatcher must handle select change events');
assert.match(source, /if \(cariAksiForm\(el\)\) return;/, 'form handler must not be triggered by nested input changes');
console.log('PASS delegated change handler updates controls without submitting parent forms');
