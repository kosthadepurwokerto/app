-- Kolom bukti bayar pada pembayaran (kunci berkas foto/PDF).
-- Jalankan sekali pada database yang sudah ada.
alter table payments add column bukti_key text;
