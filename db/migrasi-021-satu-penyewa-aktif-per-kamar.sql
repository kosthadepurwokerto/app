-- 021: satu kamar tidak boleh memiliki lebih dari satu penyewa aktif.
-- Preflight ini menampilkan duplikat lama; jangan memperbaikinya otomatis.
select kamar_id, count(*) as penyewa_aktif
  from tenants
 where status='aktif' and kamar_id is not null
 group by kamar_id having count(*) > 1;
-- CREATE UNIQUE INDEX sengaja fail-closed bila duplikat masih ada: migrasi/deploy berhenti
-- dan invariant tidak dianggap aktif sebelum data diperbaiki secara eksplisit.
create unique index if not exists idx_tenants_one_active_room
  on tenants(kamar_id) where status='aktif' and kamar_id is not null;
