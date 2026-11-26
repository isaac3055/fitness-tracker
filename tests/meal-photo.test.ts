import { describe,it,expect,vi } from "vitest";
import { handleMealPhoto, MEAL_TIMEOUT_MS, providerFailureCode } from "../src/lib/meal-photo-handler";
import { FREE_MEAL_MODEL,mealEstimateSchema,personalMeal,validatePhoto } from "../src/lib/meal-photo";

const estimate={food_detected:true,dishes:[{name:"测试餐",grams:600,calories:1200,protein:60,carbs:150,fat:40}],uncertainty:"重量和用油不确定"};
// Signature fixture only, not a real food photo; no network calls in these tests.
const image="data:image/jpeg;base64,"+Buffer.from([255,216,255,217]).toString("base64");
const env={enabled:"true",key:"synthetic-private-key",url:"https://fixture.invalid",publicKey:"synthetic-public-key"};
function setup({allowed=true,authenticated=true}={}) {
 const consume=vi.fn(async()=>allowed);
 const authorize=vi.fn(async()=>({authenticated,consume}));
 const fetch=vi.fn<typeof globalThis.fetch>(async()=>Response.json({model:FREE_MEAL_MODEL,choices:[{finish_reason:"stop",message:{content:JSON.stringify(estimate)}}]}));
 const log=vi.fn();
 return {deps:{env,authorize,fetch,log},consume,authorize,fetch,log};
}
const request=(body:unknown={image,diners:2,consent:true},token=true)=>new Request("https://fixture.invalid/api/meal-photo",{
 method:"POST",headers:{"Content-Type":"application/json",...(token?{Authorization:"Bearer synthetic-jwt"}:{})},body:JSON.stringify(body)});
describe("meal photo security and provider isolation",()=>{
 it("is disabled without explicit enablement and key",async()=>{
  const s=setup();
  for(const override of [{enabled:"false"},{key:""}]) {
   expect((await handleMealPhoto(request(),{...s.deps,env:{...env,...override}})).status).toBe(503);
  }
  expect(s.fetch).not.toHaveBeenCalled();expect(s.authorize).not.toHaveBeenCalled();
 });
 it("requires a validated session",async()=>{
  const s=setup({authenticated:false});
  expect((await handleMealPhoto(request({},false),s.deps)).status).toBe(401);
  expect((await handleMealPhoto(request(),s.deps)).status).toBe(401);
  expect(s.consume).not.toHaveBeenCalled();expect(s.fetch).not.toHaveBeenCalled();
 });
 it("rejects invalid diners, missing consent, external URLs and model injection",async()=>{
  const s=setup();
  for(const body of [
   {image,diners:0,consent:true},{image,diners:1.5,consent:true},
   {image,diners:2,consent:false},{image:"https://private.invalid/image",diners:2,consent:true},
   {image,diners:2,consent:true,model:"paid-model"}
  ])expect((await handleMealPhoto(request(body),s.deps)).status).toBe(400);
  expect(s.consume).not.toHaveBeenCalled();expect(s.fetch).not.toHaveBeenCalled();
 });
 it("bounds body size without trusting content-length",async()=>{
  const s=setup();
  expect((await handleMealPhoto(request({image:"x".repeat(1_220_000)}),s.deps)).status).toBe(413);
  expect(s.fetch).not.toHaveBeenCalled();
 });
 it("fails closed if quota is exhausted or unavailable",async()=>{
  const s=setup({allowed:false});
  expect((await handleMealPhoto(request(),s.deps)).status).toBe(429);
  s.consume.mockRejectedValueOnce(new Error("missing RPC"));
  expect((await handleMealPhoto(request(),s.deps)).status).toBe(503);
  expect(s.fetch).not.toHaveBeenCalled();
 });
 it("calls only fixed provider/model once and divides the total on server",async()=>{
  const s=setup(),result=await handleMealPhoto(request(),s.deps);
  expect(result.status).toBe(200);
  expect((await result.json()).personal).toMatchObject({calories:600,protein:30,carbs:75,fat:20});
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(s.fetch).toHaveBeenCalledTimes(1);expect(s.consume).toHaveBeenCalledTimes(1);
  const [url,options]=s.fetch.mock.calls[0] as unknown as [string,RequestInit];
  expect(url).toBe("https://api.siliconflow.cn/v1/chat/completions");
  expect(JSON.parse(options.body as string)).toMatchObject({model:FREE_MEAL_MODEL,enable_thinking:false});
  expect(JSON.parse(options.body as string)).not.toHaveProperty("diners");
 });
 it("does not retry or expose provider errors/secrets",async()=>{
  for(const status of [401,402,429,500]) {
   const s=setup();s.fetch.mockResolvedValueOnce(new Response("synthetic-private-key provider error",{status}));
   const result=await handleMealPhoto(request(),s.deps);
   expect(result.status).toBe(status===401?503:status===429?429:502);
   expect(await result.text()).not.toContain("synthetic-private-key");
   expect(s.fetch).toHaveBeenCalledTimes(1);
  }
 });
 it("handles timeout/network failure and never falls back",async()=>{
  const s=setup();s.fetch.mockRejectedValueOnce(new Error("timeout"));
  expect((await handleMealPhoto(request(),s.deps)).status).toBe(502);
  expect(s.fetch).toHaveBeenCalledTimes(1);
 });
 it("rejects malformed, truncated, wrong-model and out-of-range nutrition",async()=>{
  for(const override of [
   {choices:[{finish_reason:"length",message:{content:JSON.stringify(estimate)}}]},
   {model:"paid-model"},
   {choices:[{finish_reason:"stop",message:{content:"not JSON"}}]},
   {choices:[{finish_reason:"stop",message:{content:JSON.stringify({...estimate,dishes:[{...estimate.dishes[0],calories:-10}]})}}]}
  ]) {
   const s=setup();
   s.fetch.mockResolvedValueOnce(Response.json({model:FREE_MEAL_MODEL,choices:[{finish_reason:"stop",message:{content:JSON.stringify(estimate)}}],...override}));
   expect((await handleMealPhoto(request(),s.deps)).status).toBe(502);
  }
 });
 it("does not fabricate an entry when no food is detected",async()=>{
  const s=setup();
  s.fetch.mockResolvedValueOnce(Response.json({model:FREE_MEAL_MODEL,choices:[{finish_reason:"stop",message:{content:JSON.stringify({food_detected:false,dishes:[],uncertainty:"无食物"})}}]}));
  expect((await handleMealPhoto(request(),s.deps)).status).toBe(422);
 });
});
describe("nutrition and image validation",()=>{
 it("requires actual JPEG signature and rejects invalid base64",()=>{
  expect(()=>validatePhoto(image)).not.toThrow();
  for(const bad of ["data:image/jpeg;base64,YWJjZA==",image+"!",image.replace("jpeg","png")])
   expect(()=>validatePhoto(bad)).toThrow();
 });
 it("sums whole dishes before dividing, allows unequal meal correction later",()=>{
  const parsed=mealEstimateSchema.parse({...estimate,dishes:[...estimate.dishes,{name:"汤",grams:300,calories:300,protein:12,carbs:18,fat:6}]});
  expect(personalMeal(parsed,3)).toMatchObject({calories:500,protein:24,carbs:56,fat:15.3});
  expect(()=>personalMeal(parsed,0)).toThrow();
  expect(()=>mealEstimateSchema.parse({...estimate,food_detected:false})).toThrow();
 });
});

describe("slow provider regression",()=>{
 it("waits beyond the old 45-second cutoff, and aborts at 120 seconds",async()=>{
  vi.useFakeTimers();
  const timeout=vi.spyOn(AbortSignal,"timeout").mockImplementation(ms=>{
   const controller=new AbortController();
   setTimeout(()=>controller.abort(new DOMException("Timed out","TimeoutError")),ms);
   return controller.signal;
  });
  try {
   const s=setup();
   s.fetch.mockImplementationOnce(async(_url,options)=>new Promise((_resolve,reject)=>{
    options!.signal!.addEventListener("abort",()=>reject(options!.signal!.reason),{once:true});
   }));
   let settled=false;
   const result=handleMealPhoto(request(),s.deps).then(r=>{settled=true;return r;});
   // Let body reading/auth/JSON validation finish before the first advance.
   await vi.advanceTimersByTimeAsync(0);
   expect(timeout).toHaveBeenCalledWith(120_000);
   expect(MEAL_TIMEOUT_MS).toBe(120_000);
   await vi.advanceTimersByTimeAsync(46_000);
   expect(settled).toBe(false);
   await vi.advanceTimersByTimeAsync(74_000);
   const response=await result;
   expect(response.status).toBe(504);
   expect(await response.text()).toContain("PROVIDER_TIMEOUT");
   expect(s.fetch).toHaveBeenCalledTimes(1);
   expect(s.log).toHaveBeenCalledWith({event:"meal_photo_failure",stage:"connect",code:"PROVIDER_TIMEOUT",elapsedMs:120_000});
  } finally {timeout.mockRestore();vi.useRealTimers();}
 });
 it("trims harmless surrounding key whitespace without sending invalid headers",async()=>{
  const s=setup();
  expect((await handleMealPhoto(request(),{...s.deps,env:{...env,key:"  synthetic-private-key\n"}})).status).toBe(200);
  expect(new Headers(s.fetch.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer synthetic-private-key");
  s.fetch.mockClear();
  expect((await handleMealPhoto(request(),{...s.deps,env:{...env,key:"bad\nheader"}})).status).toBe(503);
  expect(s.fetch).not.toHaveBeenCalled();
 });
 it("reports body timeouts and logs only whitelisted metadata",async()=>{
  const s=setup(),secret="synthetic-private-key secret-photo-content";
  const error=Object.assign(new Error(secret),{name:"TimeoutError",cause:{code:secret}});
  s.fetch.mockResolvedValueOnce({ok:true,json:async()=>{throw error;}} as unknown as Response);
  const response=await handleMealPhoto(request(),s.deps);
  expect(response.status).toBe(504);
  expect(JSON.stringify(s.log.mock.calls)).not.toContain(secret);
  expect(await response.text()).not.toContain(secret);
  expect(s.log.mock.calls[0][0]).toMatchObject({stage:"read",code:"PROVIDER_TIMEOUT"});
 });
 it("recognizes DNS/connect failures without leaking untrusted error strings",()=>{
  expect(providerFailureCode({cause:{code:"ENOTFOUND"}})).toBe("ENOTFOUND");
  expect(providerFailureCode({cause:{code:"UND_ERR_CONNECT_TIMEOUT"}})).toBe("UND_ERR_CONNECT_TIMEOUT");
  expect(providerFailureCode({name:"SecretToken",message:"secret",code:"secret"})).toBe("PROVIDER_NETWORK");
 });
});
