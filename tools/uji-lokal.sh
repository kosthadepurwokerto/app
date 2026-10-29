#!/usr/bin/env bash
# Uji E2E lengkap di DB LOKAL terpisah (default /tmp/hklocal).
# - DB uji selalu di-reset supaya angka kas/ledger bermakna.
# - Server lama dimatikan lewat PID yang disimpan (pola pkill bisa cocok dengan
#   command line skrip ini sendiri dan mematikan uji di tengah jalan).
set -u
cd "$(dirname "$0")/.."
PERSIST=${PERSIST:-/tmp/hklocal}
PIDF=/tmp/hkdev.pid

# 1) stop: matikan proses lama (npx -> node wrangler -> workerd), tunggu port bebas
if [ -f "$PIDF" ]; then
  for pid in $(cat "$PIDF"); do kill "$pid" 2>/dev/null; done
fi
for p in $(ps -eo pid,args | grep -E "(wrangler|workerd).*--persist-to $PERSIST" | grep -v grep | grep -v 'ps -eo' | awk '{print $1}'); do
  kill "$p" 2>/dev/null
done
for i in $(seq 1 30); do ss -ltn 2>/dev/null | grep -q ':8787 ' || break; sleep 0.5; done
rm -f "$PIDF"

# 2) DB uji bersih
rm -rf "$PERSIST"; mkdir -p "$PERSIST"
npx wrangler d1 execute hadekost-db --local --persist-to "$PERSIST" --file=db/schema.sql >/tmp/hk-schema.log 2>&1 || { echo "SKEMA GAGAL"; tail -5 /tmp/hk-schema.log; exit 1; }
if grep -qi 'error' /tmp/hk-schema.log; then echo "SKEMA ADA ERROR:"; grep -i -A3 'error' /tmp/hk-schema.log | head -20; exit 1; fi
# migrasi kolom/tabel baru: skema dasar tidak memuat tenant_kamar (pindah kamar) dsb.
# skema dasar sudah memuat kolom 013/014; sisanya (login per kost, hp multi kost, pindah kamar) masih baru
# skema dasar sudah memuat kolom 001-016; hanya 017 (riwayat kamar) yang tabelnya masih baru
for m in db/migrasi-017-*.sql; do
  npx wrangler d1 execute hadekost-db --local --persist-to "$PERSIST" --file="$m" >>/tmp/hk-schema.log 2>&1 || { echo "MIGRASI GAGAL: $m"; tail -5 /tmp/hk-schema.log; exit 1; }
done
# Akun seed WAJIB punya No. HP: login hanya menerima No. HP (username ditolak),
# jadi tanpa UJI_HP seluruh uji runtuh di langkah login pertama.
UJI_TANPA_GANTI=1 UJI_HP=081200000100 node tools/buat-akun.mjs admin 'Kostsaya12345' admin 'Administrator Utama' > "$PERSIST/akun.sql"
npx wrangler d1 execute hadekost-db --local --persist-to "$PERSIST" --file="$PERSIST/akun.sql" >/dev/null 2>&1
rm -f "$PERSIST/akun.sql"

# 3) bucket R2 lokal: `wrangler r2 bucket create` tidak mengenal --local, jadi bucket
#    dibuat langsung ke persist lokal (metadata sqlite miniflare). Tanpa ini `wrangler dev`
#    menolak start saat wrangler.toml memuat binding [[r2_buckets]].
/usr/bin/python3 tools/r2-lokal.py "$PERSIST" hadekost-ktp >/tmp/hk-r2.log 2>&1 || { echo "R2 LOKAL GAGAL"; tail -5 /tmp/hk-r2.log; exit 1; }

# 4) server
setsid npx wrangler dev --local --persist-to "$PERSIST" --var COOKIE_SECURE:false --port 8787 >/tmp/hkdev.log 2>&1 < /dev/null &
echo $! > "$PIDF"
for i in $(seq 1 60); do curl -s -o /dev/null http://localhost:8787/api/session && break; sleep 1; done

# 5) uji
/usr/bin/python3 - <<'PY'
src=open('tools/uji-e2e.sh').read()
extra=open('tools/uji-pindah-kamar.sh').read()
ekor="echo\nif [ $fail -eq 0 ]"
i=src.rindex(ekor)
if '== PINDAH KAMAR ==' not in src:
    src=src[:i]+extra+src[i:]
open('/tmp/uji-e2e-gabung.sh','w').write(src)
PY
bash /tmp/uji-e2e-gabung.sh
HASIL=$?

# 5) bersihkan proses
for pid in $(cat "$PIDF"); do kill "$pid" 2>/dev/null; done
for p in $(ps -eo pid,args | grep -E "(wrangler|workerd).*--persist-to $PERSIST" | grep -v grep | grep -v 'ps -eo' | awk '{print $1}'); do
  kill "$p" 2>/dev/null
done
rm -f "$PIDF"
exit $HASIL
