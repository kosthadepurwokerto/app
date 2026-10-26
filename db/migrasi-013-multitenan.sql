-- =====================================================================
-- Migrasi 013 — MULTITENAN (satu database, banyak kost)
--
-- Setiap baris data diberi kolom `kost` (kunci kost). Login memilih kost, dan semua
-- query otomatis difilter per kost lewat worker/db-kost.js.
--
-- Data lama otomatis masuk ke kost 'kost-hade' (nilai default kolom) — tidak ada data
-- yang hilang.
--
-- CATATAN PENTING: SQLite tidak mendukung "add column if not exists". Karena itu
-- ALTER TABLE di bawah dijalankan oleh tools/migrasi-multiten.js, yang mengabaikan
-- galat "duplicate column name" sehingga migrasi aman dijalankan berulang.
--
--   bash tools/migrasi-multiten.sh --ya        # produksi (backup otomatis dulu)
-- =====================================================================

-- ---------- 1. Daftar kost ----------
create table if not exists kosts (
  kunci       text primary key,                 -- slug unik dari nama aplikasi
  nama_app    text not null unique,
  kota        text,
  tagline     text,
  logo_kunci  text,
  logo_tipe   text,
  aktif       integer not null default 1,
  created_at  text not null default (datetime('now'))
);

insert or ignore into kosts (kunci, nama_app, kota, tagline)
  values ('kost-hade', 'Kost Hade', 'Purwokerto', 'Guesthouse Management Premium');

-- ---------- 2. Akses akun ke kost ----------
-- Satu akun boleh membuka beberapa kost (dipakai master / admin multi-unit).
create table if not exists akses_kost (
  user_id text not null references users(id) on delete cascade,
  kost    text not null references kosts(kunci) on delete cascade,
  primary key (user_id, kost)
);

insert or ignore into akses_kost (user_id, kost)
  select id, 'kost-hade' from users;

-- ---------- 3. Kolom kost pada tabel data ----------
-- Role 'master' divalidasi di aplikasi: CHECK lama pada users.role hanya admin/staff
-- dan SQLite tidak bisa mengubah CHECK tanpa membuat ulang tabel.
alter table users      add column kost text not null default 'kost-hade';
alter table rooms      add column kost text not null default 'kost-hade';
alter table tenants    add column kost text not null default 'kost-hade';
alter table bills      add column kost text not null default 'kost-hade';
alter table payments   add column kost text not null default 'kost-hade';
alter table ledger     add column kost text not null default 'kost-hade';
alter table categories add column kost text not null default 'kost-hade';
alter table counters   add column kost text not null default 'kost-hade';
alter table sessions   add column kost text;

-- ---------- 4. Keunikan & indeks per kost ----------
create unique index if not exists idx_rooms_kost_no       on rooms(kost, no_kamar);
create unique index if not exists idx_tenants_kost_kode    on tenants(kost, kode);
create unique index if not exists idx_categories_kost_nama on categories(kost, jenis, nama);
create index if not exists idx_rooms_kost     on rooms(kost);
create index if not exists idx_tenants_kost   on tenants(kost, status);
create index if not exists idx_payments_kost  on payments(kost, tgl_bayar desc);
create index if not exists idx_ledger_kost    on ledger(kost, tanggal desc);
create index if not exists idx_bills_kost     on bills(kost, status);
