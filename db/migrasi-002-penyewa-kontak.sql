-- Migrasi untuk database yang SUDAH berjalan (produksi).
-- Kolom baru penyewa: kontak darurat + foto KTP (disimpan di R2, DB hanya menyimpan kunci).
-- Jalankan sekali:  wrangler d1 execute hadekost-db --remote --file=db/migrasi-002-penyewa-kontak.sql
-- Bila kolom sudah ada, D1 menolak pernyataan itu ("duplicate column name") — aman diabaikan.
alter table tenants add column kontak_darurat text;
alter table tenants add column hp_darurat text;
alter table tenants add column ktp_key text;
alter table tenants add column ktp_tipe text;
