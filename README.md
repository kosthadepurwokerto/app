# Kost Hade — Guesthouse Management

Manajemen kost: kamar, penyewa, tagihan, pembayaran, ledger operasional, laporan.

**Backend:** Cloudflare Workers + D1 (SQLite). Tanpa langganan, tanpa server, login aman
(password PBKDF2, sesi di cookie HttpOnly). Data tersimpan di database — bukan lagi di
browser, jadi bisa dibuka dari HP dan PC sekaligus.

## Struktur

```
pub/            UI statis (index.html + d1-adapter.js)
worker/index.js Worker API (rute /api/*) + penyaji halaman
worker/logic.js Logika bisnis murni (bisa diuji di Node)
db/schema.sql   Skema D1: tabel, trigger audit, view dashboard, kategori default
tools/buat-akun.mjs  Pembuat akun (hash PBKDF2)
tools/uji-e2e.sh     Uji end-to-end terhadap Worker lokal
wrangler.toml
```

## Jalankan lokal

```bash
npm install
npx wrangler d1 execute hadekost-db --local --file=db/schema.sql
node tools/buat-akun.mjs admin 'PasswordKuat123' admin 'Administrator'   # salin hasilnya:
npx wrangler d1 execute hadekost-db --local --command "<hasil perintah di atas>"
npm run dev            # http://localhost:8787
npm test   # atau: bash tools/uji-lokal.sh  (163 pemeriksaan, DB lokal terpisah)
```

## Deploy (sekali)

```bash
# 1. buat database D1 dan salin database_id ke wrangler.toml
npx wrangler d1 create hadekost-db

# 2. terapkan skema ke database produksi
npx wrangler d1 execute hadekost-db --remote --file=db/schema.sql

# 3. buat akun admin pertama
node tools/buat-akun.mjs admin 'PasswordKuat123' admin 'Administrator'
npx wrangler d1 execute hadekost-db --remote --command "<hasil perintah di atas>"

# 4. deploy
npx wrangler deploy
```

Setelah deploy, aplikasi tersedia di `https://hadekost.<subdomain>.workers.dev`.

## Aturan bisnis yang dijaga kode

- **Tagihan** dibuat otomatis saat registrasi (+1 bulan, 31 Jan → 28/29 Feb). Jatuh tempo
  tidak diketik bebas; setelah pembayaran lunas, tagihan bulan berikutnya dibuat otomatis.
- **Pembayaran** harus cocok persis dengan tagihan terbuka; tanggal tidak boleh di masa depan;
  setiap pembayaran punya nomor struk `STR-YYYYMMDD-NNN`.
- **Hapus = void.** Transaksi ledger tidak dihapus fisik, hanya ditandai `voided_at`.
  Semua insert/update di `rooms`, `tenants`, `bills`, `payments`, `ledger`, `users` dicatat
  otomatis oleh trigger ke `audit_log`.
- **Penyewa berriwayat** tidak bisa dihapus; gunakan Check-out.
- **Staf** tidak melihat menu User/Reset; setiap API menolak permintaan tanpa sesi (401).

## Keamanan

- Password disimpan sebagai `pbkdf2$100000$salt$hash` (iterasi 100.000 = batas Workers).
- Sesi: token acak 32 byte; yang disimpan di DB hanya SHA-256-nya, umur 7 hari.
- Cookie: `HttpOnly; SameSite=Lax; Secure` (lokal: `COOKIE_SECURE=false`).
- Tidak ada kredensial di repo. Akun dibuat lewat `tools/buat-akun.mjs`.

## Yang belum tersedia di versi D1

- Pindah kamar (check-out, edit penyewa, bayar N bulan, bukti bayar sudah ada).
- Foto KTP lewat R2: kode sudah siap, butuh token API Cloudflare berizin
  **Workers R2 Storage** (`npx wrangler r2 bucket create hadekost-ktp`, lalu aktifkan blok
  `[[r2_buckets]]` di `wrangler.toml`). Selama belum aktif, foto disimpan di tabel `ktp_berkas`.

## Migrasi database

`schema.sql` dipakai untuk **database baru**. Database yang sudah berjalan cukup menjalankan
migrasi berurutan di `db/migrasi-*.sql` yang belum pernah diterapkan (kolom/index/tabel baru):

```bash
# cek dulu, lalu jalankan dengan pengaman (backup otomatis + tolak DELETE/UPDATE tanpa WHERE)
bash tools/sql-produksi.sh db/migrasi-00X-nama-migrasi.sql --ya
```

Daftar migrasi yang ada sekarang: 001 kolom dasar, 002 kontak penyewa, 003 ktp_berkas,
004 pengingat WA, 005 sumber penyewa, 006 index kuota, 007 bayar banyak bulan,
008 tanggal mulai tagihan, 009 bukti bayar, 010 periode lunas, 011 counter kode penyewa.
`schema.sql` sudah memuat semua kolom tersebut, jadi DB baru **tidak** perlu menjalankan 001-011.

## Backup & pemulihan

```bash
npm run backup                        # ekspor D1 ke ~/backup/hadekost/ (30 berkas terakhir disimpan)
```
Backup harian otomatis: cron 20:00 UTC (03:00 WIB), log di `~/logs/backup-hadekost.log`.

Memulihkan: buat database baru, lalu impor berkas dengan
`npx wrangler d1 import <nama-db> --file=<berkas.sql>` (uji di database terpisah sebelum menimpa produksi).

## Uji

`npm test` menjalankan seluruh uji E2E (163 pemeriksaan) pada D1 lokal terpisah; database produksi
tidak tersentuh. Uji mencakup otorisasi role, perhitungan kas/tunggakan, void, bayar N bulan,
prorata, bukti bayar, dan regresi bug yang pernah terjadi.

## Aplikasi Android (APK)

Pembungkus WebView ada di `~/projects/hadekost-android` (repo terpisah):

```bash
cd ~/projects/hadekost-android && ./build-apk.sh   # -> hadekost-1.0.0.apk
```

Alamat server ditanam saat build; ganti dengan `./build-apk.sh --alamat https://...`.
Berkas kunci `kosthade-release.jks` harus disimpan — pembaruan APK wajib memakai kunci sama.

## UI & aset

- `pub/app.html` disajikan oleh Worker untuk `/` (dan `/index.html`) supaya header keamanan
  benar-benar terpasang; jangan menamainya `index.html` lagi — lapisan aset akan
  melayaninya lebih dulu dan memotong header.
- Tailwind dibangun lokal (`npm run ui` → `pub/tailwind.css`), tanpa CDN, supaya tampilan
  tetap benar saat sinyal lambat atau CDN diblokir. `npm run deploy` menjalankan build UI
  lebih dulu.
- HTML hanya kerangka: skrip di `pub/app.js`, gaya halaman di `pub/app.css`, ikon di
  `pub/fontawesome.css` + `pub/webfonts/`, font Plus Jakarta di `pub/fonts.css`.
  Jangan menaruh `<script>`/`<style>` sebaris lagi di `app.html` — CSP halaman tidak
  mengizinkan `'unsafe-inline'` untuk skrip, jadi kode sebaris akan diam-diam tidak jalan.
- Aksi tombol/form di HTML memakai atribut `data-h="<ekspresi JS>"` (mis.
  `data-h="closeModal()"`). Pelaksanaannya satu pendengar global di akhir `app.js`;
  fungsi yang dipanggil dari HTML harus tersedia di `window`, dan `this` di dalam
  ekspresi menunjuk elemen yang diklik.

- Manifest PWA + ikon: `/manifest.webmanifest`, `/ikon-192.png`, `/ikon-512.png`.
