import {createServer} from 'node:http';
import {mkdirSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore,InputError} from './store.mjs';

const assets=new Map([['/',['index.html','text/html']],['/app.mjs',['app.mjs','text/javascript']],['/style.css',['style.css','text/css']]]);
function json(res,status,value,headers={}){
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}).end(JSON.stringify(value));
}
function detail(res,status,item){
  json(res,status,item,{ETag:'"'+item.revision+'"'});
}
async function body(req){
  if((req.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json') throw new InputError('Send JSON for this request.',415);
  let length=0;const chunks=[];
  for await(const part of req.iterator({destroyOnReturn:false})){
    length+=part.length;
    if(length>8192){req.resume();throw new InputError('Request body is too large.',413);}
    chunks.push(part);
  }
  let parsed;
  try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new InputError('Invalid JSON.');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new InputError('Expected a JSON object.');
  return parsed;
}

export function app(store){
  return createServer(async (req,res)=>{
    try{
      const url=new URL(req.url,'http://localhost'),path=url.pathname,method=req.method;
      if(path==='/api/requests'&&method==='GET'){
        json(res,200,store.list({status:url.searchParams.get('status')??'',q:url.searchParams.get('q')??''}));return;
      }
      if(path==='/api/requests'&&method==='POST'){
        detail(res,201,store.add(await body(req)));return;
      }
      const match=path.match(/^\/api\/requests\/([0-9]{1,10})$/);
      if(match&&method==='GET'){detail(res,200,store.get(Number(match[1])));return;}
      if(match&&method==='PATCH'){
        const version=/^"([1-9][0-9]*)"$/.exec(req.headers['if-match']??'');
        if(!version)throw new InputError('A current request revision is required in If-Match.',428);
        detail(res,200,store.update(Number(match[1]),(await body(req)).status,Number(version[1])));
        return;
      }
      const asset=assets.get(path);
      if(asset&&method==='GET'){
        const [name,type]=asset;
        const content=await readFile(new URL('./public/'+name,import.meta.url));
        res.writeHead(200,{'Content-Type':type+'; charset=utf-8','X-Content-Type-Options':'nosniff'}).end(content);return;
      }
      json(res,404,{error:'Not found.'});
    }catch(e){
      if(e instanceof InputError){json(res,e.status,{error:e.message});return;}
      console.error(e);json(res,500,{error:'The request could not be completed.'});
    }
  });
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const path=process.env.REQUEST_DB||fileURLToPath(new URL('./data/requests.sqlite',import.meta.url));
  mkdirSync(dirname(path),{recursive:true});
  const server=app(openStore(path));
  server.listen(Number(process.env.PORT||4180),process.env.HOST||'127.0.0.1',function(){
    console.log('Service Request Tracker: http://'+this.address().address+':'+this.address().port);
  });
}
