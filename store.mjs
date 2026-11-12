import {DatabaseSync} from 'node:sqlite';
export const statuses=['Open','Assigned','In progress','Completed'];
export const teams=['Facilities','IT','People','Operations'];
export const transitions={Open:['Assigned'],Assigned:['Open','In progress'],'In progress':['Assigned','Completed'],Completed:['Open']};

export class InputError extends Error {
  constructor(message,status=400){super(message);this.status=status;}
}

function clean(value,label,max) {
  if(typeof value!=='string'||!value.trim()||value.trim().length>max) throw new InputError(label+' must be 1–'+max+' characters.');
  return value.trim();
}
const seed=[
  [1040,'Set up a laptop for new starter','Avery Cole','IT','Prepare a laptop and standard software before the start date.','Completed'],
  [1041,'Request access to the CRM','Noah Parker','Operations','Set up access for a new account coordinator.','Open'],
  [1042,'Replace access badge','Taylor Reed','Facilities','The current access badge is unreliable at the east entrance. Please issue a replacement.','In progress'],
  [1043,'Prepare a desk in Studio B','Riley Chen','Facilities','Set up a monitor, chair, and power supply at desk B12.','Assigned'],
  [1044,'Update new starter checklist','Morgan Ellis','People','Add the equipment return and badge handover steps.','Open']
];

export function openStore(path,{seedData=true}={}) {
  const db=new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
  db.exec(`CREATE TABLE IF NOT EXISTS requests(
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, requester TEXT NOT NULL, team TEXT NOT NULL,
    description TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('Open','Assigned','In progress','Completed')),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS activity(
    id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES requests(id),
    event TEXT NOT NULL, previous_status TEXT, status TEXT NOT NULL, at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS activity_request ON activity(request_id,id);
  CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY);`);
  if(!db.prepare('PRAGMA table_info(requests)').all().some(column=>column.name==='revision'))
    db.exec('ALTER TABLE requests ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
  const insert=db.prepare('INSERT INTO requests(id,title,requester,team,description,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
  const log=db.prepare('INSERT INTO activity(request_id,event,previous_status,status,at) VALUES(?,?,?,?,?)');
  function tx(fn){
    db.exec('BEGIN IMMEDIATE');
    try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}
  }
  if(seedData){
    tx(()=>{
      if(db.prepare("SELECT key FROM metadata WHERE key='seed-v1'").get())return;
      for(const [id,title,requester,team,description,status] of seed){
        const progression=statuses.slice(0,statuses.indexOf(status)+1);
        const time=(i)=>'2026-06-0'+(id-1038)+'T09:'+String(i*10).padStart(2,'0')+':00.000Z';
        insert.run(id,title,requester,team,description,status,time(0),time(progression.length-1));
        progression.forEach((step,i)=>log.run(id,i?'Status changed':'Request opened',progression[i-1]??null,step,time(i)));
      }
      db.prepare("INSERT INTO metadata VALUES('seed-v1')").run();
    });
  }
  const byId=db.prepare('SELECT * FROM requests WHERE id=?');
  const history=db.prepare('SELECT event,previous_status,status,at FROM activity WHERE request_id=? ORDER BY id');
  function get(id){
    const item=byId.get(id);
    if(!item)throw new InputError('Request not found.',404);
    return {...item,history:history.all(id),next:transitions[item.status]};
  }
  return {
    close:()=>db.close(),
    list({status='',q=''}={}){
      if(status&&!statuses.includes(status))throw new InputError('Unknown status.');
      if(q.length>100)throw new InputError('Search must be 100 characters or fewer.');
      return db.prepare(`SELECT id,title,requester,team,status,updated_at FROM requests
       WHERE (?='' OR status=?) AND (?='' OR instr(lower(title||' '||requester||' '||team||' SR-'||id),lower(?))>0)
       ORDER BY updated_at DESC,id DESC`).all(status,status,q,q);
    },
    get,
    add(body){
      const title=clean(body.title,'Title',100), requester=clean(body.requester,'Requester',70),
        team=clean(body.team,'Team',30), description=clean(body.description,'Description',1000);
      if(!teams.includes(team))throw new InputError('Select a valid team.');
      return tx(()=>{
        const {id}=db.prepare('SELECT max(coalesce((SELECT max(id) FROM requests),1039),1039)+1 AS id').get();
        const now=new Date().toISOString();
        insert.run(id,title,requester,team,description,'Open',now,now);
        log.run(id,'Request opened',null,'Open',now);
        return get(id);
      });
    },
    update(id,status,revision){
      if(!Number.isSafeInteger(revision)||revision<1)throw new InputError('A request revision is required.',428);
      if(!statuses.includes(status))throw new InputError('Select a valid status.');
      return tx(()=>{
        const item=get(id);
        if(item.revision!==revision)throw new InputError('Someone updated this request. Review the latest version before trying again.',412);
        if(!item.next.includes(status))throw new InputError('That status change is not available. Refresh the request and try again.',409);
        const now=new Date().toISOString();
        db.prepare('UPDATE requests SET status=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?').run(status,now,id,revision);
        log.run(id,'Status changed',item.status,status,now);
        return get(id);
      });
    }
  };
}
