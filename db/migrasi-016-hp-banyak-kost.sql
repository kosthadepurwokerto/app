-- =====================================================================
-- Migrasi 016 — Satu No. HP, banyak kost (pola "master mendaftarkan admin")
--
-- Model yang dipakai:
--   1. Master membuat kost baru, lalu mendaftarkan No. HP sebagai admin kost itu.
--   2. HP yang sudah punya akun TIDAK dibuatkan akun kedua — cukup diberi baris
--      akses_kost untuk kost baru (satu akun, banyak kost).
--   3. HP terdaftar di lebih dari 1 kost -> login selalu menampilkan pilihan kost.
--   4. Admin yang membuat user hanya bisa membuat user di kost yang sedang aktif.
--
-- Yang ditambahkan: kolom users.akses_diminta. Bila 1 -> master (atau admin kost
-- asal) MEMINTA pemilik HP memilih kost setiap login, walau baru punya satu kost.
-- Perubahan ini tidak menghapus/mengubah data lama (akses_diminta default 0).
-- =====================================================================

alter table users add column akses_diminta integer not null default 0;

-- Pastikan setiap akun punya baris akses untuk kost induknya, supaya jumlah kost
-- akun = max(1, jumlah baris akses_kost) dan tidak ada akun "tanpa kost".
insert or ignore into akses_kost (user_id, kost)
  select id, kost from users where kost is not null and kost <> '';

-- Indeks bantu: cari pemilik HP dengan cepat saat master mendaftarkan admin.
create index if not exists idx_users_hp_kost on users(hp, kost);
