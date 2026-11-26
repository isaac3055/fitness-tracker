import { createClient } from "@supabase/supabase-js";
import { FREE_MEAL_MODEL, MEAL_PROMPT, mealRequestSchema, mealEstimateSchema, personalMeal, validatePhoto } from "./meal-photo";

type Env={enabled?:string;key?:string;url?:string;publicKey?:string};
type Access={authenticated:boolean;consume:()=>Promise<boolean>};
type Diagnostic={event:"meal_photo_failure";stage:"connect"|"read"|"http";code:string;elapsedMs:number};
type Dependencies={env:Env;fetch:typeof fetch;authorize:(token:string)=>Promise<Access>;log?:(entry:Diagnostic)=>void};
// Below the 150s function limit, leaving time for authentication and response handling.
export const MEAL_TIMEOUT_MS=120_000;
export function providerFailureCode(error:unknown):string {
 const value=error as {name?:unknown;code?:unknown;cause?:{code?:unknown}};
 if(value?.name==="TimeoutError"||value?.name==="AbortError")return "PROVIDER_TIMEOUT";
 const code=value?.cause?.code??value?.code;
 return typeof code==="string" && ["ENOTFOUND","EAI_AGAIN","ECONNRESET","ECONNREFUSED","ETIMEDOUT","UND_ERR_CONNECT_TIMEOUT","UND_ERR_HEADERS_TIMEOUT","UND_ERR_SOCKET"].includes(code)
  ? code : "PROVIDER_NETWORK";
}
const response=(status:number,error:string)=>Response.json({error},{status,headers:{"Cache-Control":"no-store"}});
export async function handleMealPhoto(request:Request,deps:Dependencies):Promise<Response> {
 if(deps.env.enabled!=="true" || !deps.env.key || !deps.env.url || !deps.env.publicKey)
  return response(503,"拍照分析尚未启用，请先使用手动记录。");
 const apiKey=deps.env.key.trim();
 if(!apiKey || /[^!-~]/.test(apiKey))
  return response(503,"服务端 API 密钥格式无效，请检查 Vercel 中的 SILICONFLOW_API_KEY。");
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
  const started=Date.now();
  const report=(stage:Diagnostic["stage"],code:string)=>{
   // Never log error.message/cause, tokens, photos, prompts or provider output.
   try {deps.log?.({event:"meal_photo_failure",stage,code,elapsedMs:Math.max(0,Date.now()-started)});}catch{/* Logging cannot affect the response. */}
  };
  const networkFailure=(error:unknown,stage:"connect"|"read")=>{
   const code=providerFailureCode(error);report(stage,code);
   return code==="PROVIDER_TIMEOUT"
    ? response(504,"免费模型在120秒内未完成响应（PROVIDER_TIMEOUT）。未保存记录，也未自动重试；可稍后重试或手动记录。")
    : response(502,"服务器连接免费模型失败（"+code+"）。照片仍在本页，请稍后重试。");
  };
  let upstream:Response;
  try {
   upstream=await deps.fetch("https://api.siliconflow.cn/v1/chat/completions",{
    method:"POST",redirect:"error",signal:AbortSignal.timeout(MEAL_TIMEOUT_MS),
    headers:{"Authorization":"Bearer "+apiKey,"Content-Type":"application/json"},
    body:JSON.stringify({
     model:FREE_MEAL_MODEL,stream:false,enable_thinking:false,max_tokens:1800,
     response_format:{type:"json_object"},
     messages:[{role:"system",content:MEAL_PROMPT},{role:"user",content:[
      {type:"text",text:"请分析这张照片中的整份食物，输出约定的 JSON。"},
      {type:"image_url",image_url:{url:parsed.image}}
     ]}]
    })
   });
  }catch(error){return networkFailure(error,"connect");}
  if(!upstream.ok){
   report("http","PROVIDER_HTTP_"+upstream.status);
   if(upstream.status===401||upstream.status===403)return response(503,"模型服务拒绝访问（PROVIDER_HTTP_"+upstream.status+"），请检查 API 密钥与模型权限。");
   return response(upstream.status===429?429:502,"免费模型暂时不可用（PROVIDER_HTTP_"+upstream.status+"）；未切换至其他模型，请稍后重试或手动记录。");
  }
  let output;
  try {output=await upstream.json();}catch(error){return networkFailure(error,"read");}
  try {
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
 return {env,fetch:globalThis.fetch,log:entry=>console.warn(JSON.stringify(entry)),authorize:async token=>{
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
