// Buat akun: node tools/buat-akun.mjs <username> <password> [master|admin|staff] [nama] [kunci-kost]
// Mencetak satu INSERT untuk users (hash PBKDF2) — tempel ke wrangler d1 execute.
const ITER = 100000;
const b64 = (buf) => Buffer.from(buf).toString('base64');

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, key, 256);
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(bits)}`;
}

const [rawUser, password, rawRole = 'admin', fullname, rawKost = 'kost-hade'] = process.argv.slice(2);
if (!rawUser || !password) {
  console.error('Pakai: node tools/buat-akun.mjs <username> <password> [master|admin|staff] [nama lengkap] [kunci-kost]');
  process.exit(1);
}
const username = String(rawUser).trim().toLowerCase();
const role = String(rawRole).trim().toLowerCase();
if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
  console.error('Username 3-32 karakter: huruf kecil, angka, titik, garis bawah, atau strip.');
  process.exit(1);
}
if (!['master', 'admin', 'staff'].includes(role)) {
  console.error('Role harus master, admin, atau staff.');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password minimal 8 karakter.');
  process.exit(1);
}
const id = 'usr_' + crypto.randomUUID().slice(0, 8);
const hash = await hashPassword(password);
const nama = (fullname || username).trim().replace(/'/g, "''");
const kost = String(rawKost || 'kost-hade').trim().toLowerCase();
// Akun baru wajib mengganti password saat login pertama (must_change_password = 1),
// kecuali akun yang memang dibuat untuk pengujian otomatis (UJI_TANPA_GANTI=1).
const wajibGanti = process.env.UJI_TANPA_GANTI === '1' ? 0 : 1;
const barisUser = `insert into users (id, username, fullname, role, password_hash, aktif, must_change_password, kost) values ('${id}', '${username.toLowerCase()}', '${nama}', '${role}', '${hash}', 1, ${wajibGanti}, '${kost}');`;
// Akun harus punya akses ke kost-nya (dipakai login untuk memilih kost).
const barisAkses = `insert or ignore into akses_kost (user_id, kost) values ('${id}', '${kost}');`;
console.log(barisUser);
console.log(barisAkses);
