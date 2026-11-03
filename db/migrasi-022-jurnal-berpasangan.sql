-- Jalankan sekali pada database yang sudah ada:
create table if not exists journal_entries (
  id integer primary key autoincrement,
  tanggal text not null,
  sumber text not null,
  source_ref text not null,
  keterangan text,
  created_by text references users(id),
  voided_at text,
  kost text not null default 'kost-hade',
  created_at text not null default (datetime('now')),
  unique (kost, sumber, source_ref)
);
create table if not exists journal_lines (
  id integer primary key autoincrement,
  journal_id integer not null references journal_entries(id) on delete cascade,
  akun_kode text not null,
  akun_nama text not null,
  debet integer not null default 0 check (debet >= 0),
  kredit integer not null default 0 check (kredit >= 0),
  kost text not null default 'kost-hade',
  check ((debet > 0 and kredit = 0) or (kredit > 0 and debet = 0))
);
create index if not exists idx_journal_entries_tanggal on journal_entries(tanggal desc);
create index if not exists idx_journal_lines_journal on journal_lines(journal_id);