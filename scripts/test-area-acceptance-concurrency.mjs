// Two actual PostgreSQL sessions, entirely local; never reads production config.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
import {id,setupAreaAcceptance} from '../tests/fixtures/area-acceptance.mjs'
const {default:EmbeddedPostgres}=await import(process.env.ARC_EMBEDDED_PG_MODULE ?? 'embedded-postgres')
const socket=net.createServer()
await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve)})
const port=socket.address().port
await new Promise(resolve=>socket.close(resolve))
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arc-takeoff-pg-'))
const cluster=new EmbeddedPostgres({databaseDir:path.join(dir,'db'),port,user:'postgres',password:'local-disposable-test',persistent:false,onLog:()=>{},onError:()=>{}})
const clients=[]
let started=false
try{
 await cluster.initialise();await cluster.start();started=true
 for(let i=0;i<3;i++){const client=cluster.getPgClient();await client.connect();clients.push(client)}
 const [a,b,observer]=clients
 await setupAreaAcceptance(sql=>a.query(sql))
 const row=n=>({id:id(n),org_id:id(1),drawing_sheet_id:id(3),sheet_version_id:id(4),condition_id:id(6),data:{type:'area',points:[[0,0],[1,0],[1,1],[0,1]]},quantity:100,uom:'sf'})
 const accept=(client,snapshot,rows)=>client.query('select accept_takeoff_area_snapshot($1,$2,$3,$4::jsonb,$5::jsonb)',[id(1),id(4),id(6),JSON.stringify(snapshot),JSON.stringify(rows)])
 const snapshot=async()=> (await observer.query('select id,data from drawing_markups order by id')).rows
 const bpid=(await b.query('select pg_backend_pid() as pid')).rows[0].pid
 const waitForLock=async()=>{
  for(let i=0;i<100;i++){
   const state=(await observer.query('select wait_event from pg_stat_activity where pid=$1',[bpid])).rows[0]
   if(state?.wait_event==='advisory')return
   await new Promise(resolve=>setTimeout(resolve,20))
  }
  throw new Error('Second connection did not wait for the measurement scope lock')
 }
 await a.query('begin')
 await accept(a,[],[row(10)])
 const second=accept(b,[],[row(11)]).then(()=>null,e=>e)
 await waitForLock();await a.query('commit')
 assert.equal((await second)?.code,'40001','competing automatic save must reject its stale snapshot')
 assert.equal((await snapshot()).length,1)
 const beforeManual=await snapshot()
 await a.query('begin')
 await a.query('insert into drawing_markups(id,org_id,drawing_sheet_id,sheet_version_id,condition_id,data) values($1,$2,$3,$4,$5,$6)',[id(12),id(1),id(3),id(4),id(6),{type:'area',points:[[0,0],[.5,0],[.5,.5]]}])
 const afterManual=accept(b,beforeManual,[row(13)]).then(()=>null,e=>e)
 await waitForLock();await a.query('commit')
 assert.equal((await afterManual)?.code,'40001','manual writes must serialize with automatic acceptance')
 assert.equal((await snapshot()).length,2)
 await b.query('set role anon')
 await assert.rejects(accept(b,[],[row(14)]),/permission denied/)
 await b.query('reset role')
 console.log('PASS: simultaneous automatic saves and manual/automatic races serialize and reject stale snapshots; anonymous callers are denied.')
}finally{
 for(const client of clients)await client.end().catch(()=>{})
 if(started)await cluster.stop()
 fs.rmSync(dir,{recursive:true,force:true})
}
