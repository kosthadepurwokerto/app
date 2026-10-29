#!/usr/bin/python3
"""Isi worker/aset-cadangan.js dengan isi folder pub/ (base64).

Hanya dipakai saat `wrangler deploy` gagal di tahap unggah aset (error 10013).
Jalankan sebelum build/deploy darurat, lalu kembalikan file ke versi kosong
setelah aset normal bisa diunggah lagi.
"""
import base64, json, os, sys

AKAR = os.path.join(os.path.dirname(__file__), '..', 'pub')
TUJUAN = os.path.join(os.path.dirname(__file__), '..', 'worker', 'aset-cadangan.js')

TIPE = {
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ico': 'image/x-icon',
}

berkas = {}
for d, _, fs in os.walk(AKAR):
    for f in sorted(fs):
        p = os.path.join(d, f)
        rel = '/' + os.path.relpath(p, AKAR).replace(os.sep, '/')
        ext = os.path.splitext(f)[1].lower()
        with open(p, 'rb') as fh:
            isi = fh.read()
        berkas[rel] = {'tipe': TIPE.get(ext, 'application/octet-stream'), 'b64': base64.b64encode(isi).decode()}

sumber = open(TUJUAN, encoding='utf-8').read()
awal = sumber.index('export const BERKAS_EMBED = ')
akhir = sumber.index('};', awal) + 2
baru = 'export const BERKAS_EMBED = ' + json.dumps(berkas, ensure_ascii=False, indent=0).replace('\n', '') + ';'
open(TUJUAN, 'w', encoding='utf-8').write(sumber[:awal] + baru + sumber[akhir:])
print(f'{len(berkas)} berkas di-embed ke worker/aset-cadangan.js ({sum(len(v["b64"]) for v in berkas.values())} char base64)')
