import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('repository history enforces ownership, pagination, leases and retention', async () => {
 const db=new PGlite();
 const owner='00000000-0000-0000-0000-000000000001',other='00000000-0000-0000-0000-000000000002',site='00000000-0000-0000-0000-000000000003';
 try {
 await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
 create table auth.users(id uuid primary key);
 create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
 create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
 grant usage on schema auth,public to authenticated,anon,service_role;`);
 const migrations=new URL('../migrations/',import.meta.url);
 for(const file of (await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file,migrations),'utf8'));
 await db.exec(`insert into auth.users values('${owner}'),('${other}'); insert into public.websites(id,owner_id,fqdn) values('${site}','${owner}','example.com');`);
 async function identity(user,anonymous=false) {await db.exec('reset role; set role authenticated'); await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,is_anonymous:anonymous})]);}
 async function attach(url='https://github.com/example/site',enabled=true) {return (await db.query('select public.set_website_repository($1,null,$2,$3) as data',[url,enabled,site])).rows[0].data;}
 async function history(before=null) {return (await db.query("select public.website_repository_history($1,null,'2026-10-01','2026-10-30',$2) as data",[site,before])).rows[0].data;}
 async function claim() {await db.exec('reset role; set role service_role');return (await db.query('select public.claim_website_repository() as data')).rows[0].data;}
 const sha='a'.repeat(40),page=[{sha,message:'Update service page',author:'example',authored_at:'2026-10-01T10:00:00Z',committed_at:'2026-10-02T10:00:00Z'}];
 async function complete(job,commits=page) {return (await db.query('select public.complete_website_repository($1,$2,$3,$4,true) as data',[job.id,job.lease,JSON.stringify(commits),sha])).rows[0].data;}
 await identity(other);await assert.rejects(()=>attach(),/Website not found/);
 await identity(owner,true);await assert.rejects(()=>attach(),/Website not found/);
 await identity(owner);await assert.rejects(()=>attach('https://evil.example/a/b'),/GitHub repository/);
 await attach();let job=await claim();assert.ok(job);
 assert.equal(await complete(job),true); assert.equal(await complete(job),false,'lease cannot be replayed');
 await identity(owner);let result=await history();assert.equal(result.commits.length,1);assert.equal(result.commits[0].sha,sha);assert.equal(result.repository.enabled,true);
 await identity(other);await assert.rejects(()=>history(),/Website not found/);
 await identity(owner);await attach(undefined,false);assert.equal(await claim(),null);
 await identity(owner);assert.equal((await history()).commits.length,1,'pause keeps commits');
 await attach();job=await claim();await identity(owner);await attach('https://github.com/example/new-site');await db.exec('reset role; set role service_role');assert.equal(await complete(job),false,'replacement fences in-flight results');
 job=await claim();assert.ok(job);assert.equal(await complete(job),true);
 await identity(owner);assert.equal((await history()).commits.length,2,'replacement retains old stream');
 await db.exec('reset role');
 const current=(await db.query('select id from public.website_repositories where enabled')).rows[0].id;
 await db.query("insert into public.website_repository_commits(repository_id,sha,message,committed_at) select $1,lpad(to_hex(n),40,'0'),'Historical change','2026-10-01'::timestamptz + n*interval '1 minute' from generate_series(1,105) n",[current]);
 await identity(owner);const first=await history();assert.equal(first.commits.length,100);assert.equal(first.has_more,true);
 const second=await history(first.commits.at(-1).id);assert.equal(second.commits.length,7);assert.equal(second.has_more,false);
 assert.ok(Date.parse(first.commits.at(-1).committed_at)>=Date.parse(second.commits[0].committed_at));
 await attach(null);assert.equal(await claim(),null);await identity(owner);assert.equal((await history()).commits.length,100,'unlink retains paginated history');
 await db.exec('reset role');await db.query("update public.websites set fqdn='renamed.example.com' where id=$1",[site]);await identity(owner);assert.equal((await history()).commits.length,0,'FQDN rename isolates old data');
 await db.exec('reset role; set role anon');await assert.rejects(()=>db.query('select * from public.website_repository_commits'),/permission denied/);
 } finally {await db.close();}
});
