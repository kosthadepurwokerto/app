-- Migrasi dasar untuk database lama (sebelum kolom-kolom ini ada di schema.sql).
-- Aman dijalankan pada DB baru? TIDAK — D1 menolak "duplicate column". Jalankan hanya sekali pada DB lama.
alter table users add column push_terkirim integer not null default 0;
alter table categories add column arus_kas integer not null default 1;
