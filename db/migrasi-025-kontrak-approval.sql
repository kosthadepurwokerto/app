-- Tahap 1: kontrak sewa, status verifikasi pembayaran, dan jejak approval.
-- Jalankan satu kali pada database lama setelah backup.

create table if not exists contracts (
  id            integer primary key autoincrement,
  nomor         text not null,
  tenant_id     integer not null references tenants(id) on delete restrict,
  kamar_id      integer references rooms(id) on delete restrict,
  mulai         text not null,
  berakhir      text not null,
  harga         integer not null check (harga > 0),
  deposit       integer not null default 0 check (deposit >= 0),
  status        text not null default 'aktif' check (status in ('akan_dimulai','aktif','akan_berakhir','berakhir','dibatalkan')),
  catatan       text,
  kost          text not null default 'kost-hade',
  created_by    text references users(id),
  created_at    text not null default (datetime('now')),
  unique (kost, nomor)
);
create index if not exists idx_contracts_tenant on contracts(kost, tenant_id, mulai desc);
create index if not exists idx_contracts_expiry on contracts(kost, berakhir, status);

-- Pembayaran lama dianggap sudah disahkan agar migrasi tidak mengubah saldo berjalan.
alter table payments add column approval_status text not null default 'approved';
alter table payments add column approved_by text references users(id);
alter table payments add column approved_at text;
alter table payments add column rejection_reason text;
create index if not exists idx_payments_approval on payments(kost, approval_status, created_at);

create table if not exists payment_reviews (
  id            integer primary key autoincrement,
  payment_id    integer not null references payments(id) on delete cascade,
  status_lama   text not null,
  status_baru   text not null check (status_baru in ('pending','approved','rejected')),
  alasan        text,
  reviewed_by   text not null references users(id),
  created_at    text not null default (datetime('now'))
);
create index if not exists idx_payment_reviews_payment on payment_reviews(payment_id, created_at desc);

create table if not exists document_templates (
  id            integer primary key autoincrement,
  jenis         text not null,
  nama          text not null,
  aktif         integer not null default 1,
  kost          text not null default 'kost-hade',
  created_at    text not null default (datetime('now')),
  unique (kost, jenis)
);
insert or ignore into document_templates (jenis, nama, kost) values
 ('perjanjian-sewa','Perjanjian Sewa Kamar','kost-hade'),
 ('tagihan-sewa','Tagihan Sewa','kost-hade'),
 ('surat-tunggakan','Surat Tunggakan','kost-hade'),
 ('kuitansi-pembayaran','Kuitansi Pembayaran','kost-hade'),
 ('berita-acara-checkout','Berita Acara Check-out','kost-hade'),
 ('pengembalian-deposit','Bukti Pengembalian Deposit','kost-hade');
