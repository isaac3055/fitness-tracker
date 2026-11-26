import { emptyData, localDate, defaultPlans } from "./domain";
export function demoData() {
  const data = emptyData();
  data.profiles = [{id:"demo",height_cm:175,goal_weight_kg:70,calorie_target:2100,protein_target:120,timezone:"Asia/Shanghai"}];
  for (let i=6;i>=0;i--) {
    const d = new Date(); d.setDate(d.getDate()-i);
    data.body_measurements.push({id:"demo-"+i,logged_on:localDate(d),weight_kg:78+i*0.12,body_fat_percent:23,waist_cm:86});
  }
  data.training_plans = defaultPlans.map((p,i)=>({id:"plan-"+i,...p}));
  data.food_entries = [{id:"food",logged_on:localDate(),meal:"早餐",name:"示例：鸡蛋、牛奶、燕麦",calories:520,protein:30,carbs:55,fat:20}];
  data.daily_energy = [{id:"energy",logged_on:localDate(),active_kcal:450,resting_kcal:1500}];
  return data;
}
