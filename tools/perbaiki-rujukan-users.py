#!/usr/bin/env python3
"""
Perbaiki rujukan tabel `users` yang tertinggal sebagai "users_lama".

Latar: mengganti definisi tabel users (untuk menambah role 'master') dilakukan dengan
`alter table users rename to users_lama` lalu membuat tabel users baru. SQLite di D1
menulis ulang definisi tabel/view LAIN yang merujuk ke users sehingga menunjuk ke
"users_lama", dan insert ke users pun gagal ("no such table: main.users_lama",
"error in view v_dashboard: no such table: main.payments__lama").

Urutan kerja skrip ini (penting, karena view bisa menahan rename tabel):
  1. Simpan definisi semua view yang terdampak, lalu DROP view tersebut.
  2. Untuk setiap tabel terdampak: rename -> buat ulang (tanpa "users_lama") -> salin data -> buang tabel lama.
  3. Buat ulang view dari definisi yang disimpan, dengan nama tabel yang sudah benar.
  4. Pastikan tidak ada lagi rujukan "users_lama"/"__lama".

  ./perbaiki-rujukan-users.sh            # lokal
  ./perbaiki-rujukan-users.sh --remote   # produksi (BACKUP DULU: bash tools/backup-produksi.sh)
"""
import json, os, re, subprocess, sys

REMOTE = '--remote' if '--remote' in sys.argv else ''
DB = os.environ.get('DB_NAME', 'hadekost-db')


def sql_mentah(sql):
    cmd = ['npx', 'wrangler', 'd1', 'execute', DB] + ([REMOTE] if REMOTE else []) + ['--json', '--command', sql]
    r = subprocess.run(cmd, capture_output=True, text=True)
    keluaran = (r.stdout or '') + (r.stderr or '')
    if '"success": true' not in keluaran:
        raise RuntimeError(keluaran.strip()[:500])
    try:
        return json.loads(r.stdout)[0].get('results', [])
    except Exception:
        return []


def jalankan(sql):
    return sql_mentah(sql)


def nama_bersih(sql):
    return sql.replace('"users_lama"', 'users').replace('users_lama', 'users').replace('__lama', '')


def main():
    # ---- 1. kumpulkan objek terdampak ----
    semua = jalankan(
        "select type, name, sql from sqlite_master where type in ('table','view') and sql is not null") or []
    tabel = [o for o in semua if o['type'] == 'table' and ('users_lama' in (o['sql'] or '') or '__lama' in (o['sql'] or ''))]
    view = [o for o in semua if o['type'] == 'view' and ('users_lama' in (o['sql'] or '') or '__lama' in (o['sql'] or ''))]

    if not tabel and not view:
        print('Tidak ada rujukan users_lama. Tidak ada yang perlu diperbaiki.')
        return 0

    print(f'Tabel terdampak ({len(tabel)}):', ', '.join(o['name'] for o in tabel) or '-')
    print(f'View terdampak ({len(view)}):', ', '.join(o['name'] for o in view) or '-')

    # ---- 2. buang view dulu (menahan rename tabel) ----
    for v in view:
        print(f'  drop view {v["name"]}')
        jalankan(f'drop view if exists {v["name"]}')

    # ---- 3. bangun ulang tabel terdampak ----
    for o in tabel:
        nama, sql = o['name'], nama_bersih(o['sql'])
        kolom = [k['name'] for k in (jalankan(f"select name from pragma_table_info('{nama}')") or [])]
        daftar = ', '.join(kolom)
        sementara = f'{nama}__lama'
        print(f'  rebuild {nama} ({len(kolom)} kolom)')
        jalankan(f'drop table if exists {sementara}')
        jalankan(f'alter table {nama} rename to {sementara}')
        jalankan(sql)
        jalankan(f'insert into {nama} ({daftar}) select {daftar} from {sementara}')
        jalankan(f'drop table {sementara}')

    # ---- 4. buat ulang view ----
    for v in view:
        sql_view = nama_bersih(v['sql'])
        print(f'  buat view {v["name"]}')
        jalankan(sql_view)

    # ---- 5. verifikasi ----
    sisa = jalankan("select count(*) as n from sqlite_master where sql like '%users_lama%' or sql like '%__lama%'")
    n = sisa[0]['n'] if sisa else 0
    print(f'Selesai. Rujukan lama tersisa: {n}')
    return 0 if n == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
