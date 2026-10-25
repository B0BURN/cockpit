// Shared cockpit logic: used by the app (browser) and the Worker (notifications).
// All times are handled in "shifted" epoch ms: real epoch + tz offset, read with getUTC* getters,
// so results are identical whatever the device or server time zone is.
export const DAYS = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
export const OFF_DEFAULT = 300; // Asia/Tashkent, UTC+5, no DST
const DAY = 864e5, HOUR = 36e5, MIN = 6e4;
const pad = n => String(n).padStart(2, "0");

export function off(data){ return ((data.settings && data.settings.tzOffsetMin) ?? OFF_DEFAULT) * MIN; }
export const ymdS = s => { const d = new Date(s); return d.getUTCFullYear()+"-"+pad(d.getUTCMonth()+1)+"-"+pad(d.getUTCDate()); };
export const parseYmdS = k => { const [y,m,d] = k.split("-").map(Number); return Date.UTC(y, m-1, d); };
export const dowS = s => (new Date(s).getUTCDay()+6)%7 + 1;
export const dayStartS = s => Math.floor(s/DAY)*DAY;
export const mondayS = s => dayStartS(s) - (dowS(s)-1)*DAY;
export const hm = t => { const [h,m] = (t||"0:0").split(":").map(Number); return h*60+(m||0); };
export const clockS = s => { const d = new Date(s); return pad(d.getUTCHours())+":"+pad(d.getUTCMinutes()); };
export const isRecurring = t => !!t.repeat;

export function semWeekS(data, s){
  const st = data.settings || {}, m = mondayS(s);
  if(st.weeks){ const i = st.weeks.findIndex(w => parseYmdS(w)===m); if(i>=0) return i+1;
    const b = (st.breaks||[]).find(b => s >= parseYmdS(b.start) && s < parseYmdS(b.end)+DAY); return b? "break" : null; }
  if(!st.semesterStart) return null;
  return Math.floor((dayStartS(s) - mondayS(parseYmdS(st.semesterStart)))/(7*DAY))+1;
}
export function inBreak(data, s){ return (data.settings?.breaks||[]).some(b => s >= parseYmdS(b.start) && s < parseYmdS(b.end)+DAY); }
export function holidayOnS(data, s){ return (data.settings?.holidays||[]).find(h => h.date===ymdS(s)); }
export function weekStartS(data, n){
  const st = data.settings || {};
  if(st.weeks && st.weeks[n-1]) return parseYmdS(st.weeks[n-1]);
  if(!st.semesterStart) return null;
  return mondayS(parseYmdS(st.semesterStart)) + (n-1)*7*DAY;
}
function firstClass(data, course){
  return (data.schedule?.blocks||[]).filter(b => b.course===course && b.cat==="class").sort((a,b)=>a.d-b.d||hm(a.s)-hm(b.s))[0];
}
// due time in shifted ms, or null
export function taskDueS(data, t){
  if(t.due) return Date.parse(t.due) + off(data);
  if(t.week){ const base = weekStartS(data, t.week); if(base==null) return null;
    const fc = firstClass(data, t.course), d = t.day || fc?.d || 1, time = t.time || fc?.s || "00:00";
    return base + (d-1)*DAY + hm(time)*MIN; }
  return null;
}
export function isLapsedS(t, dueS, nowS){ return !!(t.expire && dueS!=null && dueS < nowS - 3*HOUR); }
export function occursOnS(t, s){ const w = dowS(s);
  if(t.repeat==="daily") return true; if(t.repeat==="weekdays") return w<=5; if(t.repeat==="weekly") return (t.day||1)===w; return false; }
export const isExam = t => (t.weight||0) >= 20 || (/\b(midterm|final|exam)\b/i.test(t.title||"") && !/\b(plan|prep|revision|review)\b/i.test(t.title||""));
export const isGraded = t => !!t.weight || /quiz|midterm|final|exam/i.test(t.title||"");

export function blocksOnS(data, s){
  const off = holidayOnS(data, s) || inBreak(data, s);
  return (data.schedule?.blocks||[]).map((b,i)=>({...b,i})).filter(b => b.d===dowS(s) && !(off && b.cat==="class")).sort((a,b)=>hm(a.s)-hm(b.s));
}
export function openTasks(data, nowS){
  const out = [];
  for(const [id,t] of Object.entries(data.tasks||{})){
    if(t.done || t.dismissed || isRecurring(t)) continue;
    const d = taskDueS(data, t); if(d==null || isLapsedS(t, d, nowS)) continue;
    out.push({id, t, d});
  }
  return out.sort((a,b)=>a.d-b.d);
}
// overdue or inside the remind window
export function alertTasks(data, nowS){ return openTasks(data, nowS).filter(x => x.d - nowS <= (x.t.remind ?? 2)*DAY); }
// next occurrence of a recurring task within `days` days (that isn't done for that date)
export function recurringSoon(data, nowS, days=2){
  const out = [];
  for(const [id,t] of Object.entries(data.tasks||{})){
    if(!isRecurring(t) || t.done || t.dismissed || t.repeat==="daily") continue;
    for(let i=0;i<=days;i++){ const s = dayStartS(nowS)+i*DAY;
      if(occursOnS(t, s) && !(t.doneDates||[]).includes(ymdS(s))){ out.push({id,t,d:s,i}); break; } }
  }
  return out;
}

export function countdown(ms){
  const a = Math.abs(ms), d = Math.floor(a/DAY), h = Math.floor(a%DAY/HOUR), m = Math.round(a%HOUR/MIN);
  const s = d? d+"d"+(h? " "+h+"h":"") : h? h+"h"+(m? " "+m+"m":"") : Math.max(1,m)+"m";
  return ms < 0 ? s+" overdue" : "in "+s;
}
export function fmtDayS(s, nowS){
  const n = Math.round((dayStartS(s)-dayStartS(nowS))/DAY), d = new Date(s);
  const day = n===0? "Today" : n===1? "Tomorrow" : n===-1? "Yesterday" : Math.abs(n)<7? DAYS[dowS(s)-1] : d.getUTCDate()+" "+["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
  const c = clockS(s); return day + (c==="00:00"? "" : " "+c);
}

/* ----- grades ----- */
export function calcCourse(c){
  let earned=0, remMax=0, remExp=0, max=0, lost=0;
  for(const k of c.components||[]){ max += k.max; const has = k.real!=null && k.real!=="";
    if(has && k.multi && k.doneMax!=null && +k.doneMax < k.max){ const dm = +k.doneMax; earned += +k.real; lost += dm - +k.real; remMax += k.max - dm; remExp += +(k.exp||0)*(k.max-dm)/k.max; }
    else if(has){ earned += +k.real; lost += k.max - +k.real; } else { remMax += k.max; remExp += +(k.exp||0); } }
  const projected = earned + remExp;
  return {earned, remMax, remExp, max, lost, projected, gap: (c.target||0) - projected};
}

/* ----- body ----- */
export function planWeightAt(st, s){
  const sD = parseYmdS(st.startDate), gD = parseYmdS(st.goalDate), f = Math.min(1, Math.max(0, (s - sD)/(gD - sD)));
  return st.startWeight - (st.startWeight - st.goalWeight)*f;
}
export function avgWeight7(data, endKey){
  const end = parseYmdS(endKey), pts = Object.entries(data.days||{}).filter(([k,d]) => d && d.weight && parseYmdS(k) <= end && parseYmdS(k) > end - 7*DAY).map(([,d]) => +d.weight);
  return pts.length? {avg: pts.reduce((a,b)=>a+b,0)/pts.length, n: pts.length} : null;
}
export function lastWeight(data){
  const k = Object.keys(data.days||{}).filter(k => data.days[k]?.weight).sort().pop();
  return k? {k, v: +data.days[k].weight} : null;
}
export function sessionMins(data, keyS, cat, nowOff){
  return Object.values(data.sessions||{}).filter(s => s.cat===cat && ymdS(s.start + nowOff)===keyS).reduce((a,s)=>a+(s.mins||0),0);
}

/* ----- focus suggestion ----- */
export function focusSuggestion(data, nowS){
  const o = off(data), courses = data.courses || {};
  // study minutes per course over the last 7 days
  const studied = {};
  for(const s of Object.values(data.sessions||{})) if(s.cat==="study" && s.course && s.start + o > nowS - 7*DAY) studied[s.course] = (studied[s.course]||0) + (s.mins||0);
  const cand = {};
  for(const x of openTasks(data, nowS)){
    const c = x.t.course; if(!c || !isGraded(x.t)) continue;
    const days = (x.d - nowS)/DAY; if(days > 21) continue;
    let score = (x.t.weight || 5) / Math.max(0.5, days + 1);
    if(days < 0) score *= 0.5; // already past: less useful than the next one
    if(courses[c]?.passfail) score *= 0.5;
    if(!cand[c] || cand[c].score < score) cand[c] = {course:c, score, x};
  }
  let best = Object.values(cand).map(v => {
    const cc = courses[v.course]; const gap = cc? Math.max(0, calcCourse(cc).gap) : 0;
    const lowStudy = 1 + Math.max(0, 1 - (studied[v.course]||0)/120) * 0.3;
    return {...v, total: v.score * (1 + Math.min(gap,20)/50) * lowStudy};
  }).sort((a,b)=>b.total-a.total)[0];
  if(!best){ // nothing graded soon: course furthest below target
    const g = Object.entries(courses).filter(([,c])=>!c.passfail).map(([id,c]) => ({course:id, gap: calcCourse(c).gap})).sort((a,b)=>b.gap-a.gap)[0];
    if(!g) return null; best = {course:g.course, x:null, gap:g.gap};
  }
  const cc = courses[best.course] || {};
  const wk = best.x ? semWeekS(data, best.x.d) : null;
  const topic = (cc.syl?.topics||[]).filter(t => typeof wk==="number" ? t.week < wk && !/revision|review|midterm|final|exam/i.test(t.topic) : false).slice(-3).map(t => t.topic.split(";")[0]).join(", ");
  // the next free study block today (after now)
  const nowM = Math.floor((nowS - dayStartS(nowS))/MIN);
  const blk = blocksOnS(data, nowS).find(b => b.cat==="study" && hm(b.e) > nowM);
  return {course: best.course, name: cc.short || best.course, task: best.x?.t || null, due: best.x?.d ?? null, topics: topic, block: blk || null};
}

/* ----- morning brief ----- */
export function buildBrief(data, nowMs){
  const o = off(data), nowS = nowMs + o, st = data.settings || {}, wk = semWeekS(data, nowS);
  const d = new Date(nowS), head = DAYS[dowS(nowS)-1]+" "+d.getUTCDate()+" "+["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
  const wkTxt = wk==="break"? "Semester break" : wk? "Week "+wk : "Outside semester";
  const hol = holidayOnS(data, nowS);
  const blocks = blocksOnS(data, nowS).filter(b => ["class","work","gym","study"].includes(b.cat));
  const today = blocks.map(b => `${b.s} ${b.course && b.cat==="class"? b.course : b.t}${b.tentative? " (proposed)":""}`);
  const al = alertTasks(data, nowS), overdue = al.filter(x => x.d < nowS), soon = al.filter(x => x.d >= nowS);
  const line = x => `${isExam(x.t)? "🚨 ":""}${x.t.title} · ${countdown(x.d - nowS)}${x.t.course? " · "+x.t.course:""}${x.t.weight? " · "+x.t.weight+"%":""}`;
  const deadlines = [...overdue, ...soon].map(line);
  for(const r of recurringSoon(data, nowS, 2)) deadlines.push(`${r.t.title} · ${r.i===0? "today" : r.i===1? "tomorrow" : DAYS[dowS(r.d)-1]}`);
  // upcoming exams just outside their window (next 14 days)
  const exams = openTasks(data, nowS).filter(x => isExam(x.t) && x.d >= nowS && x.d - nowS <= 14*DAY && !al.includes(x));
  // yesterday
  const yS = nowS - DAY, yK = ymdS(yS), y = data.days?.[yK] || {};
  const gym = sessionMins(data, yK, "gym", o), study = sessionMins(data, yK, "study", o);
  const kcalT = st.kcal || 1950, protT = st.protein || 160, stepsT = st.steps || 10000;
  const a7 = avgWeight7(data, yK), plan = st.startDate? planWeightAt(st, dayStartS(nowS)) : null, lw = lastWeight(data);
  const yParts = [
    y.kcal!=null? `${y.kcal}/${kcalT} kcal` : "kcal –",
    y.protein!=null? `${y.protein}/${protT} g protein` : "protein –",
    y.steps!=null? `${y.steps} steps` : "steps –",
    `gym ${Math.round(gym)}m`, `study ${(study/60).toFixed(1)}h`];
  const wTxt = a7? `7d avg ${a7.avg.toFixed(1)} kg vs plan ${plan?.toFixed(1)} (${(a7.avg-plan>=0?"+":"")}${(a7.avg-plan).toFixed(1)})`
    : `no weigh-in in 7 days${lw? " (last "+lw.v+" kg on "+lw.k.slice(5)+")":""}; plan ${plan?.toFixed(1)} kg`;
  const f = focusSuggestion(data, nowS);
  const focus = f? `Study ${f.name}${f.task? ` for ${f.task.title} (${countdown(f.due-nowS)}${f.task.weight? ", "+f.task.weight+"%":""})`:""}${f.block? ` in the ${f.block.s}–${f.block.e} block` : " tonight"}${f.topics? ": "+f.topics : ""}.` : "";
  const nothingLogged = y.kcal==null && y.protein==null && y.steps==null && y.weight==null;
  // short push body
  const first = blocks[0];
  const pushBody = [
    first? `First: ${first.s} ${first.course && first.cat==="class"? first.course : first.t}` : "No classes or shifts today",
    overdue.length? `${overdue.length} overdue` : null,
    soon[0]? `${soon[0].t.title} ${countdown(soon[0].d-nowS)}` : exams[0]? `${exams[0].t.title} ${countdown(exams[0].d-nowS)}` : null,
    nothingLogged? "yesterday not logged" : (y.kcal!=null? `${y.kcal}/${kcalT} kcal` : null),
    f? `Focus: ${f.name}` : null].filter(Boolean).join(" · ");
  return {title: `${head} · ${wkTxt}${hol? " · "+hol.name : ""}`, today, deadlines, exams: exams.map(line), yesterday: yParts.join(" · "), weight: wTxt, focus, pushBody, nothingLogged};
}

/* ----- notifications for a 5-minute cron slot: (t0, t1] in real ms ----- */
export function notificationsFor(data, t0Real, t1Real){
  const o = off(data), t0 = t0Real + o, t1 = t1Real + o, out = [];
  const hit = s => s > t0 && s <= t1;
  const today = dayStartS(t1);
  // 1. morning brief at 06:05
  const briefAt = hm(data.settings?.briefTime || "06:05")*MIN;
  if(hit(today + briefAt)){ const b = buildBrief(data, t1Real); out.push({tag:"brief-"+ymdS(t1), title:b.title, body:b.pushBody, url:"./#brief"}); }
  // 2. blocks starting in 10 minutes (today and just after midnight)
  for(const dayS of [today, today+DAY]){
    for(const b of blocksOnS(data, dayS)){
      if(!["class","work","gym","study"].includes(b.cat)) continue;
      const start = dayS + hm(b.s)*MIN, lead = (data.settings?.blockLeadMin ?? 10)*MIN;
      if(!hit(start - lead)) continue;
      let body = `${b.s}–${b.e}${b.room? " · "+b.room : ""}`;
      if(b.cat==="study"){ const f = focusSuggestion(data, start - lead); if(f) body += ` · Suggested: ${f.name}${f.task? " ("+f.task.title+")":""}`; }
      out.push({tag:`blk-${ymdS(dayS)}-${b.i}`, title:`${b.t}${b.tentative? " (proposed)":""} in 10 min`, body, url:"./#today"});
    }
  }
  // 3. deadline thresholds
  for(const x of openTasks(data, t1 - 60*DAY)){
    const t = x.t, exam = isExam(t), remind = (t.remind ?? 2)*DAY;
    const marks = [[remind, "Reminder window opens"], [DAY, "Due in 24 hours"], [2*HOUR, "Due in 2 hours"]];
    if(exam){ marks.push([3*DAY, "3 days to go"]); marks.push([7*DAY, "1 week to go"]); }
    const seen = new Set();
    for(const [lead, label] of marks){
      if(lead > remind && !(exam && lead<=7*DAY)) continue;
      const at = x.d - lead; if(seen.has(at) || !hit(at)) continue; seen.add(at);
      out.push({tag:`dl-${x.id}-${lead}`, title:`${exam? "🚨 EXAM: ":""}${t.title}`,
        body:`${label} · ${fmtDayS(x.d, at)}${t.course? " · "+t.course:""}${t.weight? " · "+t.weight+"% of grade":""}`, url:"./#today"});
    }
  }
  // 4. evening log nudge
  const nudgeAt = hm(data.settings?.nudgeTime || "21:40")*MIN;
  if(hit(today + nudgeAt)){
    const k = ymdS(today), d = data.days?.[k] || {}, st = data.settings || {}, miss = [];
    if(d.weight==null) miss.push("weight"); if(d.kcal==null) miss.push("kcal"); if(d.protein==null) miss.push("protein"); if(d.steps==null) miss.push("steps");
    const parts = [];
    if(miss.length) parts.push("Not logged yet: "+miss.join(", "));
    if(d.kcal!=null) parts.push(`${d.kcal}/${st.kcal||1950} kcal`);
    if(d.protein!=null && d.protein < (st.protein||160)) parts.push(`${(st.protein||160)-d.protein} g protein to go`);
    if(d.steps!=null && d.steps < (st.steps||10000)) parts.push(`${(st.steps||10000)-d.steps} steps short`);
    if(parts.length) out.push({tag:"log-"+k, title:"Daily log", body:parts.join(" · "), url:"./#log"});
  }
  return out;
}
