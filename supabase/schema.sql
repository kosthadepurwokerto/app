-- =====================================================================
-- Kost Hade — Skema Database (Supabase / PostgreSQL)
-- Jalankan di Supabase SQL Editor, atau: supabase db push
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------- ENUM ----------
do $$ begin
  create type user_role as enum ('admin', 'staff');
exception when duplicate_object then null; end $$;

do $$ begin
  create type room_status as enum ('tersedia', 'terisi', 'perbaikan');
exception when duplicate_object then null; end $$;

do $$ begin
  create type tenant_status as enum ('aktif', 'keluar');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bill_status as enum ('belum_bayar', 'lunas', 'sebagian', 'batal');
exception when duplicate_object then null; end $$;

do $$ begin
  create type ledger_type as enum ('pendapatan', 'pengeluaran', 'neraca');
exception when duplicate_object then null; end $$;

-- ---------- PROFIL / USER ----------
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text unique not null,
  fullname    text not null,
  role        user_role not null default 'staff',
  created_at  timestamptz not null default now()
);

-- ---------- KATEGORI LEDGER ----------
create table if not exists categories (
  id           uuid primary key default gen_random_uuid(),
  jenis        ledger_type not null,
  nama         text not null,
  saldo_normal text not null default 'Debet' check (saldo_normal in ('Debet', 'Kredit')),
  aktif        boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (jenis, nama)
);

-- ---------- KAMAR ----------
create table if not exists rooms (
  id             uuid primary key default gen_random_uuid(),
  no_kamar       text unique not null,
  tipe           text not null,
  harga_bulanan  numeric(12,2) not null default 0 check (harga_bulanan >= 0),
  harga_harian   numeric(12,2) not null default 0 check (harga_harian >= 0),
  status         room_status not null default 'tersedia',
  catatan        text,
  created_at     timestamptz not null default now()
);

-- ---------- PENYEWA ----------
create table if not exists tenants (
  id           uuid primary key default gen_random_uuid(),
  kode         text unique not null,                -- TEN-0001
  nama         text not null,
  hp           text,
  kamar_id     uuid references rooms(id) on delete set null,
  tgl_masuk    date not null,
  tgl_keluar   date,
  status       tenant_status not null default 'aktif',
  created_at   timestamptz not null default now()
);
create index if not exists idx_tenants_status on tenants(status);
create index if not exists idx_tenants_kamar on tenants(kamar_id);

-- ---------- TAGIHAN SEWA (sumber jatuh tempo) ----------
create table if not exists bills (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  periode     date not null,                        -- awal periode (tgl 1)
  jatuh_tempo date not null,
  jumlah      numeric(12,2) not null check (jumlah > 0),
  status      bill_status not null default 'belum_bayar',
  created_at  timestamptz not null default now(),
  unique (tenant_id, periode)
);
create index if not exists idx_bills_jatuh_tempo on bills(jatuh_tempo) where status <> 'lunas';

-- ---------- PEMBAYARAN SEWA ----------
create table if not exists payments (
  id           uuid primary key default gen_random_uuid(),
  nomor_struk  text unique not null,
  bill_id      uuid references bills(id) on delete set null,
  tenant_id    uuid references tenants(id) on delete set null,
  tgl_bayar    date not null default current_date,
  jumlah       numeric(12,2) not null check (jumlah > 0),
  keterangan   text,
  created_by   uuid references profiles(id),
  voided_at    timestamptz,                         -- soft delete, jejak audit
  created_at   timestamptz not null default now()
);
create index if not exists idx_payments_tgl on payments(tgl_bayar desc);

-- ---------- LEDGER OPERASIONAL ----------
create table if not exists ledger (
  id          uuid primary key default gen_random_uuid(),
  tanggal     date not null default current_date,
  jenis       ledger_type not null,
  kategori_id uuid references categories(id) on delete set null,
  kategori    text not null,                        -- snapshot nama kategori
  jumlah      numeric(12,2) not null check (jumlah > 0),
  keterangan  text,
  created_by  uuid references profiles(id),
  voided_at   timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists idx_ledger_tanggal on ledger(tanggal desc);

-- ---------- AUDIT LOG ----------
create table if not exists audit_log (
  id         bigserial primary key,
  actor      uuid references profiles(id),
  actor_name text,
  aksi       text not null,                         -- insert/update/delete/void
  tabel      text not null,
  row_id     text,
  data_lama  jsonb,
  data_baru  jsonb,
  created_at timestamptz not null default now()
);

-- =====================================================================
-- HELPER: cek role user login
-- =====================================================================
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin');
$$;

-- =====================================================================
-- Nomor dokumen otomatis: TEN-0001, STR-YYYYMMDD-001
-- =====================================================================
create sequence if not exists seq_tenant;
create or replace function next_tenant_code() returns text
language sql volatile as $$
  select 'TEN-' || lpad(nextval('seq_tenant')::text, 4, '0');
$$;

create or replace function next_receipt_no() returns text
language plpgsql volatile as $$
declare n int;
begin
  select count(*)+1 into n from payments where tgl_bayar = current_date;
  return 'STR-' || to_char(current_date, 'YYYYMMDD') || '-' || lpad(n::text, 3, '0');
end $$;

-- =====================================================================
-- TRIGGER: audit log otomatis untuk tabel transaksi
-- =====================================================================
create or replace function log_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare who jsonb; nm text;
begin
  select to_jsonb(p) - 'created_at' into who from profiles p where p.id = auth.uid();
  nm := coalesce(who->>'fullname', 'system');
  insert into audit_log(actor, actor_name, aksi, tabel, row_id, data_lama, data_baru)
  values (auth.uid(), nm, lower(tg_op),
          tg_table_name,
          coalesce((case when tg_op = 'DELETE' then old.id else new.id end)::text, ''),
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['public.payments','public.ledger','public.tenants','public.rooms','public.bills']
  loop
    execute format('drop trigger if exists trg_audit_%s on %s', split_part(t,'.',2), t);
    execute format('create trigger trg_audit_%s after insert or update or delete on %s for each row execute function log_audit()', split_part(t,'.',2), t);
  end loop;
end $$;

-- =====================================================================
-- ROLE: staff tidak boleh hapus apa pun; hanya admin bisa hapus
-- =====================================================================
revoke all on table audit_log from anon, authenticated;
grant select on table audit_log to authenticated;
revoke delete on table tenants, rooms, bills, payments, ledger, categories from anon, authenticated;

-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
alter table profiles   enable row level security;
alter table categories enable row level security;
alter table rooms      enable row level security;
alter table tenants    enable row level security;
alter table bills      enable row level security;
alter table payments   enable row level security;
alter table ledger     enable row level security;
alter table audit_log  enable row level security;

-- PROFILES: semua user login boleh baca (untuk nama), hanya admin boleh ubah
drop policy if exists p_profiles_read on profiles;
create policy p_profiles_read on profiles for select to authenticated using (true);
drop policy if exists p_profiles_self_update on profiles;
create policy p_profiles_self_update on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid() and role = (select role from profiles where id = auth.uid()));

-- Helper macro untuk tabel data: semua login baca; insert/update semua login; delete hanya admin
do $$
declare t text;
begin
  foreach t in array array['categories','rooms','tenants','bills','payments','ledger']
  loop
    execute format('drop policy if exists p_%1$s_select on %1$s', t);
    execute format('create policy p_%1$s_select on %1$s for select to authenticated using (true)', t);
    execute format('drop policy if exists p_%1$s_insert on %1$s', t);
    execute format('create policy p_%1$s_insert on %1$s for insert to authenticated with check (true)', t);
    execute format('drop policy if exists p_%1$s_update on %1$s', t);
    execute format('create policy p_%1$s_update on %1$s for update to authenticated using (true)', t);
    execute format('drop policy if exists p_%1$s_delete on %1$s', t);
    execute format('create policy p_%1$s_delete on %1$s for delete to authenticated using (is_admin())', t);
  end loop;
end $$;

-- AUDIT: hanya admin baca
drop policy if exists p_audit_read on audit_log;
create policy p_audit_read on audit_log for select to authenticated using (is_admin());

-- =====================================================================
-- VIEW: ringkasan dashboard (angka dihitung di DB, bukan di browser)
-- =====================================================================
create or replace view v_dashboard as
select
  (select count(*) from rooms)::int                                        as total_kamar,
  (select count(*) from rooms where status = 'terisi')::int                as kamar_terisi,
  (select count(*) from rooms where status = 'tersedia')::int              as kamar_tersedia,
  (select count(*) from tenants where status = 'aktif')::int               as penyewa_aktif,
  coalesce((select sum(jumlah) from payments where voided_at is null),0)   as total_sewa,
  coalesce((select sum(jumlah) from ledger where jenis='pendapatan' and voided_at is null),0) as total_pendapatan_ops,
  coalesce((select sum(jumlah) from ledger where jenis='pengeluaran' and voided_at is null),0) as total_pengeluaran,
  coalesce((select sum(jumlah) from bills where status <> 'lunas' and jatuh_tempo < current_date),0) as tunggakan;

create or replace view v_kas_bulanan as
select
  bulan,
  pendapatan_ops,
  pengeluaran_ops,
  coalesce((
    select sum(p.jumlah) from payments p
    where date_trunc('month', p.tgl_bayar)::date = bulan and p.voided_at is null
  ), 0) as pendapatan_sewa
from (
  select
    date_trunc('month', tanggal)::date                              as bulan,
    sum(case when jenis = 'pendapatan'  then jumlah else 0 end)     as pendapatan_ops,
    sum(case when jenis = 'pengeluaran' then jumlah else 0 end)     as pengeluaran_ops
  from ledger
  where voided_at is null
  group by 1
) x;

-- =====================================================================
-- SEED: kategori default
-- =====================================================================
insert into categories (jenis, nama, saldo_normal) values
  ('pengeluaran','Listrik & Air','Debet'),
  ('pengeluaran','Gaji Karyawan','Debet'),
  ('pengeluaran','Wifi & Internet','Debet'),
  ('pengeluaran','Perawatan Kamar','Debet'),
  ('pengeluaran','Kebersihan & Peralatan','Debet'),
  ('pengeluaran','Air Minum & Sembako','Debet'),
  ('pengeluaran','Pajak & Perizinan','Debet'),
  ('pengeluaran','Biaya Lain-lain','Debet'),
  ('pendapatan','Kantin / Vending Machine','Kredit'),
  ('pendapatan','Penjualan Barang Bekas','Kredit'),
  ('pendapatan','Deposit Hangus','Kredit'),
  ('pendapatan','Kemitraan Jasa Laundry','Kredit'),
  ('pendapatan','Pemasukan Lain-lain','Kredit'),
  ('neraca','Pembelian Aset Tetap','Debet'),
  ('neraca','Penyusutan Aset Tetap','Kredit'),
  ('neraca','Penerimaan Deposit Jaminan','Kredit'),
  ('neraca','Pengembalian Deposit Jaminan','Debet'),
  ('neraca','Setoran Modal Pemilik','Kredit'),
  ('neraca','Penarikan Prive Pemilik','Debet')
on conflict (jenis, nama) do nothing;
