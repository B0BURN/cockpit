// Semester Cockpit Worker: sync + push notifications + Claude chat.
// Source of truth: data.json in a private GitHub repo (env.GH_OWNER/env.DATA_REPO), so Claude can also edit it.
import { sendPush } from "./push.js";
import { notificationsFor, buildBrief, openTasks, taskDueS, off, ymdS, countdown, recurringSoon, clockS } from "../../app/logic.js";

const CORS = {"Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"authorization,content-type", "Access-Control-Allow-Methods":"GET,POST,OPTIONS", "Access-Control-Max-Age":"86400"};
const json = (o, status=200) => new Response(JSON.stringify(o), {status, headers:{"content-type":"application/json", ...CORS}});

/* ---------- GitHub file store ---------- */
const enc = new TextEncoder(), dec = new TextDecoder();
const toB64 = s => { const b = enc.encode(s); let x = ""; for(let i=0;i<b.length;i+=0x8000) x += String.fromCharCode(...b.subarray(i,i+0x8000)); return btoa(x); };
const fromB64 = s => { const bin = atob(s.replace(/\n/g,"")); const b = new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) b[i] = bin.charCodeAt(i); return dec.decode(b); };
function gh(env, path, init={}){
  return fetch(`https://api.github.com/repos/${env.GH_OWNER}/${env.DATA_REPO}/contents/${path}`, {...init, headers:{
    "Authorization":"Bearer "+env.DATA_TOKEN, "Accept":"application/vnd.github+json", "User-Agent":"semester-cockpit", "X-GitHub-Api-Version":"2022-11-28", ...(init.headers||{})}});
}
async function readFile(env, path, fallback){
  const r = await gh(env, path);
  if(r.status===404) return {obj: fallback, sha: null};
  if(!r.ok) throw new Error("GitHub read "+path+": "+r.status);
  const j = await r.json();
  let text = j.content? fromB64(j.content) : null;
  if(text==null){ // >1MB files come without content
    const raw = await gh(env, path, {headers:{"Accept":"application/vnd.github.raw+json"}}); text = await raw.text(); }
  return {obj: JSON.parse(text), sha: j.sha};
}
async function writeFile(env, path, obj, sha, message){
  const r = await gh(env, path, {method:"PUT", body: JSON.stringify({message, content: toB64(JSON.stringify(obj, null, 1)), ...(sha? {sha}: {})})});
  if(r.status===409 || r.status===422) return null; // conflict: caller retries
  if(!r.ok) throw new Error("GitHub write "+path+": "+r.status+" "+(await r.text()).slice(0,200));
  return (await r.json()).content.sha;
}
// read-modify-write with retry; mutate(obj) returns true if it changed something
async function update(env, path, fallback, mutate, message){
  for(let i=0;i<4;i++){
    const {obj, sha} = await readFile(env, path, fallback);
    if(!mutate(obj)) return obj;
    if(await writeFile(env, path, obj, sha, message)) return obj;
  }
  throw new Error("Could not save after retries (conflict)");
}
const EMPTY = () => ({v:1, docs:{}});

// docs map -> state object used by logic.js
function toState(store){
  const s = {settings:null, schedule:null, timer:null, tasks:{}, courses:{}, days:{}, sessions:{}};
  for(const [key, rec] of Object.entries(store.docs||{})){
    if(rec.x) continue; const [col, id] = key.split("/");
    if(col==="config") s[id] = rec.d; else if(s[col]) s[col][id] = rec.d;
  }
  return s;
}
function mergeChanges(store, changes){
  let changed = false;
  for(const c of changes||[]){
    if(!c || !c.c || !c.i || !/^[A-Za-z0-9_\-.~:@+]+$/.test(c.i) || !["config","tasks","courses","days","sessions"].includes(c.c)) continue;
    const key = c.c+"/"+c.i, cur = store.docs[key];
    if(cur && cur.u >= c.u) continue;
    store.docs[key] = c.x? {x:true, u:c.u} : {d:c.d, u:c.u}; changed = true;
  }
  return changed;
}

/* ---------- Claude chat ---------- */
const TOOLS = [
  {name:"get_docs", description:"Read documents from a collection. collection is one of tasks, courses, days, sessions, config (config ids: settings, schedule, timer). Omit ids to get the whole collection (sessions: only the last 14 days).",
    input_schema:{type:"object", properties:{collection:{type:"string"}, ids:{type:"array", items:{type:"string"}}}, required:["collection"]}},
  {name:"put_doc", description:"Create or update one document. With merge=true the given fields are merged into the existing document (set a field to null to clear it); with merge=false the document is replaced. Day logs use id YYYY-MM-DD and must include date. New task ids: short random strings.",
    input_schema:{type:"object", properties:{collection:{type:"string"}, id:{type:"string"}, data:{type:"object"}, merge:{type:"boolean"}}, required:["collection","id","data"]}},
  {name:"delete_doc", description:"Delete one document.", input_schema:{type:"object", properties:{collection:{type:"string"}, id:{type:"string"}}, required:["collection","id"]}},
];
function systemPrompt(state, nowMs){
  const o = off(state), nowS = nowMs + o, b = buildBrief(state, nowMs);
  const tasks = openTasks(state, nowS).slice(0, 40).map(x => `- [${x.id}] ${x.t.title}${x.t.course? " ("+x.t.course+")":""}${x.t.weight? " "+x.t.weight+"%":""} — due ${ymdS(x.d)} ${new Date(x.d).toISOString().slice(11,16)} (${countdown(x.d-nowS)})`).join("\n");
  const rec = Object.entries(state.tasks).filter(([,t]) => t.repeat && !t.done).map(([id,t]) => `- [${id}] ${t.title} (${t.repeat}${t.day? " day "+t.day:""})`).join("\n");
  const courses = Object.entries(state.courses).map(([id,c]) => `- ${id}: ${c.name}, target ${c.target}${c.passfail? " (pass/fail)":""}; components: ${(c.components||[]).map(k => `${k.name} max ${k.max} plan ${k.exp} real ${k.real??"–"}`).join("; ")}`).join("\n");
  const now = new Date(nowS);
  return `You are the assistant inside Bobur's "Semester Cockpit" iPhone app (university semester, CBU internship, gym and diet). Be brief and direct: answer in a few short lines, no fluff. When he asks to add, change, log or complete something, do it with the tools, then confirm in one line what changed.

Local time now: ${now.toISOString().slice(0,16).replace("T"," ")} (Asia/Tashkent, UTC+5). Weekday ${(now.getUTCDay()+6)%7+1} (1=Mon).

Data model:
- tasks: {title, cat (study|class|work|gym|road|diet|life), course?, due? (ISO 8601 with offset, e.g. 2026-10-28T10:30:00+05:00), week? (semester week), day? (1=Mon..7=Sun), remind (days before due to warn, default 2), weight? (% of grade), done, doneAt?, dismissed?, expire?, repeat? (daily|weekdays|weekly + day), doneDates? (YYYY-MM-DD list for recurring), notes?, created (epoch ms)}. To complete a task set done=true and doneAt=now (epoch ms). For a recurring task add today's date to doneDates.
- days/<YYYY-MM-DD>: {date, weight, kcal, protein, steps, wake, bed}. kcal and protein are daily totals: when he says "ate 500 kcal" ADD to the existing value (read it first).
- sessions: {title, cat, course, start, end (epoch ms), mins, taskId, distractions}.
- courses/<ID>: {name, short, target, passfail?, components:[{name,max,exp,real,multi?,doneMax?,when}], syl?}. To record a grade set components[i].real (replace the whole components array).
- config/settings: targets (kcal ${state.settings?.kcal}, protein ${state.settings?.protein}, steps ${state.settings?.steps}), weeks (Monday of each semester week), holidays, breaks, weight plan. config/schedule: {blocks:[{d,s,e,t,cat,course?,room?,tentative?}]}.

Today's brief:
${b.title}
Today: ${b.today.join(", ") || "nothing scheduled"}
Deadlines: ${b.deadlines.join("; ") || "none"}
Exams next 2 weeks: ${b.exams.join("; ") || "none"}
Yesterday: ${b.yesterday}. ${b.weight}
Focus: ${b.focus}

Open tasks (by due date):
${tasks || "none"}
Recurring:
${rec || "none"}
Courses:
${courses}`;
}
async function chat(env, body){
  if(!env.ANTHROPIC_API_KEY) return json({error:"Claude chat isn't set up yet: add an Anthropic API key."}, 400);
  const nowMs = Date.now();
  let {obj: store, sha} = await readFile(env, "data.json", EMPTY());
  let state = toState(store); const changes = [];
  const messages = (body.messages||[]).slice(-16).map(m => ({role: m.role==="assistant"? "assistant":"user", content: String(m.content||"").slice(0, 4000)}));
  if(!messages.length || messages[messages.length-1].role!=="user") return json({error:"no message"}, 400);
  let reply = "", tokens = 0;
  for(let step=0; step<8; step++){
    const r = await fetch("https://api.anthropic.com/v1/messages", {method:"POST", headers:{"x-api-key":env.ANTHROPIC_API_KEY, "anthropic-version":"2023-06-01", "content-type":"application/json"},
      body: JSON.stringify({model: env.MODEL || "claude-sonnet-4-5", max_tokens: 1200, system: systemPrompt(state, nowMs), tools: TOOLS, messages})});
    if(!r.ok) return json({error:"Claude API error "+r.status+": "+(await r.text()).slice(0,300)}, 502);
    const j = await r.json(); tokens += (j.usage?.input_tokens||0) + (j.usage?.output_tokens||0);
    messages.push({role:"assistant", content: j.content});
    const uses = j.content.filter(c => c.type==="tool_use");
    reply = j.content.filter(c => c.type==="text").map(c => c.text).join("\n").trim() || reply;
    if(!uses.length || j.stop_reason!=="tool_use") break;
    const results = [];
    for(const u of uses){
      let out;
      try{
        const {collection:col, id, ids, data, merge} = u.input || {};
        if(!["config","tasks","courses","days","sessions"].includes(col)) throw new Error("unknown collection");
        const get = i => col==="config"? state[i] : state[col][i];
        if(u.name==="get_docs"){
          if(ids && ids.length) out = Object.fromEntries(ids.map(i => [i, get(i) ?? null]));
          else if(col==="config") out = {settings:state.settings, schedule:state.schedule};
          else if(col==="sessions") out = Object.fromEntries(Object.entries(state.sessions).filter(([,s]) => s.start > nowMs - 14*864e5));
          else out = state[col];
        } else if(u.name==="put_doc"){
          if(!id || !/^[A-Za-z0-9_\-.~:@+]+$/.test(id)) throw new Error("bad id");
          let d = merge? {...(get(id)||{}), ...data} : data;
          d = Object.fromEntries(Object.entries(d).filter(([,v]) => v!==null));
          if(col==="config") state[id] = d; else state[col][id] = d;
          changes.push({c:col, i:id, d, u:Date.now()}); out = {ok:true, doc:d};
        } else if(u.name==="delete_doc"){
          if(col==="config") state[id] = null; else delete state[col][id];
          changes.push({c:col, i:id, x:true, u:Date.now()}); out = {ok:true};
        } else throw new Error("unknown tool");
      }catch(e){ out = {error:String(e.message||e)}; }
      results.push({type:"tool_result", tool_use_id:u.id, content: JSON.stringify(out).slice(0, 60000)});
    }
    messages.push({role:"user", content: results});
  }
  if(changes.length){
    let saved = await writeFile(env, "data.json", (mergeChanges(store, changes), store), sha, "Claude chat edit");
    if(!saved) await update(env, "data.json", EMPTY(), s => mergeChanges(s, changes), "Claude chat edit");
  }
  return json({reply: reply || "Done.", changed: changes.length, tokens});
}

/* ---------- notifications ---------- */
async function pushAll(env, messages){
  if(!messages.length) return {sent:0};
  const {obj: subs, sha} = await readFile(env, "push.json", {subs:[]});
  const gone = new Set(); let sent = 0;
  for(const s of subs.subs){
    for(const m of messages){
      const status = await sendPush(s, m, env).catch(() => 0);
      if(status===404 || status===410){ gone.add(s.endpoint); break; }
      if(status>=200 && status<300) sent++;
    }
  }
  if(gone.size) await update(env, "push.json", {subs:[]}, o => { const n = o.subs.length; o.subs = o.subs.filter(s => !gone.has(s.endpoint)); return o.subs.length!==n; }, "Remove expired push subscriptions");
  return {sent};
}
async function cron(env, scheduledTime){
  const t1 = Math.floor(scheduledTime/3e5)*3e5, t0 = t1 - 3e5;
  const {obj: store} = await readFile(env, "data.json", EMPTY());
  const msgs = notificationsFor(toState(store), t0, t1);
  return pushAll(env, msgs);
}

/* ---------- timer: lock-screen Shortcuts + "timer running" notification ---------- */
const COURSE_ALIASES = [[/^(tsa|time ?series)$/i,"TSA"],[/^(ml|machine ?learning)$/i,"ML"],[/^(ads|dsa|algo|algorithms?)$/i,"ADS"],
  [/^(dev|dev ?econ|development)$/i,"DEV"],[/^(mm|math|math ?methods)$/i,"MM"],[/^(rp|capstone|research)$/i,"RP"],[/^(ent|entrepreneurship)$/i,"ENT"]];
const CAT_SET = ["study","class","work","gym","road","diet","life"];
const sid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const fmtMins = m => { m = Math.round(m); return m < 60 ? m+"m" : Math.floor(m/60)+"h"+(m%60? " "+m%60+"m" : ""); };

// Push messages that mirror a timer change (start → "running since", stop → "logged").
// tag "timer" makes each new message replace the previous one on the lock screen.
// prev = the timer doc before this change; repeats (same start) and stale replays are skipped.
function timerPushes(state, changes, prev){
  const o = off(state), out = [];
  for(const c of changes||[]){
    if(c.c!=="config" || c.i!=="timer" || c.x) continue;
    if(!(c.u > Date.now() - 10*6e4)) continue; // an offline change synced much later: don't buzz
    const t = c.d || {};
    if(t.running && prev?.running && prev.start===t.start) continue; // e.g. distraction counter update
    if(!t.running && !prev?.running) continue;
    if(t.running){
      out.push({tag:"timer", title:`⏱ ${t.title||"Timer"} · since ${clockS(t.start + o)}`, body:"Timer running. Stop it from your lock-screen Shortcut or the app.", url:"./", ttl:12*3600});
    } else {
      const s = (changes||[]).find(x => x.c==="sessions" && !x.x && x.d && x.d.end && Math.abs(x.d.end - (c.u||0)) < 5*6e4);
      out.push({tag:"timer", title: s? `✓ Logged ${fmtMins(s.d.mins)} · ${s.d.title}` : "Timer stopped", body: s? `${clockS(s.d.start + o)}–${clockS(s.d.end + o)}` : "", url:"./", ttl:3600});
    }
  }
  return out;
}

// /timer?action=start|stop|toggle|status&course=TSA&title=...&cat=study  → plain-text reply for Shortcuts
async function timerEndpoint(env, params){
  const action = (params.action || "toggle").toLowerCase(), now = Date.now();
  const {obj: store} = await readFile(env, "data.json", EMPTY());
  const state = toState(store), cur = state.timer, o = off(state);
  const running = !!cur?.running;
  if(action==="status") return {text: running? `${cur.title} · ${fmtMins((now-cur.start)/6e4)} (since ${clockS(cur.start+o)})` : "No timer running", changes:[]};

  const changes = [];
  const stop = () => {
    if(!running) return null;
    const mins = (now - cur.start)/6e4;
    changes.push({c:"config", i:"timer", d:{running:false}, u:now});
    if(mins >= 1){
      const d = {taskId:cur.taskId||null, title:cur.title, cat:cur.cat, course:cur.course||null, start:cur.start, end:now, mins:Math.round(mins*10)/10, distractions:cur.distractions||0};
      changes.push({c:"sessions", i:sid(), d, u:now});
    }
    return mins;
  };

  if(action==="stop" || (action==="toggle" && running)){
    const mins = stop();
    return {prev: cur, text: mins==null? "No timer running" : mins < 1? "Stopped (under a minute, not logged)" : `Logged ${fmtMins(mins)} of ${cur.title}`, changes};
  }
  if(action!=="start" && action!=="toggle") return {text:"Unknown action. Use start, stop, toggle or status.", changes:[], status:400};

  // start (stops and logs any running timer first)
  let course = null;
  const raw = String(params.course||"").trim();
  if(raw){ course = state.courses[raw.toUpperCase()]? raw.toUpperCase() : (COURSE_ALIASES.find(([re]) => re.test(raw))||[])[1] || null; }
  const cat = CAT_SET.includes(String(params.cat||"").toLowerCase())? params.cat.toLowerCase() : course? "study" : "life";
  const title = String(params.title||"").trim().slice(0,120) || (course? (state.courses[course]?.short || course)+" study" : cat[0].toUpperCase()+cat.slice(1));
  const prev = stop();
  // timer doc must be written after the stop above, so give it a later timestamp
  changes.push({c:"config", i:"timer", d:{running:true, start:now, distractions:0, target:0, title, cat, course, taskId:null}, u:now+1});
  return {prev: cur, text: `Started ${title} at ${clockS(now+o)}` + (prev!=null && prev>=1? ` · logged ${fmtMins(prev)} of ${cur.title}` : ""), changes};
}

/* ---------- HTTP ---------- */
export default {
  async fetch(req, env, ctx){
    if(req.method==="OPTIONS") return new Response(null, {headers:CORS});
    const url = new URL(req.url);
    if(url.pathname==="/health") return json({ok:true});
    if((req.headers.get("authorization")||"") !== "Bearer "+env.APP_PASSWORD) return json({error:"wrong password"}, 401);
    try{
      if(url.pathname==="/vapid") return json({key: env.VAPID_PUBLIC, chat: !!env.ANTHROPIC_API_KEY});
      const body = req.method==="POST"? await req.json().catch(() => ({})) : {};
      if(url.pathname==="/timer"){
        const params = {...Object.fromEntries(url.searchParams), ...body};
        const r = await timerEndpoint(env, params);
        if(r.changes.length){
          const store = await update(env, "data.json", EMPTY(), s => mergeChanges(s, r.changes), "Timer (Shortcut)");
          ctx.waitUntil(pushAll(env, timerPushes(toState(store), r.changes, r.prev)).catch(() => {}));
        }
        return new Response(r.text, {status: r.status||200, headers:{"content-type":"text/plain; charset=utf-8", ...CORS}});
      }
      if(url.pathname==="/sync"){
        const changes = body.changes || [];
        let prevTimer = null;
        const store = changes.length
          ? await update(env, "data.json", EMPTY(), s => { prevTimer = s.docs["config/timer"]?.d || null; return mergeChanges(s, changes); }, "App sync")
          : (await readFile(env, "data.json", EMPTY())).obj;
        // timer started/stopped in the app → mirror it on the lock screen (only if this change actually won)
        const tc = changes.filter(c => c && c.c==="config" && c.i==="timer" && store.docs["config/timer"]?.u===c.u);
        if(tc.length) ctx.waitUntil(pushAll(env, timerPushes(toState(store), [...tc, ...changes.filter(c => c && c.c==="sessions")], prevTimer)).catch(() => {}));
        return json({docs: store.docs, ts: Date.now()});
      }
      if(url.pathname==="/subscribe"){
        const sub = body.subscription; if(!sub?.endpoint || !sub?.keys?.p256dh) return json({error:"bad subscription"}, 400);
        await update(env, "push.json", {subs:[]}, o => { if(o.subs.some(s => s.endpoint===sub.endpoint)) return false; o.subs.push({endpoint:sub.endpoint, keys:sub.keys, added:Date.now(), device:String(body.device||"").slice(0,80)}); return true; }, "Add push subscription");
        return json({ok:true});
      }
      if(url.pathname==="/unsubscribe"){
        await update(env, "push.json", {subs:[]}, o => { const n = o.subs.length; o.subs = o.subs.filter(s => s.endpoint!==body.endpoint); return o.subs.length!==n; }, "Remove push subscription");
        return json({ok:true});
      }
      if(url.pathname==="/test-push"){
        const {obj: store} = await readFile(env, "data.json", EMPTY());
        const b = buildBrief(toState(store), Date.now());
        return json(await pushAll(env, [{tag:"test", title:"Cockpit notifications work ✓", body:b.pushBody, url:"./#brief"}]));
      }
      if(url.pathname==="/chat") return await chat(env, body);
      return json({error:"not found"}, 404);
    }catch(e){ return json({error:String(e.message||e)}, 500); }
  },
  async scheduled(event, env, ctx){ ctx.waitUntil(cron(env, event.scheduledTime)); },
};
