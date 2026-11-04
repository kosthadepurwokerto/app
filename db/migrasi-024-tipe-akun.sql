-- Klasifikasi akun eksplisit untuk laporan berbasis double-entry.
-- Jalankan sekali pada database lama; database baru perlu kolom ini di schema.sql.
alter table categories add column tipe_akun text not null default 'expense'
  check (tipe_akun in ('asset','liability','equity','revenue','expense'));

update categories set tipe_akun='revenue' where jenis='pendapatan';
update categories set tipe_akun='expense' where jenis='pengeluaran';
update categories set tipe_akun='asset' where jenis='neraca' and nama like '%Aset%';
update categories set tipe_akun='asset' where jenis='neraca' and nama like '%Pembelian%';
update categories set tipe_akun='liability' where jenis='neraca' and nama like '%Deposit%';
update categories set tipe_akun='liability' where jenis='neraca' and nama like '%Jaminan%';
update categories set tipe_akun='equity' where jenis='neraca' and (nama like '%Modal%' or nama like '%Prive%' or nama like '%Penarikan%');
update categories set tipe_akun='asset' where jenis='neraca' and (nama like '%Penyusutan%' or nama like '%Depresiasi%');

create index if not exists idx_categories_kost_tipe on categories(kost, tipe_akun, aktif);
