#!/usr/bin/env bash
# Jalankan SQL pada database PRODUKSI dengan pengaman:
#  - wajib punya penanda eksplisit --ya
#  - menolak DELETE/UPDATE/DROP tanpa WHERE, atau yang menyasar seluruh tabel
#  - otomatis backup lebih dulu
# Pemakaian: bash tools/sql-produksi.sh berkas.sql --ya
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${2:-}" != "--ya" ]; then
  echo "Ditolak: sertakan --ya di akhir perintah (operasi ini mengubah data produksi)."
  exit 2
fi
FILE="${1:?berkas SQL wajib}"
[ -f "$FILE" ] || { echo "Berkas tidak ada: $FILE"; exit 2; }

NORMAL=$(tr '\n' ' ' < "$FILE" | tr -s ' ' | sed 's/;/\n/g' | sed 's/^ *//; s/ *$//' | grep -v '^$' || true)
BAHAYA=0
while IFS= read -r q; do
  LOW=$(echo "$q" | tr 'A-Z' 'a-z')
  case "$LOW" in
    delete\ from*|update*|drop\ *|truncate*)
      if ! echo "$LOW" | grep -q ' where '; then
        echo "DITOLAK (tanpa WHERE): $q" >&2; BAHAYA=1
      fi ;;
  esac
done <<< "$NORMAL"
if [ "$BAHAYA" -ne 0 ]; then
  echo "Ada pernyataan berbahaya. Perbaiki dulu; tidak ada yang dijalankan." >&2
  exit 3
fi

echo "== Backup dulu =="
bash tools/backup-produksi.sh "sebelum-$(basename "$FILE" .sql)"
echo "== Jalankan $FILE =="
export CLOUDFLARE_API_TOKEN="$(tr -d '\n\r ' < "$HOME/.cf_token")"
npx wrangler d1 execute hadekost-db --remote --file="$FILE"
