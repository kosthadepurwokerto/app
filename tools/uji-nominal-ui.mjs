// uji regresi: -5000 / -5.000 tidak boleh jadi 5000
import { nominalUang } from '../worker/logic.js';
const kasus = [['-5000',null],['-5.000',null],['abc',null],['1,5',null],['1.500',1500],['Rp 1.500',1500],['1500',1500]];
let gagal=0;
for (const [v, harus] of kasus) {
  const h = nominalUang(v);
  const ok = h === harus;
  if (!ok) gagal++;
  console.log((ok?'PASS':'FAIL'), JSON.stringify(v), '=>', h, '(harus', harus + ')');
}
process.exit(gagal?1:0);
