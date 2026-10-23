#!/usr/bin/env bash
# Backup database produksi ke berkas SQL sebelum operasi berisiko.
# Pemakaian: bash tools/backup-produksi.sh [alasan]
# Menyimpan di ~/backup/hadekost/ (di luar repo — berisi data pribadi penyewa).
set -euo pipefail
cd "$(dirname "$0")/.."
ALASAN="${1:-manual}"
DIR="$HOME/backup/hadekost"
mkdir -p "$DIR"
OUT="$DIR/hadekost-$(date +%Y%m%d-%H%M%S)-${ALASAN//[^a-zA-Z0-9_-]/_}.sql"
export CLOUDFLARE_API_TOKEN="$(tr -d '\n\r ' < "$HOME/.cf_token")"
npx wrangler d1 export hadekost-db --remote --output "$OUT" >/dev/null 2>&1
if [ ! -s "$OUT" ]; then echo "GAGAL: backup kosong ($OUT)"; exit 1; fi
echo "Backup: $OUT ($(du -h "$OUT" | cut -f1))"
# simpan 30 backup terakhir
ls -1t "$DIR"/hadekost-*.sql 2>/dev/null | tail -n +31 | xargs -r rm -f
