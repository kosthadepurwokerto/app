#!/usr/bin/env python3
"""Siapkan bucket R2 lokal untuk `wrangler dev --local`.

Latar: kalau wrangler.toml memuat [[r2_buckets]], `wrangler dev --local` menolak jalan
sampai bucket-nya terdaftar di persist lokal. Perintah `wrangler r2 bucket create` hanya
bisa ke akun Cloudflare sungguhan (tidak ada flag --local di wrangler 4.x), jadi baris
bucket dimasukkan langsung ke metadata SQLite milik miniflare.

Pakai:  tools/r2-lokal.py <persist-dir> <nama-bucket>
Aman dijalankan berulang (insert or ignore).
"""
import os
import sqlite3
import sys


def kolom(con, tabel):
    return [r[1] for r in con.execute(f"pragma table_info({tabel})")]


def main():
    persist = sys.argv[1] if len(sys.argv) > 1 else "/tmp/hklocal"
    nama = sys.argv[2] if len(sys.argv) > 2 else "hadekost-ktp"
    db = os.path.join(persist, "v3", "r2", "miniflare-R2BucketObject", "metadata.sqlite")
    os.makedirs(os.path.dirname(db), exist_ok=True)
    con = sqlite3.connect(db)
    try:
        con.execute(
            "create table if not exists _mf_buckets ("
            "name text primary key, creation_date integer, jurisdiction text default 'default')"
        )
        # kolom opsional ditambahkan belakangan oleh miniflare versi lain
        con.execute("insert or ignore into _mf_buckets (name) values (?)", (nama,))
        con.commit()
        baris = list(con.execute("select * from _mf_buckets"))
    finally:
        con.close()
    print(f"bucket lokal siap: {nama} (tabel _mf_buckets, {len(baris)} baris)")


if __name__ == "__main__":
    main()
