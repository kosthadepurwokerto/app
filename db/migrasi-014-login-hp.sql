-- =====================================================================
-- Migrasi 014 — LOGIN PAKAI NO. HP
--
-- Aturan: nomor HP menjadi identitas login (unik), sehingga petugas tidak perlu
-- mengetik nama kost. Akun lama boleh tanpa nomor HP; nomor diisi lewat menu User.
--
--   ./tools/migrasi-multiten.sh --remote --ya   (jalankan setelah 013)
-- =====================================================================
alter table users add column hp text;
create unique index if not exists idx_users_hp on users(hp) where hp is not null and hp <> '';
