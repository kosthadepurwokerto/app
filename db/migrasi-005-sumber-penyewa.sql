-- Asal data penyewa: 'manual' (diinput petugas) atau 'wa' (dikirim penyewa lewat WhatsApp)
alter table tenants add column sumber text not null default 'manual';
