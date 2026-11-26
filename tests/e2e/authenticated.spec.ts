import { test, expect } from "@playwright/test";
test("registered session can manage records, persist, export and logout",async({page})=>{
 test.skip(process.env.E2E_AUTH!=="1","Requires the synthetic configured build");
 const uid="10000000-0000-0000-0000-000000000001";
 const user={id:uid,email:"fitness@example.invalid",aud:"authenticated",role:"authenticated",app_metadata:{provider:"email",providers:["email"]},user_metadata:{},created_at:"2026-01-01T00:00:00Z"};
 const token=[{alg:"HS256",typ:"JWT"},{sub:uid,role:"authenticated",exp:Math.floor(Date.now()/1000)+3600},{}].map(v=>Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
 const db:Record<string,Record<string,unknown>[]>={};
 let id=0;
 await page.route("https://fitness-ci.supabase.co/**",async route=>{
  const request=route.request(),url=new URL(request.url());
  const headers={"access-control-allow-origin":"*","access-control-allow-headers":"*","content-type":"application/json"};
  if(request.method()==="OPTIONS"){await route.fulfill({status:200,headers,body:""});return;}
  if(url.pathname==="/auth/v1/token"){
   await route.fulfill({headers,json:{access_token:token,refresh_token:"synthetic-refresh",expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,token_type:"bearer",user}});return;
  }
  if(url.pathname==="/auth/v1/user"){await route.fulfill({headers,json:user});return;}
  if(url.pathname==="/auth/v1/logout"){await route.fulfill({status:204,headers});return;}
  const table=url.pathname.split("/").at(-1)!;
  if(!url.pathname.startsWith("/rest/v1/")){await route.fulfill({status:400,headers,json:{message:"Unexpected fixture request"}});return;}
  if(request.headers().authorization!=="Bearer "+token){await route.fulfill({status:401,headers,json:{message:"Missing session"}});return;}
  db[table]??=[];
  const rowID=url.searchParams.get("id")?.replace("eq.","");
  const method=request.method();
  if(method==="GET"){await route.fulfill({headers,json:db[table]});return;}
  if(method==="DELETE"){db[table]=db[table].filter(r=>r.id!==rowID);await route.fulfill({status:204,headers});return;}
  const body=request.postDataJSON();
  for(const raw of Array.isArray(body)?body:[body]){
   const existing=rowID?db[table].find(r=>r.id===rowID):url.searchParams.has("on_conflict")?db[table].find(r=>r.user_id===raw.user_id&&(table==="profiles"||r.logged_on===raw.logged_on)):undefined;
   if(existing)Object.assign(existing,raw);else db[table].push({...raw,id:String(++id)});
  }
  await route.fulfill({status:201,headers,body:""});
 });
 await page.goto("/");
 await page.getByLabel("邮箱",{exact:true}).fill("fitness@example.invalid");
 await page.locator('input[name="password"]').fill("synthetic-password-123");
 await page.getByRole("button",{name:"登录",exact:true}).click();
 await expect(page.getByText("个人空间",{exact:true})).toBeVisible();
 await page.getByRole("button",{name:/身体数据/}).first().click();
 await page.getByRole("button",{name:/记录身体数据/}).click();
 await page.getByLabel("体重 kg",{exact:true}).fill("80");
 await page.getByRole("button",{name:"保存记录"}).click();
 await expect(page.getByText("80 kg",{exact:true})).toBeVisible();
 await page.getByRole("button",{name:"编辑",exact:true}).click();
 await page.getByLabel("体重 kg",{exact:true}).fill("79.5");
 await page.getByRole("button",{name:"保存记录"}).click();
 await expect(page.getByText("79.5 kg",{exact:true})).toBeVisible();
 await page.getByRole("button",{name:/饮食记录/}).first().click();
 await page.getByRole("button",{name:/记录饮食/}).click();
 await page.getByLabel("食物与份量",{exact:true}).fill("虚构测试餐 1 份");
 await page.getByLabel("热量 kcal",{exact:true}).fill("600");
 await page.getByLabel("蛋白质 g",{exact:true}).fill("40");
 await page.getByRole("button",{name:"保存记录"}).click();
 await expect(page.getByText("虚构测试餐 1 份",{exact:true})).toBeVisible();
 await page.reload();
 await page.getByRole("button",{name:/饮食记录/}).first().click();
 await expect(page.getByText("虚构测试餐 1 份",{exact:true})).toBeVisible();
 page.once("dialog",dialog=>dialog.accept());
 await page.getByRole("button",{name:"删除",exact:true}).click();
 await expect(page.getByText("虚构测试餐 1 份",{exact:true})).toHaveCount(0);
 await page.getByRole("button",{name:/设置与同步/}).click();
 const download=page.waitForEvent("download");
 await page.getByRole("button",{name:"导出我的数据"}).click();
 expect((await download).suggestedFilename()).toBe("fitness-data.json");
 await page.getByRole("button",{name:"退出登录"}).click();
 await expect(page.getByRole("heading",{name:/每一点改变/})).toBeVisible();
 expect(db.body_measurements[0].weight_kg).toBe(79.5);
 expect(db.food_entries).toHaveLength(0);
});
