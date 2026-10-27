#!/usr/bin/env bash
# Uji MULTITENAN: dua kost, isolasi data, peran master/admin, parameter, logo, reset.
# Server dijalankan sendiri di port 8798 dengan DB lokal terpisah (/tmp/hkmulti-uji).
set -u
cd "$(dirname "$0")/.."
PERSIST=/tmp/hkmulti-uji
PORT=8798
B=http://localhost:$PORT
fail=0
ck() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (harap $3, dapat $2)${4:+ | balasan: $4}"; fail=$((fail+1)); fi; }
# cek dengan isi balasan (dipakai saat mendiagnosa kegagalan API)
ckb() { local isi; isi=$(cat /tmp/act.out 2>/dev/null | head -c 160); ck "$1" "$2" "$3" "$isi"; }
json() { node -e "const d=JSON.parse(require('fs').readFileSync('$1','utf8'));console.log($2)"; }
# Bedakan "tidak bisa masuk" (cookie hilang -> 200/undefined) dari "jawaban dari kost yang salah".

pkill -f "port $PORT" 2>/dev/null
rm -rf "$PERSIST"; mkdir -p "$PERSIST"
npx wrangler d1 execute hadekost-db --local --persist-to "$PERSIST" --file=db/schema.sql >/tmp/m-schema.log 2>&1 || { echo "SKEMA GAGAL"; tail -5 /tmp/m-schema.log; exit 1; }

# Akun master (role master) + admin kost pertama
UJI_TANPA_GANTI=1 node tools/buat-akun.mjs master 'Masterpass123' master 'Sang Master' > /tmp/m-master.sql
npx wrangler d1 execute hadekost-db --local --persist-to "$PERSIST" --file=/tmp/m-master.sql >/dev/null 2>&1
UJI_TANPA_GANTI=1 node tools/buat-akun.mjs admin 'Kostsaya12345' admin 'Administrator Utama' > /tmp/m-admin.sql
npx wrangler d1 execute hadekost-db --local --persist-to "$PERSIST" --file=/tmp/m-admin.sql >/dev/null 2>&1

npx wrangler dev --local --persist-to "$PERSIST" --var COOKIE_SECURE:false --port $PORT >/tmp/m-dev.log 2>&1 &
DEVPID=$!
for i in $(seq 1 60); do curl -s -o /dev/null "$B/api/session" && break; sleep 1; done

TODAY=$(TZ=Asia/Makassar date +%F)
JAR_M=/tmp/m-master.jar; A=/tmp/m-admin.jar
login() { curl -s -c "$1" -o "$2" -w '%{http_code}' -X POST -H 'content-type: application/json' -d "{\"username\":\"$3\",\"password\":\"$4\"}" $B/api/login; }
tokof() { sed -n 's/.*"token": *"\([^"]*\)".*/\1/p' "$1"; }
act() { curl -s -o /tmp/act.out -w '%{http_code}' -X POST -H 'content-type: application/json' -H "x-sesi-apk: $1" -d "$2" $B/api/action; }

echo "== 1. LOGIN & PERAN =="
ck "Master login" "$(login $JAR_M /tmp/r1 master Masterpass123)" "200"
ck "Login balas role master" "$(json /tmp/r1 "d.user.role")" "master"
ck "Admin login" "$(login $A /tmp/r2 admin Kostsaya12345)" "200"
ck "Login memuat branding" "$(json /tmp/r2 "d.kost.namaApp+'/'+d.kost.kota")" "Kost Hade/Purwokerto"
TM_MASTER=$(tokof /tmp/r1); TA=$(tokof /tmp/r2)

echo "== 2. HANYA MASTER KELOLA DAFTAR KOST =="
ck "Admin lihat daftar kost 403" "$(curl -s -o /dev/null -w '%{http_code}' -b $A $B/api/master/kost)" "403"
ck "Admin buat kost 403" "$(curl -s -o /dev/null -w '%{http_code}' -b $A -X POST -H 'content-type: application/json' -d '{"namaApp":"Nakal","username":"nakal","password":"Nakal12345"}' $B/api/master/kost)" "403"
ck "Master buat Kost Melati" "$(curl -s -b $JAR_M -o /tmp/r3 -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"namaApp":"Kost Melati","kota":"Semarang","tagline":"Kost Putri","username":"adminmelati","password":"Melati12345"}' $B/api/master/kost)" "200"
ck "Kunci = slug nama" "$(json /tmp/r3 'd.kost.kunci')" "kost-melati"
ck "Nama dobel ditolak 409" "$(curl -s -o /dev/null -w '%{http_code}' -b $JAR_M -X POST -H 'content-type: application/json' -d '{"namaApp":"Kost Melati","username":"lain","password":"Lain123456"}' $B/api/master/kost)" "409"
ck "Master lihat 2 kost" "$(curl -s -b $JAR_M $B/api/master/kost | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).daftar.length))")" "2"

echo "== 3. ADMIN KOST BARU =="
curl -s -o /tmp/r4 -X POST -H 'content-type: application/json' -d '{"username":"adminmelati","password":"Melati12345"}' $B/api/login
TM=$(tokof /tmp/r4)
ck "Wajib ganti sandi (bootstrap 403)" "$(curl -s -o /dev/null -w '%{http_code}' -H "x-sesi-apk: $TM" $B/api/bootstrap)" "403"
curl -s -o /dev/null -X POST -H 'content-type: application/json' -H "x-sesi-apk: $TM" -d '{"lama":"Melati12345","baru":"MelatiBaru123"}' $B/api/password
curl -s -o /tmp/r5 -X POST -H 'content-type: application/json' -d '{"username":"adminmelati","password":"MelatiBaru123"}' $B/api/login
TM=$(tokof /tmp/r5)
ck "Setelah ganti sandi (bootstrap 200)" "$(curl -s -o /dev/null -w '%{http_code}' -H "x-sesi-apk: $TM" $B/api/bootstrap)" "200"
ck "Branding Melati" "$(curl -s -H "x-sesi-apk: $TM" $B/api/bootstrap -o /tmp/r6; json /tmp/r6 "d.kost.namaApp+'/'+d.kost.kota")" "Kost Melati/Semarang"

echo "== 4. ISOLASI DATA =="
ck "Hade tambah kamar 101" "$(act "$TA" '{"action":"rooms.create","data":{"noKamar":"101","tipe":"Standar","hargaBulanan":1100000}}')" "200"
ck "Hade daftar Budi" "$(act "$TA" "{\"action\":\"tenants.create\",\"data\":{\"nama\":\"Budi Hade\",\"hp\":\"8123456789\",\"kamar\":\"101\",\"tglMasuk\":\"$TODAY\"}}")" "200"
ck "Tagihan otomatis 1.100.000" "$(curl -s -H "x-sesi-apk: $TA" $B/api/bootstrap -o /tmp/r7; json /tmp/r7 'd.penyewa[0][7]')" "1100000"
ck "Melati tambah kamar 101 sendiri" "$(act "$TM" '{"action":"rooms.create","data":{"noKamar":"101","tipe":"Melati","hargaBulanan":900000}}')" "200"
ck "Melati daftar Siti" "$(act "$TM" "{\"action\":\"tenants.create\",\"data\":{\"nama\":\"Siti Melati\",\"hp\":\"81299990000\",\"kamar\":\"101\",\"tglMasuk\":\"$TODAY\"}}")" "200"
ck "Melati hanya lihat Siti" "$(curl -s -H "x-sesi-apk: $TM" $B/api/bootstrap -o /tmp/r8; json /tmp/r8 "d.penyewa.map(p=>p[1]).join(',')")" "Siti Melati"
ck "Hade hanya lihat Budi" "$(curl -s -H "x-sesi-apk: $TA" $B/api/bootstrap -o /tmp/r9; json /tmp/r9 "d.penyewa.map(p=>p[1]).join(',')")" "Budi Hade"
ck "HP penyewa Hade tidak terlihat di Melati" "$(grep -c '8123456789' /tmp/r8)" "0"

echo "== 5. PEMBAYARAN TERPISAH =="
ck "Melati bayar 900rb" "$(act "$TM" "{\"action\":\"payments.create\",\"data\":{\"kamar\":\"101\",\"jumlah\":900000,\"tanggal\":\"$TODAY\"}}")" "200"
ck "Hade bayar 1,1jt" "$(act "$TA" "{\"action\":\"payments.create\",\"data\":{\"kamar\":\"101\",\"jumlah\":1100000,\"tanggal\":\"$TODAY\"}}")" "200"
ck "Kas Melati 900000" "$(curl -s -H "x-sesi-apk: $TM" $B/api/bootstrap -o /tmp/r10; json /tmp/r10 'd.stats.sisaKas')" "900000"
ck "Kas Hade 1100000" "$(curl -s -H "x-sesi-apk: $TA" $B/api/bootstrap -o /tmp/r11; json /tmp/r11 'd.stats.sisaKas')" "1100000"

echo "== 6. PARAMETER & LOGO =="
ck "Admin ubah parameter" "$(curl -s -o /dev/null -w '%{http_code}' -b $A -X POST -H 'content-type: application/json' -d '{"kota":"Purwokerto Kota","tagline":"Guesthouse Premium"}' $B/api/parameter)" "200"
ck "Nama aplikasi tidak bisa diubah (409)" "$(curl -s -o /dev/null -w '%{http_code}' -b $A -X POST -H 'content-type: application/json' -d '{"namaApp":"Nama Baru"}' $B/api/parameter)" "409"
ck "Kota tersimpan" "$(curl -s -H "x-sesi-apk: $TA" $B/api/bootstrap -o /tmp/r12; json /tmp/r12 'd.kost.kota')" "Purwokerto Kota"
printf '\x89PNG\r\n\x1a\n' > /tmp/m-logo.png
ck "Unggah logo" "$(curl -s -o /tmp/r13 -w '%{http_code}' -b $A -X POST -F 'file=@/tmp/m-logo.png;type=image/png' $B/api/parameter/logo)" "200"
LK=$(json /tmp/r13 'd.kost.logoKunci')
ck "Logo terbuka publik" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/logo?kunci=$LK&kost=kost-hade")" "200"
ck "Logo kost lain ditolak 403" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/logo?kunci=$LK&kost=kost-melati")" "403"

echo "== 7. RESET KHUSUS MASTER =="
ck "Admin reset 403" "$(act "$TA" '{"action":"data.resetLog","data":{"password":"Kostsaya12345"}}')" "403"
ck "Master reset tanpa sandi 401" "$(act "$TM_MASTER" '{"action":"data.resetLog","data":{}}')" "401"
ck "Master reset log Hade" "$(act "$TM_MASTER" '{"action":"data.resetLog","data":{"password":"Masterpass123"}}')" "200"
ck "Kas Hade 0 setelah reset" "$(curl -s -H "x-sesi-apk: $TA" $B/api/bootstrap -o /tmp/r14; json /tmp/r14 'd.stats.sisaKas')" "0"
ck "Kas Melati tidak terpengaruh" "$(curl -s -H "x-sesi-apk: $TM" $B/api/bootstrap -o /tmp/r15; json /tmp/r15 'd.stats.sisaKas')" "900000"
ck "Kamar & penyewa Hade utuh" "$(curl -s -H "x-sesi-apk: $TA" $B/api/bootstrap -o /tmp/r16; json /tmp/r16 "d.stats.totalKamar+'/'+d.stats.totalPenyewa")" "1/1"

echo "== 8. MASTER BERPINDAH KOST =="
ck "Master pilih kost-melati" "$(curl -s -o /dev/null -w '%{http_code}' -b $JAR_M -X POST -H 'content-type: application/json' -d '{"kunci":"kost-melati"}' $B/api/pilih-kost)" "200"
ck "Master lihat data Melati" "$(curl -s -b $JAR_M $B/api/bootstrap -o /tmp/r17; json /tmp/r17 "d.kost.namaApp+'/'+d.stats.sisaKas")" "Kost Melati/900000"
ck "Admin tidak boleh pindah kost" "$(curl -s -o /dev/null -w '%{http_code}' -b $A -X POST -H 'content-type: application/json' -d '{"kunci":"kost-melati"}' $B/api/pilih-kost)" "403"

echo "== 9. USERNAME SAMA DI DUA KOST =="
ck "Master buat kost ketiga" "$(curl -s -o /dev/null -w '%{http_code}' -b $JAR_M -X POST -H 'content-type: application/json' -d '{"namaApp":"Kost Tiga","kota":"Solo","tagline":"Kost Tiga","username":"admin","password":"TigaAdmin123","fullname":"Admin Tiga","hp":"0857-9999-0000"}' $B/api/master/kost)" "200"
# "tigaadmin" milik Kost Tiga. Master kini di kost-melati, jadi di sana nama itu BUKAN duplikat -> boleh.
ck "Nama milik kost lain boleh dibuat di sini" "$(curl -s -o /tmp/act.out -w '%{http_code}' -b $JAR_M -X POST -H 'content-type: application/json' -d '{"action":"users.create","data":{"username":"tigaadmin","fullname":"Tiga di Melati","password":"Lagi1234567","role":"staff"}}' $B/api/action)" "200"
# ...dan sekarang di kost-melati sudah ada: membuat lagi -> 409.
ck "Username sama TIDAK boleh dua kali dalam satu kost (409)" "$(curl -s -o /tmp/act.out -w '%{http_code}' -b $JAR_M -X POST -H 'content-type: application/json' -d '{"action":"users.create","data":{"username":"tigaadmin","fullname":"Duplikat","password":"Lagi1234567","role":"staff"}}' $B/api/action)" "409"
# Nama yang sama di kost lain tetap sah: pindah ke kost-hade lalu buat "tigaadmin".
ck "Pindah ke Kost Hade" "$(curl -s -o /dev/null -w '%{http_code}' -b $JAR_M -X POST -H 'content-type: application/json' -d '{"kunci":"kost-hade"}' $B/api/pilih-kost)" "200"
ck "Username sama di kost lain tetap boleh" "$(curl -s -o /tmp/act.out -w '%{http_code}' -b $JAR_M -X POST -H 'content-type: application/json' -d '{"action":"users.create","data":{"username":"tigaadmin","fullname":"Tiga di Hade","password":"Lagi1234567","role":"staff"}}' $B/api/action)" "200"
ck "Kost Hade tetap punya admin-nya sendiri" "$(curl -s -b $JAR_M $B/api/bootstrap -o /tmp/t13.json; node -e "const d=require('/tmp/t13.json');console.log(d.kost.namaApp+'/'+d.users.filter(u=>u.username==='admin').length)")" "Kost Hade/1"

kill $DEVPID 2>/dev/null
echo
if [ $fail -eq 0 ]; then echo "SEMUA LULUS MULTITENAN"; else echo "$fail GAGAL"; fi
exit $fail
