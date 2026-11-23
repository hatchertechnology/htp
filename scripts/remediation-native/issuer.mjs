// Disposable loopback Supabase substitute: synthetic issuer and transparent PostgREST relay.
import http from 'node:http'
import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { writeFileSync } from 'node:fs'
const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'})
const jwk={...publicKey.export({format:'jwk'}),kid:'fixture',alg:'ES256',use:'sig'}
const jwks={keys:[jwk]}; writeFileSync(`${process.env.FIXTURE_DIR}/jwks.json`,JSON.stringify(jwks))
const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url')
const issuer=`http://127.0.0.1:${process.env.ISSUER_PORT}/auth/v1`
for (const [name,sub] of [['owner','00000000-0000-0000-0000-000000000001'],['other','00000000-0000-0000-0000-000000000002']]) {
 const h=enc({alg:'ES256',kid:'fixture',typ:'JWT'}),p=enc({sub,role:'authenticated',aud:'authenticated',is_anonymous:false,iss:issuer,exp:Math.floor(Date.now()/1000)+3600})
 writeFileSync(`${process.env.FIXTURE_DIR}/${name}.token`,`${h}.${p}.${sign('sha256',Buffer.from(`${h}.${p}`),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url')}`)
}
http.createServer(async(req,res)=>{
 try {
  if(req.url==='/auth/v1/.well-known/jwks.json'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify(jwks))}
  if(req.url==='/auth/v1/user'){
   const parts=(req.headers.authorization||'').replace(/^Bearer /,'').split('.'); if(parts.length!==3 || !verify('sha256',Buffer.from(`${parts[0]}.${parts[1]}`),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(parts[2],'base64url'))) {res.writeHead(401);return res.end()}
   const claims=JSON.parse(Buffer.from(parts[1],'base64url')); if(claims.iss!==issuer || claims.exp<Date.now()/1000){res.writeHead(401);return res.end()}
   res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({id:claims.sub,aud:'authenticated',role:'authenticated',is_anonymous:false}))
  }
  if(!req.url.startsWith('/rest/v1/')){res.writeHead(404);return res.end()}
  const target=new URL(req.url.slice('/rest/v1'.length),process.env.FIXTURE_REST)
  const headers={...req.headers,host:target.host}; delete headers.connection
  const upstream=http.request(target,{method:req.method,headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res)});upstream.on('error',()=>{res.writeHead(502);res.end()});req.pipe(upstream)
 } catch {res.writeHead(500);res.end()}
}).listen(Number(process.env.ISSUER_PORT),'127.0.0.1')
