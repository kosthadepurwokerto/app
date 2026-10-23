-- Tabel counter untuk nomor berurutan (kode penyewa tidak dipakai ulang setelah dihapus).
create table if not exists counters (nama text primary key, value integer not null default 0);
-- isi awal dari data yang ada (hanya bila belum ada barisnya; INSERT OR IGNORE, bukan ON CONFLICT)
insert or ignore into counters (nama, value)
  select 'kode_penyewa', coalesce(max(cast(substr(kode,5) as integer)),0) from tenants;
