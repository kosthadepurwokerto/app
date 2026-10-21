#!/usr/bin/env bash
# Uji end-to-end Worker + D1 lokal (http://localhost:8787).
set -u
B=http://localhost:8787
J=$(mktemp); K=$(mktemp); fail=0
ck() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (harap $3, dapat $2)"; fail=$((fail+1)); fi; }

code() { curl -s -o /tmp/hade_body -w '%{http_code}' "$@"; }
body() { cat /tmp/hade_body; }

# --- tunggu server siap ---
for i in $(seq 1 40); do curl -s -o /dev/null "$B/api/session" && break; sleep 1; done

# 1. tanpa login -> 401
ck "API tanpa login ditolak 401" "$(code "$B/api/dashboard")" "401"
# 2. halaman statis tetap bisa dibuka (layar login)
ck "Halaman utama tersaji 200" "$(code "$B/")" "200"
ck "index.html memuat adapter" "$(grep -c 'src="d1-adapter.js"' /tmp/hade_body)" "1"

# 3. login salah
ck "Login password salah ditolak 401" "$(code -X POST -H 'content-type: application/json' -d '{"username":"admin","password":"salah"}' "$B/api/login")" "401"
# 4. login benar (cookie jar)
ck "Login admin berhasil 200" "$(code -c $J -X POST -H 'content-type: application/json' -d '{"username":"admin","password":"Kostsaya12345"}' "$B/api/login")" "200"
ck "Cookie sesi HttpOnly terpasang" "$(grep -c 'hade_sesi' $J)" "1"
ck "Session mengembalikan role admin" "$(code -b $J "$B/api/session" >/dev/null; node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/hade_body')).user.role)")" "admin"

# 5. bootstrap: kategori ter-seed + dashboard nol
code -b $J "$B/api/bootstrap" >/dev/null
node -e "
const b=JSON.parse(require('fs').readFileSync('/tmp/hade_body'));
console.log(JSON.stringify({katPeng:b.kategori.Pengeluaran.length,katPen:b.kategori.Pendapatan.length,katNer:b.kategori.Neraca.length,kamar:b.stats.totalKamar}));" > /tmp/hade_bs
ck "Bootstrap: kategori 8/5/6 & kamar 0" "$(cat /tmp/hade_bs)" '{"katPeng":8,"katPen":5,"katNer":6,"kamar":0}'

# 6. tambah kamar
act() { code -b $J -X POST -H 'content-type: application/json' -d "$2" "$B/api/action/$1"; }
ck "Tambah kamar 101" "$(code -b $J -X POST -H 'content-type: application/json' -d '{"action":"rooms.create","data":{"noKamar":"101","tipe":"Standar","hargaBulanan":1100000,"hargaHarian":100000}}' "$B/api/action")" "200"
ck "Kamar dobel ditolak 409" "$(code -b $J -X POST -H 'content-type: application/json' -d '{"action":"rooms.create","data":{"noKamar":"101","tipe":"Standar","hargaBulanan":1100000}}' "$B/api/action")" "409"
code -b $J -X POST -H 'content-type: application/json' -d '{"action":"rooms.create","data":{"noKamar":"102","tipe":"Deluxe","hargaBulanan":1250000}}' "$B/api/action" >/dev/null

# 7. validasi penyewa
ck "Penyewa nama 1 huruf ditolak 400" "$(code -b $J -X POST -H 'content-type: application/json' -d '{"action":"tenants.create","data":{"nama":"A","kamar":"101","tglMasuk":"2026-10-01"}}' "$B/api/action")" "400"
ck "Penyewa kamar fiktif ditolak 404" "$(code -b $J -X POST -H 'content-type: application/json' -d '{"action":"tenants.create","data":{"nama":"Budi","kamar":"999","tglMasuk":"2026-10-01"}}' "$B/api/action")" "404"
TODAY=$(date +%F)
ck "Daftar penyewa Budi (hari ini)" "$(code -b $J -X POST -H 'content-type: application/json' -d "{\"action\":\"tenants.create\",\"data\":{\"nama\":\"Budi Santoso\",\"hp\":\"8123456789\",\"kamar\":\"101\",\"tglMasuk\":\"$TODAY\"}}" "$B/api/action")" "200"
ck "Kamar 101 tidak bisa didaftari penyewa kedua 409" "$(code -b $J -X POST -H 'content-type: application/json' -d "{\"action\":\"tenants.create\",\"data\":{\"nama\":\"Siti\",\"kamar\":\"101\",\"tglMasuk\":\"$TODAY\"}}" "$B/api/action")" "409"

code -b $J "$B/api/dashboard" >/dev/null
ck "Dashboard: 1 terisi, penyewa aktif 1, nama muncul" "$(node -e "const d=JSON.parse(require('fs').readFileSync('/tmp/hade_body'));console.log([d.stats.kamarTerisi,d.stats.totalPenyewa,d.kamar.find(k=>k[0]==='101')[5],d.penyewa[0][6]].join('|'))")" "1|1|Budi Santoso|$(date -d "+1 month" +%F)"

# 8. pembayaran: nominal salah lalu benar
ck "Bayar nominal salah ditolak 409" "$(code -b $J -X POST -H 'content-type: application/json' -d "{\"action\":\"payments.create\",\"data\":{\"kamar\":\"101\",\"jumlah\":500000,\"tanggal\":\"$TODAY\"}}" "$B/api/action")" "409"
ck "Bayar tepat 1.100.000 diterima" "$(code -b $J -X POST -H 'content-type: application/json' -d "{\"action\":\"payments.create\",\"data\":{\"kamar\":\"101\",\"jumlah\":1100000,\"tanggal\":\"$TODAY\",\"keterangan\":\"Sewa\"}}" "$B/api/action")" "200"
ck "Bayar tanggal masa depan ditolak 400" "$(code -b $J -X POST -H 'content-type: application/json' -d '{"action":"payments.create","data":{"kamar":"101","jumlah":1100000,"tanggal":"2099-01-01"}}' "$B/api/action")" "400"

code -b $J "$B/api/dashboard" >/dev/null
ck "Setelah bayar: tagihan berikutnya dibuat (jatuh tempo +1 bln)" "$(node -e "const d=JSON.parse(require('fs').readFileSync('/tmp/hade_body'));console.log([d.stats.sisaKas,d.penyewa[0][6]].join('|'))")" "1100000|$(date -d "+2 month" +%F)"

# 9. ledger
ck "Catat pengeluaran" "$(code -b $J -X POST -H 'content-type: application/json' -d "{\"action\":\"ledger.create\",\"data\":{\"jenis\":\"Pengeluaran\",\"kategori\":\"Wifi & Internet\",\"jumlah\":350000,\"tanggal\":\"$TODAY\",\"keterangan\":\"Wifi\"}}" "$B/api/action")" "200"
ck "Kategori tak dikenal tetap dicatat? (wajib ada nazhir) -> diterima apa adanya" "$(code -b $J -X POST -H 'content-type: application/json' -d "{\"action\":\"ledger.create\",\"data\":{\"jenis\":\"pengeluaran\",\"kategori\":\"Listrik & Air\",\"jumlah\":500000,\"tanggal\":\"$TODAY\"}}" "$B/api/action")" "200"
ck "Nominal nol ditolak 400" "$(code -b $J -X POST -H 'content-type: application/json' -d "{\"action\":\"ledger.create\",\"data\":{\"jenis\":\"pengeluaran\",\"kategori\":\"Wifi & Internet\",\"jumlah\":0,\"tanggal\":\"$TODAY\"}}" "$B/api/action")" "400"
code -b $J "$B/api/ops" >/dev/null
ck "Ledger berisi 2 transaksi" "$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/hade_body')).length)")" "2"

# 10. hapus/void
code -b $J "$B/api/ops" >/dev/null
LED=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/hade_body'))[0][0])")
ck "Void transaksi" "$(code -b $J -X POST -H 'content-type: application/json' -d "{\"action\":\"ledger.void\",\"data\":{\"id\":$LED}}" "$B/api/action")" "200"
ck "Void dua kali ditolak 409" "$(code -b $J -X POST -H 'content-type: application/json' -d "{\"action\":\"ledger.void\",\"data\":{\"id\":$LED}}" "$B/api/action")" "409"
code -b $J "$B/api/ops" >/dev/null
ck "Ledger tinggal 1 setelah void" "$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/hade_body')).length)")" "1"

# 11. hapus penyewa berriwayat -> ditolak
ck "Hapus penyewa berriwayat ditolak 409" "$(code -b $J -X POST -H 'content-type: application/json' -d '{"action":"tenants.delete","data":{"id":"TEN-0001","kamar":"101"}}' "$B/api/action")" "409"
ck "Check-out penyewa" "$(code -b $J -X POST -H 'content-type: application/json' -d '{"action":"tenants.checkout","data":{"id":"TEN-0001","kamar":"101"}}' "$B/api/action")" "200"
code -b $J "$B/api/dashboard" >/dev/null
ck "Setelah check-out kamar 101 tersedia" "$(node -e "const d=JSON.parse(require('fs').readFileSync('/tmp/hade_body'));console.log(d.kamar.find(k=>k[0]==='101')[4])")" "Tersedia"
ck "Hapus kamar 101 (kosong) berhasil" "$(code -b $J -X POST -H 'content-type: application/json' -d '{"action":"rooms.delete","data":{"noKamar":"101"}}' "$B/api/action")" "200"

# 12. audit & sesi
ck "Logout" "$(code -b $J "$B/api/logout")" "200"
ck "Setelah logout -> 401" "$(code -b $J "$B/api/dashboard")" "401"

echo
if [ $fail -eq 0 ]; then echo "SEMUA LULUS"; else echo "$fail GAGAL"; fi
exit $fail
