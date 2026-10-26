# Login Tanpa "Nama Kost" — hasil kerja

Cara masuk yang sekarang (dan kenapa):
petugas **tidak perlu** memilih/mengetik nama kost. Satu alamat server melayani semua kost.

## Yang berubah

| Fitur | Cara pakai |
|---|---|
| **Kolom "Kode/Nama Aplikasi" disembunyikan** | Langsung isi Email/Username + sandi. Server tahu kost pemilik akun. |
| **Login pakai email** | `admin@kosthade.local` atau `admin` — dua-duanya diterima untuk akun `admin`. |
| **Ingat saya (default tercentang)** | Sesi 90 hari; sesi disimpan di perangkat, jadi aplikasi langsung terbuka. |
| **Tautan khusus kost** | `https://hadekost.244.my.id/?kost=kost-melati` → kolom kode terisi otomatis (untuk kost kedua/berikutnya). |
| **APK satu untuk semua kost** | Alamat server bisa diganti di HP: ketuk dan **tahan** layar galat → isi alamat baru. |

## Aturan yang dipegang

- `username` tetap **unik di seluruh server**, sehingga tanpa nama kost pun tidak ada ambigu.
- Bila satu akun terdaftar di **beberapa kost**, server mengembalikan `perluPilihKost` dan
  aplikasi menampilkan modal "Pilih Kost" — hanya di kasus itu, dan cukup sekali.
- Master tetap bisa membuka semua kost dari menu **Kost** (tidak perlu memilih saat login).
- Login via email memakai format `depan@domain`; kalau akun dengan email itu tidak ada,
  sistem mencoba bagian sebelum `@` (username klasik). Akun lama tetap berfungsi.

## Tautan cepat per kost

```
https://hadekost.244.my.id/            -> login biasa (tanpa mengetik kost)
https://hadekost.244.my.id/?kost=kost-hade
https://hadekost.244.my.id/?kost=kost-lain
```

## Uji

- `bash tools/uji-lokal.sh` → 172 pemeriksaan LULUS
- `bash tools/uji-multitenan.sh` → 40 pemeriksaan LULUS
- Produksi: login tanpa kost 200, login via email 200, `ingat:true` → sesi 90 hari
  (cookie `Max-Age=7776000`), master tanpa kost langsung masuk.
