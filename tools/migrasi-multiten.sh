#!/bin/bash
# Migrasi database ke mode MULTITENAN (banyak kost dalam satu database).
#
#   ./migrasi-multiten.sh              # lokal: DB uji /tmp (persist .wrangler lokal)
#   ./migrasi-multiten.sh --remote --ya   # produksi (WAJIB backup dulu, lihat di bawah)
#
# Sifatnya idempoten: setiap pernyataan dijalankan satu per satu dan galat
# "duplicate column name" / "already exists" diabaikan, karena SQLite tidak punya
# "add column if not exists".
set -u
cd "$(dirname "$0")/.."

REMOTE=""
for a in "$@"; do
  case "$a" in
    --remote) REMOTE="--remote" ;;
    --ya) ;;
    *) echo "argumen tidak dikenal: $a"; exit 2 ;;
  esac
done

if [ -n "$REMOTE" ]; then
  echo "== mode PRODUKSI =="
  if ! ls ~/backup/hadekost/*.sql >/dev/null 2>&1; then
    echo "Tidak ada backup di ~/backup/hadekost/. Membuat backup dulu…"
  fi
  bash tools/backup-produksi.sh "sebelum-multitenan" || { echo "BACKUP GAGAL — migrasi dibatalkan."; exit 1; }
  echo "Backup dibuat. Lanjut migrasi…"
fi

DB="${DB_NAME:-hadekost-db}"
export DB_NAME="$DB"
export MIG_REMOTE="$REMOTE"
SQLFILE="db/migrasi-013-multitenan.sql"
PECAH=/tmp/migrasi-013-pecah.sql

# Pisahkan per pernyataan. Baris komentar dibuang, ';' di dalam string/kurung diabaikan.
/usr/bin/python3 - "$SQLFILE" "$PECAH" <<'PY'
import sys, re
masuk, keluar = sys.argv[1], sys.argv[2]
isi = open(masuk).read()
# buang komentar baris penuh
baris = [b for b in isi.split('\n') if not re.match(r'^\s*--', b)]
isi = '\n'.join(baris)
hasil, buf, dalam_str, dalam_kurung, i = [], [], False, 0, 0
while i < len(isi):
    c = isi[i]
    if c == "'":
        dalam_str = not dalam_str
    elif not dalam_str:
        if c == '(':
            dalam_kurung += 1
        elif c == ')':
            dalam_kurung = max(0, dalam_kurung - 1)
        elif c == ';' and dalam_kurung == 0:
            teks = ''.join(buf).strip()
            if teks:
                hasil.append(teks)
            buf = []
            i += 1
            continue
    buf.append(c)
    i += 1
sisa = ''.join(buf).strip()
if sisa:
    hasil.append(sisa)
open(keluar, 'w').write('\n---\n'.join(hasil))
print(f'{len(hasil)} pernyataan dipisah')
PY

BERHASIL=0; DILEWATI=0; GAGAL=0; n=0
# Setiap pernyataan dijalankan lewat --command. Argumen diteruskan sebagai array
# (bukan string) supaya kutip/baris baru di dalam SQL tidak dirusak shell — inilah
# yang membuat --file gagal pada pernyataan multi-baris sebelumnya.
/usr/bin/python3 - "$PECAH" <<'PY'
import subprocess, sys, os, json
pecah = open(sys.argv[1]).read().split('\n---\n')
remote = os.environ.get('MIG_REMOTE', '')
db = os.environ.get('DB_NAME', 'hadekost-db')
ok = lewat = gagal = 0
for n, stmt in enumerate(pecah, 1):
    stmt = stmt.strip()
    if not stmt:
        continue
    cmd = ['npx', 'wrangler', 'd1', 'execute', db] + (['--remote'] if remote else []) + ['--command', stmt]
    r = subprocess.run(cmd, capture_output=True, text=True)
    keluaran = (r.stdout or '') + (r.stderr or '')
    if '"success": true' in keluaran:
        ok += 1
    elif 'duplicate column' in keluaran.lower() or 'already exists' in keluaran.lower():
        lewat += 1
    else:
        gagal += 1
        print(f'GAGAL #{n}: {stmt.splitlines()[0][:90]}')
        for baris in keluaran.splitlines():
            if 'ERROR' in baris:
                print('   ', baris.strip()[:150])
print(f'Selesai: berhasil={ok} dilewati={lewat} gagal={gagal}')
sys.exit(0 if gagal == 0 else 1)
PY
HASIL=$?

rm -f "$PECAH"
exit $HASIL
