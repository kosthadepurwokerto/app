#!/usr/bin/env python3
"""
Migrasi 015: username unik PER KOST (sebelumnya unik global).

Setelah login memakai No. HP (migrasi 014), username hanyalah label tampilan. Tiap kost
boleh punya akun bernama "admin"; identitas login dibedakan oleh No. HP (unik global).

Aturan UNIQUE(username) tertanam di definisi tabel `users` (bukan indeks terpisah) sehingga
SQLite tidak bisa menghapusnya tanpa membuat ulang tabel. Skrip ini:

  1. simpan & DROP view/trigger yang merujuk users (tanpa itu rename tabel ditolak);
  2. simpan isi tabel perujuk users ke tabel sementara `__isi` lalu kosongkan — D1 menolak
     rename users selama masih ada baris anak (FOREIGN KEY constraint failed);
  3. rename users -> users_lama_pindah; buat users baru TANPA UNIQUE(username);
  4. bangun ulang setiap tabel perujuk (D1 menulis ulang definisinya menjadi
     references "users_lama_pindah" saat rename, jadi definisi asli harus dibuat ulang),
     lalu salin isinya balik;
  5. salin data users & buang tabel lama;
  6. buat indeks unik (kost, username) dan indeks hp;
  7. buat ulang view/trigger dari definisi yang disimpan.

Langkah 2-5 dikirim ke D1 sebagai SATU perintah SQL (D1 menolak BEGIN/COMMIT).
Aman diulang: bila username sudah bukan unique global, skrip berhenti tanpa mengubah apa pun.

  ./tools/migrasi-username-per-kost.py --remote            (BACKUP DULU: bash tools/backup-produksi.sh)
  PERSIST_TO=/tmp/x ./tools/migrasi-username-per-kost.py   (uji di D1 lokal)
"""
import json
import os
import subprocess
import sys

REMOTE = '--remote' if '--remote' in sys.argv else ''
DB = os.environ.get('DB_NAME', 'hadekost-db')
SEMENTARA = 'users_lama_pindah'
PERSIST = os.environ.get('PERSIST_TO') or ''
AKAR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

STRUKTUR_BARU = """CREATE TABLE users (
  id text primary key,
  username text not null,
  fullname text not null,
  role text not null default 'staff' check (role in ('master','admin','staff')),
  kost text not null default 'kost-hade' references kosts(kunci),
  hp text,
  password_hash text not null,
  aktif integer not null default 1,
  must_change_password integer not null default 0,
  created_at text not null default (datetime('now'))
)"""


def sql(q):
    """Kirim satu perintah SQL (boleh beberapa statement) ke D1."""
    cmd = ['npx', 'wrangler', 'd1', 'execute', DB] + ([REMOTE] if REMOTE else []) + ['--json']
    if PERSIST:
        cmd += ['--local', '--persist-to', PERSIST]
    cmd += ['--command', q]
    p = subprocess.run(cmd, capture_output=True, text=True, cwd=AKAR)
    keluaran = (p.stdout or '') + (p.stderr or '')
    if '"success": true' not in keluaran:
        raise RuntimeError(f'{q[:80]} -> {keluaran.strip()[-500:]}')
    awal = keluaran.find('[')
    if awal < 0:
        return []
    teks = keluaran[awal:]
    akhir = teks.rfind(']')
    while akhir > 0:
        try:
            hasil = []
            for blok in json.loads(teks[:akhir + 1]):
                hasil += blok.get('results') or []
            return hasil
        except Exception:
            akhir = teks.rfind(']', 0, akhir)
    return []


def main():
    definisi = sql("select sql from sqlite_master where type='table' and name='users'")
    if not definisi:
        print('Tabel users tidak ditemukan.')
        return 1
    ddl = ' '.join((definisi[0]['sql'] or '').lower().split())

    if 'username text unique' not in ddl:
        if sql("select name from sqlite_master where type='index' and name='idx_users_kost_username'"):
            print('Sudah dimigrasi: username unik per kost. Tidak ada perubahan.')
            return 0
        sql('create unique index if not exists idx_users_kost_username on users(kost, username)')
        print('Indeks idx_users_kost_username dibuat.')
        return 0

    print('Users masih memakai UNIQUE(username) global -> membuat ulang tabel...')

    objek = sql("select type, name, sql from sqlite_master where type in ('view','trigger') and sql is not null") or []
    # view/trigger yang menyebut users ATAU tabel perujuk users — keduanya ikut dibangun ulang
    kandidat = (sql("select name from sqlite_master where type='table' and sql is not null "
                    "and name not in ('users','sqlite_sequence')") or [])
    perujuk = [r for r in kandidat if 'users' in (sql(f"select sql from sqlite_master where name='{r['name']}'")[0]['sql'] or '').lower()]
    nama_perujuk = [r['name'] for r in perujuk]
    terkait = [o for o in objek if any(k in (o['sql'] or '').lower() for k in ['users'] + nama_perujuk)]
    for o in terkait:
        print(f'  drop {o["type"]} {o["name"]}')
        sql(f'drop {o["type"]} if exists {o["name"]}')

    perujuk = [dict(r, sql=sql(f"select sql from sqlite_master where name='{r['name']}'")[0]['sql']) for r in perujuk]
    for r in perujuk:
        print(f'  tabel perujuk users: {r["name"]}')

    kolom = [k['name'] for k in (sql("select name from pragma_table_info('users')") or [])]
    daftar = ', '.join(kolom)

    # indeks non-unik ikut hilang saat tabel di-drop; namanya dipakai lagi nanti
    indeks = []
    for r in perujuk:
        indeks += sql(f"select name, sql from sqlite_master where type='index' and tbl_name='{r['name']}' "
                      "and name not like 'sqlite_%' and sql is not null") or []

    # D1 menolak rename users selama masih ada baris anak (FK), jadi isi tabel perujuk
    # diselamatkan ke __isi lalu dikosongkan lebih dulu.
    for r in perujuk:
        sql(f'drop table if exists {r["name"]}__isi')
        sql(f'create table {r["name"]}__isi as select * from {r["name"]}')
        sql(f'delete from {r["name"]}')

    langkah = [
        f'drop table if exists {SEMENTARA}',
        f'alter table users rename to {SEMENTARA}',
        STRUKTUR_BARU,
        f'insert into users ({daftar}) select {daftar} from {SEMENTARA}',
        f'drop table {SEMENTARA}',
    ]
    langkah += [f'drop index if exists {i["name"]}' for i in indeks]
    for r in perujuk:
        nama, skema = r['name'], r['sql'] or ''
        langkah += [
            f'create table {nama}__baru' + skema[skema.index('('):],
            f'insert into {nama}__baru select * from {nama}__isi',
            f'drop table {nama}',
            f'alter table {nama}__baru rename to {nama}',
        ]
    langkah += [f'drop table if exists {r["name"]}__isi' for r in perujuk]

    # D1 menjalankan beberapa statement dalam satu perintah secara implisit (BEGIN/COMMIT
    # ditolak), jadi tiap langkah dikirim terpisah agar kegagalan menunjuk statement persisnya.
    for i, l in enumerate(langkah):
        try:
            sql(l)
        except Exception:
            print(f'GAGAL di langkah {i + 1}/{len(langkah)}: {l[:90]}')
            raise
    print(f'  {len(kolom)} kolom users disalin, {len(perujuk)} tabel perujuk dibangun ulang')


    sql('create unique index if not exists idx_users_kost_username on users(kost, username)')
    sql("create unique index if not exists idx_users_hp on users(hp) where hp is not null and hp <> ''")

    for o in terkait:
        print(f'  buat ulang {o["type"]} {o["name"]}')
        sql(o['sql'])

    jumlah = sql('select count(*) as n from users')
    print(f'Selesai. Jumlah akun: {jumlah[0]["n"] if jumlah else "?"}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
