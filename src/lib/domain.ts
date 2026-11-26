import { z } from "zod";
export const dateSchema = z.iso.date();
const number = (min: number, max: number) => z.coerce.number().finite().min(min).max(max);
export const schemas = {
  profiles: z.object({
    height_cm: number(50, 250), goal_weight_kg: number(20, 400),
    calorie_target: number(500, 10000), protein_target: number(0, 500),
    timezone: z.string().refine(v => { try { new Intl.DateTimeFormat("en", {timeZone:v}); return true; } catch { return false; } }, "请输入有效时区")
  }),
  body_measurements: z.object({
    logged_on: dateSchema, weight_kg: number(20, 400),
    body_fat_percent: z.preprocess(v => v === "" ? null : v, number(1, 75).nullable()),
    waist_cm: z.preprocess(v => v === "" ? null : v, number(20, 250).nullable())
  }),
  training_plans: z.object({
    day_of_week: number(0, 6).int(), name: z.string().trim().min(1).max(100),
    exercises: z.string().trim().min(1).max(4000)
  }),
  workout_logs: z.object({
    logged_on: dateSchema, name: z.string().trim().min(1).max(100),
    duration_minutes: number(1, 1440), calories: number(0, 15000)
  }),
  food_entries: z.object({
    logged_on: dateSchema, meal: z.enum(["早餐", "午餐", "晚餐", "加餐"]),
    name: z.string().trim().min(1).max(100), calories: number(0, 15000),
    protein: number(0, 1000), carbs: number(0, 2000), fat: number(0, 1000)
  }),
  daily_energy: z.object({
    logged_on: dateSchema, active_kcal: number(0, 15000), resting_kcal: number(0, 10000)
  })
};
export type Table = keyof typeof schemas;
export type Row = { id: string; user_id?: string; [key: string]: unknown };
export type Data = Record<Table | "health_daily" | "health_workouts" | "health_measurements", Row[]>;
export const emptyData = (): Data => ({
  profiles: [], body_measurements: [], training_plans: [], workout_logs: [],
  food_entries: [], daily_energy: [], health_daily: [], health_workouts: [], health_measurements: []
});
export function localDate(date = new Date(), timezone?: string): string {
  if (timezone) return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  return [date.getFullYear(), String(date.getMonth()+1).padStart(2,"0"), String(date.getDate()).padStart(2,"0")].join("-");
}
export function dayOfWeek(date: string) { return new Date(date + "T12:00:00Z").getUTCDay(); }
export function energyBalance(intake: number, active: number | null, resting: number | null) {
  if (active === null || resting === null) return { expenditure: null, deficit: null };
  const expenditure = active + resting;
  return { expenditure, deficit: expenditure - intake };
}
export function dailySummary(data: Data, date: string) {
  const food = data.food_entries.filter(r => r.logged_on === date);
  const health = data.health_daily.find(r => r.logged_on === date);
  const manual = data.daily_energy.find(r => r.logged_on === date);
  // Imported daily energy already includes workouts; never add workout calories again.
  // Do not combine a partial HealthKit total with manual energy for the same day.
  const source = health ?? manual;
  const value = (key: string) => source?.[key] == null ? null : Number(source[key]);
  const intake = food.reduce((sum,r) => sum + Number(r.calories), 0);
  const protein = food.reduce((sum,r) => sum + Number(r.protein), 0);
  return { intake, protein, ...energyBalance(intake,value("active_kcal"),value("resting_kcal")),
    source: health ? "Apple Health" : manual ? "手动" : "尚无消耗数据",
    steps: health?.steps ?? null };
}
export function weightTrend(data: Data) {
  const byDay = new Map<string, number>();
  for (const r of [...data.health_measurements].sort((a,b) => String(a.measured_at).localeCompare(String(b.measured_at))))
    if (r.weight_kg != null) byDay.set(String(r.logged_on), Number(r.weight_kg));
  // A deliberate manual measurement overrides the imported measurement for that date.
  for (const r of data.body_measurements) byDay.set(String(r.logged_on), Number(r.weight_kg));
  return [...byDay].sort(([a],[b]) => a.localeCompare(b)).map(([date,weight]) => ({date,weight}));
}
export const defaultPlans = [
  { day_of_week: 2, name: "全身力量 A", exercises: "坐姿推胸/自由卧推 4×8\n高位下拉 4×8\n坐姿推肩 4×8\n腿举 4×8" },
  { day_of_week: 3, name: "有氧爬坡", exercises: "按个人耐受调整坡度和时长，记录实际完成情况" },
  { day_of_week: 4, name: "全身力量 B", exercises: "坐姿推胸/自由卧推 4×8\n高位下拉 4×8\n飞鸟 4×8\n腿弯举 4×8" },
  { day_of_week: 6, name: "全身力量 A", exercises: "坐姿推胸/自由卧推 4×8\n高位下拉 4×8\n坐姿推肩 4×8\n腿举 4×8" },
  { day_of_week: 0, name: "有氧爬坡", exercises: "按个人耐受调整，轻松恢复" }
];
