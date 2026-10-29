-- =====================================================================
-- Audit log per kost.
-- Tabel audit_log sengaja tidak dibungkus db-kost (ditulis ke env.DB mentah),
-- sehingga tanpa kolom `kost` semua kost berbagi satu jejak aktivitas:
-- admin kost A bisa membaca aktivitas kost B.
-- Terapkan: wrangler d1 execute hadekost-db --local|--remote --file=db/migrasi-018-audit-kost.sql
-- =====================================================================
alter table audit_log add column kost text;
create index if not exists idx_audit_kost_created on audit_log(kost, created_at desc);

-- Isi baris lama dari aktor bila username-nya unik per kost (idx_users_kost_username).
update audit_log set kost = (
  select u.kost from users u where u.username = audit_log.actor_name
) where kost is null and actor_name is not null;
