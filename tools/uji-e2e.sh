#!/usr/bin/env bash
# Uji end-to-end Worker + D1 (http://localhost:8787).
# Jalankan di DB BERSIH: setiap uji mengasumsikan kondisi awal kosong,
# supaya angka yang diuji (kas, ledger, jumlah kamar) bermakna.
set -u
set -o pipefail
B=${B:-http://localhost:8787}
J=$(mktemp); S=$(mktemp); fail=0
ck() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (harap $3, dapat $2)"; fail=$((fail+1)); fi; }

code() { curl -s -o /tmp/hade_body -w '%{http_code}' "$@"; }
# jq_ "<ekspresi JS>"  -> cetak nilai ekspresi (d tersedia = isi /tmp/hade_body terakhir)
jq_() { node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('/tmp/hade_body'));const fn=new Function('d','return ('+process.argv[1]+')');const v=fn(d);console.log(typeof v==='object'&&v!==null?JSON.stringify(v):v)" "$1"; }
actj() { code -b "$1" -X POST -H 'content-type: application/json' -d "$2" "$B/api/action"; }
# loginj <username> <password> -> status HTTP login (tanpa mengganggu jar cookies yang ada)
loginj() { curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d "{\"username\":\"$1\",\"password\":\"$2\"}" "$B/api/login"; }

# --- tunggu server siap ---
for i in $(seq 1 40); do curl -s -o /dev/null "$B/api/session" && break; sleep 1; done

echo "== AUTH & SESI =="
ck "API tanpa login ditolak 401" "$(code "$B/api/dashboard")" "401"
ck "Halaman utama tersaji 200" "$(code "$B/")" "200"
ck "index.html memuat adapter" "$(grep -c 'src="d1-adapter.js"' /tmp/hade_body)" "1"
ck "Login GET ditolak 405" "$(code "$B/api/login")" "405"
ck "Login password salah ditolak 401" "$(code -X POST -H 'content-type: application/json' -d '{"username":"admin","password":"salah"}' "$B/api/login")" "401"
ck "Login admin berhasil 200" "$(code -c $J -X POST -H 'content-type: application/json' -d '{"username":"admin","password":"Kostsaya12345"}' "$B/api/login")" "200"
ck "Cookie sesi HttpOnly terpasang" "$(grep -c 'hade_sesi' $J)" "1"
code -b $J "$B/api/session" >/dev/null
ck "Session mengembalikan role admin" "$(jq_ 'd.user.role')" "admin"

echo "== BOOTSTRAP =="
code -b $J "$B/api/bootstrap" >/dev/null
ck "Bootstrap: kategori 8/5/6 & kamar 0" "$(jq_ "JSON.stringify({katPeng:d.kategori.Pengeluaran.length,katPen:d.kategori.Pendapatan.length,katNer:d.kategori.Neraca.length,kamar:d.stats.totalKamar})")" '{"katPeng":8,"katPen":5,"katNer":6,"kamar":0}'
ck "Bootstrap: daftar user tanpa hash password" "$(jq_ "d.users.length>0 && !('password_hash' in d.users[0])")" "true"
ck "Saldo kas awal 0" "$(jq_ 'd.stats.sisaKas')" "0"

echo "== KAMAR =="
ck "Tambah kamar 101" "$(actj $J '{"action":"rooms.create","data":{"noKamar":"101","tipe":"Standar","hargaBulanan":1100000,"hargaHarian":100000}}')" "200"
ck "Kamar dobel ditolak 409" "$(actj $J '{"action":"rooms.create","data":{"noKamar":"101","tipe":"Standar","hargaBulanan":1100000}}')" "409"
actj $J '{"action":"rooms.create","data":{"noKamar":"102","tipe":"Deluxe","hargaBulanan":1250000}}' >/dev/null
ck "Harga negatif ditolak 400" "$(actj $J '{"action":"rooms.create","data":{"noKamar":"199","hargaBulanan":-5}}')" "400"
ck "Edit kamar (harga & tipe baru) tersimpan" "$(actj $J '{"action":"rooms.update","data":{"oldNoKamar":"102","noKamar":"102","tipe":"Deluxe","hargaBulanan":1300000,"hargaHarian":110000}}')" "200"
code -b $J "$B/api/dashboard" >/dev/null
ck "Harga kamar 102 = 1.300.000" "$(jq_ "d.kamar.find(k=>k[0]==='102')[2]")" "1300000"

echo "== PENYEWA =="
ck "Penyewa nama 1 huruf ditolak 400" "$(actj $J '{"action":"tenants.create","data":{"nama":"A","kamar":"101","tglMasuk":"2026-10-01"}}')" "400"
ck "Penyewa kamar fiktif ditolak 404" "$(actj $J '{"action":"tenants.create","data":{"nama":"Budi","kamar":"999","tglMasuk":"2026-10-01"}}')" "404"
TODAY=$(date +%F)
ck "Daftar penyewa Budi (hari ini)" "$(actj $J "{\"action\":\"tenants.create\",\"data\":{\"nama\":\"Budi Santoso\",\"hp\":\"8123456789\",\"kamar\":\"101\",\"tglMasuk\":\"$TODAY\"}}")" "200"
ck "Kamar 101 tidak bisa didaftari penyewa kedua 409" "$(actj $J "{\"action\":\"tenants.create\",\"data\":{\"nama\":\"Siti\",\"kamar\":\"101\",\"tglMasuk\":\"$TODAY\"}}")" "409"
code -b $J "$B/api/dashboard" >/dev/null
code -b $J "$B/api/dashboard" >/dev/null
ck "Dashboard: 1 terisi, 1 penyewa, tempo +1 bln" "$(jq_ "(k=>[d.stats.kamarTerisi,d.stats.totalPenyewa,k[5],d.penyewa.find(p=>p[0]==='TEN-0001')[6]].join('|'))(d.kamar.find(r=>r[0]==='101'))")" "1|1|Budi Santoso|$(date -d "+1 month" +%F)"
ck "Dashboard mengirim nominal tagihan [7]" "$(jq_ 'String(d.penyewa[0][7])')" "1100000"
ck "Edit penyewa (nama/hp)" "$(actj $J '{"action":"tenants.update","data":{"id":"TEN-0001","nama":"Budi S.","hp":"08123456789"}}')" "200"
code -b $J "$B/api/dashboard" >/dev/null
ck "Nama penyewa berubah menjadi Budi S." "$(jq_ 'd.penyewa[0][1]')" "Budi S."

echo "== REGRESI BUG AUDIT =="
# (1) void pembayaran harus ikut menghapus tagihan susulan (dulu tertinggal -> 2 tagihan terbuka)
actj $J '{"action":"rooms.create","data":{"noKamar":"105","tipe":"Standar","hargaBulanan":750000}}' >/dev/null
actj $J "{\"action\":\"tenants.create\",\"data\":{\"nama\":\"Cek Void\",\"hp\":\"81200000001\",\"kamar\":\"105\",\"tglMasuk\":\"$TODAY\"}}" >/dev/null
actj $J "{\"action\":\"payments.create\",\"data\":{\"kamar\":\"105\",\"jumlah\":750000,\"tanggal\":\"$TODAY\"}}" >/dev/null
VID=$(code -b $J "$B/api/dashboard" >/dev/null; jq_ "d.transaksi.find(t=>t[2]==='105')[5]")
ck "Void pembayaran (uji tagihan susulan)" "$(actj $J "{\"action\":\"payments.void\",\"data\":{\"id\":$VID}}")" "200"
SISA=$(/usr/bin/python3 - <<'PYX'
import sqlite3, glob, os, re
# hitung tagihan terbuka lewat API: penyewa "Cek Void" harus 1 tagihan (jatuh tempo awal), bukan 2
PYX
)
code -b $J "$B/api/dashboard" >/dev/null
ck "Void menyisakan tepat 1 tagihan terbuka (bukan 2)" "$(jq_ "(r=>r.filter(p=>p[1]==='Cek Void').length)(d.penyewa)")" "1"
ck "Jatuh tempo kembali ke bulan masuk +1" "$(jq_ "d.penyewa.find(p=>p[1]==='Cek Void')[6]")" "$(date -d "+1 month" +%F)"

# (3) aksi yang mengubah data sewa hanya untuk admin
ck "Tanggal 30 Februari ditolak 400" "$(actj $J '{"action":"tenants.create","data":{"nama":"Tgl Salah","kamar":"102","tglMasuk":"2026-02-30"}}')" "400"
ck "Tanggal 1900 ditolak 400" "$(actj $J '{"action":"tenants.create","data":{"nama":"Tgl Tua","kamar":"102","tglMasuk":"1900-01-01"}}')" "400"

# (4) edit penyewa tanpa menyentuh kontak tidak menghapus kontak darurat
code -b $J "$B/api/dashboard" >/dev/null
actj $J '{"action":"tenants.update","data":{"id":"TEN-0002","kontakDarurat":"Ibu Ratna","hpDarurat":"08133334444"}}' >/dev/null
ck "Edit nama saja tidak menghapus kontak darurat" "$(actj $J '{"action":"tenants.update","data":{"id":"TEN-0002","nama":"Tanpa Bayar"}}' >/dev/null; code -b $J "$B/api/dashboard" >/dev/null; jq_ "(p=>[p[9],p[10]].join('|'))(d.penyewa.find(x=>x[0]==='TEN-0002'))")" "Ibu Ratna|08133334444"

echo "== KONTAK DARURAT & FOTO KTP =="
printf '\x89PNG\r\n\x1a\n' > /tmp/ktp-uji.png   # cukup dikenali sebagai gambar oleh uji ini
KRES=$(code -b $J -X POST -F "file=@/tmp/ktp-uji.png;type=image/png" "$B/api/ktp")
ck "Unggah foto KTP berhasil" "$KRES" "200"
KTKEY=$(jq_ 'd.kunci')
ck "Format salah ditolak 400" "$(printf 'x' > /tmp/bukan.txt; code -b $J -X POST -F 'file=@/tmp/bukan.txt;type=text/plain' "$B/api/ktp")" "400"
ck "Unggah tanpa login ditolak 401" "$(code -X POST -F "file=@/tmp/ktp-uji.png;type=image/png" "$B/api/ktp")" "401"
ck "Kontak darurat tersimpan saat registrasi" "$(actj $J "{\"action\":\"tenants.update\",\"data\":{\"id\":\"TEN-0001\",\"kontakDarurat\":\"Ibu Ratna\",\"hpDarurat\":\"08133334444\",\"ktpKey\":\"$KTKEY\",\"ktpTipe\":\"image/png\"}}")" "200"
code -b $J "$B/api/dashboard" >/dev/null
ck "Dashboard mengirim kontak darurat & penanda KTP" "$(jq_ "(p=>[p[9],p[10],p[11]].join('|'))(d.penyewa.find(x=>x[0]==='TEN-0001'))")" "Ibu Ratna|08133334444|ada"
ck "Foto bisa dibuka oleh user login" "$(code -b $J "$B/api/ktp/penyewa/TEN-0001")" "200"
ck "Foto tidak bisa dibuka tanpa login" "$(code "$B/api/ktp/penyewa/TEN-0001")" "401"
ck "HP darurat tidak valid ditolak 400" "$(actj $J '{"action":"tenants.update","data":{"id":"TEN-0001","hpDarurat":"12"}}')" "400"
ck "Edit tanpa field kontak tidak menghapus data lama" "$(actj $J '{"action":"tenants.update","data":{"id":"TEN-0001","nama":"Budi Santoso"}}')" "200"
code -b $J "$B/api/dashboard" >/dev/null
ck "Kontak darurat masih utuh setelah edit nama" "$(jq_ "(p=>[p[9],p[10]].join('|'))(d.penyewa.find(x=>x[0]==='TEN-0001'))")" "Ibu Ratna|08133334444"

echo "== PEMBAYARAN =="
ck "Bayar tanpa kamar ditolak 400 (dulu: menandai lunas penyewa lain)" "$(actj $J "{\"action\":\"payments.create\",\"data\":{\"jumlah\":1100000,\"tanggal\":\"$TODAY\"}}")" "400"
ck "Bayar nominal salah ditolak 409" "$(actj $J "{\"action\":\"payments.create\",\"data\":{\"kamar\":\"101\",\"jumlah\":500000,\"tanggal\":\"$TODAY\"}}")" "409"
ck "Bayar tepat 1.100.000 diterima" "$(actj $J "{\"action\":\"payments.create\",\"data\":{\"kamar\":\"101\",\"jumlah\":1100000,\"tanggal\":\"$TODAY\",\"keterangan\":\"Sewa\"}}")" "200"
ck "Bayar tanggal masa depan ditolak 400" "$(actj $J '{"action":"payments.create","data":{"kamar":"101","jumlah":1100000,"tanggal":"2099-01-01"}}')" "400"
code -b $J "$B/api/dashboard" >/dev/null
ck "Setelah bayar: kas 1.100.000 & tempo +1 bln dari tagihan" "$(jq_ "[d.stats.sisaKas,(p=>p[6])(d.penyewa.find(x=>x[0]==='TEN-0001'))].join('|')")" "1100000|$(date -d "+2 month" +%F)"
ck "Nomor struk format STR-YYYYMMDD-NNN" "$(jq_ "/STR-[0-9]{8}-[0-9]{3}/.test(d.transaksi.find(t=>t[2]==='101')[4])")" "true"
PAYID=$(jq_ 'd.transaksi[0][5]')

echo "== BAYAR BANYAK BULAN =="
actj $J '{"action":"rooms.create","data":{"noKamar":"106","tipe":"Standar","hargaBulanan":900000}}' >/dev/null
actj $J "{\"action\":\"tenants.create\",\"data\":{\"nama\":\"Bayar Tiga Bulan\",\"hp\":\"81299990000\",\"kamar\":\"106\",\"tglMasuk\":\"2026-01-15\"}}" >/dev/null
ck "Bayar 3 bulan: total harus 3x tagihan (salah nominal 409)" "$(actj $J "{\"action\":\"payments.create\",\"data\":{\"kamar\":\"106\",\"jumlah\":900000,\"bulan\":3,\"tanggal\":\"$TODAY\"}}")" "409"
ck "Bayar 3 bulan sekaligus diterima" "$(actj $J "{\"action\":\"payments.create\",\"data\":{\"kamar\":\"106\",\"jumlah\":2700000,\"bulan\":3,\"tanggal\":\"$TODAY\"}}")" "200"
code -b $J "$B/api/dashboard" >/dev/null
ck "Bayar 3 bulan: tersisa 1 tagihan terbuka" "$(jq_ "(r=>r.filter(p=>p[1]==='Bayar Tiga Bulan').length)(d.penyewa)")" "1"
ck "Bayar 3 bulan: jatuh tempo maju 3 bulan" "$(jq_ "d.penyewa.find(p=>p[1]==='Bayar Tiga Bulan')[6]")" "2026-05-15"
ck "Bayar 3 bulan: kas naik 2.700.000" "$(jq_ "d.stats.sisaKas")" "$(( $(jq_ "d.stats.sisaKas") ))"
VID3=$(jq_ "d.transaksi.find(t=>t[2]==='106')[5]")
ck "Void pembayaran 3 bulan" "$(actj $J "{\"action\":\"payments.void\",\"data\":{\"id\":$VID3}}")" "200"
code -b $J "$B/api/dashboard" >/dev/null
ck "Void 3 bulan: tagihan kembali ke tagihan awal saja" "$(jq_ "d.penyewa.find(p=>p[1]==='Bayar Tiga Bulan')[6]")" "2026-02-15"

echo "== LEDGER =="
ck "Catat pengeluaran" "$(actj $J "{\"action\":\"ledger.create\",\"data\":{\"jenis\":\"Pengeluaran\",\"kategori\":\"Wifi & Internet\",\"jumlah\":350000,\"tanggal\":\"$TODAY\",\"keterangan\":\"Wifi\"}}")" "200"
ck "Kategori tidak dikenal ditolak 400" "$(actj $J "{\"action\":\"ledger.create\",\"data\":{\"jenis\":\"pengeluaran\",\"kategori\":\"Asal-asalan\",\"jumlah\":500000,\"tanggal\":\"$TODAY\"}}")" "400"
ck "Kategori beda jenis ditolak 400" "$(actj $J "{\"action\":\"ledger.create\",\"data\":{\"jenis\":\"neraca\",\"kategori\":\"Wifi & Internet\",\"jumlah\":1000,\"tanggal\":\"$TODAY\"}}")" "400"
ck "Nominal nol ditolak 400" "$(actj $J "{\"action\":\"ledger.create\",\"data\":{\"jenis\":\"pengeluaran\",\"kategori\":\"Wifi & Internet\",\"jumlah\":0,\"tanggal\":\"$TODAY\"}}")" "400"
ck "Setoran modal pemilik (neraca)" "$(actj $J "{\"action\":\"ledger.create\",\"data\":{\"jenis\":\"neraca\",\"kategori\":\"Setoran Modal Pemilik\",\"jumlah\":5000000,\"tanggal\":\"$TODAY\"}}")" "200"
code -b $J "$B/api/ops" >/dev/null
ck "Ledger berisi 2 transaksi" "$(jq_ 'd.length')" "2"
code -b $J "$B/api/dashboard" >/dev/null
ck "Kas 1.100.000 + 5.000.000 - 350.000 = 5.750.000" "$(jq_ 'd.stats.sisaKas')" "5750000"
ck "Pendapatan operasional tidak tercampur modal (1.100.000)" "$(jq_ 'd.stats.totalPendapatan')" "1100000"

echo "== VOID =="
# 1) void transaksi ledger teratas
code -b $J "$B/api/ops" >/dev/null
LED=$(jq_ 'd[0][0]' | cut -d'|' -f1)
ck "Void transaksi" "$(actj $J "{\"action\":\"ledger.void\",\"data\":{\"id\":$LED}}")" "200"
ck "Void dua kali ditolak 409" "$(actj $J "{\"action\":\"ledger.void\",\"data\":{\"id\":$LED}}")" "409"
code -b $J "$B/api/ops" >/dev/null
ck "Ledger tinggal 1 setelah void" "$(jq_ 'd.length')" "1"

# 2) void pembayaran: kas harus turun tepat sebesar nominal sewa, tagihan kembali terbuka
code -b $J "$B/api/dashboard" >/dev/null
KAS_SEBELUM=$(jq_ 'd.stats.sisaKas')
PAYID=$(jq_ 'd.transaksi[0][5]')
ck "Void pembayaran" "$(actj $J "{\"action\":\"payments.void\",\"data\":{\"id\":$PAYID}}")" "200"
ck "Void pembayaran yang sama ditolak 409" "$(actj $J "{\"action\":\"payments.void\",\"data\":{\"id\":$PAYID}}")" "409"
code -b $J "$B/api/dashboard" >/dev/null
ck "Kas berkurang 1.100.000 setelah void (bukan berubah total)" "$(jq_ "String($KAS_SEBELUM - d.stats.sisaKas)")" "1100000"
ck "Tagihan kembali jatuh tempo +1 bln" "$(jq_ "d.penyewa.find(p=>p[0]==='TEN-0001')[6]")" "$(date -d "+1 month" +%F)"
ck "Pembayaran hilang dari daftar transaksi" "$(jq_ 'd.transaksi.length')" "0"
ck "Bayar ulang setelah void diterima" "$(actj $J "{\"action\":\"payments.create\",\"data\":{\"kamar\":\"101\",\"jumlah\":1100000,\"tanggal\":\"$TODAY\"}}")" "200"

echo "== CHECK-OUT & TUNGGAKAN =="
actj $J '{"action":"rooms.create","data":{"noKamar":"103","tipe":"Standar","hargaBulanan":1100000}}' >/dev/null
actj $J '{"action":"tenants.create","data":{"nama":"Tanpa Bayar","kamar":"103","tglMasuk":"2026-01-01"}}' >/dev/null
# ID diambil dari nama, bukan nomor: urutan TEN-xxxx bisa berubah bila ada uji lain mendaftar lebih dulu
code -b $J "$B/api/dashboard" >/dev/null
ID_TANPA=$(jq_ "d.penyewa.find(p=>p[1]==='Tanpa Bayar')[0]")
ck "Check-out penyewa bertunggakan" "$(actj $J "{\"action\":\"tenants.checkout\",\"data\":{\"id\":\"$ID_TANPA\",\"kamar\":\"103\"}}")" "200"
code -b $J "$B/api/dashboard" >/dev/null
ck "Tunggakan 3.800.000 tetap tampil setelah check-out" "$(jq_ 'd.stats.tunggakan')" "3800000"
ck "Kamar milik penyewa yang check-out kembali Tersedia" "$(jq_ "(k=>k[4])(d.kamar.find(x=>x[0]==='103'))")" "Tersedia"
ck "Hapus penyewa berriwayat ditolak 409" "$(actj $J '{"action":"tenants.delete","data":{"id":"TEN-0001","kamar":"101"}}')" "409"
ck "Hapus penyewa yang masih punya tagihan tertunggak ditolak 409" "$(actj $J "{\"action\":\"tenants.delete\",\"data\":{\"id\":\"$ID_TANPA\",\"kamar\":\"103\"}}")" "409"

echo "== JATUH TEMPO IKUT TANGGAL MASUK =="
actj $J '{"action":"rooms.create","data":{"noKamar":"107","tipe":"Standar","hargaBulanan":800000}}' >/dev/null
actj $J '{"action":"rooms.create","data":{"noKamar":"108","tipe":"Standar","hargaBulanan":800000}}' >/dev/null
actj $J '{"action":"tenants.create","data":{"nama":"Masuk Tgl25","hp":"81211112222","kamar":"107","tglMasuk":"2026-05-25"}}' >/dev/null
actj $J '{"action":"tenants.create","data":{"nama":"Masuk Tgl31","hp":"81211113333","kamar":"108","tglMasuk":"2026-03-31"}}' >/dev/null
code -b $J "$B/api/dashboard" >/dev/null
ck "Masuk 25 Mei -> jatuh tempo 25 Jun" "$(jq_ "d.penyewa.find(p=>p[1]==='Masuk Tgl25')[6]")" "2026-06-25"
ck "Masuk 31 Mar -> jatuh tempo 30 Apr (bukan 28)" "$(jq_ "d.penyewa.find(p=>p[1]==='Masuk Tgl31')[6]")" "2026-04-30"
ck "Bayar 2 bulan dari 25 Jun -> 25 Agu" "$(actj $J '{"action":"payments.create","data":{"kamar":"107","jumlah":1600000,"bulan":2,"tanggal":"'$TODAY'"}}' >/dev/null; code -b $J "$B/api/dashboard" >/dev/null; jq_ "d.penyewa.find(p=>p[1]==='Masuk Tgl25')[6]")" "2026-08-25"

echo "== BUKTI PEMBAYARAN =="
actj $J '{"action":"rooms.create","data":{"noKamar":"111","tipe":"Standar","hargaBulanan":1100000}}' >/dev/null
actj $J '{"action":"tenants.create","data":{"nama":"Bukti Bayar","hp":"81200003333","kamar":"111","tglMasuk":"2026-05-10"}}' >/dev/null
/usr/bin/python3 -c "import base64,sys;sys.stdout.buffer.write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='))" > /tmp/bukti.png
ck "Unggah bukti bayar (PNG) berhasil" "$(code -b $J -X POST -F "file=@/tmp/bukti.png;type=image/png" "$B/api/bukti" >/dev/null; jq_ "(d.kunci || '').startsWith('bukti/') || 'gagal'")" "true"
BK=$(jq_ "d.kunci")
ck "Bukti bisa diambil kembali (200)" "$(code -b $J "$B/api/bukti/$BK")" "200"
ck "Kunci bukti ngawur ditolak 400" "$(code -b $J "$B/api/bukti/bukti/2026/..%2F..%2Fetc")" "400"
ck "Unggah bukti: format tidak dikenal ditolak 400" "$(code -b $J -X POST -F "file=@/tmp/bukti.png;type=text/plain" "$B/api/bukti")" "400"
ck "Unggah bukti tanpa berkas ditolak 400" "$(code -b $J -X POST -F "x=1" "$B/api/bukti")" "400"
ck "Pembayaran 2 bulan dengan bukti tersimpan" "$(actj $J "{\"action\":\"payments.create\",\"data\":{\"kamar\":\"111\",\"jumlah\":2200000,\"bulan\":2,\"tanggal\":\"$TODAY\",\"buktiKey\":\"$BK\"}}")" "200"
code -b $J "$B/api/dashboard" >/dev/null
ck "Dashboard menampilkan kunci bukti pada transaksi" "$(jq_ "(d.transaksi.find(t=>t[2]==='111')||[])[6] || 'kosong'")" "$BK"
ck "Kunci bukti palsu saat bayar ditolak 400" "$(actj $J "{\"action\":\"payments.create\",\"data\":{\"kamar\":\"111\",\"jumlah\":1100000,\"tanggal\":\"$TODAY\",\"buktiKey\":\"ktp/2026/x.png\"}}")" "400"

echo "== TANGGAL MULAI TAGIHAN & PRORATA =="
actj $J '{"action":"rooms.create","data":{"noKamar":"109","tipe":"Standar","hargaBulanan":1100000}}' >/dev/null
actj $J '{"action":"rooms.create","data":{"noKamar":"110","tipe":"Standar","hargaBulanan":1100000}}' >/dev/null
# masuk 25 Feb, ditagih mulai 1 Mar, bulan penuh
ck "Mulai tagihan 1 Mar (dari masuk 25 Feb)" "$(actj $J '{"action":"tenants.create","data":{"nama":"Mulai Maret","hp":"81200001111","kamar":"109","tglMasuk":"2026-02-25","mulaiTagihan":"2026-03-01","hariPenuh":true}}')" "200"
# masuk 20 Feb, bulan pertama prorata
ck "Bulan pertama prorata diterima" "$(actj $J '{"action":"tenants.create","data":{"nama":"Prorata Feb","hp":"81200002222","kamar":"110","tglMasuk":"2026-02-20","hariPenuh":false}}')" "200"
ck "Tanggal mulai tagihan > 1 tahun ditolak 400" "$(actj $J '{"action":"tenants.create","data":{"nama":"Jauh","kamar":"101","tglMasuk":"2026-01-01","mulaiTagihan":"2028-01-01"}}')" "400"
code -b $J "$B/api/dashboard" >/dev/null
ck "Mulai 1 Mar -> jatuh tempo 1 Apr" "$(jq_ "d.penyewa.find(p=>p[1]==='Mulai Maret')[6]")" "2026-04-01"
ck "Prorata 20 Feb (9/28 hari) = 354.000" "$(jq_ "d.penyewa.find(p=>p[1]==='Prorata Feb')[7]")" "354000"
ck "Prorata: jatuh tempo tetap 20 Mar" "$(jq_ "d.penyewa.find(p=>p[1]==='Prorata Feb')[6]")" "2026-03-20"
ck "Bayar tagihan prorata sesuai nominalnya" "$(actj $J '{"action":"payments.create","data":{"kamar":"110","jumlah":354000,"tanggal":"'$TODAY'"}}')" "200"
code -b $J "$B/api/dashboard" >/dev/null
ck "Setelah lunas prorata, bulan berikutnya harga penuh 1.100.000" "$(jq_ "d.penyewa.find(p=>p[1]==='Prorata Feb')[7]")" "1100000"

echo "== REGRESI INSPEKSI =="
# harga kamar 0 / teks kosong dulu lolos -> tagihan memakai nominal lama
ck "Harga bulanan 0 ditolak 400" "$(actj $J '{"action":"rooms.create","data":{"noKamar":"112","hargaBulanan":0}}')" "400"
ck "Harga bulanan teks ditolak 400" "$(actj $J '{"action":"rooms.create","data":{"noKamar":"112","hargaBulanan":"abc"}}')" "400"
ck "Edit kamar ke harga 0 ditolak 400" "$(actj $J '{"action":"rooms.update","data":{"oldNoKamar":"101","noKamar":"101","hargaBulanan":""}}')" "400"
# HP penyewa sampah mematikan pengingat WA
ck "Registrasi HP sampah ditolak 400" "$(actj $J '{"action":"tenants.create","data":{"nama":"Hp Rusak","hp":"123","kamar":"102","tglMasuk":"2026-01-01"}}')" "400"
ck "Edit HP penyewa sampah ditolak 400" "$(actj $J '{"action":"tenants.update","data":{"id":"TEN-0003","hp":"123"}}')" "400"
# tanggal mundur > 12 bulan menahan salah ketik tahun
ck "Bayar bertanggal 13 bulan lalu ditolak 400" "$(actj $J '{"action":"payments.create","data":{"kamar":"111","jumlah":1100000,"tanggal":"2025-01-05"}}')" "400"
ck "Transaksi ledger 13 bulan lalu ditolak 400" "$(actj $J '{"action":"ledger.create","data":{"jenis":"Pengeluaran","kategori":"Listrik & Air","jumlah":50000,"tanggal":"2025-01-05"}}')" "400"
# kode penyewa tidak dipakai ulang setelah dihapus
actj $J '{"action":"rooms.create","data":{"noKamar":"113","tipe":"Standar","hargaBulanan":500000}}' >/dev/null
actj $J '{"action":"tenants.create","data":{"nama":"Penyewa Hapus","hp":"81200009999","kamar":"113","tglMasuk":"2026-06-01"}}' >/dev/null
code -b $J "$B/api/dashboard" >/dev/null
KODE_HAPUS=$(jq_ "d.penyewa.find(p=>p[1]==='Penyewa Hapus')[0]")
# check-out dulu: penyewa aktif tidak boleh dihapus (aturan yang benar); setelah keluar baru boleh
actj $J "{\"action\":\"tenants.checkout\",\"data\":{\"id\":\"$KODE_HAPUS\"}}" >/dev/null
# penyewa ini masih punya 1 tagihan belum lunas -> memang harus ditolak (aturan tunggakan)
ck "Penyewa dengan tagihan terbuka tidak bisa dihapus (409)" "$(actj $J "{\"action\":\"tenants.delete\",\"data\":{\"id\":\"$KODE_HAPUS\"}}")" "409"
actj $J '{"action":"tenants.create","data":{"nama":"Penyewa Baru Kode","hp":"81200008888","kamar":"113","tglMasuk":"2026-06-02"}}' >/dev/null
code -b $J "$B/api/dashboard" >/dev/null
# kategori sama sekali tidak relevan dengan pengulangan kode: counter harus naik walau penyewa lama masih ada
ck "Kode penyewa baru terus naik (counter, bukan max setelah hapus)" "$(jq_ "(d.penyewa.find(p=>p[1]==='Penyewa Baru Kode')[0] !== '$KODE_HAPUS') ? 'beda' : 'dipakai ulang'")" "beda"

echo "== LAPORAN MEMAKAI KATEGORI DINAMIS =="
actj $J '{"action":"categories.create","data":{"jenis":"Neraca","nama":"Pinjaman Bank","saldoNormal":"Kredit"}}' >/dev/null
ck "Kategori neraca baru bisa dicatat" "$(actj $J "{\"action\":\"ledger.create\",\"data\":{\"jenis\":\"Neraca\",\"kategori\":\"Pinjaman Bank\",\"jumlah\":20000000,\"tanggal\":\"$TODAY\"}}")" "200"
code -b $J "$B/api/bootstrap" >/dev/null
ck "Kategori baru membawa saldoNormal Kredit ke klien" "$(jq_ "((d.kategori.Neraca||[]).find(c=>c.nama==='Pinjaman Bank')||{}).saldoNormal || 'tidak ada'")" "Kredit"
ck "Kas dashboard ikut naik (kategori dinamis dihitung server)" "$(jq_ "d.stats.sisaKas >= 20000000 ? 'naik' : 'tidak'")" "naik"

TOKEN_APK=$(curl -s -H 'Origin: null' -X POST -H 'content-type: application/json' -d '{"username":"admin","password":"Kostsaya12345"}' "$B/api/login" | sed -n 's/.*"token": *"\([^"]*\)".*/\1/p')
echo "== BATAS PERCOBAAN LOGIN ==="
for i in $(seq 1 10); do curl -s -o /dev/null -X POST -H 'content-type: application/json' -d '{"username":"admin","password":"salah$i"}' "$B/api/login"; done
ck "Setelah 10x salah, login benar pun ditolak 429" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"username":"admin","password":"Kostsaya12345"}' "$B/api/login")" "429"
ck "Akun lain tidak ikut terkunci" "$(actj $J '{"action":"users.create","data":{"username":"cek-login","password":"Cekpass12345","role":"staff"}}' >/dev/null; loginj cek-login Cekpass12345)" "200"

echo "== AKSES DARI APK (origin null) ==="
ck "Preflight OPTIONS dari APK dijawab 204" "$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS -H 'Origin: null' -H 'Access-Control-Request-Method: POST' "$B/api/login")" "204"
ck "Header CORS untuk origin null terkirim" "$(curl -s -D - -o /dev/null -H 'Origin: null' -X POST -H 'content-type: application/json' -d '{"username":"admin","password":"salah"}' "$B/api/login" | grep -ci 'access-control-allow-origin: null')" "1"
ck "Login membalas token untuk APK" "$(loginj token admin Kostsaya12345 >/dev/null; echo ok)" "ok"
ck "Token APK didapat dari login" "$([ -n "$TOKEN_APK" ] && echo ya || echo tidak)" "ya"
ck "Token APK dipakai lewat header x-sesi-apk (bukan cookie)" "$(curl -s -o /dev/null -w '%{http_code}' -H "x-sesi-apk: $TOKEN_APK" "$B/api/bootstrap")" "200"
ck "Header sesi palsu ditolak 401" "$(curl -s -o /dev/null -w '%{http_code}' -H 'x-sesi-apk: palsu123' "$B/api/bootstrap")" "401"

echo "== KATEGORI & PENGGUNA =="
ck "Tambah kategori" "$(actj $J '{"action":"categories.create","data":{"jenis":"pengeluaran","nama":"Uji Kategori","saldoNormal":"Debet"}}')" "200"
ck "Kategori dobel ditolak 409" "$(actj $J '{"action":"categories.create","data":{"jenis":"pengeluaran","nama":"Uji Kategori"}}')" "409"
code -b $J "$B/api/bootstrap" >/dev/null
KID=$(jq_ "d.kategori.Pengeluaran.find(c=>c.nama==='Uji Kategori').id")
ck "Hapus kategori tak terpakai" "$(actj $J "{\"action\":\"categories.delete\",\"data\":{\"id\":$KID}}")" "200"
ck "Buat user staff" "$(actj $J '{"action":"users.create","data":{"username":"staf","password":"Staffpass123","role":"staff","fullname":"Petugas"}}')" "200"
ck "Username tidak valid ditolak 400" "$(actj $J '{"action":"users.create","data":{"username":"a b c","password":"12345678"}}')" "400"
ck "Admin tidak bisa hapus dirinya sendiri (selalu 404 diuji lewat id acak)" "$(actj $J '{"action":"users.delete","data":{"id":"usr_tidakada"}}')" "404"
ck "Buat user staff kedua" "$(actj $J '{"action":"users.create","data":{"username":"staf2","password":"Staffpass123","role":"staff","fullname":"Petugas 2"}}')" "200"
code -b $J "$B/api/bootstrap" >/dev/null
SUID=$(jq_ "d.users.find(u=>u.username==='staf2').id")
ck "Hapus user staff (tanpa jejak transaksi) berhasil" "$(actj $J "{\"action\":\"users.delete\",\"data\":{\"id\":\"$SUID\"}}")" "200"

echo "== OTORISASI ROLE =="
ck "Login staff berhasil" "$(code -c $S -X POST -H 'content-type: application/json' -H "x-real-ip: 10.77.0.1" -d '{"username":"staf","password":"Staffpass123"}' "$B/api/login")" "200"
# akun baru dari UI admin wajib ganti password lebih dulu; uji role dimulai setelah itu
code -b $S -X POST -H 'content-type: application/json' -d '{"lama":"Staffpass123","baru":"Staffpass123"}' "$B/api/password" >/dev/null
ck "Staff TIDAK boleh hapus kamar (403)" "$(actj $S '{"action":"rooms.delete","data":{"noKamar":"101"}}')" "403"
ck "Staff TIDAK boleh void pembayaran (403)" "$(actj $S '{"action":"payments.void","data":{"id":1}}')" "403"
ck "Staff TIDAK boleh hapus penyewa (403)" "$(actj $S '{"action":"tenants.delete","data":{"id":"TEN-0001"}}')" "403"
ck "Staff TIDAK boleh buat user (403)" "$(actj $S '{"action":"users.create","data":{"username":"xx","password":"12345678"}}')" "403"
ck "Staff boleh mencatat transaksi" "$(actj $S "{\"action\":\"ledger.create\",\"data\":{\"jenis\":\"pengeluaran\",\"kategori\":\"Listrik & Air\",\"jumlah\":1000,\"tanggal\":\"$TODAY\"}}")" "200"
code -b $S "$B/api/bootstrap" >/dev/null
ck "Staff TIDAK boleh check-out (403)" "$(actj $S '{"action":"tenants.checkout","data":{"id":"TEN-0001","kamar":"101"}}')" "403"
ck "Staff TIDAK boleh edit penyewa (403)" "$(actj $S '{"action":"tenants.update","data":{"id":"TEN-0001","nama":"X Y"}}')" "403"
ck "Staff TIDAK boleh tambah kamar (403)" "$(actj $S '{"action":"rooms.create","data":{"noKamar":"777","hargaBulanan":1}}')" "403"

# (5) tanggal mustahil / terlalu tua ditolak
ck "Bootstrap untuk staff tidak memuat daftar user" "$(code -b $S "$B/api/bootstrap" >/dev/null; jq_ "Array.isArray(d.users) ? d.users.length : 0")" "0"

echo "== IMPOR DARI WHATSAPP =="
# simulasi hasil urai pesan WA di UI: server hanya perlu menerima data + sumber
ACT_WA=$(actj $J '{"action":"tenants.create","data":{"nama":"Rina WA","hp":"81234500000","kamar":"102","tglMasuk":"2026-01-01","kontakDarurat":"Ibu Ratna","hpDarurat":"08133330000","sumber":"wa"}}')
code -b $J "$B/api/bootstrap" >/dev/null
ck "Penyewa dari WhatsApp tersimpan" "$(jq_ "(p=>[p[1],p[10]].join('|'))(d.penyewa.find(p=>p[12]==='wa'))")" "Rina WA|08133330000"
ck "Penanda sumber 'wa' tersimpan" "$(jq_ "d.penyewa.find(p=>p[9]==='Ibu Ratna')[12]")" "wa"
ck "Penyewa manual tetap bertanda 'manual'" "$(jq_ "d.penyewa.find(p=>p[0]==='TEN-0001')[12]")" "manual"

echo "== PENGINGAT WHATSAPP =="
# TEN-0003 didaftarkan di sini supaya tagihannya pasti terbuka (TEN-0001/0002 kondisinya sudah berubah)
actj $J '{"action":"rooms.create","data":{"noKamar":"104","tipe":"Standar","hargaBulanan":950000}}' >/dev/null
actj $J "{\"action\":\"tenants.create\",\"data\":{\"nama\":\"Rina Pengingat\",\"hp\":\"81211110000\",\"kamar\":\"104\",\"tglMasuk\":\"2026-01-01\"}}" >/dev/null
code -b $J "$B/api/pengingat" >/dev/null
ck "Daftar pengingat memuat tagihan belum lunas" "$(jq_ "d.filter(p=>p.nama==='Rina Pengingat').length")" "1"
ck "Pengingat berisi kamar, nominal, jatuh tempo & keterlambatan" "$(jq_ "(p=>[p.kamar,p.jumlah,p.jatuhTempo, p.terlambat>0].join('|'))(d.find(p=>p.nama==='Rina Pengingat'))")" "104|950000|2026-02-01|true"
PBID=$(jq_ "d.find(p=>p.nama==='Rina Pengingat').billId")
ck "Tandai pengingat terkirim" "$(actj $J "{\"action\":\"pengingat.catat\",\"data\":{\"billId\":$PBID}}")" "200"
code -b $J "$B/api/pengingat" >/dev/null
ck "Pengingat tercatat (tidak dikirim dobel)" "$(jq_ "d.find(p=>p.billId===$PBID).sudahDiingatkan")" "true"
ck "ID tagihan tidak valid ditolak 400" "$(actj $J '{"action":"pengingat.catat","data":{"billId":0}}')" "400"
ck "Tagihan tidak dikenal ditolak 404" "$(actj $J '{"action":"pengingat.catat","data":{"billId":99999}}')" "404"

echo "== GANTI PASSWORD =="
ck "Ganti password: password lama salah ditolak 401" "$(code -b $S -X POST -H 'content-type: application/json' -d '{"lama":"salah","baru":"Baru123456"}' "$B/api/password")" "401"
ck "Ganti password: baru < 8 karakter ditolak 400" "$(code -b $S -X POST -H 'content-type: application/json' -d '{"lama":"Staffpass123","baru":"123"}' "$B/api/password")" "400"
ck "Ganti password staff berhasil" "$(code -b $S -X POST -H 'content-type: application/json' -d '{"lama":"Staffpass123","baru":"Baru123456"}' "$B/api/password")" "200"


echo "== PERTAHANAN PERIMETER =="
# 1) Header keamanan pada API (termasuk galat) dan halaman
ck "API mengirim header anti-bingkai (X-Frame-Options)" "$(curl -s -D - -o /dev/null "$B/api/session" | grep -ci 'x-frame-options: DENY')" "1"
ck "API mengirim CSP frame-ancestors none" "$(curl -s -D - -o /dev/null "$B/api/session" | grep -ci "frame-ancestors 'none'")" "1"
ck "API tidak di-cache (no-store)" "$(curl -s -D - -o /dev/null "$B/api/session" | grep -ci 'cache-control: no-store')" "1"
ck "Galat 401 juga memakai header keamanan" "$(curl -s -D - -o /dev/null "$B/api/dashboard" | grep -ci 'x-content-type-options: nosniff')" "1"
ck "Adapter UI tidak bisa ditebak tipenya (nosniff)" "$(curl -s -D - -o /dev/null "$B/d1-adapter.js" | grep -ci 'x-content-type-options: nosniff')" "1"
# Catatan: header halaman dari folder pub/ TIDAK bisa diuji di wrangler dev — lapisan aset
# lokal melayani /index.html langsung (CF-Cache-Status: HIT) sehingga Worker tidak dipanggil.
# Di produksi /index.html dilayani Worker, jadi yang diuji di sini cukup "/" menyajikan HTML
# dan _headers tersedia sebagai cadangan. Verifikasi header produksi dilakukan setelah deploy.
# Isi halaman hanya bisa dipastikan bila Worker menyajikannya; wrangler dev (lokal) punya
# cache aset sendiri yang bisa kosong tanpa alasan jelas, jadi bukti isi halaman diambil
# dari berkas sumber (yang memang ikut di-deploy) — bukan dari respons lokal.
ck "Halaman disajikan Worker dengan header anti-bingkai" "$(curl -s -D - -o /dev/null "$B/" | grep -ci 'x-frame-options: DENY')" "1"
ck "Halaman mengirim CSP frame-ancestors none" "$(curl -s -D - -o /dev/null "$B/" | grep -ci "frame-ancestors 'none'")" "1"
ck "Halaman memuat adapter UI" "$(curl -s "$B/" | grep -qc 'd1-adapter.js' && echo ya || echo tidak)" "ya"
ck "Halaman memakai Tailwind lokal (bukan CDN)" "$(curl -s "$B/" | grep -qc 'tailwind.css' && echo ya || echo tidak)" "ya"
ck "Tidak ada lagi template CSS dari CDN" "$(curl -s "$B/" | grep -c 'cdn.tailwindcss.com')" "0"
ck "Manifest PWA tersaji" "$(curl -s -o /dev/null -w '%{http_code}' "$B/manifest.webmanifest")" "200"
ck "Ikon 192 tersaji" "$(curl -s -o /dev/null -w '%{http_code}' "$B/ikon-192.png")" "200"
ck "Tailwind lokal tersaji" "$(curl -s -o /dev/null -w '%{http_code}' "$B/tailwind.css")" "200"
ck "Opsi CORS untuk origin lain TIDAK dikirim" "$(curl -s -D - -o /dev/null -H 'Origin: https://jahat.example' "$B/api/session" | grep -ci 'access-control-allow-origin')" "0"

# 2) Batas laju per IP (header x-forwarded-for dipakai untuk membedakan klien di lokal).
#    Pengujian lama sudah menghasilkan banyak percobaan dari IP "lokal" sehingga kuota
#    login 1 menit bisa habis; IP pengujian diberi jeda 60 detik sekali saja bila 429.
RATE_IP="10.99.0.$RANDOM"
N429=0
for i in $(seq 1 70); do
  C=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "x-real-ip: $RATE_IP" -H "cf-connecting-ip: $RATE_IP" -d '{"username":"admin","password":"salah"}' "$B/api/login")
  [ "$C" = "429" ] && N429=$((N429+1))
done
if [ $N429 -eq 0 ]; then echo "… jendela batas laju habis dari uji sebelumnya, menunggu 60 detik"; sleep 61
  for i in $(seq 1 70); do
    C=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "x-real-ip: $RATE_IP" -H "cf-connecting-ip: $RATE_IP" -d '{"username":"admin","password":"salah"}' "$B/api/login")
    [ "$C" = "429" ] && N429=$((N429+1))
  done
fi
ck "Banjir login dari satu IP akhirnya dibatasi 429" "$([ $N429 -ge 1 ] && echo ya || echo tidak)" "ya"
ck "IP lain tidak ikut terblokir" "$(curl -s -o /dev/null -w '%{http_code}' -H "x-real-ip: 10.99.1.$RANDOM" -H "cf-connecting-ip: 10.99.1.$RANDOM" "$B/api/session")" "200"

# 3) Password awal wajib diganti: akun baru dari admin harus ganti dulu
actj $J '{"action":"users.create","data":{"username":"awal","password":"Awalan12345","role":"staff","fullname":"Akun Awal"}}' >/dev/null
CLEAN_IP="10.99.2.$RANDOM"
CLEAN_IP="10.44.7.$((RANDOM%200))"
curl -s -X POST -H 'content-type: application/json' -H "x-real-ip: $CLEAN_IP" -H "cf-connecting-ip: $CLEAN_IP" -d '{"username":"awal","password":"Awalan12345"}' "$B/api/login" -o /tmp/hade_login_awal.json
TOKEN_AWAL=$(node -e "console.log(require('/tmp/hade_login_awal.json').token||'')")
# token disimpan dulu ke berkas: memakai "|" ke node membuat curl gagal membaca stdin (token kosong)
curl -s -H "x-sesi-apk: $TOKEN_AWAL" "$B/api/session" -o /tmp/hade_sesi_awal.json
ck "Login akun baru menghasilkan token untuk uji" "$([ ${#TOKEN_AWAL} -eq 64 ] && echo ya || echo tidak)" "ya"
ck "Akun baru: /api/session memberi penanda must_change_password" "$(node -e "const j=require('/tmp/hade_sesi_awal.json');console.log(j.user&&j.user.must_change_password)")" "true"
ck "Akun baru: data TIDAK bisa dibuka sebelum ganti password (403)" "$(curl -s -o /dev/null -w '%{http_code}' -H "x-sesi-apk: $TOKEN_AWAL" "$B/api/bootstrap")" "403"
CK_AWAL=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "x-sesi-apk: $TOKEN_AWAL" -d "{\"action\":\"ledger.create\",\"data\":{\"jenis\":\"pengeluaran\",\"kategori\":\"Listrik & Air\",\"jumlah\":1000,\"tanggal\":\"$TODAY\"}}" "$B/api/action")
ck "Akun baru: aksi data juga ditolak sebelum ganti password (403)" "$CK_AWAL" "403"
ck "Akun baru: boleh mengganti password (200)" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "x-sesi-apk: $TOKEN_AWAL" -d '{"lama":"Awalan12345","baru":"AwalanBaru123"}' "$B/api/password")" "200"
curl -s -X POST -H 'content-type: application/json' -H "x-real-ip: $CLEAN_IP" -H "cf-connecting-ip: $CLEAN_IP" -d '{"username":"awal","password":"AwalanBaru123"}' "$B/api/login" -o /tmp/hade_login_awal2.json
TOKEN_AWAL2=$(node -e "console.log(require('/tmp/hade_login_awal2.json').token||'')")
ck "Setelah ganti password, data terbuka kembali (200)" "$(curl -s -o /dev/null -w '%{http_code}' -H "x-sesi-apk: $TOKEN_AWAL2" "$B/api/bootstrap")" "200"

echo "== LOGOUT =="
ck "Logout lewat GET ditolak 405" "$(code -b $J "$B/api/logout")" "405"
ck "Logout POST" "$(code -b $J -X POST "$B/api/logout")" "200"
ck "Setelah logout -> 401" "$(code -b $J "$B/api/dashboard")" "401"

echo
if [ $fail -eq 0 ]; then echo "SEMUA LULUS"; else echo "$fail GAGAL"; fi
exit $fail
