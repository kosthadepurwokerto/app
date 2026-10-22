// Buat akun: node tools/buat-akun.mjs <username> <password> [admin|staff] [nama]
// Mencetak satu INSERT untuk users (hash PBKDF2) — tempel ke wrangler d1 execute.
const ITER = 100000;
const b64 = (buf) => Buffer.from(buf).toString('base64');

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, key, 256);
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(bits)}`;
}

const [rawUser, password, rawRole = 'admin', fullname] = process.argv.slice(2);
if (!rawUser || !password) {
  console.error('Pakai: node tools/buat-akun.mjs <username> <password> [admin|staff] [nama lengkap]');
  process.exit(1);
}
const username = String(rawUser).trim().toLowerCase();
const role = String(rawRole).trim().toLowerCase();
if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
  console.error('Username 3-32 karakter: huruf kecil, angka, titik, garis bawah, atau strip.');
  process.exit(1);
}
if (!['admin', 'staff'].includes(role)) {
  console.error('Role harus admin atau staff.');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password minimal 8 karakter.');
  process.exit(1);
}
const id = 'usr_' + crypto.randomUUID().slice(0, 8);
const hash = await hashPassword(password);
const nama = (fullname || username).trim().replace(/'/g, "''");
const sql = `insert into users (id, username, fullname, role, password_hash, aktif) values ('${id}', '${username.toLowerCase()}', '${nama}', '${role}', '${hash}', 1);`;
console.log(sql);
