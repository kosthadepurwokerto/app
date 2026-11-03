#!/usr/bin/env bash
# Uji isolasi ANTAR-KOST (regresi).
#
# Suite utama (uji-e2e.sh) hanya memakai satu kost, sehingga bug yang menulis data
# ke kost yang salah tidak pernah tertangkap. Di sini dipakai DUA kost:
#   kost-hade   (id_baru 1)  -> sudah ada 1 kamar 101
#   kost-melati (id_baru 2)  -> kosong, kamar dibuat lewat API
# Akun admin punya akses ke keduanya, jadi bisa berpindah kost seperti di produksi.
#
# Pemakaian: bash tools/uji-dua-kost.sh   (dipanggil otomatis oleh uji-lokal.sh)
set -u
set -o pipefail
cd "$(dirname "$0")/.."
B=${B:-http://localhost:8788}
PERSIST=${PERSIST2:-/tmp/hk2kuji}
PIDF=/tmp/hk2dev2.pid
fail=0
ck() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (harap $3, dapat $2)"; fail=$((fail+1)); fi; }
code() { curl -s -o /tmp/hade_body2 -w '%{http_code}' "$@"; }
jq_() { node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('/tmp/hade_body2'));const fn=new Function('d','return ('+process.argv[1]+')');const v=fn(d);console.log(typeof v==='object'&&v!==null?JSON.stringify(v):v)" "$1"; }
actj() { code -b "$1" -X POST -H 'content-type: application/json' -d "$2" "$B/api/action"; }
# dbq <sql> -> nilai kolom pertama dari D1 lokal (lewat wrangler, bukan baca file sqlite langsung)
dbq() {
  npx wrangler d1 execute hadekost-db --local --persist-to "$PERSIST" --json --command="$1" 2>/dev/null \
    | /usr/bin/python3 -c 'import json,sys
raw=sys.stdin.read(); i=raw.find("[")
try:
    d=json.loads(raw[i:])
    r=d[0]["results"][0]
    print(list(r.values())[0] if r else "")
except Exception:
    print("ERR")'
}

# --- 1) bersihkan proses lama pada persist ini ---
if [ -f "$PIDF" ]; then for pid in $(cat "$PIDF"); do kill "$pid" 2>/dev/null; done; fi
for p in $(ps -eo pid,args | grep -E "(wrangler|workerd).*--persist-to $PERSIST" | grep -v grep | grep -v 'ps -eo' | awk '{print $1}'); do kill "$p" 2>/dev/null; done
for i in $(seq 1 30); do ss -ltn 2>/dev/null | grep -q ":$(( ${B##*:} )) " || break; sleep 0.5; done
rm -rf "$PERSIST"; mkdir -p "$PERSIST"

# --- 2) skema + migrasi ---
npx wrangler d1 execute hadekost-db --local --persist-to "$PERSIST" --file=db/schema.sql >/tmp/hk2-schema.log 2>&1 \
  || { echo "SKEMA GAGAL"; tail -5 /tmp/hk2-schema.log; exit 1; }
for m in db/migrasi-017-*.sql db/migrasi-020-*.sql db/migrasi-021-*.sql; do
  [ -f "$m" ] || continue
  npx wrangler d1 execute hadekost-db --local --persist-to "$PERSIST" --file="$m" >>/tmp/hk2-schema.log 2>&1 \
    || { echo "MIGRASI GAGAL: $m"; tail -5 /tmp/hk2-schema.log; exit 1; }
done

# --- 3) akun admin + kost kedua + akses ---
UJI_TANPA_GANTI=1 UJI_HP=081200000100 node tools/buat-akun.mjs admin 'Kostsaya12345' admin 'Administrator Utama' > "$PERSIST/akun.sql"
npx wrangler d1 execute hadekost-db --local --persist-to "$PERSIST" --file="$PERSIST/akun.sql" >/dev/null 2>&1
rm -f "$PERSIST/akun.sql"
cat > "$PERSIST/dua.sql" <<'SQL'
insert or ignore into kosts (kunci, nama_app, kota, tagline) values ('kost-melati', 'Kost Melati', 'Solo', 'Penginapan');

insert or ignore into akses_kost (user_id, kost) select id, 'kost-melati' from users where username = 'admin';
insert or ignore into categories (jenis, nama, saldo_normal, arus_kas, kost)
  select jenis, nama, saldo_normal, arus_kas, 'kost-melati' from categories where kost = 'kost-hade';
insert or ignore into rooms (no_kamar, tipe, harga_bulanan, harga_harian, status, kost)
  values ('101', 'Reguler', 750000, 0, 'tersedia', 'kost-hade');
SQL
npx wrangler d1 execute hadekost-db --local --persist-to "$PERSIST" --file="$PERSIST/dua.sql" >/tmp/hk2-seed.log 2>&1 \
  || { echo "SEED GAGAL"; tail -5 /tmp/hk2-seed.log; exit 1; }
rm -f "$PERSIST/dua.sql"

# --- 4) server kedua ---
setsid npx wrangler dev --local --persist-to "$PERSIST" --var COOKIE_SECURE:false --port "${B##*:}" >/tmp/hkdev2.log 2>&1 < /dev/null &
echo $! > "$PIDF"
for i in $(seq 1 60); do curl -s -o /dev/null "$B/api/session" && break; sleep 1; done

J=$(mktemp)
TODAY=$(date +%F)

echo "== MULTI-KOST: PILIH KOST =="
ck "Login admin dua kost minta pilih kost" "$(code -c "$J" -X POST -H 'content-type: application/json' -d '{"username":"081200000100","password":"Kostsaya12345"}' "$B/api/login")" "200"
ck "Balasan login meminta pilih kost" "$(jq_ 'd.perluPilihKost === true')" "true"
ck "Daftar kost berisi dua kost" "$(jq_ 'd.daftarKost.map(k=>k.kunci).sort().join(",")')" "kost-hade,kost-melati"
ck "Kost tak dikenal ditolak 400 (bukan diterima mentah)" "$(code -b "$J" -X POST -H 'content-type: application/json' -d '{"kunci":"kost-ngawur"}' "$B/api/pilih-kost")" "400"
ck "Pesan: kode aplikasi tidak dikenal" "$(jq_ 'd.error')" "Kode aplikasi tidak dikenal."
ck "Pilih kost lewat slug diterima" "$(code -b "$J" -X POST -H 'content-type: application/json' -d '{"kunci":"kost-hade"}' "$B/api/pilih-kost")" "200"
ck "Slug tetap menjadi kunci kost kanonik" "$(jq_ 'd.kost.kunci')" "kost-hade"
ck "Nama kost ikut benar (bukan kosong)" "$(jq_ 'd.kost.kota')" "Purwokerto"
ck "Sesi tersimpan sebagai slug, bukan angka" "$(code -b "$J" "$B/api/session" >/dev/null; jq_ 'd.user.kost')" "kost-hade"
ck "Pilih kost-melati" "$(code -b "$J" -X POST -H 'content-type: application/json' -d '{"kunci":"kost-melati"}' "$B/api/pilih-kost")" "200"
ck "Sesi aktif di kost-melati" "$(code -b "$J" "$B/api/session" >/dev/null; jq_ 'd.user.kost')" "kost-melati"

echo "== MULTI-KOST: BACA TIDAK BOCOR =="
ck "Dashboard Melati tidak memuat kamar Hade" "$(code -b "$J" "$B/api/bootstrap" >/dev/null; jq_ 'd.kamar.length')" "0"
ck "Kategori Melati ada (hasil duplikasi seed)" "$(code -b "$J" "$B/api/bootstrap" >/dev/null; jq_ 'Object.values(d.kategori).flat().length > 0')" "true"
ck "Audit log Melati tidak membocorkan aktivitas Hade" "$(code -b "$J" "$B/api/audit-log" >/dev/null; jq_ 'd.logs.every(x=>x.kost==="kost-melati")')" "true"
# Staff tidak boleh membaca audit log yang memuat rincian data pribadi.
# (akun staff dibuat pada suite utama, bukan tersedia pada fixture dua kost.)

echo "== MULTI-KOST: TULIS MASUK KE KOST AKTIF =="
KODE_M=$(date +%s | tail -c 6)
ck "Buat kamar M$KODE_M di Melati" "$(actj "$J" "{\"action\":\"rooms.create\",\"noKamar\":\"M$KODE_M\",\"tipe\":\"Standar\",\"hargaBulanan\":900000,\"hargaHarian\":0}")" "200"
ck "Kamar tersimpan dengan kost=kost-melati" "$(dbq "select kost from rooms where no_kamar='M$KODE_M'")" "kost-melati"
ck "Kamar Hade tidak bertambah (jumlah 1)" "$(dbq "select count(*) from rooms where kost='kost-hade'")" "1"
ck "Dashboard Melati memuat kamar baru" "$(code -b "$J" "$B/api/bootstrap" >/dev/null; jq_ 'd.kamar.length')" "1"
ck "Daftar penyewa Melati masih kosong" "$(code -b "$J" "$B/api/bootstrap" >/dev/null; jq_ 'd.penyewa.length')" "0"

ck "Daftarkan penyewa di kamar Melati" "$(actj "$J" "{\"action\":\"tenants.create\",\"data\":{\"nama\":\"Sari Melati\",\"hp\":\"81277770001\",\"kamar\":\"M$KODE_M\",\"tglMasuk\":\"$TODAY\"}}")" "200"
ck "Penyewa tersimpan dengan kost=kost-melati" "$(dbq "select kost from tenants where nama='Sari Melati'")" "kost-melati"
printf 'iVBORw0KGgo=' | base64 -d > "$PERSIST/ktp-uji.png"
KTP_M=$(code -b "$J" -X POST -F "file=@$PERSIST/ktp-uji.png;type=image/png" "$B/api/ktp")
ck "Unggah KTP Sari Melati" "$KTP_M" "200"
KTP_KEY_M=$(jq_ 'd.kunci')
actj "$J" "{\"action\":\"tenants.update\",\"data\":{\"id\":\"TEN-0001\",\"ktpKey\":\"$KTP_KEY_M\",\"ktpTipe\":\"image/png\"}}" >/dev/null
ck "Pindah sesi ke Hade untuk uji KTP" "$(code -b "$J" -X POST -H 'content-type: application/json' -d '{"kunci":"kost-hade"}' "$B/api/pilih-kost")" "200"
ck "KTP Melati tidak bisa diambil dari sesi Hade" "$(code -b "$J" "$B/api/ktp/penyewa/TEN-0001")" "404"
ck "Kembali ke kost Melati" "$(code -b "$J" -X POST -H 'content-type: application/json' -d '{"kunci":"kost-melati"}' "$B/api/pilih-kost")" "200"
ck "Tagihan pertama memakai kost-melati" "$(dbq "select kost from bills order by id desc limit 1")" "kost-melati"
ck "Kamar Melati berstatus terisi" "$(dbq "select status from rooms where no_kamar='M$KODE_M'")" "terisi"
ck "Kamar Hade tetap tersedia" "$(dbq "select status from rooms where kost='kost-hade'")" "tersedia"
ck "Dashboard Melati: 1 penyewa" "$(code -b "$J" "$B/api/bootstrap" >/dev/null; jq_ 'd.penyewa.length')" "1"

echo "== MULTI-KOST: PENDAPATAN / KATEGORI =="
ck "Catat pendapatan lain di Melati" "$(actj "$J" '{"action":"ledger.create","data":{"jenis":"Pendapatan","kategori":"Pemasukan Lain-lain","keterangan":"uji dua kost","jumlah":100000,"tanggal":"'"$TODAY"'"}}')" "200"
ck "Ledger tersimpan dengan kost=kost-melati" "$(dbq "select kost from ledger order by id desc limit 1")" "kost-melati"
ck "Kategori Melati punya salinan sendiri (19)" "$(dbq "select count(*) from categories where kost='kost-melati'")" "19"
ck "Kategori Hade tidak bertambah (19)" "$(dbq "select count(*) from categories where kost='kost-hade'")" "19"

echo "== MULTI-KOST: KEMBALI KE KOST PERTAMA =="
ck "Pindah kembali ke Hade" "$(code -b "$J" -X POST -H 'content-type: application/json' -d '{"kunci":"kost-hade"}' "$B/api/pilih-kost")" "200"
ck "Dashboard Hade: tetap 1 kamar" "$(code -b "$J" "$B/api/bootstrap" >/dev/null; jq_ 'd.kamar.length')" "1"
ck "Dashboard Hade: penyewa Melati tidak terlihat" "$(code -b "$J" "$B/api/bootstrap" >/dev/null; jq_ 'd.penyewa.length')" "0"
ck "Tambah kamar H99 di Hade" "$(actj "$J" '{"action":"rooms.create","noKamar":"H99","tipe":"Reguler","hargaBulanan":800000,"hargaHarian":0}')" "200"
ck "Kamar H99 tersimpan dengan kost=kost-hade" "$(dbq "select kost from rooms where no_kamar='H99'")" "kost-hade"
ck "Kamar Melati tetap hanya 1" "$(dbq "select count(*) from rooms where kost='kost-melati'")" "1"
ck "Nomor kamar yang sama di kost ini ditolak 409" "$(actj "$J" '{"action":"rooms.create","noKamar":"M'"$KODE_M"'","tipe":"Standar","hargaBulanan":900000}')" "409"

echo "== MULTI-KOST: KODE PENYEWA BERURUTAN PER KOST =="
ck "Pindah ke Melati lagi" "$(code -b "$J" -X POST -H 'content-type: application/json' -d '{"kunci":"kost-melati"}' "$B/api/pilih-kost")" "200"
ck "Buat kamar M2$KODE_M" "$(actj "$J" "{\"action\":\"rooms.create\",\"noKamar\":\"M2$KODE_M\",\"tipe\":\"Standar\",\"hargaBulanan\":900000}")" "200"
ck "Daftarkan penyewa kedua Melati" "$(actj "$J" "{\"action\":\"tenants.create\",\"data\":{\"nama\":\"Budi Melati\",\"hp\":\"81277770002\",\"kamar\":\"M2$KODE_M\",\"tglMasuk\":\"$TODAY\"}}")" "200"
ck "Kode penyewa kedua bukan bentrok (TEN-0002)" "$(jq_ 'd.message.includes("TEN-0002")')" "true"
ck "Dua penyewa Melati, tetap tanpa data Hade" "$(dbq "select count(*) from tenants where kost='kost-melati'")" "2"

echo "== MULTI-KOST: SELESAI (gagal: $fail) =="

# --- bersihkan ---
for pid in $(cat "$PIDF"); do kill "$pid" 2>/dev/null; done
for p in $(ps -eo pid,args | grep -E "(wrangler|workerd).*--persist-to $PERSIST" | grep -v grep | grep -v 'ps -eo' | awk '{print $1}'); do kill "$p" 2>/dev/null; done
rm -f "$PIDF" "$J"
if [ $fail -eq 0 ]; then echo "DUA-KOST SEMUA LULUS"; else echo "DUA-KOST GAGAL: $fail"; fi
exit $fail
