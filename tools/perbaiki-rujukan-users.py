#!/usr/bin/env python3
"""
Perbaiki rujukan FK yang menggantung ke tabel sementara (`users_lama_pindah`, `users_lama`, `__lama`).

Latar: mengganti definisi tabel `users` dilakukan dengan `alter table users rename to ...`
lalu membuat tabel users baru. D1/SQLite menulis ulang definisi tabel LAIN yang punya foreign
key ke `users` supaya menunjuk nama sementara itu; setelah tabel sementara dibuang, rujukan
tersebut menggantung dan INSERT ke users gagal:
  "no such table: main.users_lama_pindah"

Perbaikan di sini TIDAK memakai `alter table ... rename` (itulah penyebabnya):
  1. simpan + drop view/trigger yang menyentuh tabel terdampak,
  2. untuk tiap tabel terdampak: salin data ke `<tabel>__baru`, drop tabel lama,
     buat ulang dari definisi yang sudah dibersihkan (FK -> users), salin balik, drop perantara,
  3. buat ulang view/trigger,
  4. buang sisa tabel sementara.

Aman diulang: kalau tidak ada rujukan menggantung, skrip tidak mengubah apa pun.

  /usr/bin/python3 tools/perbaiki-rujukan-users.py --remote
"""
import json, os, re, subprocess, sys

REMOTE = '--remote' if '--remote' in sys.argv else ''
DB = os.environ.get('DB_NAME', 'hadekost-db')
POLA = re.compile(r'(users_lama\w*|__lama\w*|_pindah\b)', re.I)


def sql(q):
    cmd = ['npx', 'wrangler', 'd1', 'execute', DB] + ([REMOTE] if REMOTE else []) + ['--json', '--command', q]
    r = subprocess.run(cmd, capture_output=True, text=True)
    keluaran = (r.stdout or '') + (r.stderr or '')
    if '"success": true' not in keluaran:
        raise RuntimeError(f'{q[:90]} -> {keluaran.strip()[:400]}')
    try:
        return json.loads(r.stdout)[0].get('results', [])
    except Exception:
        return []


def bersihkan_ddl(ddl):
    """Hanya bagian REFERENCES yang dibersihkan: nama tabel sementara -> users."""
    def ganti(m):
        return f'{m.group(1)}"users"{m.group(3)}'
    return re.sub(r'(references\s*)"?(\w*(?:users_lama\w*|__lama\w*|\w*_pindah))"?(\s*\()', ganti, ddl, flags=re.I)


def main():
    objek = sql("select type, name, sql from sqlite_master where sql is not null") or []
    terdampak = [o for o in objek if o['type'] == 'table' and POLA.search(o['sql'] or '')]
    sampah = [o['name'] for o in objek
              if o['type'] == 'table' and re.fullmatch(r'\w*(users_lama\w*|__lama\w*|\w*_pindah)', o['name'] or '', re.I)]

    if not terdampak and not sampah:
        print('Tidak ada rujukan tabel sementara. Bersih.')
        return 0

    print('Tabel terdampak :', ', '.join(o['name'] for o in terdampak) or '-')
    print('Sisa sementara  :', ', '.join(sampah) or '-')

    # view & trigger yang menyentuh tabel terdampak harus dibuang lalu dibuat ulang
    nama_penting = {o['name'] for o in terdampak} | {'users'}
    simpan = [o for o in objek if o['type'] in ('view', 'trigger')
              and any(re.search(r'\b' + re.escape(n) + r'\b', o['sql'] or '') for n in nama_penting)]
    for o in simpan:
        print(f'  simpan & drop {o["type"]} {o["name"]}')
        sql(f'drop {o["type"]} if exists {o["name"]}')

    for o in terdampak:
        nama = o['name']
        ddl = bersihkan_ddl(o['sql'])
        kolom = [k['name'] for k in (sql(f"select name from pragma_table_info('{nama}')") or [])]
        daftar = ', '.join(kolom)
        perantara = f'{nama}__baru'
        print(f'  rebuild {nama} ({len(kolom)} kolom)')
        sql(f'drop table if exists {perantara}')
        sql(f'create table {perantara} as select * from {nama} where 0')
        sql(f'insert into {perantara} ({daftar}) select {daftar} from {nama}')
        sql(f'drop table {nama}')
        sql(ddl)
        sql(f'insert into {nama} ({daftar}) select {daftar} from {perantara}')
        sql(f'drop table {perantara}')

    for o in simpan:
        print(f'  buat ulang {o["type"]} {o["name"]}')
        sql(o['sql'])

    for nama in sampah:
        ada = sql(f"select count(*) as n from sqlite_master where type='table' and name='{nama}'")
        if ada and ada[0]['n']:
            print(f'  drop sisa tabel sementara {nama}')
            sql(f'drop table if exists {nama}')

    sisa = [x for x in (sql("select type, name, sql from sqlite_master where sql is not null") or [])
            if POLA.search(x['sql'] or '') and not re.search(r'\bsessions?\b.*_lama\b', x['name'] or '')]
    print(f'Selesai. Objek yang masih menyebut nama sementara: {len(sisa)}')
    for x in sisa:
        print('   ', x['type'], x['name'])
    return 0 if not sisa else 1


if __name__ == '__main__':
    sys.exit(main())
