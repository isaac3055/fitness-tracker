import { createClient } from "@supabase/supabase-js";
import { FREE_MEAL_MODEL, MEAL_PROMPT, mealRequestSchema, mealEstimateSchema, personalMeal, validatePhoto } from "./meal-photo";

type Env={enabled?:string;key?:string;url?:string;publicKey?:string};
type Access={authenticated:boolean;consume:()=>Promise<boolean>};
type Dependencies={env:Env;fetch:typeof fetch;authorize:(token:string)=>Promise<Access>};
const response=(status:number,error:string)=>Response.json({error},{status,headers:{"Cache-Control":"no-store"}});
export async function handleMealPhoto(request:Request,deps:Dependencies):Promise<Response> {
 if(deps.env.enabled!=="true" || !deps.env.key || !deps.env.url || !deps.env.publicKey)
  return response(503,"拍照分析尚未启用，请先使用手动记录。");
 const token=request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/)?.[1];
 if(!token)return response(401,"请先登录。");
 let access:Access;
 try {access=await deps.authorize(token);}catch{return response(503,"暂时无法验证登录，请稍后重试。");}
 if(!access.authenticated)return response(401,"登录已过期，请重新登录。");
 try {
  // Read a bounded stream even when content-length is absent or false.
  const reader=request.body?.getReader();
  if(!reader)return response(400,"请选择照片。");
  const chunks:Uint8Array[]=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
   if(size>1_210_000){await reader.cancel();return response(413,"照片太大，请换一张或重新拍照。");}chunks.push(value);}
  let parsed;
  try {parsed=mealRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));validatePhoto(parsed.image);}
  catch{return response(400,"照片或分食人数无效，请重新选择并同意照片分析。");}
  let allowed=false;
  try {allowed=await access.consume();}catch{return response(503,"拍照分析限额尚未配置，请先使用手动记录。");}
  if(!allowed)return response(429,"已达到分析次数限制，或操作过快。每人每天最多10次、全站100次，间隔至少10秒。");
  let upstream:Response;
  try {
   upstream=await deps.fetch("https://api.siliconflow.cn/v1/chat/completions",{
    method:"POST",redirect:"error",signal:AbortSignal.timeout(45000),
    headers:{"Authorization":"Bearer "+deps.env.key,"Content-Type":"application/json"},
    body:JSON.stringify({
     model:FREE_MEAL_MODEL,stream:false,enable_thinking:false,max_tokens:1800,
     response_format:{type:"json_object"},
     messages:[{role:"system",content:MEAL_PROMPT},{role:"user",content:[
      {type:"text",text:"请分析这张照片中的整份食物，输出约定的 JSON。"},
      {type:"image_url",image_url:{url:parsed.image}}
     ]}]
    })
   });
  }catch{return response(502,"免费分析暂时不可用或超时，照片仍在本页，可稍后重试或手动记录。");}
  if(!upstream.ok)return response(upstream.status===429?429:502,"免费模型暂时不可用；未切换至其他模型，请稍后重试或手动记录。");
  try {
   const output=await upstream.json();
   if(output.model!==FREE_MEAL_MODEL || output.choices?.[0]?.finish_reason!=="stop")throw new Error("Incomplete response");
   const text=output.choices?.[0]?.message?.content;
   if(typeof text!=="string"||text.length>20000)throw new Error("Invalid response");
   const estimate=mealEstimateSchema.parse(JSON.parse(text));
   if(!estimate.food_detected)return response(422,"未识别到食物，请拍清楚食物和盘子后重试。");
   const personal=personalMeal(estimate,parsed.diners);
   if(personal.calories>15000||personal.protein>1000||personal.carbs>2000||personal.fat>1000)throw new Error("Out of range");
   return Response.json({estimate,personal,diners:parsed.diners},{headers:{"Cache-Control":"no-store"}});
  }catch{return response(502,"分析结果不完整或格式无效，未保存记录，请重试或手动填写。");}
 }catch{return response(400,"未能读取照片，请重试。");}
}

export function productionDependencies():Dependencies {
 const env={enabled:process.env.MEAL_PHOTO_ENABLED,key:process.env.SILICONFLOW_API_KEY,
  url:process.env.NEXT_PUBLIC_SUPABASE_URL,publicKey:process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY};
 return {env,fetch:globalThis.fetch,authorize:async token=>{
  const client=createClient(env.url!,env.publicKey!,{global:{headers:{Authorization:"Bearer "+token}},
   auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const {data,error}=await client.auth.getUser(token);
  if(error||!data.user)return {authenticated:false,consume:async()=>false};
  return {authenticated:true,consume:async()=>{
   const {data:allowed,error:rpcError}=await client.rpc("consume_meal_photo_quota");
   if(rpcError)throw rpcError;return allowed===true;
  }};
 }};
}
