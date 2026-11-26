import { describe, it, expect } from "vitest";
import { schemas, emptyData, dailySummary, energyBalance, localDate, dayOfWeek, weightTrend, defaultPlans } from "../src/lib/domain";
describe("energy accounting",()=>{
 it("does not add workout calories twice",()=>{
  const d=emptyData();
  d.food_entries=[{id:"f",logged_on:"2026-01-01",calories:1800,protein:110}];
  d.workout_logs=[{id:"w",logged_on:"2026-01-01",calories:400}];
  d.daily_energy=[{id:"m",logged_on:"2026-01-01",active_kcal:500,resting_kcal:1600}];
  d.health_daily=[{id:"h",logged_on:"2026-01-01",active_kcal:600,resting_kcal:1600}];
  expect(dailySummary(d,"2026-01-01")).toMatchObject({intake:1800,protein:110,expenditure:2200,deficit:400,source:"Apple Health"});
 });
 it("keeps missing/partial burn unknown",()=>{
  expect(energyBalance(1800,null,1600).deficit).toBeNull();
  const d=emptyData();
  d.daily_energy=[{id:"m",logged_on:"2026-01-01",active_kcal:500,resting_kcal:1600}];
  d.health_daily=[{id:"h",logged_on:"2026-01-01",active_kcal:100,resting_kcal:null}];
  expect(dailySummary(d,"2026-01-01").deficit).toBeNull();
 });
 it("retains an explicit zero",()=>expect(energyBalance(0,0,0)).toEqual({expenditure:0,deficit:0}));
});
describe("validation and date boundaries",()=>{
 it("rejects invalid calendar dates, NaN and negative nutrition",()=>{
  expect(schemas.body_measurements.safeParse({logged_on:"2026-02-30",weight_kg:80}).success).toBe(false);
  expect(schemas.daily_energy.safeParse({logged_on:"2026-01-01",active_kcal:NaN,resting_kcal:1500}).success).toBe(false);
  expect(schemas.food_entries.safeParse({logged_on:"2026-01-01",meal:"早餐",name:"egg",calories:-1,protein:0,carbs:0,fat:0}).success).toBe(false);
 });
 it("accepts empty optional body fields",()=>{
  expect(schemas.body_measurements.parse({logged_on:"2026-01-01",weight_kg:80,body_fat_percent:"",waist_cm:""}).waist_cm).toBeNull();
 });
 it("does not derive a Chinese day from UTC",()=>{
  expect(localDate(new Date("2026-01-01T18:00:00Z"),"Asia/Shanghai")).toBe("2026-01-02");
  expect(dayOfWeek("2026-11-23")).toBe(1);
 });
 it("keeps Monday and Friday off",()=>expect(defaultPlans.map(p=>p.day_of_week)).not.toEqual(expect.arrayContaining([1,5])));
});
describe("measurement provenance",()=>{
 it("takes latest imported weight and deliberate manual override",()=>{
  const d=emptyData();
  d.health_measurements=[
   {id:"h2",logged_on:"2026-01-01",measured_at:"2026-01-01T12:00:00Z",weight_kg:79},
   {id:"h1",logged_on:"2026-01-01",measured_at:"2026-01-01T08:00:00Z",weight_kg:80},
   {id:"fat",logged_on:"2026-01-02",measured_at:"2026-01-02T08:00:00Z",body_fat_percent:22}
  ];
  expect(weightTrend(d)).toEqual([{date:"2026-01-01",weight:79}]);
  d.body_measurements=[{id:"m",logged_on:"2026-01-01",weight_kg:78}];
  expect(weightTrend(d)).toEqual([{date:"2026-01-01",weight:78}]);
 });
});
