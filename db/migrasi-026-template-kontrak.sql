-- Tahap 2: teks template dokumen yang bisa disunting dari menu Kontrak.
-- Jalankan satu kali setelah backup; kolom `isi` tidak bisa ditambah dua kali.
alter table document_templates add column isi text;
