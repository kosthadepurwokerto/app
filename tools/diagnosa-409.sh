#!/usr/bin/env bash
# Diagnosa kegagalan uji 409 pada bab 9 uji multitenan.
set -u
cd "$(dirname "$0")/.."
PERSIST=/tmp/hkdiag
PORT=8802
B=http://localhost:$PORT

pkill -f "port $PORT" 2>/dev/null
rm -rf "$PERSIST"; mkdir -p "$PERSIST"
npx wrangler d1 execute hadekost-db --local --persist-to "$PERSIST" --file=db/schema.sql >/dev/null 2>&1
UJI_TANPA_GANTI=1 node tools/buat-akun.mjs master 'Masterpass123' master 'Sang Master' > /tmp/dg-master.sql
npx wrangler d1 execute hadekost-db --local --persist-to "$PERSIST" --file=/tmp/dg-master.sql >/dev/null 2>&1
UJI_TANPA_GANTI=1 node tools/buat-akun.mjs admin 'Kostsaya12345' admin 'Admin Hade' > /tmp/dg-admin.sql
npx wrangler d1 execute hadekost-db --local --persist-to "$PERSIST" --file=/tmp/dg-admin.sql >/dev/null 2>&1

npx wrangler dev --local --persist-to "$PERSIST" --var COOKIE_SECURE:false --port $PORT >/tmp/dg-dev.log 2>&1 &
DEVPID=$!
for i in $(seq 1 60); do curl -s -o /dev/null "$B/api/session" && break; sleep 1; done

J=/tmp/dg.jar; rm -f $J
curl -s -c $J -o /dev/null -X POST -H 'content-type: application/json' -d '{"username":"master","password":"Masterpass123"}' $B/api/login

echo "1) master buat Kost Melati"
curl -s -b $J -X POST -H 'content-type: application/json' \
  -d '{"namaApp":"Kost Melati","kota":"Semarang","tagline":"Kost Putri","username":"admin","password":"Melati12345","fullname":"Admin Melati"}' \
  "$B/api/master/kost" | head -c 200; echo

echo "2) isi users setelah pembuatan kost"
npx wrangler d1 execute hadekost-db --local --persist-to "$PERSIST" --json --command "select username, kost from users order by kost" 2>/dev/null \
 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>JSON.parse(s)[0].results.forEach(r=>console.log('   ',r.kost,'->',r.username)))"

echo "3) master pindah ke kost-melati"
curl -s -b $J -X POST -H 'content-type: application/json' -d '{"kunci":"kost-melati"}' "$B/api/pilih-kost" | head -c 100; echo
echo "   sesi: $(curl -s -b $J "$B/api/session" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);console.log((d.user&&d.user.username)+" @ "+(d.kost&&d.kost.kunci))})')"

echo "4) coba buat 'admin' lagi di kost-melati (HARUSNYA 409)"
curl -s -b $J -o /tmp/dg-out.json -w '   status=%{http_code}\n' -X POST -H 'content-type: application/json' \
  -d '{"action":"users.create","data":{"username":"admin","fullname":"Dup","password":"Lagi1234567","role":"staff"}}' "$B/api/action"
cat /tmp/dg-out.json; echo

echo "5) isi users setelah percobaan"
npx wrangler d1 execute hadekost-db --local --persist-to "$PERSIST" --json --command "select username, fullname, kost from users order by kost" 2>/dev/null \
 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>JSON.parse(s)[0].results.forEach(r=>console.log('   ',r.kost,'->',r.username,'/',r.fullname)))"

kill $DEVPID 2>/dev/null
