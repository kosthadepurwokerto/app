echo "== PINDAH KAMAR =="
# Blok ini jalan di akhir suite (sesudah LOGOUT), jadi sesi admin dipasang ulang.
# Batas percobaan login sengaja terisi oleh uji sandi di depan: kosongkan dulu.
npx wrangler d1 execute hadekost-db --local --persist-to "${PERSIST:-/tmp/hklocal}" --command "delete from login_percobaan" >/dev/null 2>&1
code -c $J -X POST -H 'content-type: application/json' -d '{"username":"081200000100","password":"Kostsaya12345"}' "$B/api/login" >/dev/null
code -b $S -X POST -H 'content-type: application/json' -d '{"username":"081200000103","password":"Staffpass123"}' "$B/api/login" >/dev/null

actj $J '{"action":"rooms.create","data":{"noKamar":"301","tipe":"Standar","hargaBulanan":1100000}}' >/dev/null
actj $J '{"action":"rooms.create","data":{"noKamar":"302","tipe":"Standar","hargaBulanan":1100000}}' >/dev/null
actj $J '{"action":"rooms.create","data":{"noKamar":"303","tipe":"Standar","hargaBulanan":1100000}}' >/dev/null
actj $J '{"action":"rooms.create","data":{"noKamar":"304","tipe":"Standar","hargaBulanan":1100000}}' >/dev/null
# penyewa khusus uji ini: jangan pakai penyewa yang kondisinya diubah uji sebelumnya
ck "Penyewa uji pindah dibuat" "$(actj $J "{\"action\":\"tenants.create\",\"data\":{\"nama\":\"Pindah Uji\",\"hp\":\"81211119999\",\"kamar\":\"301\",\"tglMasuk\":\"2026-01-01\"}}")" "200"
code -b $J "$B/api/dashboard" >/dev/null
ID_PINDAH=$(jq_ "d.penyewa.find(p=>p[1]==='Pindah Uji')[0]")

ck "Staff TIDAK boleh pindah kamar (403)" "$(actj $S "{\"action\":\"tenants.pindah\",\"data\":{\"id\":\"$ID_PINDAH\",\"kamar\":\"302\",\"tanggal\":\"$TODAY\"}}")" "403"
ck "Pindah ke kamar yang sama ditolak 400" "$(actj $J "{\"action\":\"tenants.pindah\",\"data\":{\"id\":\"$ID_PINDAH\",\"kamar\":\"301\",\"tanggal\":\"$TODAY\"}}")" "400"
ck "Pindah ke kamar fiktif ditolak 404" "$(actj $J "{\"action\":\"tenants.pindah\",\"data\":{\"id\":\"$ID_PINDAH\",\"kamar\":\"999\",\"tanggal\":\"$TODAY\"}}")" "404"
ck "Pindah ke kamar terisi ditolak 409" "$(actj $J "{\"action\":\"tenants.pindah\",\"data\":{\"id\":\"$ID_PINDAH\",\"kamar\":\"101\",\"tanggal\":\"$TODAY\"}}")" "409"
ck "Pindah tanpa tanggal ditolak 400" "$(actj $J "{\"action\":\"tenants.pindah\",\"data\":{\"id\":\"$ID_PINDAH\",\"kamar\":\"302\"}}")" "400"
ck "Pindah sebelum tanggal check-in ditolak 400" "$(actj $J "{\"action\":\"tenants.pindah\",\"data\":{\"id\":\"$ID_PINDAH\",\"kamar\":\"302\",\"tanggal\":\"2025-12-01\"}}")" "400"
ck "Pindah hari ini diterima" "$(actj $J "{\"action\":\"tenants.pindah\",\"data\":{\"id\":\"$ID_PINDAH\",\"kamar\":\"302\",\"tanggal\":\"$TODAY\"}}")" "200"
code -b $J "$B/api/dashboard" >/dev/null
ck "Kamar penyewa jadi 302" "$(jq_ "d.penyewa.find(p=>p[1]==='Pindah Uji')[3]")" "302"
ck "Kamar 302 terisi" "$(jq_ "(k=>k[4])(d.kamar.find(x=>x[0]==='302'))")" "Terisi"
ck "Kamar 301 kembali tersedia" "$(jq_ "(k=>k[4])(d.kamar.find(x=>x[0]==='301'))")" "Tersedia"

# pindah terjadwal: kamar hari ini TIDAK berubah, tapi kamar tujuan dikunci dari penyewa baru
DEPAN=$(date -d "+20 days" +%F)
ck "Pindah terjadwal diterima" "$(actj $J "{\"action\":\"tenants.pindah\",\"data\":{\"id\":\"$ID_PINDAH\",\"kamar\":\"303\",\"tanggal\":\"$DEPAN\"}}")" "200"
code -b $J "$B/api/dashboard" >/dev/null
ck "Pindah terjadwal TIDAK mengubah kamar hari ini" "$(jq_ "d.penyewa.find(p=>p[1]==='Pindah Uji')[3]")" "302"
ck "Penyewa baru di kamar terjadwal ditolak 409" "$(actj $J "{\"action\":\"tenants.create\",\"data\":{\"nama\":\"Penyerobot\",\"kamar\":\"303\",\"tglMasuk\":\"$TODAY\"}}")" "409"

# riwayat: pindahan masa depan tidak boleh jadi sasaran penutupan kontrak
ck "Pindah lagi hari ini tetap bisa" "$(actj $J "{\"action\":\"tenants.pindah\",\"data\":{\"id\":\"$ID_PINDAH\",\"kamar\":\"304\",\"tanggal\":\"$TODAY\"}}")" "200"
code -b $J "$B/api/dashboard" >/dev/null
ck "Kamar penyewa jadi 304" "$(jq_ "d.penyewa.find(p=>p[1]==='Pindah Uji')[3]")" "304"
ck "Kamar 303 tetap terkunci untuk pindahan terjadwal" "$(actj $J "{\"action\":\"tenants.create\",\"data\":{\"nama\":\"Penyerobot Dua\",\"kamar\":\"303\",\"tglMasuk\":\"$TODAY\"}}")" "409"

# edit penyewa juga bisa memindah kamar -> riwayat harus ikut tercatat
ck "Edit penyewa ke kamar kosong 301 diterima" "$(actj $J "{\"action\":\"tenants.update\",\"data\":{\"id\":\"$ID_PINDAH\",\"kamar\":\"301\"}}")" "200"
npx wrangler d1 execute hadekost-db --local --persist-to "${PERSIST:-/tmp/hklocal}" --json --command "select kamar_id, mulai, sampai from tenant_kamar where tenant_id=(select id from tenants where nama='Pindah Uji') order by mulai" > /tmp/hade_tk.json 2>/dev/null
# harapan: 301(tutup), 302(tutup), 304(tutup), 301(baru, terbuka), 303(jadwal, terbuka) = 4 baris, 2 terbuka
ck "Riwayat kamar 4 baris & 2 kontrak terbuka (kini + terjadwal)" "$(node -e "const r=JSON.parse(require('fs').readFileSync('/tmp/hade_tk.json'))[0].results;console.log(r.length+'|'+r.filter(x=>x.sampai===null).length)")" "4|2"
