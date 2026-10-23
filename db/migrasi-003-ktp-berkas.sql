-- Tabel cadangan penyimpanan foto KTP bila bucket R2 belum tersedia (KTP_MODE = 'd1').
-- Jalankan sekali: wrangler d1 execute hadekost-db --remote --file=db/migrasi-003-ktp-berkas.sql
create table if not exists ktp_berkas (
  kunci      text primary key,
  tipe       text not null,
  ukuran     integer not null,
  isi        blob not null,
  created_at text not null default (datetime('now'))
);
