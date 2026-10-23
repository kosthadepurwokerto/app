-- Tanggal mulai tagihan & penanda bulan penuh (menentukan jatuh tempo & prorata bulan pertama).
-- Jalankan sekali pada database yang sudah ada.
alter table tenants add column tgl_mulai_tagihan text;
alter table tenants add column hari_penuh integer not null default 1;
