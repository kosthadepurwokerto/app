/** Tailwind untuk UI Kost Hade — di-build ke pub/tailwind.css saat `npm run ui`.
 *  Dulu halaman memakai https://cdn.tailwindcss.com (butuh internet + lambat di HP);
 *  sekarang CSS-nya disajikan sendiri oleh Worker, jadi aplikasi tetap rapi walau
 *  sambungan lambat atau CDN diblokir.
 */
module.exports = {
  content: ['./pub/app.html'],
  theme: { extend: {} },
  corePlugins: { preflight: true },
  plugins: [],
};
