"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { configured, supabase } from "@/lib/supabase";
import { dailySummary, dayOfWeek, defaultPlans, emptyData, localDate, schemas, weightTrend, type Data, type Row, type Table } from "@/lib/domain";
import { demoData } from "@/lib/demo";

type Field = { key: string; label: string; type?: string; options?: string[]; optional?: boolean; min?: number; max?: number; };
const fields: Record<Table, Field[]> = {
 profiles: [{key:"height_cm",label:"身高 cm",min:50,max:250},{key:"goal_weight_kg",label:"目标体重 kg",min:20,max:400},{key:"calorie_target",label:"每日摄入目标 kcal",min:500,max:10000},{key:"protein_target",label:"每日蛋白质目标 g",min:0,max:500},{key:"timezone",label:"时区",type:"text"}],
 body_measurements: [{key:"logged_on",label:"日期",type:"date"},{key:"weight_kg",label:"体重 kg",min:20,max:400},{key:"body_fat_percent",label:"体脂 %",optional:true,min:1,max:75},{key:"waist_cm",label:"腰围 cm",optional:true,min:20,max:250}],
 training_plans: [{key:"day_of_week",label:"星期（0 周日，1 周一 … 6 周六）",min:0,max:6},{key:"name",label:"计划名称",type:"text"},{key:"exercises",label:"动作、组数与次数",type:"textarea"}],
 workout_logs: [{key:"logged_on",label:"日期",type:"date"},{key:"name",label:"训练名称",type:"text"},{key:"duration_minutes",label:"时长 min",min:1,max:1440},{key:"calories",label:"训练活动热量 kcal",min:0,max:15000}],
 food_entries: [{key:"logged_on",label:"日期",type:"date"},{key:"meal",label:"餐次",options:["早餐","午餐","晚餐","加餐"]},{key:"name",label:"食物与份量",type:"text"},{key:"calories",label:"热量 kcal",min:0,max:15000},{key:"protein",label:"蛋白质 g",min:0,max:1000},{key:"carbs",label:"碳水 g",min:0,max:2000},{key:"fat",label:"脂肪 g",min:0,max:1000}],
 daily_energy: [{key:"logged_on",label:"日期",type:"date"},{key:"active_kcal",label:"全天活动消耗 kcal",min:0,max:15000},{key:"resting_kcal",label:"全天静息消耗 kcal",min:0,max:10000}]
};
const titles: Record<Table,string> = { profiles:"身体与目标设置",body_measurements:"身体记录",training_plans:"训练计划",workout_logs:"训练打卡",food_entries:"饮食记录",daily_energy:"全天能量消耗" };
const tabs = [["today","概览","◈"],["body","身体数据","◉"],["training","训练计划","↗"],["food","饮食记录","◌"],["analysis","数据分析","⌁"],["settings","设置与同步","⚙"]];
const defaults: Record<string,string> = { height_cm:"175",goal_weight_kg:"70",calorie_target:"2100",protein_target:"120",timezone:"Asia/Shanghai",day_of_week:"2",meal:"早餐",calories:"0",protein:"0",carbs:"0",fat:"0" };

export default function Tracker() {
 const generation=useRef(0);
 const [session,setSession] = useState<Session|null>(null);
 const [ready,setReady] = useState(false);
 const [demo,setDemo] = useState(false);
 const [recovery,setRecovery] = useState(false);
 const [tab,setTab] = useState("today");
 const [date,setDate] = useState(localDate());
 const [data,setData] = useState<Data>(emptyData);
 const [busy,setBusy] = useState(false);
 const [message,setMessage] = useState("");
 const [editing,setEditing] = useState<{table:Table;row?:Row}|null>(null);
 const [authMode,setAuthMode] = useState<"login"|"register"|"reset">("login");
 useEffect(()=>{
   if (!supabase) { setReady(true); return; }
   supabase.auth.getSession().then(({data,error})=>{ if(error)setMessage(error.message);generation.current++;setSession(data.session);setReady(true); });
   const {data:{subscription}} = supabase.auth.onAuthStateChange((event,current)=>{
     generation.current++;setSession(current); setData(emptyData()); setEditing(null);
     if(event==="PASSWORD_RECOVERY")setRecovery(true);
   });
   return ()=>subscription.unsubscribe();
 },[]);
 const load = useCallback(async()=>{
   if (demo) { setData(demoData()); return; }
   if (!supabase || !session) return;
   const uid = session.user.id;
   const ticket=++generation.current;
   const result = emptyData();
   for (const table of Object.keys(result) as (keyof Data)[]) {
     // Page through every row; no silent PostgREST 1,000-row truncation.
     for(let offset=0;;offset+=500) {
       const {data:rows,error} = await supabase.from(table).select("*").eq("user_id",uid).order("id").range(offset,offset+499);
       if(error)throw new Error(error.message);
       result[table].push(...rows);
       if(rows.length<500)break;
     }
   }
   if(ticket===generation.current)setData(result);
 },[session,demo]);
 useEffect(()=>{ load().catch(e=>setMessage(String(e))); },[load]);
 const run = async(action:()=>Promise<void>)=>{
   if(busy)return; setBusy(true);setMessage("");
   try { await action(); } catch(e) { setMessage(e instanceof Error?e.message:String(e)); }
   finally { setBusy(false); }
 };
 async function auth(form:FormData) {
   if(!supabase)throw new Error("请先配置 Supabase，或进入演示模式。");
   const email=String(form.get("email")).trim(), password=String(form.get("password")??"");
   if(authMode==="reset"){
     const {error}=await supabase.auth.resetPasswordForEmail(email,{redirectTo:location.origin});
     if(error)throw error;setMessage("如该邮箱已注册，将收到密码重置邮件。");return;
   }
   const {data:result,error}=authMode==="login"
     ? await supabase.auth.signInWithPassword({email,password})
     : await supabase.auth.signUp({email,password,options:{emailRedirectTo:location.origin}});
   if(error)throw error;
   if(!result.session)setMessage("注册成功，请前往邮箱确认后登录。");
 }
 async function save(form:FormData) {
   if(!editing || !supabase || !session || demo)return;
   const raw=Object.fromEntries(form.entries());
   const parsed=schemas[editing.table].safeParse(raw);
   if(!parsed.success)throw new Error(parsed.error.issues.map(i=>i.path.join(".")+": "+i.message).join("；"));
   const table=editing.table;
   const payload: Record<string,unknown>={...parsed.data,user_id:session.user.id,...(editing.row?{id:editing.row.id}:{})};
   const conflict=table==="profiles"?"user_id":table==="body_measurements"||table==="daily_energy"?"user_id,logged_on":undefined;
   const query=editing.row
     ? supabase.from(table).update(parsed.data).eq("id",editing.row.id).eq("user_id",session.user.id)
     : conflict ? supabase.from(table).upsert(payload,{onConflict:conflict}) : supabase.from(table).insert(payload);
   const {error}=await query;
   if(error)throw error;
   setEditing(null);await load();setMessage("已保存");
 }
 async function remove(table:Table,row:Row) {
   if(!supabase||demo||!session||!window.confirm("确认删除这条记录？"))return;
   const {error}=await supabase.from(table).delete().eq("id",row.id).eq("user_id",session.user.id);
   if(error)throw error;await load();
 }
 const profile=data.profiles[0];
 useEffect(()=>{ if(typeof profile?.timezone==="string") { try {setDate(localDate(new Date(),profile.timezone));} catch {setMessage("个人资料中的时区无效，请在设置中修正。");} } },[profile?.timezone]);
 const summary=dailySummary(data,date);
 const trend=weightTrend(data);
 const latest=trend.at(-1);
 const selectedPlans=data.training_plans.filter(p=>Number(p.day_of_week)===dayOfWeek(date));
 const shown=(table:keyof Data)=>data[table].filter(r=>!r.logged_on || r.logged_on===date);
 function add(table:Table,row?:Row){setEditing({table,row});setMessage("");}
 function list(table:Table,rows:Row[]) {
   return <div className="records">{rows.length===0?<div className="empty">还没有记录，从第一条开始吧。</div>:rows.map(row=><article className="record" key={row.id}><div>
     <strong>{String(row.name??(table==="body_measurements"?row.weight_kg+" kg":table==="daily_energy"?"活动 "+row.active_kcal+" · 静息 "+row.resting_kcal:"目标设置"))}</strong>
     <p>{table==="training_plans"?["周日","周一","周二","周三","周四","周五","周六"][Number(row.day_of_week)]:String(row.logged_on??"")}</p>
     {table==="training_plans"&&<p className="multiline">{String(row.exercises)}</p>}
     {table==="food_entries"&&<p>{String(row.meal)} · {String(row.calories)} kcal · 蛋白质 {String(row.protein)} g</p>}
     {table==="workout_logs"&&<p>{String(row.duration_minutes)} min · {String(row.calories)} kcal</p>}
     {table==="body_measurements"&&<p>体脂 {String(row.body_fat_percent??"—")}% · 腰围 {String(row.waist_cm??"—")} cm</p>}
   </div>{!demo&&<div className="row-actions"><button disabled={busy} onClick={()=>add(table,row)}>编辑</button><button disabled={busy} onClick={()=>run(()=>remove(table,row))}>删除</button></div>}</article>)}</div>;
 }
 function chart() {
   if(trend.length<2)return <div className="empty">记录至少两天体重后显示趋势。</div>;
   const points=trend.slice(-30), min=Math.min(...points.map(p=>p.weight))-0.5,max=Math.max(...points.map(p=>p.weight))+0.5;
   const start=new Date(points[0].date).getTime(), span=new Date(points.at(-1)!.date).getTime()-start||1;
   const coords=points.map(p=>[20+(new Date(p.date).getTime()-start)/span*660,170-(p.weight-min)/(max-min)*140]);
   return <><svg className="chart" viewBox="0 0 700 200" role="img" aria-label="最近三十次体重记录趋势"><line x1="20" y1="180" x2="680" y2="180" stroke="#dae3df"/><polyline points={coords.map(p=>p.join(",")).join(" ")} fill="none" stroke="#16856c" strokeWidth="3"/>{coords.map(([x,y],i)=><circle key={i} cx={x} cy={y} r="4" fill="#16856c"><title>{points[i].date+"："+points[i].weight+" kg"}</title></circle>)}</svg><div className="spread muted"><span>{points[0].date}</span><span>{points.at(-1)?.date}</span></div></>;
 }
 if(!ready)return <main className="auth"><p>正在载入…</p></main>;
 if(!session&&!demo)return <main className="auth"><div className="auth-brand">◈ FITNESS TRACKER <small>V1.0</small></div><div className="auth-card"><span className="eyebrow">健康有迹可循</span><h1>每一点改变，<br/>都值得被看见。</h1><p className="muted">记录身体、训练和饮食，让坚持有方向。</p>
   {!configured&&<div className="notice">尚未配置 Supabase。正式注册登录需完成 README 中的部署配置；可先查看演示。</div>}
   <form onSubmit={e=>{e.preventDefault();const form=new FormData(e.currentTarget);void run(()=>auth(form));}}>
     <label>邮箱<input name="email" type="email" autoComplete="email" required maxLength={254}/></label>
     {authMode!=="reset"&&<label>密码<input name="password" type="password" autoComplete={authMode==="register"?"new-password":"current-password"} minLength={12} required maxLength={128}/><small>至少 12 位</small></label>}
     <button className="primary" disabled={busy||!configured}>{busy?"处理中…":authMode==="register"?"创建账号":authMode==="reset"?"发送重置邮件":"登录"}</button>
   </form>
   <div className="auth-links">{(["login","register","reset"] as const).filter(m=>m!==authMode).map(m=><button key={m} onClick={()=>{setAuthMode(m);setMessage("");}}>{m==="login"?"已有账号？登录":m==="register"?"创建新账号":"忘记密码"}</button>)}</div>
   <button className="demo-button" onClick={()=>{setDemo(true);setMessage("");}}>查看演示 · 仅虚构数据 →</button>
   {message&&<p role="status" className="notice">{message}</p>}
 </div><p className="auth-foot">你的健康记录，仅属于你。</p></main>;
 return <div className="app-shell">
   <aside className="sidebar"><a className="brand" href="/">◈ <span>FITNESS<br/><small>TRACKER</small></span></a><p className="nav-caption">我的健康空间</p><nav>{tabs.map(([key,label,icon])=><button key={key} className={tab===key?"nav-item active":"nav-item"} onClick={()=>{setTab(key);setEditing(null);}}><span>{icon}</span>{label}</button>)}</nav><div className="sidebar-foot"><span className="avatar">{demo?"D":session?.user.email?.[0]?.toUpperCase()}</span><div><strong>{demo?"演示访客":"个人空间"}</strong><small>{demo?"虚构数据 · 只读":"数据按账号隔离"}</small></div></div></aside>
   <main className="workspace"><header className="topbar"><span>个人健康管理 / {tabs.find(t=>t[0]===tab)?.[1]}</span><button disabled={busy} onClick={()=>run(async()=>{generation.current++;setData(emptyData());setEditing(null);if(demo){setDemo(false);return;}const {error}=await supabase!.auth.signOut();if(error)throw error;})}>退出{demo?"演示":"登录"}</button></header>
   {demo&&<div className="demo-banner">演示模式 · 所有数据均为虚构，仅供体验界面，无法保存或同步。</div>}
   <div className="page-heading"><div><span className="eyebrow">MAKE PROGRESS, EVERY DAY</span><h1>{tabs.find(t=>t[0]===tab)?.[1]}</h1><p className="muted">照顾好自己，从记录今天开始。</p></div><label className="date-picker">记录日期<input aria-label="记录日期" type="date" value={date} onChange={e=>setDate(e.target.value||localDate())}/></label></div>
   {message&&<div role="status" className="notice">{message}</div>}
   {recovery&&<section className="panel"><h2>设置新密码</h2><form onSubmit={e=>{e.preventDefault();const password=String(new FormData(e.currentTarget).get("newPassword"));void run(async()=>{const {error}=await supabase!.auth.updateUser({password});if(error)throw error;setRecovery(false);setMessage("密码已更新");});}}><label>新密码<input name="newPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required/></label><button className="primary" disabled={busy}>更新密码</button></form></section>}
   {tab==="today"&&<>
     <div className="stat-grid"><Stat label="最新体重" value={latest?.weight??"—"} unit="kg" note={latest?.date??"添加第一条身体记录"}/><Stat label="今日摄入" value={summary.intake} unit="kcal" note={profile?"目标 "+profile.calorie_target+" kcal":"先设置个人目标"}/><Stat label="今日消耗" value={summary.expenditure??"—"} unit="kcal" note={summary.source}/><Stat label="热量差额" value={summary.deficit??"—"} unit="kcal" note="消耗 − 摄入；正数为缺口"/></div>
     <div className="two-columns"><section className="panel"><div className="spread"><h2>体重变化</h2><button onClick={()=>setTab("body")}>查看记录 ↗</button></div>{chart()}</section><section className="panel dark"><span className="eyebrow">TODAY'S PLAN</span><h2>{selectedPlans.length?"今天，向目标靠近一步":"今天，给身体一点恢复时间"}</h2>{selectedPlans.map(p=><p key={p.id}>{String(p.name)}</p>)}<p>周一、周五为默认休息日。计划可按自己的节奏修改。</p><button onClick={()=>setTab("training")}>打开训练计划 →</button></section></div>
     <section className="panel"><div className="spread"><h2>营养与活动</h2><button disabled={demo||busy} onClick={()=>add("daily_energy",shown("daily_energy")[0])}>填写全天消耗</button></div><p>蛋白质 {summary.protein.toFixed(1)} / {String(profile?.protein_target??"—")} g · 步数 {String(summary.steps??"—")}</p><progress max={Number(profile?.protein_target)||120} value={summary.protein}/><p className="muted">全天消耗 = 静息 + 活动。训练热量不重复累加；Apple Health 数据优先于手动消耗。当天数据可能尚未完整。</p></section>
   </>}
   {tab==="body"&&<><section className="panel"><div className="spread"><h2>身体变化，一目了然</h2><button className="primary" disabled={demo||busy} onClick={()=>add("body_measurements")}>＋ 记录身体数据</button></div>{chart()}</section><section className="panel"><h2>手动记录</h2>{list("body_measurements",[...data.body_measurements].sort((a,b)=>String(b.logged_on).localeCompare(String(a.logged_on))))}<h2>Apple Health 测量</h2>{data.health_measurements.length?data.health_measurements.map(r=><p key={r.id}>{String(r.logged_on)} · {r.weight_kg!=null?String(r.weight_kg)+" kg":""} {r.body_fat_percent!=null?"体脂 "+r.body_fat_percent+"%":""}</p>):<p className="muted">尚未从 iPhone 同步测量。</p>}</section></>}
   {tab==="training"&&<><section className="panel"><div className="spread"><h2>每周训练计划</h2><div className="actions"><button disabled={demo||busy||data.training_plans.length>0} onClick={()=>run(async()=>{const {error}=await supabase!.from("training_plans").insert(defaultPlans.map(p=>({...p,user_id:session!.user.id})));if(error)throw error;await load();})}>载入默认计划</button><button className="primary" disabled={demo||busy} onClick={()=>add("training_plans")}>＋ 添加计划</button></div></div><p className="muted">默认周一、周五休息；其余日程可自由编辑。</p>{list("training_plans",[...data.training_plans].sort((a,b)=>Number(a.day_of_week)-Number(b.day_of_week)))}</section><section className="panel"><div className="spread"><h2>当日训练打卡</h2><button disabled={demo||busy} onClick={()=>add("workout_logs")}>＋ 记录训练</button></div>{list("workout_logs",shown("workout_logs"))}<h3>Apple Health 训练</h3>{shown("health_workouts").map(r=><p key={r.id}>类型 {String(r.activity_type)} · {String(r.duration_minutes)} min · {String(r.calories??"—")} kcal</p>)}<p className="muted">手动打卡与 Apple Health 训练分别显示；两者均不会重复增加全天消耗。</p></section></>}
   {tab==="food"&&<><div className="stat-grid"><Stat label="总摄入" value={summary.intake} unit="kcal"/><Stat label="蛋白质" value={summary.protein.toFixed(1)} unit="g"/><Stat label="碳水化合物" value={shown("food_entries").reduce((s,r)=>s+Number(r.carbs),0).toFixed(1)} unit="g"/><Stat label="脂肪" value={shown("food_entries").reduce((s,r)=>s+Number(r.fat),0).toFixed(1)} unit="g"/></div><section className="panel"><div className="spread"><h2>今天吃了什么</h2><button className="primary" disabled={demo||busy} onClick={()=>add("food_entries")}>＋ 记录饮食</button></div><p className="muted">按包装营养表或可靠食物数据库填写；此版本采用手动录入。</p>{list("food_entries",shown("food_entries"))}</section></>}
   {tab==="analysis"&&<><section className="panel"><h2>体重趋势</h2>{chart()}<p>累计记录 {trend.length} 天 · 首末体重变化 {trend.length>1?(trend.at(-1)!.weight-trend[0].weight).toFixed(1)+" kg":"—"}</p></section><section className="panel"><h2>最近七天能量记录</h2><div className="table-scroll"><table><thead><tr><th>日期</th><th>摄入 kcal</th><th>消耗 kcal</th><th>缺口 kcal</th><th>蛋白质 g</th></tr></thead><tbody>{Array.from({length:7},(_,i)=>{const d=new Date(date+"T12:00:00");d.setDate(d.getDate()-6+i);const day=localDate(d),s=dailySummary(data,day);return <tr key={day}><td>{day}</td><td>{s.intake}</td><td>{s.expenditure??"—"}</td><td>{s.deficit??"—"}</td><td>{s.protein.toFixed(1)}</td></tr>;})}</tbody></table></div><p className="muted">未记录饮食时，摄入显示 0，不代表当天实际未进食。热量差额是记录估算值。</p></section></>}
   {tab==="settings"&&<><section className="panel"><div className="spread"><h2>身体与目标</h2><button disabled={demo||busy} onClick={()=>add("profiles",profile)}>编辑目标</button></div>{profile?<p>身高 {String(profile.height_cm)} cm · 目标体重 {String(profile.goal_weight_kg)} kg<br/>摄入目标 {String(profile.calorie_target)} kcal · 蛋白质 {String(profile.protein_target)} g<br/>时区 {String(profile.timezone)}</p>:<p>设置自己的身高、目标体重与营养目标。</p>}<p className="muted">目标由你自行设定，不构成医疗建议。</p></section><section className="panel"><span className="eyebrow">APPLE HEALTH</span><h2>在 iPhone 上授权，一处查看健康记录。</h2><p>使用配套 iOS App 登录同一账号，授权后主动同步。网页无法直接读取 HealthKit。</p><p>同步范围：活动与静息能量、步数、运动时长与类型、心率、体重和体脂。腰围手动记录。</p><button disabled={busy} onClick={()=>run(load)}>刷新同步数据</button><p className="muted">最近同步：{data.health_daily.length?new Date(Math.max(...data.health_daily.map(r=>new Date(String(r.synced_at)).getTime()))).toLocaleString():"尚未同步"}。拒绝读取权限时系统可能返回空数据，不能据此判断授权状态。</p></section><section className="panel"><h2>数据与隐私</h2><p>支持导出全部记录与删除账号。账号删除会同时删除全部健康记录，无法恢复。</p><div className="actions"><button disabled={demo||busy} onClick={()=>{const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="fitness-data.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}>导出我的数据</button><button className="danger" disabled={demo||busy} onClick={()=>{if(window.prompt("此操作永久删除账号及全部记录。输入 DELETE 确认")!=="DELETE")return;void run(async()=>{const {error}=await supabase!.rpc("delete_my_account");if(error)throw error;await supabase!.auth.signOut({scope:"local"});setSession(null);setData(emptyData());});}}>删除账号与全部数据</button></div></section></>}
   {editing&&!demo&&<div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label={titles[editing.table]}><div className="spread"><h2>{editing.row?"编辑":"添加"}{titles[editing.table]}</h2><button aria-label="关闭编辑" disabled={busy} onClick={()=>setEditing(null)}>✕</button></div><form key={editing.table+(editing.row?.id??"new")} onSubmit={e=>{e.preventDefault();const form=new FormData(e.currentTarget);void run(()=>save(form));}}><div className="form-grid">{fields[editing.table].map(field=><label key={field.key}>{field.label}{field.optional?"（可选）":""}{field.options?<select name={field.key} defaultValue={String(editing.row?.[field.key]??defaults[field.key]??"")}>{field.options.map(o=><option key={o}>{o}</option>)}</select>:field.type==="textarea"?<textarea name={field.key} required maxLength={4000} defaultValue={String(editing.row?.[field.key]??"")}/>:<input name={field.key} type={field.type??"number"} step={field.key==="day_of_week"?"1":"any"} min={field.min} max={field.max} required={!field.optional} maxLength={field.type==="text"?100:undefined} defaultValue={String(editing.row?.[field.key]??(field.type==="date"?date:defaults[field.key]??""))}/>}</label>)}</div><div className="actions"><button className="primary" disabled={busy}>{busy?"保存中…":"保存记录"}</button><button type="button" disabled={busy} onClick={()=>setEditing(null)}>取消</button></div>{message&&<p role="status" className="notice">{message}</p>}</form></section></div>}
   <footer>FITNESS TRACKER V1.0 · 按自己的节奏，持续向前。</footer></main>
 </div>;
}
function Stat({label,value,unit,note}:{label:string;value:string|number;unit:string;note?:string}) {
 return <article className="stat"><span>{label}</span><div><strong>{value}</strong><small>{unit}</small></div>{note&&<p>{note}</p>}</article>;
}
