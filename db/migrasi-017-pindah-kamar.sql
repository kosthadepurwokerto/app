-- 017: riwayat kamar per penyewa (pindah kamar).
-- tenant_kamar menyimpan kontrak sewa per kamar: mulai..sampai. sampai null = kontrak berjalan.
-- tenants.kamar_id tetap jadi kamar yang berlaku HARI INI (dipakai UI & tagihan),
-- sedangkan baris bertanggal depan di sini adalah pindah kamar yang dijadwalkan.
create table if not exists tenant_kamar (
  id         integer primary key autoincrement,
  tenant_id  integer not null references tenants(id) on delete cascade,
  kamar_id   integer not null references rooms(id),
  mulai      text not null,
  sampai     text,
  created_by integer,
  created_at text not null default (datetime('now'))
);

create index if not exists idx_tenant_kamar_tenant on tenant_kamar(tenant_id, mulai);
create index if not exists idx_tenant_kamar_kamar on tenant_kamar(kamar_id, mulai);

-- isi kontrak berjalan untuk penyewa aktif yang belum punya riwayat
insert into tenant_kamar (tenant_id, kamar_id, mulai, sampai)
select t.id, t.kamar_id, coalesce(nullif(t.tgl_masuk,''), date('now')), null
  from tenants t
 where t.status = 'aktif'
   and t.kamar_id is not null
   and not exists (select 1 from tenant_kamar k where k.tenant_id = t.id);
