# Kost Hade — Guesthouse Management

Aplikasi manajemen kost: kamar, penyewa, tagihan, pembayaran, ledger operasional, laporan.

**Status backend:** sebelumnya seluruh data disimpan di `localStorage` browser (hilang saat cache
dibersihkan, tidak sinkron antar perangkat, password plaintext). Sekarang aplikasi memakai
**Supabase** (PostgreSQL + Auth) dengan RLS dan audit log.

## Arsitektur

```
index.html            UI (satu halaman, tanpa build step)
config.js             URL + anon key Supabase (aman publik)
supabase-adapter.js   semua akses data + validasi
supabase/schema.sql   tabel, RLS, view, trigger audit, seed kategori
```

Tabel: `profiles`, `rooms`, `tenants`, `bills`, `payments`, `ledger`, `categories`, `audit_log`.
View: `v_dashboard`, `v_kas_bulanan`.

## Setup (sekali saja, ±10 menit)

1. **Buat project Supabase** — https://supabase.com/dashboard → New project. Catat
   `Project URL` dan `anon public key` (Settings → API).
2. **Jalankan skema** — SQL Editor → New query → tempel isi `supabase/schema.sql` → Run.
   Atau lewat CLI: `supabase db push`.
3. **Isi `config.js`** dengan URL & anon key dari langkah 1.
4. **Buat akun admin** — Authentication → Users → Add user (email + password, centang
   *Auto Confirm User*). Lalu di SQL Editor:
   ```sql
   insert into profiles (id, username, fullname, role)
   select id, split_part(email,'@',1), 'Administrator', 'admin'
   from auth.users where email = 'admin@domain-anda.com';
   ```
   Akun staf: ulangi dengan `role = 'staff'`.
5. Buka aplikasi → login dengan email + password tersebut.

## Aturan bisnis yang dijaga di kode

- **Jatuh tempo** berasal dari tabel `bills`, bukan diketik bebas. Tagihan dibuat otomatis
  saat registrasi (+1 bulan) dan setelah pembayaran lunas.
- **Pembayaran** harus cocok persis dengan tagihan terbuka; setelah lunas, tagihan berikutnya
  dibuat otomatis. Tanggal bayar tidak boleh di masa depan.
- **Hapus = void.** Transaksi keuangan tidak dihapus fisik, hanya ditandai `voided_at`, dan
  setiap perubahan tercatat di `audit_log` (trigger database).
- **Hanya admin** yang boleh menghapus data (policy RLS). Staf bisa input & edit.
- Penyewa yang sudah punya riwayat pembayaran tidak bisa dihapus — gunakan **Check-out**.

## Keamanan

- `anon key` boleh berada di repo publik; akses data dibatasi RLS, dan password dikelola
  Supabase Auth (hash bcrypt, bukan plaintext).
- **Jangan** menaruh `service_role key` di file mana pun di repo ini.
- Menu "ganti user tanpa password" dari versi lama sudah dihapus.
