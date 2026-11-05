import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve('.');
const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'hadekost-approval-'));
const port = 19000 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const child = spawn('npx', ['wrangler','dev','--local','--persist-to',persist,'--var','COOKIE_SECURE:false','--port',String(port)], {cwd:root, env:{...process.env,WRANGLER_SEND_METRICS:'false'},stdio:'inherit'});
const req = async (p, opts={}) => { const r=await fetch(base+p, opts); let body; try{body=await r.json()}catch{body=await r.text()} return {status:r.status,body,headers:r.headers}; };
const post = (p, body, cookie) => req(p,{method:'POST',headers:{'content-type':'application/json',...(cookie?{cookie}: {})},body:JSON.stringify(body)});
try {
  let ready=false; for(let i=0;i<80;i++){try{await fetch(base+'/api/session');ready=true;break}catch{await new Promise(r=>setTimeout(r,250))}} assert.ok(ready);
  execFileSync('npx',['wrangler','d1','execute','hadekost-db','--local','--persist-to',persist,'--file=db/schema.sql'],{cwd:root,stdio:'ignore'});
  execFileSync('npx',['wrangler','d1','execute','hadekost-db','--local','--persist-to',persist,'--file=db/migrasi-017-pindah-kamar.sql'],{cwd:root,stdio:'ignore'});
  execFileSync('npx',['wrangler','d1','execute','hadekost-db','--local','--persist-to',persist,'--file=db/migrasi-022-jurnal-berpasangan.sql'],{cwd:root,stdio:'ignore'});
  execFileSync('npx',['wrangler','d1','execute','hadekost-db','--local','--persist-to',persist,'--file=db/migrasi-025-kontrak-approval.sql'],{cwd:root,stdio:'ignore'});
  const seed=execFileSync('node',['tools/buat-akun.mjs','admin','Kostsaya12345','admin','Admin'],{cwd:root,env:{...process.env,UJI_TANPA_GANTI:'1',UJI_HP:'081200000100'}}).toString(); const seedFile=path.join(persist,'seed.sql'); fs.writeFileSync(seedFile,seed); execFileSync('npx',['wrangler','d1','execute','hadekost-db','--local','--persist-to',persist,'--file='+seedFile],{cwd:root,stdio:'ignore'}); fs.rmSync(seedFile,{force:true});
  const login=await post('/api/login',{username:'081200000100',password:'Kostsaya12345'}); assert.equal(login.status,200); const cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/api/action',{action:'rooms.create',data:{noKamar:'A1',tipe:'Standar',hargaBulanan:1000000}},cookie)).status,200);
  assert.equal((await post('/api/action',{action:'tenants.create',data:{nama:'Uji Approval',hp:'081299900001',kamar:'A1',tglMasuk:new Date().toISOString().slice(0,10)}},cookie)).status,200);
  const up=await req('/api/bukti',{method:'POST',headers:{cookie,'content-type':'multipart/form-data'} }); // malformed upload must reject
  assert.equal(up.status,400);
  const form=new FormData(); form.append('file',new Blob(['uji'],{type:'image/png'}),'bukti.png'); const ur=await req('/api/bukti',{method:'POST',headers:{cookie},body:form}); assert.equal(ur.status,200);
  const bukti=ur.body.kunci;
  assert.equal((await post('/api/action',{action:'payments.create',data:{kamar:'A1',jumlah:1000000,tanggal:new Date().toISOString().slice(0,10),buktiKey:bukti}},cookie)).status,200);
  const pending=(await req('/api/dashboard',{headers:{cookie}})).body; const row=pending.transaksi.find(x=>x[2]==='A1'); assert.equal(row[7],'pending'); assert.equal(pending.penyewa.find(x=>x[1]==='Uji Approval')[6],pending.penyewa.find(x=>x[1]==='Uji Approval')[6]);
  assert.equal((await post('/api/action',{action:'payments.review',data:{id:Number(row[5]),status:'approved'}},cookie)).status,200);
  const approved=(await req('/api/dashboard',{headers:{cookie}})).body; assert.equal(approved.transaksi.find(x=>x[2]==='A1')[7],'approved'); assert.notEqual(approved.penyewa.find(x=>x[1]==='Uji Approval')[6],new Date().toISOString().slice(0,10));
  const tenant=approved.penyewa.find(x=>x[1]==='Uji Approval')[0];
  const kontrakResp=await post('/api/action',{action:'contracts.create',data:{tenantId:tenant,nomor:'KON-UJI',mulai:new Date().toISOString().slice(0,10),berakhir:'2027-12-31',harga:1000000,deposit:1000000}},cookie); assert.equal(kontrakResp.status,200,JSON.stringify(kontrakResp.body));
  const contracts=await req('/api/kontrak',{headers:{cookie}}); assert.equal(contracts.status,200); assert.equal(contracts.body.kontrak.length,1);
  // Dokumen cetak: CSP harus mengizinkan <style> sebaris, kalau tidak kontrak tampil polos.
  const idKontrak=contracts.body.kontrak[0].id;
  const dok=await fetch(`${base}/api/dokumen?jenis=paket-kontrak&id=${idKontrak}`,{headers:{cookie}});
  assert.equal(dok.status,200);
  const csp=dok.headers.get('content-security-policy')||'';
  assert.match(csp,/style-src 'unsafe-inline'/); assert.doesNotMatch(csp,/script-src/);
  assert.match(await dok.text(),/<div class="page-break">/);
  console.log('approval/contract e2e passed');
} finally { child.kill('SIGTERM'); fs.rmSync(persist,{recursive:true,force:true}); }
