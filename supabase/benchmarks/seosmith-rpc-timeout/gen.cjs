const fs=require('fs'), crypto=require('crypto'), path=require('path');
const [fixtureDir,out]=process.argv.slice(2);
const site='00000000-0000-4000-8000-000000000002';
const legacy=JSON.parse(fs.readFileSync(path.join(fixtureDir,'seosmith-expanded.json')));
const v2=JSON.parse(fs.readFileSync(path.join(fixtureDir,'contracts/v2-complete.json')));
const counts=[1000,1000,1000,450,450,450,468,...Array(13).fill(1)];
const sizes=[7338400,7329236,7329000,4000000,4000000,...Array(15).fill(600000)];
function fresh(r) { r=structuredClone(r); r.request.request_id=crypto.randomUUID(); r.request.website_id=site; r.request.binding_generation=1; return r; }
function save(name,raw,r) {fs.writeFileSync(path.join(out,name+'.json'),raw); fs.writeFileSync(path.join(out,name+'.meta'),JSON.stringify({id:r.request.request_id,sha:crypto.createHash('sha256').update(raw).digest('hex'),bytes:Buffer.byteLength(raw)}));}
for(let i=0;i<20;i++) {const r=fresh(legacy), base=r.pages; r.pages=Array.from({length:counts[i]},(_,j)=>{let p=structuredClone(base[j%base.length]); if(j>=base.length){p.url=p.url.replace(/\/?$/,`/synthetic-${j}/`); if(p.final_url)p.final_url=p.url;} return p}); let raw=JSON.stringify(r); if(Buffer.byteLength(raw)>sizes[i]) throw Error('target smaller than report'); raw=raw.slice(0,-1)+',"synthetic_padding":"'+'x'.repeat(sizes[i]-Buffer.byteLength(raw)-23)+'"}'; save(`legacy-${i}`,raw,r); }
for(const kind of ['token','string']) for(const mode of ['worker','import']) for(let n=0;n<3;n++){const r=fresh(v2); const pad=kind==='token'?'0,'.repeat(7600000)+'0':'"[{\\\"x\\\":]}",'.repeat(1200000)+'"z"'; const raw=JSON.stringify(r).slice(0,-1)+',"padding":['+pad+']}'; if(Buffer.byteLength(raw)>16777216) throw Error('oversize'); save(`${kind}-${mode}-${n}`,raw,r);}
const bad=fresh(v2); let raw=JSON.stringify(bad).replace('{"schema_version":2','{"schema_version":2,"schema_version":2'); if(raw===JSON.stringify(bad)) throw Error('negative mutation failed'); save('duplicate-worker',raw,bad);
console.log('Synthetic: 20 legacy reports, 4831 pages; token/string valid worker/import x3 and duplicate-key rejection.');
