echo "== VALIDASI NOMINAL (ledger & pembayaran) =="
# Regresi: num() dulu membuang semua karakter non-digit, sehingga "-5000" menjadi 5000,
# "Rp 12.500" menjadi 12500, dan "1,5" menjadi 15. Kini non-angka ditolak 400, format
# ribuan/desimal yang sah dinormalkan, dan nominal pembayaran non-angka TIDAK lagi
# dianggap "kosong" (dulu: lolos ke jalur auto-lunas sebesar total tagihan).
nom_ledger() {
  local label="$1" jumlah="$2" harap="$3"
  local body
  body=$(printf '{"action":"ledger.create","jenis":"Pengeluaran","kategori":"Listrik & Air","keterangan":"nom-%s","jumlah":%s}' "$label" "$jumlah")
  ck "Nominal ledger $label -> HTTP $harap" "$(actj $J "$body")" "$harap"
}
nom_ledger negatif -5000 400
nom_ledger nol 0 400
nom_ledger huruf '"abc"' 400
nom_ledger kosong '""' 400
nom_ledger objek '{"a":1}' 400
nom_ledger array '[5000]' 400
nom_ledger desimal 12.5 400
nom_ledger terlalu-besar 999999999999999999999 400
nom_ledger teks-ribuan '"1.500"' 200
nom_ledger teks-desimal-koma '"12,5"' 400
actj $J '{"action":"ledger.create","jenis":"Pengeluaran","kategori":"Listrik & Air","keterangan":"nom-titik-ribuan","jumlah":"Rp 12.500"}' >/dev/null
code -b "$J" "$B/api/ops" >/dev/null
LED=$(cat /tmp/hade_body)
ck "Ledger '1.500' tersimpan 1500" \
  "$(printf '%s' "$LED" | /usr/bin/python3 -c "import sys,json;d=json.load(sys.stdin);print([r[4] for r in d if r[5]=='nom-teks-ribuan'][0])" 2>/dev/null)" "1500"
ck "Ledger 'Rp 12.500' tersimpan 12500" \
  "$(printf '%s' "$LED" | /usr/bin/python3 -c "import sys,json;d=json.load(sys.stdin);print([r[4] for r in d if r[5]=='nom-titik-ribuan'][0])" 2>/dev/null)" "12500"
ck "Pembayaran jumlah 'abc' ditolak 400 (bukan auto-lunas)" \
  "$(actj $J "{\"action\":\"payments.create\",\"data\":{\"kamar\":\"101\",\"jumlah\":\"abc\",\"tanggal\":\"$TODAY\"}}")" "400"
