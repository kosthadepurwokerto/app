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
bash tools/uji-e2e.sh  # 32 pemeriksaan
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

- Edit data penyewa (check-out lalu daftar ulang sebagai gantinya).
- Kelola kategori & pengguna dari dalam aplikasi (lewat SQL/`tools/buat-akun.mjs`).
