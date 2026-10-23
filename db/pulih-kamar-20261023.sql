-- Pulihkan kamar yang terhapus oleh pembersihan data uji (lihat audit_log 2026-10-23 03:12-03:21).
-- Nilai diambil dari audit_log aksi='room.create' + aksi='room.update' (kamar 104 sempat diubah
-- menjadi Deluxe Rp 1.250.000). Kamar uji (901, ZA1, ZZ1) TIDAK dipulihkan.
insert or ignore into rooms (no_kamar, tipe, harga_bulanan, harga_harian, status) values
  ('101', 'Standar', 1100000, 100000, 'tersedia'),
  ('102', 'Standar', 1100000, 100000, 'tersedia'),
  ('103', 'Standar', 1100000, 100000, 'tersedia'),
  ('104', 'Deluxe',  1250000, 100000, 'tersedia'),
  ('105', 'Standar', 1100000, 100000, 'tersedia'),
  ('106', 'standar', 1100000, 100000, 'tersedia'),
  ('107', 'Deluxe',  1250000, 100000, 'tersedia'),
  ('108', 'Standar', 1100000, 100000, 'tersedia'),
  ('109', 'Standar', 1100000, 100000, 'tersedia'),
  ('110', 'Standar', 1100000, 100000, 'tersedia');
