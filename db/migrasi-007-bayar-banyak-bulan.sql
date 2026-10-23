-- Kolom jumlah bulan pada pembayaran (bayar N bulan sekaligus).
-- Jalankan sekali pada database yang sudah ada.
alter table payments add column bulan integer not null default 1;
