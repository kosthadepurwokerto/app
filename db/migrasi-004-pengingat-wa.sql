-- Catat pengingat WhatsApp yang sudah dikirim per tagihan (mencegah kirim dobel).
create table if not exists pengingat_wa (
  id          integer primary key autoincrement,
  bill_id     integer not null references bills(id) on delete cascade,
  tenant_id   integer not null references tenants(id) on delete cascade,
  hp          text,
  dikirim_oleh text references users(id),
  created_at  text not null default (datetime('now')),
  unique (bill_id)
);
create index if not exists idx_pengingat_tanggal on pengingat_wa(created_at);
