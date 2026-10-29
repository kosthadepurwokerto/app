-- =====================================================================
-- Kost Hade — Skema D1 (SQLite)
-- Terapkan: wrangler d1 execute hadekost-db --local --file=db/schema.sql
--           wrangler d1 execute hadekost-db --remote --file=db/schema.sql
-- =====================================================================

-- ---------- DAFTAR KOST (MULTITENAN) ----------
-- Kunci kost = slug unik dari nama aplikasi dan menjadi pemisah semua data.
-- Dibuat sebelum `users` karena users.kost merujuk ke tabel ini.
create table if not exists kosts (
  kunci       text primary key,
  nama_app    text not null unique,
  kota        text,
  tagline     text,
  logo_kunci  text,
  logo_tipe   text,
  aktif       integer not null default 1,
  created_at  text not null default (datetime('now'))
);

-- ---------- AKUN ----------
create table if not exists users (
  id                  text primary key,
  username            text not null,          -- label akun; unik PER KOST (lihat indeks di bawah)
  fullname            text not null,
  role                text not null default 'staff' check (role in ('master','admin','staff')),
  kost                text not null default 'kost-hade' references kosts(kunci),  -- kost induk user ini
  hp                  text,                   -- No. HP untuk login (ternormalisasi 08xxx, unik)
  password_hash       text not null,          -- pbkdf2$iter$salt$hash
  aktif               integer not null default 1,
  must_change_password integer not null default 0,
  akses_diminta       integer not null default 0, -- 1 = wajib pilih kost saat login (lihat migrasi 016)
  created_at          text not null default (datetime('now'))
);

-- Username unik per kost: dua kost boleh sama-sama punya "admin". Yang membedakan
-- identitas login adalah No. HP (unik global) — atau nama kost pada kolom login.
create unique index if not exists idx_users_kost_username on users(kost, username);

-- No. HP dipakai sebagai identitas login: unik bila diisi (boleh kosong untuk akun lama).
create unique index if not exists idx_users_hp on users(hp) where hp is not null and hp <> '';
create index if not exists idx_users_hp_kost on users(hp, kost);

-- hanya SHA-256 dari token sesi yang disimpan
create table if not exists sessions (
  token_hash  text primary key,
  user_id     text not null references users(id) on delete cascade,
  expires_at  text not null,
  kost        text,                          -- kost aktif untuk sesi ini
  created_at  text not null default (datetime('now'))
);
create index if not exists idx_sessions_user on sessions(user_id);

-- ---------- MULTITENAN: AKSES USER KE KOST ----------
-- Tabel `kosts` sendiri didefinisikan di bagian atas file (sebelum `users`).
-- Akses user ke kost (satu akun boleh membuka beberapa kost).
create table if not exists akses_kost (
  user_id text not null references users(id) on delete cascade,
  kost    text not null references kosts(kunci) on delete cascade,
  primary key (user_id, kost)
);
insert or ignore into kosts (kunci, nama_app, kota, tagline)
  values ('kost-hade', 'Kost Hade', 'Purwokerto', 'Guesthouse Management Premium');

-- ---------- KATEGORI LEDGER ----------
create table if not exists categories (
  id           integer primary key autoincrement,
  jenis        text not null check (jenis in ('pendapatan','pengeluaran','neraca')),
  nama         text not null,
  saldo_normal text not null default 'Debet' check (saldo_normal in ('Debet','Kredit')),
  aktif        integer not null default 1,
  arus_kas     integer not null default 1,   -- 0 = non-cash (penyusutan) tidak menggerakkan kas
  kost         text not null default 'kost-hade'
);
create unique index if not exists idx_categories_kost_nama on categories(kost, jenis, nama);

-- ---------- KAMAR ----------
create table if not exists rooms (
  id            integer primary key autoincrement,
  no_kamar      text not null,
  tipe          text not null,
  harga_bulanan integer not null default 0 check (harga_bulanan >= 0),  -- rupiah, integer
  harga_harian  integer not null default 0 check (harga_harian >= 0),
  status        text not null default 'tersedia' check (status in ('tersedia','terisi','perbaikan')),
  catatan       text,
  kost          text not null default 'kost-hade',
  created_at    text not null default (datetime('now'))
);
create unique index if not exists idx_rooms_kost_no on rooms(kost, no_kamar);

-- ---------- PENYEWA (kolom tambahan untuk DB lama; di DB baru pernyataan ini gagal
-- dengan "duplicate column" dan aman diabaikan — lihat tools/uji-lokal.sh) ----------
create table if not exists tenants (
  id          integer primary key autoincrement,
  kode        text not null,
  nama        text not null,
  hp          text,
  kamar_id    integer references rooms(id) on delete set null,
  kontak_darurat text,                       -- nama kontak darurat
  hp_darurat     text,                       -- nomor HP kontak darurat
  ktp_key     text,                          -- kunci berkas foto KTP di R2 (bukan data base64)
  ktp_tipe    text,                          -- image/jpeg | image/png | image/webp
  sumber      text not null default 'manual', -- manual = diinput petugas, wa = dikirim penyewa via WhatsApp
  tgl_masuk   text not null,                 -- YYYY-MM-DD
  tgl_mulai_tagihan text,                    -- tanggal acuan jatuh tempo tagihan (null = sama dengan tgl_masuk)
  hari_penuh  integer not null default 1,    -- 0 = bulan pertama dihitung prorata per hari
  tgl_keluar  text,
  status      text not null default 'aktif' check (status in ('aktif','keluar')),
  kost        text not null default 'kost-hade',
  created_at  text not null default (datetime('now'))
);
-- percobaan login (anti tebak sandi): dihitung per nama pengguna + IP dalam 15 menit
create table if not exists login_percobaan (
  id         integer primary key autoincrement,
  username   text not null,
  ip         text not null default '-',
  berhasil   integer not null default 0,
  created_at text not null default (datetime('now'))
);
create index if not exists idx_login_percobaan on login_percobaan(username, ip, created_at);

-- counter nomor berurutan (kode penyewa tidak boleh dipakai ulang setelah dihapus)
create table if not exists counters (
  kost  text not null default 'kost-hade',
  nama  text not null,
  value integer not null default 0,
  primary key (kost, nama)
);
insert or ignore into counters (kost, nama, value) values ('kost-hade', 'kode_penyewa', 0);
create unique index if not exists idx_tenants_kost_kode on tenants(kost, kode);
create index if not exists idx_tenants_status on tenants(status);
create index if not exists idx_tenants_kamar  on tenants(kamar_id);

-- ---------- BERKAS FOTO KTP (mode cadangan, bila R2 belum tersedia) ----------
create table if not exists ktp_berkas (
  kunci      text primary key,
  tipe       text not null,
  ukuran     integer not null,
  isi        blob not null,
  created_at text not null default (datetime('now'))
);

-- ---------- TAGIHAN SEWA ----------
create table if not exists bills (
  id          integer primary key autoincrement,
  tenant_id   integer not null references tenants(id) on delete cascade,
  periode     text not null,                 -- YYYY-MM-01
  jatuh_tempo text not null,
  jumlah      integer not null check (jumlah > 0),
  status      text not null default 'belum_bayar' check (status in ('belum_bayar','lunas')),
  kost        text not null default 'kost-hade',
  created_at  text not null default (datetime('now')),
  unique (tenant_id, periode)
);
create index if not exists idx_bills_open on bills(tenant_id, status);

-- ---------- PENGINGAT WHATSAPP ----------
-- satu baris per tagihan yang sudah diingatkan (mencegah kiriman dobel)
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

-- ---------- PEMBAYARAN ----------
create table if not exists payments (
  id           integer primary key autoincrement,
  nomor_struk  text unique not null,
  bill_id      integer references bills(id) on delete set null,
  tenant_id    integer references tenants(id) on delete set null,
  tgl_bayar    text not null,
  jumlah       integer not null check (jumlah > 0),
  keterangan   text,
  created_by   text references users(id),
  voided_at    text,
  bulan        integer not null default 1,   -- jumlah bulan yang dibayar dalam satu struk
  bukti_key    text,                        -- berkas bukti bayar (foto/PDF) di R2 / D1
  periode_lunas text,                       -- "YYYY-MM,YYYY-MM" bulan yang dilunasi struk ini
  kost         text not null default 'kost-hade',
  created_at   text not null default (datetime('now'))
);
create index if not exists idx_payments_tgl on payments(tgl_bayar desc);

-- ---------- LEDGER OPERASIONAL ----------
create table if not exists ledger (
  id           integer primary key autoincrement,
  tanggal      text not null,
  jenis        text not null check (jenis in ('pendapatan','pengeluaran','neraca')),
  kategori_id  integer references categories(id) on delete set null,
  kategori     text not null,
  kost         text not null default 'kost-hade',
  jumlah       integer not null check (jumlah > 0),
  keterangan   text,
  created_by   text references users(id),
  voided_at    text,
  created_at   text not null default (datetime('now'))
);
create index if not exists idx_ledger_tanggal on ledger(tanggal desc);

-- ---------- AUDIT LOG ----------
create table if not exists audit_log (
  id         integer primary key autoincrement,
  actor      text,
  actor_name text,
  aksi       text not null,
  tabel      text not null,
  row_id     text,
  data_lama  text,
  data_baru  text,
  created_at text not null default (datetime('now'))
);
create index if not exists idx_audit_created on audit_log(created_at desc);

-- =====================================================================
-- TRIGGER AUDIT (otomatis, tidak bisa dilewati aplikasi)
-- =====================================================================
create trigger if not exists trg_audit_rooms_i  after insert on rooms begin
  insert into audit_log(aksi,tabel,row_id,data_baru) values('insert','rooms',new.id,json_object('no_kamar',new.no_kamar,'status',new.status));
end;
create trigger if not exists trg_audit_rooms_u  after update on rooms begin
  insert into audit_log(aksi,tabel,row_id,data_lama,data_baru) values('update','rooms',new.id,json_object('no_kamar',old.no_kamar,'status',old.status,'harga_bulanan',old.harga_bulanan),json_object('no_kamar',new.no_kamar,'status',new.status,'harga_bulanan',new.harga_bulanan));
end;
create trigger if not exists trg_audit_tenants_i after insert on tenants begin
  insert into audit_log(aksi,tabel,row_id,data_baru) values('insert','tenants',new.id,json_object('kode',new.kode,'nama',new.nama,'status',new.status));
end;
create trigger if not exists trg_audit_tenants_u after update on tenants begin
  insert into audit_log(aksi,tabel,row_id,data_lama,data_baru) values('update','tenants',new.id,json_object('nama',old.nama,'status',old.status,'kamar_id',old.kamar_id),json_object('nama',new.nama,'status',new.status,'kamar_id',new.kamar_id));
end;
create trigger if not exists trg_audit_bills_i   after insert on bills begin
  insert into audit_log(aksi,tabel,row_id,data_baru) values('insert','bills',new.id,json_object('tenant_id',new.tenant_id,'periode',new.periode,'jatuh_tempo',new.jatuh_tempo,'jumlah',new.jumlah));
end;
create trigger if not exists trg_audit_bills_u   after update on bills begin
  insert into audit_log(aksi,tabel,row_id,data_lama,data_baru) values('update','bills',new.id,json_object('status',old.status,'jatuh_tempo',old.jatuh_tempo),json_object('status',new.status,'jatuh_tempo',new.jatuh_tempo));
end;
create trigger if not exists trg_audit_payments_i after insert on payments begin
  insert into audit_log(aksi,tabel,row_id,data_baru) values('insert','payments',new.id,json_object('nomor_struk',new.nomor_struk,'jumlah',new.jumlah,'tgl_bayar',new.tgl_bayar,'tenant_id',new.tenant_id));
end;
create trigger if not exists trg_audit_payments_u after update on payments begin
  insert into audit_log(aksi,tabel,row_id,data_lama,data_baru) values('update','payments',new.id,json_object('voided_at',old.voided_at),json_object('voided_at',new.voided_at));
end;
create trigger if not exists trg_audit_ledger_i   after insert on ledger begin
  insert into audit_log(aksi,tabel,row_id,data_baru) values('insert','ledger',new.id,json_object('jenis',new.jenis,'kategori',new.kategori,'jumlah',new.jumlah,'tanggal',new.tanggal));
end;
create trigger if not exists trg_audit_ledger_u   after update on ledger begin
  insert into audit_log(aksi,tabel,row_id,data_lama,data_baru) values('update','ledger',new.id,json_object('voided_at',old.voided_at),json_object('voided_at',new.voided_at));
end;
create trigger if not exists trg_audit_users_u    after update on users begin
  insert into audit_log(aksi,tabel,row_id,data_lama,data_baru) values('update','users',new.id,json_object('role',old.role,'aktif',old.aktif,'fullname',old.fullname),json_object('role',new.role,'aktif',new.aktif,'fullname',new.fullname));
end;

-- =====================================================================
-- VIEW: ringkasan (dihitung di DB)
-- =====================================================================
drop view if exists v_dashboard;
create view v_dashboard as
select
  (select count(*) from rooms)                                   as total_kamar,
  (select count(*) from rooms where status='terisi')             as kamar_terisi,
  (select count(*) from rooms where status='tersedia')           as kamar_tersedia,
  (select count(*) from tenants where status='aktif')            as penyewa_aktif,
  -- pendapatan operasional = sewa + pendapatan lain-lain (di luar mutasi neraca)
  (select coalesce(sum(jumlah),0) from payments where voided_at is null)
    + (select coalesce(sum(jumlah),0) from ledger where jenis='pendapatan' and voided_at is null)   as total_pendapatan,
  (select coalesce(sum(jumlah),0) from ledger where jenis='pengeluaran' and voided_at is null)      as total_pengeluaran,
  -- saldo kas = uang yang benar-benar masuk/keluar, termasuk setoran modal, prive, deposit, beli aset.
  -- Penyusutan Aset Tetap tidak menggerakkan kas (non-cash), jadi tidak dihitung.
  (select coalesce(sum(jumlah),0) from payments where voided_at is null)
    + (select coalesce(sum(case when l.jenis='pendapatan' then l.jumlah
                               when l.jenis='pengeluaran' then -l.jumlah
                               when l.jenis='neraca' and coalesce(c.saldo_normal,'Debet')='Kredit' then l.jumlah
                               when l.jenis='neraca' then -l.jumlah
                               else 0 end),0)
        from ledger l left join categories c on c.id = l.kategori_id
       where l.voided_at is null and coalesce(c.arus_kas, 1) = 1)                                     as sisa_kas,
 -- mutasi neto dari transaksi neraca (modal masuk - prive - beli aset + deposit)
 (select coalesce(sum(case when coalesce(c.saldo_normal,'Debet')='Kredit' then l.jumlah else -l.jumlah end),0)
    from ledger l left join categories c on c.id = l.kategori_id
   where l.jenis='neraca' and l.voided_at is null and coalesce(c.arus_kas, 1) = 1)                    as modal_neraca,
  -- pendapatan bulan berjalan (lokal, bukan UTC)
  (select coalesce(sum(jumlah),0) from payments where voided_at is null and tgl_bayar >= date('now','localtime','start of month')) as pendapatan_bulan_ini,
  -- tunggakan: SEMUA tagihan lewat jatuh tempo, termasuk penyewa yang sudah check-out
  -- (uang yang masih terutang tidak boleh hilang dari laporan hanya karena status penyewa berubah)
  (select coalesce(sum(jumlah),0) from bills
     where status='belum_bayar' and jatuh_tempo < date('now','localtime'))                          as tunggakan;

-- Tandai penyusutan sebagai non-cash: definisi arus kas TIDAK ditentukan nama kategori
-- di kode, melainkan kolom ini — kategori baru dari UI otomatis ikut benar.
update categories set arus_kas = 0 where jenis = 'neraca' and nama = 'Penyusutan Aset Tetap';

-- =====================================================================
-- SEED: kategori default
-- =====================================================================
insert or ignore into categories (jenis, nama, saldo_normal) values
  ('pengeluaran','Listrik & Air','Debet'),
  ('pengeluaran','Gaji Karyawan','Debet'),
  ('pengeluaran','Wifi & Internet','Debet'),
  ('pengeluaran','Perawatan Kamar (Maintenance)','Debet'),
  ('pengeluaran','Kebersihan & Peralatan','Debet'),
  ('pengeluaran','Air Minum & Sembako','Debet'),
  ('pengeluaran','Pajak & Perizinan','Debet'),
  ('pengeluaran','Biaya Lain-lain','Debet'),
  ('pendapatan','Kantin / Vending Machine','Kredit'),
  ('pendapatan','Penjualan Barang Bekas','Kredit'),
  ('pendapatan','Deposit Hangus','Kredit'),
  ('pendapatan','Kemitraan Jasa Laundry','Kredit'),
  ('pendapatan','Pemasukan Lain-lain','Kredit'),
  ('neraca','Pembelian Aset Tetap','Debet'),
  ('neraca','Penyusutan Aset Tetap','Kredit'),
  ('neraca','Penerimaan Deposit Jaminan','Kredit'),
  ('neraca','Pengembalian Deposit Jaminan','Debet'),
  ('neraca','Setoran Modal Pemilik','Kredit'),
  ('neraca','Penarikan Prive Pemilik','Debet');

-- ---------- INDEX TAMBAHAN (kuota baca) ----------
-- Query dashboard/ops selalu menyaring voided_at is null; index parsial membuat D1
-- tidak perlu memindai seluruh tabel pembayaran/ledger saat menghitung kas.
create index if not exists idx_payments_aktif on payments(tgl_bayar) where voided_at is null;
create index if not exists idx_ledger_aktif   on ledger(tanggal)   where voided_at is null;
create index if not exists idx_bills_status   on bills(status, jatuh_tempo);
