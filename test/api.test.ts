import test, {type TestContext} from 'node:test';
import type {AddressInfo} from 'node:net';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import net from 'node:net';
import {app} from '../src/server.ts';
import {openStore} from '../src/store.ts';

const payload={title:'Replace meeting room projector',requester:'Casey Lee',team:'IT',description:'The HDMI port is not working.'};
async function fixture(t: TestContext, db = ':memory:') {
  const store=openStore(db,{seedData:false}), server=app(store);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const port = (server.address() as AddressInfo).port, root = 'http://127.0.0.1:' + port;
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();});
  const call = (path: string, method = 'GET', value?: unknown, revision?: number) =>fetch(root+path,{method,...(value?{headers:{'Content-Type':'application/json',...(revision?{'If-Match':'"'+revision+'"'}:{})},body:JSON.stringify(value)}:{})});
  call.port = port;
  return call;
}
function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve,reject)=>{
    let reply='';
    const socket=net.connect(port,'127.0.0.1',()=>socket.write(request));
    socket.setTimeout(3000,()=>socket.destroy(new Error('No reply to: '+request.split('\r\n')[0])));
    socket.on('data', (chunk: Buffer) => {reply += chunk;}).on('error',reject).on('close',()=>resolve(reply));
  });
}
test('create, filter, and advance a request with durable activity',async t=>{
  const call=await fixture(t), created=await call('/api/requests','POST',payload);
  assert.equal(created.status,201);
  assert.equal(created.headers.get('etag'),'"1"');
  const item=await created.json(), path='/api/requests/'+item.id;
  assert.equal(item.history.length,1);
  assert.equal((await call(path,'PATCH',{status:'Assigned'},1)).status,200);
  const matching=await (await call('/api/requests?status=Assigned&q=projector')).json();
  assert.deepEqual(matching.map((x: {id: number}) => x.id),[item.id]);
  const current=await (await call(path)).json();
  assert.deepEqual(current.history.map((x: {status: string}) => x.status),['Open','Assigned']);
});
test('invalid input and forbidden transitions do not write activity',async t=>{
  const call=await fixture(t);
  assert.equal((await call('/api/requests','POST',{...payload,team:'Other'})).status,400);
  const item=await (await call('/api/requests','POST',payload)).json();
  const path='/api/requests/'+item.id;
  assert.equal((await call(path,'PATCH',{status:'Completed'},1)).status,409);
  assert.equal((await (await call(path)).json()).history.length,1);
  assert.equal((await call('/api/requests/9999')).status,404);
});
test('a stale write cannot overwrite another tab or append phantom history',async t=>{
  const call=await fixture(t);
  const created=await (await call('/api/requests','POST',payload)).json(), path='/api/requests/'+created.id;
  assert.equal((await call(path,'PATCH',{status:'Assigned'})).status,428);
  const [a,b]=await Promise.all([
    call(path,'PATCH',{status:'Assigned'},1),
    call(path,'PATCH',{status:'Assigned'},1)
  ]);
  assert.deepEqual([a.status,b.status].sort(),[200,412]);
  const get=await call(path);
  assert.equal(get.headers.get('etag'),'"2"');
  const record=await get.json();
  assert.deepEqual(record.history.map((x: {status: string}) => x.status),['Open','Assigned']);
});
test('saved requests and history survive reopening the database',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'relay-test-')), path=join(dir,'requests.sqlite');
  try{
    let db=openStore(path,{seedData:false});
    const {id}=db.add(payload);db.update(id,'Assigned',1);db.close();
    db=openStore(path,{seedData:false});
    try{assert.equal(db.get(id).status,'Assigned');assert.equal(db.get(id).history.length,2);}
    finally{db.close();}
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('a malformed address is a client error, and the server keeps answering',async t=>{
  const call=await fixture(t);
  const reply=await raw(call.port,'GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  assert.match(reply,/^HTTP\/1\.1 400/);
  assert.match(reply,/Malformed request address/);
  assert.equal((await call('/api/requests')).status,200);
});
test('a method the route does not offer gets 405 with the methods it does',async t=>{
  const call=await fixture(t);
  const created=await (await call('/api/requests','POST',payload)).json();
  for(const [path,method,allow] of [['/api/requests','PUT','GET, POST'],['/api/requests','DELETE','GET, POST'],
    ['/api/requests/'+created.id,'DELETE','GET, PATCH'],['/','POST','GET'],['/app.mjs','PUT','GET']] as [string, string, string][]){
    const response=await call(path,method);
    assert.equal(response.status,405,method+' '+path);
    assert.equal(response.headers.get('allow'),allow,method+' '+path);
  }
  assert.equal((await call('/nothing-here')).status,404);
  assert.equal((await call('/api/requests/abc')).status,404);
});
