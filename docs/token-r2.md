# Token Cloudflare khusus R2 (untuk audit bucket)

Token di `~/.cf_token` hanya punya izin Workers/D1 — tidak bisa melihat daftar bucket R2
(`GET /r2/buckets` → 403 / error 10000). Akibatnya kegagalan audit bucket pernah salah
dibaca sebagai "bucket belum ada". Token terpisah di bawah menutup celah itu.

## Langkah di dashboard (dilakukan pemilik akun)

1. Buka <https://dash.cloudflare.com/profile/api-tokens> → **Create Token**.
2. Pilih **Create Custom Token**.
3. Name: `hadekost-r2-audit`
4. Permissions (tambah satu baris saja):
   - **Account** → **Workers R2 Storage** → **Edit**
5. Account Resources: `Include` → akun `Colekdek244@gmail.com's Account`.
   (Zone Resources: biarkan kosong.)
6. TTL: sisakan kosong (tidak kedaluwarsa) atau isi sesuai kebijakan Anda.
7. **Continue to summary** → **Create Token** → salin nilainya **sekali saja**.

## Memasang di server

Simpan ke berkas terpisah agar tidak menimpa token utama:

```bash
printf '%s' 'TOKEN_BARU' > ~/.cf_token_r2
chmod 600 ~/.cf_token_r2
```

Verifikasi (harus menampilkan daftar bucket, termasuk `hadekost-ktp`):

```bash
T=$(cat ~/.cf_token_r2)
curl -s "https://api.cloudflare.com/client/v4/accounts/06ff890e3d08aeac6c12f44a82a6cac1/r2/buckets" \
  -H "Authorization: Bearer $T"
```

## Catatan

- Jangan mengganti isi `~/.cf_token`. Deploy Worker memakai token lama; menimpanya
  berisiko memutus alur deploy.
- Izin **Edit** dipilih (bukan **Read**) supaya objek bisa diperiksa/diunggah saat
  diagnosis; kalau hanya ingin audit daftar bucket, **Read** sudah cukup.
- Token ini tidak dipakai oleh aplikasi — hanya untuk audit dari server.
