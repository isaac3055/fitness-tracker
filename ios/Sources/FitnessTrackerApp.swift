import SwiftUI
import Charts
import HealthKit

@main struct FitnessTrackerApp: App {
 @StateObject private var api=API()
 @StateObject private var health=HealthSync()
 var body: some Scene { WindowGroup { RootView().environmentObject(api).environmentObject(health).tint(Color(red:0.07,green:0.48,blue:0.37)) } }
}
struct RootView: View {
 @EnvironmentObject var api: API
 @EnvironmentObject var health: HealthSync
 var body: some View {
  Group {
   if api.session == nil { LoginView() }
   else { HomeView().id(api.session!.user.id) }
  }.onChange(of:api.session?.user.id) { _,newID in if newID == nil { health.stop() } }
 }
}
struct LoginView: View {
 @EnvironmentObject var api: API
 @State private var email=""
 @State private var password=""
 @State private var register=false
 @State private var busy=false
 @State private var message=""
 var body: some View {
  NavigationStack {
   Form {
    Section { Text("每一点改变，都值得被看见。").font(.title2).bold();Text("记录身体、训练与饮食。").foregroundStyle(.secondary) }
    if !api.configured { Section { Text("请先按 README 配置 Supabase 项目。") } }
    Section(register ? "创建账号" : "登录") {
     TextField("邮箱",text:$email).textContentType(.emailAddress).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
     SecureField("密码（至少 12 位）",text:$password).textContentType(register ? .newPassword:.password)
     Button(busy ? "处理中…" : register ? "注册":"登录") {
      busy=true;message=""
      Task {
       defer{busy=false}
       do {
        if register { try await api.register(email:email.trimmingCharacters(in:.whitespaces),password:password);message="注册成功，请前往邮箱确认后登录。" }
        else { try await api.login(email:email.trimmingCharacters(in:.whitespaces),password:password) }
        password=""
       } catch { message=error.localizedDescription }
      }
     }.disabled(busy || !api.configured || password.count<12 || !email.contains("@"))
     Button(register ? "已有账号？登录":"创建新账号") { register.toggle();message="" }.disabled(busy)
    }
    if let url=URL(string:Bundle.main.object(forInfoDictionaryKey:"WebAppURL") as? String ?? ""),url.scheme=="https",!url.absoluteString.contains("YOUR_") {
     Section { Link("忘记密码？前往网页端重置",destination:url) }
    }
    if !message.isEmpty { Section { Text(message).foregroundStyle(.secondary) } }
   }.navigationTitle("Fitness Tracker")
  }
 }
}
struct NativeField {
 let key:String
 let label:String
 var numeric=false
 var optional=false
 var options:[String]=[]
}
enum Module: String,CaseIterable,Identifiable {
 case body="body_measurements",plan="training_plans",workout="workout_logs",food="food_entries",energy="daily_energy",profile="profiles"
 var id:String{rawValue}
 var title:String { switch self {
 case .body:return "身体数据";case .plan:return "训练计划";case .workout:return "训练打卡"
 case .food:return "饮食记录";case .energy:return "全天能量";case .profile:return "身体与目标"
 }}
 var fields:[NativeField] { switch self {
 case .body:return [.init(key:"logged_on",label:"日期 YYYY-MM-DD"),.init(key:"weight_kg",label:"体重 kg",numeric:true),.init(key:"body_fat_percent",label:"体脂 %",numeric:true,optional:true),.init(key:"waist_cm",label:"腰围 cm",numeric:true,optional:true)]
 case .plan:return [.init(key:"day_of_week",label:"星期（0 周日至 6 周六）",numeric:true),.init(key:"name",label:"计划名称"),.init(key:"exercises",label:"动作、组数、次数")]
 case .workout:return [.init(key:"logged_on",label:"日期 YYYY-MM-DD"),.init(key:"name",label:"训练名称"),.init(key:"duration_minutes",label:"时长 min",numeric:true),.init(key:"calories",label:"活动热量 kcal",numeric:true)]
 case .food:return [.init(key:"logged_on",label:"日期 YYYY-MM-DD"),.init(key:"meal",label:"餐次",options:["早餐","午餐","晚餐","加餐"]),.init(key:"name",label:"食物与份量"),.init(key:"calories",label:"热量 kcal",numeric:true),.init(key:"protein",label:"蛋白质 g",numeric:true),.init(key:"carbs",label:"碳水 g",numeric:true),.init(key:"fat",label:"脂肪 g",numeric:true)]
 case .energy:return [.init(key:"logged_on",label:"日期 YYYY-MM-DD"),.init(key:"active_kcal",label:"全天活动消耗 kcal",numeric:true),.init(key:"resting_kcal",label:"全天静息消耗 kcal",numeric:true)]
 case .profile:return [.init(key:"height_cm",label:"身高 cm",numeric:true),.init(key:"goal_weight_kg",label:"目标体重 kg",numeric:true),.init(key:"calorie_target",label:"摄入目标 kcal",numeric:true),.init(key:"protein_target",label:"蛋白质目标 g",numeric:true),.init(key:"timezone",label:"时区（如 Asia/Shanghai）")]
 }}
}
struct EnergyTotal {
 let intake:Double
 let active:Double?
 let resting:Double?
 var expenditure:Double? { guard let active,let resting else{return nil};return active+resting }
 var deficit:Double? { expenditure.map{$0-intake} }
}
struct HomeView: View {
 @EnvironmentObject var api: API
 @EnvironmentObject var health: HealthSync
 @Environment(\.scenePhase) private var phase
 @State private var message=""
 @State private var rows:[String:[JSONRow]]=[:]
 @State private var loading=false
 @State private var syncConsent=false
 private var today:String { HealthDates.day(Date(),timezone:TimeZone(identifier:rows["profiles"]?.first?.text("timezone") ?? "") ?? .current) }
 private var total:EnergyTotal {
  let food=(rows["food_entries"] ?? []).filter{$0.text("logged_on")==today}
  let imported=rows["health_daily"]?.first{$0.text("logged_on")==today}
  let manual=rows["daily_energy"]?.first{$0.text("logged_on")==today}
  let source=imported ?? manual
  return EnergyTotal(intake:food.reduce(0){$0+(Double($1.text("calories")) ?? 0)},active:Double(source?.text("active_kcal") ?? ""),resting:Double(source?.text("resting_kcal") ?? ""))
 }
 var body: some View {
  TabView {
   overviewContent.tabItem { Label("概览",systemImage:"chart.xyaxis.line") }
   healthContent.tabItem { Label("健康同步",systemImage:"heart") }
   NavigationStack { PrivacyView(rows:rows).disabled(health.busy || loading) }.tabItem { Label("账号",systemImage:"person.crop.circle") }
  }.onChange(of:phase) { _,value in
   if value == .active { Task { if syncConsent { await health.sync(api:api) };await reload() } }
  }
 }
 private var overviewContent: some View {
   NavigationStack {
    List {
     Section("今日概览 · "+today) {
      LabeledContent("摄入 kcal",value:String(format:"%.0f",total.intake))
      LabeledContent("消耗 kcal",value:total.expenditure.map{String(format:"%.0f",$0)} ?? "尚无完整数据")
      LabeledContent("热量缺口 kcal",value:total.deficit.map{String(format:"%.0f",$0)} ?? "—")
      Text("消耗 = 静息 + 活动。训练热量不重复计入。当天与未记录数据可能不完整。").font(.caption).foregroundStyle(.secondary)
     }
     Section("健康记录") {
      ForEach(Module.allCases) { module in NavigationLink(module.title) { RecordsView(module:module) } }
     }
     Section("身体趋势") { NativeTrend(rows:rows) }
     Section("最近七天能量") {
      ForEach(0..<7,id:\.self) { offset in
       let date=Calendar.current.date(byAdding:.day,value:offset-6,to:Date())!
       let day=HealthDates.day(date,timezone:TimeZone(identifier:rows["profiles"]?.first?.text("timezone") ?? "") ?? .current)
       let intake=(rows["food_entries"] ?? []).filter{$0.text("logged_on")==day}.reduce(0.0){$0+(Double($1.text("calories")) ?? 0)}
       let source=rows["health_daily"]?.first{$0.text("logged_on")==day} ?? rows["daily_energy"]?.first{$0.text("logged_on")==day}
       let balance=EnergyTotal(intake:intake,active:Double(source?.text("active_kcal") ?? ""),resting:Double(source?.text("resting_kcal") ?? ""))
       LabeledContent(day,value:"摄入 \(Int(intake)) / 缺口 "+(balance.deficit.map{String(format:"%.0f",$0)} ?? "—"))
      }
     }
     if !message.isEmpty { Section { Text(message).foregroundStyle(.secondary) } }
    }.navigationTitle("健康有迹可循").refreshable { await reload() }.task { await reload() }
   }
 }
 private var healthContent: some View {
   NavigationStack {
    Form {
     Section("Apple HealthKit") {
      Text("经你同意，将所选健康数据上传到你自己的 Supabase 账号。网页与 iOS 共享这些数据。")
      Text("范围：活动/静息能量、步数、运动时长与类型、平均心率、体重与体脂。首次同步导入全部可读的身体测量和训练历史，以及最近 90 天的每日汇总。")
      Toggle("我同意将授权数据同步到此账号",isOn:$syncConsent).disabled(health.busy)
      Button("授权并同步") {
       Task {
        do { try await health.authorize();await health.sync(api:api);health.observe(api:api);await reload() }
        catch { message=error.localizedDescription }
       }
      }.disabled(!syncConsent || health.busy || loading)
      Button("立即同步") { Task { await health.sync(api:api);await reload() } }.disabled(!syncConsent || health.busy || loading)
      Button("停止后台同步") { health.stop();syncConsent=false;message="已停止本次运行的自动同步；可在系统健康 App 中撤销读取权限。" }.disabled(health.busy)
      Text(health.status).font(.caption)
      Text("iOS 控制后台调度，无法保证固定频率。读取被拒绝时可能返回空值；App 不会宣称已获全部权限。").font(.caption).foregroundStyle(.secondary)
     }
     Section("健康汇总 · "+today) {
      let current=rows["health_daily"]?.first{$0.text("logged_on")==today}
      LabeledContent("步数",value:current?.text("steps") ?? "—")
      LabeledContent("运动分钟",value:current?.text("exercise_minutes") ?? "—")
      LabeledContent("平均心率 bpm",value:current?.text("heart_rate") ?? "—")
     }
     ImportedMeasurements(rows:rows["health_measurements"] ?? [])
     ImportedWorkouts(rows:rows["health_workouts"] ?? [])
     if !message.isEmpty { Section { Text(message) } }
    }.navigationTitle("健康同步")
   }
 }
 private func reload() async {
  guard !loading else{return};loading=true;defer{loading=false}
  do {
   var result:[String:[JSONRow]]=[:]
   for table in Module.allCases.map(\.rawValue)+["health_daily","health_workouts","health_measurements"] { result[table]=try await api.rows(table) }
   rows=result;message=""
  } catch { message=error.localizedDescription }
 }
}
struct WeightPoint: Identifiable { var id:String{day};let day:String;let weight:Double }
struct NativeTrend: View {
 let rows:[String:[JSONRow]]
 private var points:[WeightPoint] {
  var daily:[String:Double]=[:]
  for row in (rows["health_measurements"] ?? []).sorted(by:{$0.text("measured_at")<$1.text("measured_at")}) {
   if let weight=Double(row.text("weight_kg")) { daily[row.text("logged_on")]=weight }
  }
  for row in rows["body_measurements"] ?? [] { if let weight=Double(row.text("weight_kg")){daily[row.text("logged_on")]=weight} }
  return daily.sorted{$0.key<$1.key}.suffix(30).map{WeightPoint(day:$0.key,weight:$0.value)}
 }
 var body: some View {
  if points.count<2 { Text("至少记录两天体重后显示趋势。").foregroundStyle(.secondary) }
  else {
   Chart(points) { point in
    LineMark(x:.value("日期",point.day),y:.value("体重 kg",point.weight))
    PointMark(x:.value("日期",point.day),y:.value("体重 kg",point.weight))
   }.frame(height:180).accessibilityLabel("体重变化趋势")
  }
 }
}
struct RecordsView: View {
 @EnvironmentObject var api: API
 let module:Module
 @State private var rows:[JSONRow]=[]
 @State private var editing:JSONRow?
 @State private var editor=false
 @State private var message=""
 @State private var pendingDelete:JSONRow?
 @State private var busy=false
 var body: some View {
  List {
   if module == .plan { Section { Text("默认周一、周五休息。可自行调整。");Button("载入默认计划") { Task { await seed() } }.disabled(!rows.isEmpty || busy) } }
   ForEach(rows) { row in
    Button {
     editing=row;editor=true
    } label: {
     VStack(alignment:.leading,spacing:6) {
      Text(row.text("name").isEmpty ? module == .body ? row.text("weight_kg")+" kg":module.title : row.text("name")).font(.headline)
      ForEach(module.fields,id:\.key) { field in
       if !row.text(field.key).isEmpty { Text(field.label+"："+row.text(field.key)).font(.caption).foregroundStyle(.secondary) }
      }
     }
    }.swipeActions { Button("删除",role:.destructive) { pendingDelete=row } }
   }
   if rows.isEmpty { Text("还没有记录。点击 + 添加。").foregroundStyle(.secondary) }
   if !message.isEmpty { Text(message).foregroundStyle(.red) }
  }.navigationTitle(module.title)
  .toolbar { Button { editing=nil;editor=true } label:{Image(systemName:"plus")} }
  .sheet(isPresented:$editor,onDismiss:{Task{await reload()}}) { EditorView(module:module,row:editing) }
  .task { await reload() }.refreshable { await reload() }
  .confirmationDialog("确认删除这条记录？",isPresented:Binding(get:{pendingDelete != nil},set:{if !$0{pendingDelete=nil}})) {
   Button("删除",role:.destructive) {
    guard let pendingDelete else{return}
    Task {
     do { try await api.delete(module.rawValue,id:pendingDelete.id);await reload() }
     catch {message=error.localizedDescription}
     self.pendingDelete=nil
    }
   }
  }
 }
 private func reload() async {
  do { rows=try await api.rows(module.rawValue);message="" } catch { message=error.localizedDescription }
 }
 private func seed() async {
  busy=true;defer{busy=false}
  do {
   let plans:[(Int,String,String)]=[
    (2,"全身力量 A","坐姿推胸/自由卧推 4×8\n高位下拉 4×8\n坐姿推肩 4×8\n腿举 4×8"),
    (3,"有氧爬坡","按个人耐受调整，记录实际完成"),
    (4,"全身力量 B","坐姿推胸/自由卧推 4×8\n高位下拉 4×8\n飞鸟 4×8\n腿弯举 4×8"),
    (6,"全身力量 A","坐姿推胸/自由卧推 4×8\n高位下拉 4×8\n坐姿推肩 4×8\n腿举 4×8"),
    (0,"有氧爬坡","轻松恢复")]
   // One atomic bulk insert, so retries cannot leave a half-created default week.
   guard let uid=api.session?.user.id else {return}
   _ = try await api.request("/rest/v1/training_plans",method:"POST",body:plans.map{["user_id":uid,"day_of_week":$0.0,"name":$0.1,"exercises":$0.2] as [String:Any]})
   await reload()
  } catch { message=error.localizedDescription }
 }
}
struct EditorView: View {
 @EnvironmentObject var api: API
 @Environment(\.dismiss) private var dismiss
 let module:Module
 let row:JSONRow?
 @State private var values:[String:String]=[:]
 @State private var message=""
 @State private var busy=false
 var body: some View {
  NavigationStack {
   Form {
    ForEach(module.fields,id:\.key) { field in
     if !field.options.isEmpty {
      Picker(field.label,selection:binding(field.key)) { ForEach(field.options,id:\.self){Text($0).tag($0)} }
     } else if field.key=="exercises" {
      TextField(field.label,text:binding(field.key),axis:.vertical).lineLimit(4...12)
     } else {
      TextField(field.label+(field.optional ? "（可选）":""),text:binding(field.key)).keyboardType(field.numeric ? .decimalPad:.default).textInputAutocapitalization(.never)
     }
    }
    if !message.isEmpty { Text(message).foregroundStyle(.red) }
   }.navigationTitle(module.title)
   .toolbar {
    ToolbarItem(placement:.cancellationAction){Button("取消"){dismiss()}.disabled(busy)}
    ToolbarItem(placement:.confirmationAction){Button("保存"){Task{await save()}}.disabled(busy)}
   }.interactiveDismissDisabled(busy).onAppear {
    let defaults=["logged_on":HealthDates.day(Date(),timezone:.current),"meal":"早餐","day_of_week":"2","height_cm":"175","goal_weight_kg":"70","calorie_target":"2100","protein_target":"120","timezone":TimeZone.current.identifier,"calories":"0","protein":"0","carbs":"0","fat":"0"]
    values=Dictionary(uniqueKeysWithValues:module.fields.map { field in (field.key,row?.text(field.key) ?? defaults[field.key] ?? "") })
   }
  }
 }
 private func binding(_ key:String)->Binding<String> { Binding(get:{values[key] ?? ""},set:{values[key]=$0}) }
 private func save() async {
  busy=true;defer{busy=false}
  do {
   var payload:[String:Any]=[:]
   for field in module.fields {
    let value=(values[field.key] ?? "").trimmingCharacters(in:.whitespacesAndNewlines)
    if value.isEmpty {
     if field.optional {payload[field.key]=NSNull();continue}
     throw TrackerError.message("请填写 "+field.label)
    }
    if field.numeric {
     guard let number=Double(value),number.isFinite else { throw TrackerError.message(field.label+"必须是有效数字") }
     payload[field.key]=number
    } else { payload[field.key]=value }
   }
   if let timezone=payload["timezone"] as? String,TimeZone(identifier:timezone)==nil { throw TrackerError.message("请输入有效时区") }
   try await api.save(module.rawValue,values:payload,id:row?.id);dismiss()
  } catch {message=error.localizedDescription}
 }
}
struct PrivacyView: View {
 @EnvironmentObject var api: API
 @EnvironmentObject var health: HealthSync
 let rows:[String:[JSONRow]]
 @State private var confirm=""
 @State private var message=""
 @State private var busy=false
 private var export:String {
  let payload=rows.mapValues{$0.map(\.values)}
  guard let data=try? JSONSerialization.data(withJSONObject:payload,options:[.prettyPrinted,.sortedKeys]) else{return "{}"}
  return String(data:data,encoding:.utf8) ?? "{}"
 }
 var body: some View {
  Form {
   Section("当前账号") { Text(api.session?.user.email ?? "");Text("各账号通过数据库行级安全策略隔离。").font(.caption) }
   Section("数据管理") {
    ShareLink("导出我的数据",item:export)
    Text("导出内容包含个人健康记录，请自行选择可信保存位置。").font(.caption).foregroundStyle(.secondary)
    TextField("删除账号：输入 DELETE",text:$confirm).textInputAutocapitalization(.characters)
    Button("永久删除账号及全部数据",role:.destructive) {
     busy=true
     Task {
      defer{busy=false}
      do {
       _ = try await api.request("/rest/v1/rpc/delete_my_account",method:"POST",body:[:])
       health.stop();await api.signOut()
      } catch {message=error.localizedDescription}
     }
    }.disabled(confirm != "DELETE" || busy)
   }
   Section {
    Button("退出登录") { Task {health.stop();await api.signOut()} }.disabled(busy)
    Text("Fitness Tracker 1.0 · MIT\n目标与热量估算由用户自行管理，不构成医疗建议。").font(.caption).foregroundStyle(.secondary)
   }
   if !message.isEmpty {Text(message)}
  }.navigationTitle("账号与隐私")
 }
}

func activityName(_ raw:String) -> String {
 guard let value=UInt(raw),let type=HKWorkoutActivityType(rawValue:value) else { return "其他训练" }
 switch type {
 case .walking:return "步行"
 case .running:return "跑步"
 case .cycling:return "骑行"
 case .traditionalStrengthTraining:return "力量训练"
 case .functionalStrengthTraining:return "功能力量训练"
 case .hiking:return "徒步"
 case .elliptical:return "椭圆机"
 case .swimming:return "游泳"
 case .yoga:return "瑜伽"
 default:return "其他训练"
 }
}

struct ImportedMeasurements: View {
 let rows:[JSONRow]
 private var recent:[JSONRow] { Array(rows.sorted(by:{$0.text("measured_at")>$1.text("measured_at")}).prefix(30)) }
 private func label(_ row:JSONRow) -> String {
  let measurement=row.text("weight_kg").isEmpty ? "体脂 \(row.text("body_fat_percent"))%" : "\(row.text("weight_kg")) kg"
  return row.text("logged_on")+" · "+measurement
 }
 var body: some View {
  Section("已同步身体测量") { ForEach(recent) { row in Text(label(row)) } }
 }
}
struct ImportedWorkouts: View {
 let rows:[JSONRow]
 private var recent:[JSONRow] { Array(rows.sorted(by:{$0.text("started_at")>$1.text("started_at")}).prefix(30)) }
 private func label(_ row:JSONRow) -> String {
  let name=activityName(row.text("activity_type"))
  return "\(row.text("logged_on")) · \(name) · \(row.text("duration_minutes")) min"
 }
 var body: some View {
  Section("最近训练") { ForEach(recent) { row in Text(label(row)) } }
 }
}
