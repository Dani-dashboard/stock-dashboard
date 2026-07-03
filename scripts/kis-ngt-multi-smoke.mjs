import fs from 'node:fs/promises';
await loadDotEnv('.env');
const keys = (process.env.KIS_NGT_KEYS || '101V06,101W9000,101W06,101T06,101W09').split(',').map(s=>s.trim()).filter(Boolean);
const trIds = (process.env.KIS_NGT_TR_IDS || 'H0MFCNT0,H0MFASP0').split(',').map(s=>s.trim()).filter(Boolean);
const waitMs = Number(process.env.KIS_WS_SMOKE_WAIT_MS || 60000);
const out = 'data/kis-ngt-multi-latest.json';
const approvalKey = await getApprovalKey();
const wsUrl = process.env.KIS_MODE === 'paper' ? 'ws://ops.koreainvestment.com:31000' : 'ws://ops.koreainvestment.com:21000';
const ws = new WebSocket(wsUrl);
const state = { status:'connecting', wsUrl, keys, trIds, subscribed:[], ticks:[], messages:[], updatedAt:new Date().toISOString() };
await write();
setTimeout(()=>{try{ws.close()}catch{}}, waitMs);
await new Promise(resolve=>{
 ws.addEventListener('open', async()=>{
  for(const trId of trIds) for(const trKey of keys){
   ws.send(JSON.stringify({header:{approval_key:approvalKey,custtype:'P',tr_type:'1','content-type':'utf-8'},body:{input:{tr_id:trId,tr_key:trKey}}}));
  }
  state.status='subscribing'; state.updatedAt=new Date().toISOString(); write();
 });
 ws.addEventListener('message', async ev=>{
  const raw=String(ev.data); if(raw.includes('PINGPONG')){try{ws.send(raw)}catch{}}
  const parsed=parse(raw); state.messages.push(parsed); state.messages=state.messages.slice(-20);
  if(parsed.kind==='subscribe') state.subscribed.push(parsed.header);
  if(parsed.kind==='tick') state.ticks.push(parsed);
  state.status=state.ticks.length?'tick':'subscribed_waiting_tick'; state.updatedAt=new Date().toISOString(); await write();
 });
 ws.addEventListener('close', async()=>{state.status=state.ticks.length?'closed_after_tick':'closed_no_tick'; state.updatedAt=new Date().toISOString(); await write(); resolve();});
 ws.addEventListener('error', async e=>{state.status='error'; state.error=e.message||'websocket error'; await write();});
});
console.log(JSON.stringify(state,null,2));
function parse(raw){ try{const j=JSON.parse(raw); if(j.header?.tr_id==='PINGPONG') return {kind:'pingpong', datetime:j.header.datetime}; if(j.body?.msg1) return {kind:'subscribe', header:j.header, msg1:j.body.msg1, rt_cd:j.body.rt_cd}; return {kind:'json', header:j.header, body:j.body};}catch{} const p=raw.split('|'); if(p.length>=4){const fields=p.slice(3).join('|').split('^'); return {kind:'tick', trId:p[1], count:p[2], key:fields[0], price:fields[5]||fields[2]||null, firstFields:fields.slice(0,16), rawPreview:raw.slice(0,200)}} return {kind:'raw', rawPreview:raw.slice(0,200)}; }
async function write(){ await fs.writeFile(out, JSON.stringify(state,null,2)); }
async function getApprovalKey(){ const base=process.env.KIS_MODE==='paper'?'https://openapivts.koreainvestment.com:29443':'https://openapi.koreainvestment.com:9443'; const r=await fetch(base+'/oauth2/Approval',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grant_type:'client_credentials',appkey:process.env.KIS_APP_KEY,secretkey:process.env.KIS_APP_SECRET})}); const j=await r.json(); if(!j.approval_key) throw new Error(JSON.stringify(j)); return j.approval_key; }
async function loadDotEnv(file){const t=await fs.readFile(file,'utf8'); for(const line of t.split(/\r?\n/)){const s=line.trim(); if(!s||s.startsWith('#')) continue; const i=s.indexOf('='); if(i>0 && !(s.slice(0,i) in process.env)) process.env[s.slice(0,i)]=s.slice(i+1).trim().replace(/^[\'"]|[\'"]$/g,'');}}
