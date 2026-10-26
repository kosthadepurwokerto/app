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
UJI_TANPA_GANTI=1 node tools/buat-akun.mjs admin 'Kostsaya12345' admin 'Administrator Utama' > "$PERSIST/akun.sql"
npx wrangler d1 execute hadekost-db --local --persist-to "$PERSIST" --file="$PERSIST/akun.sql" >/dev/null 2>&1
rm -f "$PERSIST/akun.sql"

# 3) server
npx wrangler dev --local --persist-to "$PERSIST" --var COOKIE_SECURE:false --port 8787 >/tmp/hkdev.log 2>&1 &
echo $! > "$PIDF"
for i in $(seq 1 60); do curl -s -o /dev/null http://localhost:8787/api/session && break; sleep 1; done

# 4) uji
bash tools/uji-e2e.sh
HASIL=$?

# 5) bersihkan proses
for pid in $(cat "$PIDF"); do kill "$pid" 2>/dev/null; done
for p in $(ps -eo pid,args | grep -E "(wrangler|workerd).*--persist-to $PERSIST" | grep -v grep | grep -v 'ps -eo' | awk '{print $1}'); do
  kill "$p" 2>/dev/null
done
rm -f "$PIDF"
exit $HASIL
