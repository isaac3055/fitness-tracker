import Combine
import Foundation
import HealthKit

enum HealthDates {
 static func day(_ date: Date, timezone: TimeZone) -> String {
  let formatter=DateFormatter();formatter.calendar=Calendar(identifier:.gregorian)
  formatter.locale=Locale(identifier:"en_US_POSIX");formatter.timeZone=timezone;formatter.dateFormat="yyyy-MM-dd"
  return formatter.string(from:date)
 }
}
@MainActor final class HealthSync: ObservableObject {
 private let store=HKHealthStore()
 private var observers:[HKObserverQuery]=[]
 @Published var busy=false
 @Published var status="尚未同步"
 private let dailyTypes:[(HKQuantityTypeIdentifier,String,HKUnit,HKStatisticsOptions)] = [
  (.activeEnergyBurned,"active_kcal",.kilocalorie(),.cumulativeSum),
  (.basalEnergyBurned,"resting_kcal",.kilocalorie(),.cumulativeSum),
  (.stepCount,"steps",.count(),.cumulativeSum),
  (.appleExerciseTime,"exercise_minutes",.minute(),.cumulativeSum),
  (.heartRate,"heart_rate",HKUnit.count().unitDivided(by:.minute()),.discreteAverage)
 ]
 private let sampleTypes:[HKSampleType] = [
  HKQuantityType.quantityType(forIdentifier:.bodyMass)!,
  HKQuantityType.quantityType(forIdentifier:.bodyFatPercentage)!,
  HKObjectType.workoutType()
 ]
 func authorize() async throws {
  guard HKHealthStore.isHealthDataAvailable() else { throw TrackerError.message("此设备不支持 HealthKit") }
  let types:[HKObjectType]=dailyTypes.map{HKQuantityType.quantityType(forIdentifier:$0.0)! as HKObjectType}+sampleTypes.map{$0 as HKObjectType}
  let read=Set(types)
  try await store.requestAuthorization(toShare:[],read:read)
  status="已完成授权请求。读取权限由系统管理，空数据不代表已获授权。"
 }
 func stop() {
  for query in observers { store.stop(query) };observers=[]
  Task { try? await store.disableAllBackgroundDelivery() }
 }
 func observe(api: API) {
  for query in observers { store.stop(query) };observers=[]
  let types:[HKSampleType]=dailyTypes.map{HKQuantityType.quantityType(forIdentifier:$0.0)!}+sampleTypes
  for type in types {
   let query=HKObserverQuery(sampleType:type,predicate:nil) { [weak self,weak api] _,done,error in
    guard error==nil else { done();return }
    Task { @MainActor in
     defer { done() }
     guard let self,let api,api.session != nil else { return }
     await self.sync(api:api)
    }
   }
   observers.append(query);store.execute(query)
   store.enableBackgroundDelivery(for:type,frequency:.hourly) { _,_ in }
  }
 }
 private func statistics(type: HKQuantityType,options: HKStatisticsOptions,start: Date,end: Date,calendar: Calendar) async throws -> [HKStatistics] {
  try await withCheckedThrowingContinuation { continuation in
   let predicate=HKQuery.predicateForSamples(withStart:start,end:end,options:.strictStartDate)
   let query=HKStatisticsCollectionQuery(quantityType:type,quantitySamplePredicate:predicate,options:options,anchorDate:start,intervalComponents:DateComponents(calendar:calendar,timeZone:calendar.timeZone,day:1))
   query.initialResultsHandler={ _,collection,error in
    if let error { continuation.resume(throwing:error);return }
    var result:[HKStatistics]=[]
    collection?.enumerateStatistics(from:start,to:end) { value,_ in result.append(value) }
    continuation.resume(returning:result)
   }
   store.execute(query)
  }
 }
 private func anchored(type: HKSampleType,anchor: HKQueryAnchor?) async throws -> ([HKSample],[HKDeletedObject],HKQueryAnchor?) {
  try await withCheckedThrowingContinuation { continuation in
   let query=HKAnchoredObjectQuery(type:type,predicate:nil,anchor:anchor,limit:HKObjectQueryNoLimit) { _,samples,deleted,newAnchor,error in
    if let error { continuation.resume(throwing:error);return }
    continuation.resume(returning:(samples ?? [],deleted ?? [],newAnchor))
   }
   store.execute(query)
  }
 }
 func sync(api: API) async {
  guard !busy,let uid=api.session?.user.id else { return }
  busy=true;defer{busy=false}
  do {
   // Use the profile's day boundary for the same daily totals on web and phone.
   let profile=try await api.rows("profiles").first
   guard let timezone=TimeZone(identifier:profile?.text("timezone") ?? TimeZone.current.identifier) else { throw TrackerError.message("请设置有效时区") }
   var calendar=Calendar(identifier:.gregorian);calendar.timeZone=timezone
   let end=Date(),start=calendar.date(byAdding:.day,value:-89,to:calendar.startOfDay(for:end))!
   var days:[String:[String:Any]]=[:]
   for offset in 0..<90 {
    let date=calendar.date(byAdding:.day,value:offset,to:start)!
    let day=HealthDates.day(date,timezone:timezone)
    days[day]=["logged_on":day,"timezone":timezone.identifier,"active_kcal":NSNull(),"resting_kcal":NSNull(),"steps":NSNull(),"exercise_minutes":NSNull(),"heart_rate":NSNull()]
   }
   for (identifier,key,unit,options) in dailyTypes {
    let stats=try await statistics(type:HKQuantityType.quantityType(forIdentifier:identifier)!,options:options,start:start,end:end,calendar:calendar)
    for stat in stats {
     let day=HealthDates.day(stat.startDate,timezone:timezone)
     if let quantity=(options == .discreteAverage ? stat.averageQuantity() : stat.sumQuantity()) {
      days[day]?[key]=quantity.doubleValue(for:unit)
     }
    }
   }
   var measurements:[[String:Any]]=[],workouts:[[String:Any]]=[],deleted:[String]=[]
   var anchors:[(String,Data)]=[]
   for type in sampleTypes {
    let key="anchor."+uid+"."+type.identifier
    let anchor:HKQueryAnchor?
    if let data=Vault.read(key) { anchor=try NSKeyedUnarchiver.unarchivedObject(ofClass:HKQueryAnchor.self,from:data) } else { anchor=nil }
    let (samples,tombstones,next)=try await anchored(type:type,anchor:anchor)
    deleted += tombstones.map{$0.uuid.uuidString}
    for sample in samples {
     let day=HealthDates.day(sample.startDate,timezone:timezone),stamp=ISO8601DateFormatter().string(from:sample.startDate)
     if let quantity=sample as? HKQuantitySample {
      var row:[String:Any]=["sample_id":sample.uuid.uuidString,"measured_at":stamp,"logged_on":day]
      if quantity.quantityType.identifier==HKQuantityTypeIdentifier.bodyMass.rawValue {
       row["weight_kg"]=quantity.quantity.doubleValue(for:.gramUnit(with:.kilo))
      } else { row["body_fat_percent"]=quantity.quantity.doubleValue(for:.percent())*100 }
      measurements.append(row)
     } else if let workout=sample as? HKWorkout {
      var row:[String:Any]=["sample_id":workout.uuid.uuidString,"logged_on":day,"started_at":stamp,"activity_type":workout.workoutActivityType.rawValue,"duration_minutes":workout.duration/60]
      if let calories=workout.statistics(for:HKQuantityType.quantityType(forIdentifier:.activeEnergyBurned)!)?.sumQuantity()?.doubleValue(for:.kilocalorie()) { row["calories"]=calories } else { row["calories"]=NSNull() }
      workouts.append(row)
     }
    }
    if let next { anchors.append((key,try NSKeyedArchiver.archivedData(withRootObject:next,requiringSecureCoding:true))) }
   }
   guard measurements.count<=10000,workouts.count<=10000,deleted.count<=20000 else { throw TrackerError.message("首次历史数据超过单批限制，未上传且未推进同步游标。请联系维护者增加分页。") }
   guard api.session?.user.id==uid else { throw TrackerError.message("账号已切换，已取消同步") }
   _ = try await api.request("/rest/v1/rpc/sync_health_batch",method:"POST",body:["daily":Array(days.values),"measurements":measurements,"workouts":workouts,"deleted_ids":deleted])
   // Only advance anchors after the atomic server transaction succeeds.
   for (key,data) in anchors { try Vault.write(key,data) }
   status="同步完成 · "+Date().formatted(date:.abbreviated,time:.shortened)+"。仅同步可读取数据，最近 90 天每日汇总会重新计算。"
  } catch { status=error.localizedDescription }
 }
}
