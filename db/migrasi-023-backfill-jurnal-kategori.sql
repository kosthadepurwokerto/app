-- Backfill idempoten: pembayaran lama dan Ledger aktif menjadi jurnal berpasangan.
-- Tidak menyentuh transaksi void; aman dijalankan ulang.

insert or ignore into journal_entries (tanggal, sumber, source_ref, keterangan, created_by, kost)
select p.tgl_bayar, 'pembayaran', p.nomor_struk,
       coalesce(nullif(p.keterangan,''), 'Pembayaran sewa'), p.created_by, p.kost
  from payments p
 where p.voided_at is null;

insert or ignore into journal_lines (journal_id, akun_kode, akun_nama, debet, kredit, kost)
select e.id, '1000', 'Kas/Bank', p.jumlah, 0, p.kost
  from payments p join journal_entries e on e.sumber='pembayaran' and e.source_ref=p.nomor_struk and e.kost=p.kost
 where p.voided_at is null
   and not exists (select 1 from journal_lines l where l.journal_id=e.id);

insert or ignore into journal_lines (journal_id, akun_kode, akun_nama, debet, kredit, kost)
select e.id, '4100', 'Pendapatan Sewa', 0, p.jumlah, p.kost
  from payments p join journal_entries e on e.sumber='pembayaran' and e.source_ref=p.nomor_struk and e.kost=p.kost
 where p.voided_at is null
   and exists (select 1 from journal_lines l where l.journal_id=e.id and l.akun_kode='1000')
   and not exists (select 1 from journal_lines l where l.journal_id=e.id and l.akun_kode='4100');

insert or ignore into journal_entries (tanggal, sumber, source_ref, keterangan, created_by, kost)
select l.tanggal, 'ledger', 'ledger:' || l.id,
       coalesce(nullif(l.keterangan,''), l.kategori), l.created_by, l.kost
  from ledger l
 where l.voided_at is null;

insert or ignore into journal_lines (journal_id, akun_kode, akun_nama, debet, kredit, kost)
select e.id,
       case when lower(l.kategori) like '%penyusutan%' or lower(l.kategori) like '%depresiasi%' then '6100'
            when l.jenis='pendapatan' then '1000'
            when l.jenis='pengeluaran' then '5xxx'
            when lower(l.kategori) like '%deposit%' or lower(l.kategori) like '%jaminan%' then
              case when lower(l.kategori) like '%pengembalian%' then '2100' else '1000' end
            when lower(l.kategori) like '%modal%' or lower(l.kategori) like '%setoran%' then '1000'
            when lower(l.kategori) like '%prive%' or lower(l.kategori) like '%penarikan%' then '3100'
            when lower(l.kategori) like '%aset%' or lower(l.kategori) like '%pembelian%' then '1500'
            else case when c.saldo_normal='Kredit' then '1000' else '5900' end end,
       case when lower(l.kategori) like '%penyusutan%' or lower(l.kategori) like '%depresiasi%' then 'Beban Penyusutan'
            when l.jenis='pendapatan' then 'Kas/Bank'
            when l.jenis='pengeluaran' then 'Beban — ' || l.kategori
            when lower(l.kategori) like '%deposit%' or lower(l.kategori) like '%jaminan%' then
              case when lower(l.kategori) like '%pengembalian%' then 'Utang Deposit Penyewa' else 'Kas/Bank' end
            when lower(l.kategori) like '%modal%' or lower(l.kategori) like '%setoran%' then 'Kas/Bank'
            when lower(l.kategori) like '%prive%' or lower(l.kategori) like '%penarikan%' then 'Prive Pemilik'
            when lower(l.kategori) like '%aset%' or lower(l.kategori) like '%pembelian%' then 'Aset Tetap'
            else case when c.saldo_normal='Kredit' then 'Kas/Bank' else l.kategori end end,
       case when lower(l.kategori) like '%penyusutan%' or lower(l.kategori) like '%depresiasi%' then l.jumlah
            when l.jenis='pendapatan' then l.jumlah
            when l.jenis='pengeluaran' then l.jumlah
            when lower(l.kategori) like '%deposit%' or lower(l.kategori) like '%jaminan%' then
              case when lower(l.kategori) like '%pengembalian%' then l.jumlah else l.jumlah end
            when lower(l.kategori) like '%modal%' or lower(l.kategori) like '%setoran%' then l.jumlah
            when lower(l.kategori) like '%prive%' or lower(l.kategori) like '%penarikan%' then l.jumlah
            when lower(l.kategori) like '%aset%' or lower(l.kategori) like '%pembelian%' then l.jumlah
            else l.jumlah end,
       0, l.kost
  from ledger l
  join journal_entries e on e.sumber='ledger' and e.source_ref='ledger:' || l.id and e.kost=l.kost
  left join categories c on c.id=l.kategori_id
 where l.voided_at is null
   and not exists (select 1 from journal_lines x where x.journal_id=e.id);

insert or ignore into journal_lines (journal_id, akun_kode, akun_nama, debet, kredit, kost)
select e.id,
       case when lower(l.kategori) like '%penyusutan%' or lower(l.kategori) like '%depresiasi%' then '1600'
            when l.jenis='pendapatan' then '4xxx'
            when l.jenis='pengeluaran' then '1000'
            when lower(l.kategori) like '%deposit%' or lower(l.kategori) like '%jaminan%' then
              case when lower(l.kategori) like '%pengembalian%' then '1000' else '2100' end
            when lower(l.kategori) like '%modal%' or lower(l.kategori) like '%setoran%' then '3000'
            when lower(l.kategori) like '%prive%' or lower(l.kategori) like '%penarikan%' then '1000'
            when lower(l.kategori) like '%aset%' or lower(l.kategori) like '%pembelian%' then '1000'
            else case when c.saldo_normal='Kredit' then '3900' else '1000' end end,
       case when lower(l.kategori) like '%penyusutan%' or lower(l.kategori) like '%depresiasi%' then 'Akumulasi Penyusutan Aset Tetap'
            when l.jenis='pendapatan' then 'Pendapatan — ' || l.kategori
            when l.jenis='pengeluaran' then 'Kas/Bank'
            when lower(l.kategori) like '%deposit%' or lower(l.kategori) like '%jaminan%' then
              case when lower(l.kategori) like '%pengembalian%' then 'Kas/Bank' else 'Utang Deposit Penyewa' end
            when lower(l.kategori) like '%modal%' or lower(l.kategori) like '%setoran%' then 'Modal Pemilik'
            when lower(l.kategori) like '%prive%' or lower(l.kategori) like '%penarikan%' then 'Kas/Bank'
            when lower(l.kategori) like '%aset%' or lower(l.kategori) like '%pembelian%' then 'Kas/Bank'
            else case when c.saldo_normal='Kredit' then l.kategori else 'Kas/Bank' end end,
       0, l.jumlah, l.kost
  from ledger l
  join journal_entries e on e.sumber='ledger' and e.source_ref='ledger:' || l.id and e.kost=l.kost
  left join categories c on c.id=l.kategori_id
 where l.voided_at is null
   and exists (select 1 from journal_lines x where x.journal_id=e.id)
   and not exists (select 1 from journal_lines x where x.journal_id=e.id and x.kredit>0);

update journal_entries
   set voided_at=(select l.voided_at from ledger l where l.id=cast(substr(journal_entries.source_ref,8) as integer))
 where sumber='ledger' and source_ref like 'ledger:%'
   and exists (select 1 from ledger l where l.id=cast(substr(journal_entries.source_ref,8) as integer) and l.voided_at is not null);
