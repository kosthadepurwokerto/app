-- Pembatas percobaan login (anti tebak sandi).
create table if not exists login_percobaan (
  id         integer primary key autoincrement,
  username   text not null,
  ip         text not null default '-',
  berhasil   integer not null default 0,
  created_at text not null default (datetime('now'))
);
create index if not exists idx_login_percobaan on login_percobaan(username, ip, created_at);
