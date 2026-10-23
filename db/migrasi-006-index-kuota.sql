-- Index parsial untuk query kas/pengingat (hemat kuota baca D1).
create index if not exists idx_payments_aktif on payments(tgl_bayar) where voided_at is null;
create index if not exists idx_ledger_aktif   on ledger(tanggal)   where voided_at is null;
create index if not exists idx_bills_status   on bills(status, jatuh_tempo);
