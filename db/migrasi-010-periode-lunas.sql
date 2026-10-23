-- Daftar periode yang dilunasi satu struk (bayar N bulan), dipakai void agar membuka bulan yang tepat.
alter table payments add column periode_lunas text;
