const $=id=>document.getElementById(id);
const record=$('record'), list=$('requests'), filters=$('filters'), dialog=$('create'), form=$('create-form');
let selected=1042, latest=0, detailRun=0;
const format=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'});
const slug=s=>s.toLowerCase().replaceAll(' ','-');
function el(tag,text='',cls=''){
  const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;
}
const pill=status=>el('span',status,'pill '+slug(status));
function note(text){$('message').textContent=text;}
async function api(url,method='GET',body,revision){
  const r=await fetch(url,{method,...(body?{headers:{'Content-Type':'application/json',...(revision?{'If-Match':'"'+revision+'"'}:{})},body:JSON.stringify(body)}:{})});
  const payload=await r.json();
  if(!r.ok)throw Object.assign(Error(payload.error||'The request could not be completed.'),{status:r.status});
  return payload;
}
async function show(id){
  const seq=++detailRun;
  if(!id){record.replaceChildren(el('p','No matching requests. Change the filters or create a request.','empty'));return;}
  try{
    const item=await api('/api/requests/'+id);
    if(seq!==detailRun)return;
    const header=el('div','','record-head'), title=el('div');
    title.append(el('div','SR-'+id,'record-id'),el('h2',item.title));header.append(title,pill(item.status));
    const overview=el('dl','','meta');
    for(const [k,v] of [['Requester',item.requester],['Team',item.team],['Opened',format.format(new Date(item.created_at))]]){
      const cell=el('div');cell.append(el('dt',k),el('dd',v));overview.append(cell);
    }
    const desc=el('div','','description');desc.append(el('h3','Description'),el('p',item.description));
    const update=el('form','','update');
    const label=el('label','Next status'), select=el('select'), button=el('button','Save status','primary');
    for(const status of item.next){const option=el('option',status);option.value=status;select.append(option);}
    label.append(select);update.append(label,button);
    update.onsubmit=async event=>{
      event.preventDefault();button.disabled=true;
      try{await api('/api/requests/'+id,'PATCH',{status:select.value},item.revision);await load();note('SR-'+id+' status updated.');}
      catch(e){if(e.status===412)await load();note(e.message);button.disabled=false;}
    };
    const activity=el('div','','activity'), timeline=el('ol');
    for(const log of item.history){
      const li=el('li');
      li.append(el('strong',log.previous_status?log.previous_status+' → '+log.status:log.event),
        el('span',format.format(new Date(log.at))));
      timeline.append(li);
    }
    activity.append(el('h3','Activity'),timeline);record.replaceChildren(header,overview,desc,update,activity);
  }catch(e){if(seq===detailRun)record.replaceChildren(el('p',e.message,'empty'));}
}
async function load({focus=false}={}){
  const seq=++latest;
  try{
    const rows=await api('/api/requests?'+new URLSearchParams(new FormData(filters)));
    if(seq!==latest)return;
    if(!rows.some(row=>row.id===selected))selected=rows[0]?.id;
    $('count').textContent=rows.length+' '+(rows.length===1?'request':'requests');
    list.replaceChildren();
    if(!rows.length)list.append(el('p','No requests match the filters.','empty'));
    for(const item of rows){
      const button=el('button','','row'), cell=el('span');
      button.type='button';button.setAttribute('aria-pressed',String(item.id===selected));button.dataset.id=item.id;
      cell.append(el('small','SR-'+item.id+' / '+item.team),el('strong',item.title));button.append(cell,pill(item.status));
      button.onclick=()=>{selected=item.id;for(const child of list.querySelectorAll('.row'))child.setAttribute('aria-pressed',String(child===button));show(selected);};
      list.append(button);
    }
    await show(selected);
    if(focus)list.querySelector('[data-id="'+selected+'"]')?.focus();
  }catch(e){if(seq===latest)note(e.message);}
}
filters.onsubmit=e=>{e.preventDefault();note('');load();};
$('new').onclick=()=>{form.reset();$('form-error').textContent='';dialog.showModal();};
$('close').onclick=()=>dialog.close();
form.onsubmit=async e=>{
  e.preventDefault();const submit=form.querySelector('[type=submit]');
  submit.disabled=true;$('form-error').textContent='';
  try{
    const result=await api('/api/requests','POST',Object.fromEntries(new FormData(form)));
    selected=result.id;filters.reset();dialog.close();await load({focus:true});note('SR-'+result.id+' created.');
  }catch(e){$('form-error').textContent=e.message;}
  finally{submit.disabled=false;}
};
load();
