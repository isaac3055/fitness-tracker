"use client";
import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { MAX_PHOTO_BYTES, mealEstimateSchema, personalMeal } from "../lib/meal-photo";
import type { MealEstimate } from "../lib/meal-photo";

async function preparePhoto(file:File):Promise<string> {
 if(!file.type.startsWith("image/") || file.size>20_000_000)throw new Error("请选择20MB以内的照片。");
 const url=URL.createObjectURL(file);
 try {
  const image=new Image();image.src=url;
  try {await image.decode();}catch{throw new Error("浏览器无法读取这张照片，请改用 JPEG 或 PNG，或重新拍照。");}
  if(!image.width||!image.height||image.width*image.height>60_000_000)throw new Error("照片分辨率过大，请重新拍照。");
  const ratio=Math.min(1,1280/Math.max(image.width,image.height));
  const canvas=document.createElement("canvas");
  canvas.width=Math.max(1,Math.round(image.width*ratio));canvas.height=Math.max(1,Math.round(image.height*ratio));
  const context=canvas.getContext("2d");
  if(!context)throw new Error("浏览器不支持处理照片。");
  context.fillStyle="#fff";context.fillRect(0,0,canvas.width,canvas.height);
  context.drawImage(image,0,0,canvas.width,canvas.height);
  // Re-encode pixels only: do not forward EXIF, GPS or the original filename.
  const data=canvas.toDataURL("image/jpeg",0.78);
  if(!data.startsWith("data:image/jpeg;base64,")||data.length>MAX_PHOTO_BYTES/3*4+23)throw new Error("压缩后照片仍过大，请换一张照片。");
  return data;
 }finally{URL.revokeObjectURL(url);}
}
type Props={onUse:(draft:ReturnType<typeof personalMeal>)=>void};
export default function PhotoMeal({onUse}:Props) {
 const [image,setImage]=useState("");
 const [diners,setDiners]=useState(1);
 const [consent,setConsent]=useState(false);
 const [busy,setBusy]=useState(false);
 const [preparing,setPreparing]=useState(false);
 const [error,setError]=useState("");
 const [estimate,setEstimate]=useState<MealEstimate|null>(null);
 const version=useRef(0),inFlight=useRef(false),controller=useRef<AbortController|null>(null);
 useEffect(()=>()=>{version.current++;controller.current?.abort();},[]);
 async function choose(file?:File) {
  if(!file)return;const ticket=++version.current;
  setPreparing(true);setError("");setEstimate(null);setImage("");
  try {const result=await preparePhoto(file);if(ticket===version.current)setImage(result);}
  catch(e){if(ticket===version.current)setError(e instanceof Error?e.message:"无法读取照片");}
  finally{if(ticket===version.current)setPreparing(false);}
 }
 async function analyze() {
  if(inFlight.current||!image||!consent)return;
  inFlight.current=true;setBusy(true);setError("");setEstimate(null);
  const ticket=version.current;
  const current=new AbortController();controller.current=current;
  try {
   const {data,error:sessionError}=await supabase!.auth.getSession();
   if(sessionError||!data.session)throw new Error("请重新登录后再试。");
   const result=await fetch("/api/meal-photo",{method:"POST",signal:current.signal,
    headers:{"Authorization":"Bearer "+data.session.access_token,"Content-Type":"application/json"},
    body:JSON.stringify({image,diners,consent:true})});
   const body=await result.json();
   if(!result.ok)throw new Error(body.error||"分析失败，请稍后重试。");
   const parsed=mealEstimateSchema.parse(body.estimate);
   if(ticket===version.current)setEstimate(parsed);
  }catch(e){if(ticket===version.current&&!current.signal.aborted)setError(e instanceof Error?e.message:"分析失败，请稍后重试。");}
  finally{inFlight.current=false;if(ticket===version.current)setBusy(false);}
 }
 const personal=estimate?personalMeal(estimate,diners):null;
 return <section className="panel photo-meal">
  <span className="eyebrow">照片估算 · 测试功能</span><h2>拍一张，记录这餐</h2>
  <p className="muted">拍清整份食物和盘子，选择几人分食。默认每人吃相同份量；吃得不同时，可在保存前修改自己的数据。</p>
  <div className="form-grid">
   <label>拍照<input type="file" accept="image/*" capture="environment" disabled={busy||preparing} onChange={e=>{void choose(e.target.files?.[0]);e.target.value="";}}/></label>
   <label>从相册选择<input type="file" accept="image/*" disabled={busy||preparing} onChange={e=>{void choose(e.target.files?.[0]);e.target.value="";}}/></label>
  </div>
  {preparing&&<p role="status">正在压缩照片…</p>}
  {image&&<img className="meal-preview" src={image} alt="待分析的饮食照片"/>}
  <label>几人分食<select value={diners} disabled={busy} onChange={e=>setDiners(Number(e.target.value))}>{Array.from({length:20},(_,i)=><option key={i+1} value={i+1}>{i+1} 人</option>)}</select></label>
  <label className="photo-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={e=>setConsent(e.target.checked)}/>我同意将这张照片发送至硅基流动进行 AI 分析。本应用不存储照片；确认后仅保存营养记录。请避免拍入人脸、证件等无关信息。</label>
  <p className="muted"><a href="https://api-docs.siliconflow.cn/docs/legals/privacy-policy" target="_blank" rel="noreferrer">查看硅基流动隐私政策</a>。重量和用油无法由照片准确判断，结果为估算值。</p>
  <button type="button" className="primary" disabled={!image||!consent||busy||preparing} onClick={()=>void analyze()}>{busy?"正在分析…":"智能分析照片"}</button>
  {error&&<p role="alert" className="notice">{error}</p>}
  {estimate&&personal&&<div className="photo-result">
   <h3>你的这一份（按 {diners} 人均分）</h3>
   <p>{estimate.dishes.map(d=>d.name).join("、")}</p>
   <p><strong>约 {personal.calories} kcal</strong> · 蛋白质 {personal.protein} g · 碳水 {personal.carbs} g · 脂肪 {personal.fat} g</p>
   <p className="muted">{estimate.uncertainty}</p>
   <button type="button" className="primary" onClick={()=>onUse(personal)}>填入记录，检查后保存</button>
   <p className="muted">尚未保存。调整分食人数会重新计算你的份额，无需再次调用模型。</p>
  </div>}
 </section>;
}
