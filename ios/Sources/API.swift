import Foundation
import Security
import SwiftUI

enum TrackerError: LocalizedError {
 case message(String)
 var errorDescription: String? { if case .message(let value) = self { return value }; return nil }
}
enum Vault {
 static let service = "com.isaac3055.fitnesstracker"
 static func read(_ key: String) -> Data? {
  let query: [String:Any] = [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:key,kSecReturnData as String:true,kSecMatchLimit as String:kSecMatchLimitOne]
  var item: CFTypeRef?
  guard SecItemCopyMatching(query as CFDictionary,&item)==errSecSuccess else { return nil }
  return item as? Data
 }
 static func write(_ key: String, _ data: Data) throws {
  let query: [String:Any] = [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:key]
  SecItemDelete(query as CFDictionary)
  var attributes = query
  attributes[kSecValueData as String] = data
  attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
  guard SecItemAdd(attributes as CFDictionary,nil)==errSecSuccess else { throw TrackerError.message("无法安全保存登录状态") }
 }
 static func delete(_ key: String) {
  SecItemDelete([kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:key] as CFDictionary)
 }
}
struct AuthUser: Codable { let id: String; let email: String? }
struct AuthSession: Codable {
 let access_token: String
 let refresh_token: String
 let expires_at: Double?
 let user: AuthUser
}
struct JSONRow: Identifiable {
 let values: [String:Any]
 var id: String { values["id"] as? String ?? "" }
 func text(_ key: String) -> String {
  guard let value=values[key], !(value is NSNull) else { return "" }
  return String(describing:value)
 }
}
@MainActor final class API: ObservableObject {
 @Published var session: AuthSession?
 private var refreshTask: Task<Data,Error>?
 let base: String
 let key: String
 var configured: Bool { base.hasPrefix("https://") && !base.contains("YOUR_") && !key.contains("YOUR_") && !key.isEmpty }
 init() {
  base=Bundle.main.object(forInfoDictionaryKey:"SupabaseURL") as? String ?? ""
  key=Bundle.main.object(forInfoDictionaryKey:"SupabaseAnonKey") as? String ?? ""
  if let data=Vault.read("session") { session=try? JSONDecoder().decode(AuthSession.self,from:data) }
 }
 func request(_ path: String, method: String = "GET", body: Any? = nil, authenticated: Bool = true, prefer: String? = nil) async throws -> Data {
  guard configured,let url=URL(string:base+path) else { throw TrackerError.message("请先配置 Supabase URL 与公开客户端密钥") }
  if authenticated { try await refreshIfNeeded() }
  var req=URLRequest(url:url)
  req.httpMethod=method
  req.setValue(key,forHTTPHeaderField:"apikey")
  req.setValue("application/json",forHTTPHeaderField:"Content-Type")
  if authenticated {
   guard let session else { throw TrackerError.message("请重新登录") }
   req.setValue("Bearer "+session.access_token,forHTTPHeaderField:"Authorization")
  }
  if let prefer { req.setValue(prefer,forHTTPHeaderField:"Prefer") }
  if let body { req.httpBody=try JSONSerialization.data(withJSONObject:body) }
  let (data,response)=try await URLSession.shared.data(for:req)
  guard let response=response as? HTTPURLResponse else { throw TrackerError.message("网络响应无效") }
  guard (200..<300).contains(response.statusCode) else {
   // Never log request bodies, tokens or server health payloads.
   throw TrackerError.message("请求失败（\(response.statusCode)）。请检查网络、账号或项目配置。")
  }
  return data
 }
 func accept(_ data: Data) throws {
  let value=try JSONDecoder().decode(AuthSession.self,from:data)
  try Vault.write("session",data);session=value
 }
 func refreshIfNeeded() async throws {
  guard let current=session else { throw TrackerError.message("请登录") }
  if (current.expires_at ?? 0)>Date().timeIntervalSince1970+90 { return }
  if let refreshTask {
   let data=try await refreshTask.value
   guard session?.user.id==current.user.id else { throw TrackerError.message("账号已切换") }
   try accept(data);return
  }
  let task=Task { try await self.request("/auth/v1/token?grant_type=refresh_token",method:"POST",body:["refresh_token":current.refresh_token],authenticated:false) }
  refreshTask=task
  defer{refreshTask=nil}
  let data=try await task.value
  guard session?.user.id==current.user.id else { throw TrackerError.message("账号已切换") }
  try accept(data)
 }
 func login(email: String,password: String) async throws {
  let data=try await request("/auth/v1/token?grant_type=password",method:"POST",body:["email":email,"password":password],authenticated:false)
  try accept(data)
 }
 func register(email: String,password: String) async throws {
  _ = try await request("/auth/v1/signup",method:"POST",body:["email":email,"password":password],authenticated:false)
 }
 func signOut() async {
  if session != nil { _ = try? await request("/auth/v1/logout",method:"POST") }
  Vault.delete("session");session=nil
 }
 func rows(_ table: String) async throws -> [JSONRow] {
  guard let uid=session?.user.id else { throw TrackerError.message("请登录") }
  var output: [JSONRow]=[]
  var offset=0
  while true {
   let data=try await request("/rest/v1/\(table)?user_id=eq.\(uid)&select=*&order=id&limit=500&offset=\(offset)")
   let array=try JSONSerialization.jsonObject(with:data) as? [[String:Any]] ?? []
   output += array.map { JSONRow(values:$0) }
   if array.count<500 { break };offset+=500
  }
  return output
 }
 func save(_ table: String,values: [String:Any],id: String? = nil) async throws {
  guard let uid=session?.user.id else { throw TrackerError.message("请登录") }
  var payload=values;payload["user_id"]=uid
  if let id {
   _ = try await request("/rest/v1/\(table)?id=eq.\(id)&user_id=eq.\(uid)",method:"PATCH",body:payload)
  } else {
   let conflict=table=="profiles" ? "user_id" : ["body_measurements","daily_energy"].contains(table) ? "user_id,logged_on" : nil
   _ = try await request("/rest/v1/\(table)"+(conflict.map{"?on_conflict="+$0} ?? ""),method:"POST",body:payload,prefer:conflict==nil ? "return=minimal" : "resolution=merge-duplicates,return=minimal")
  }
 }
 func delete(_ table: String,id: String) async throws {
  guard let uid=session?.user.id else { throw TrackerError.message("请登录") }
  _ = try await request("/rest/v1/\(table)?id=eq.\(id)&user_id=eq.\(uid)",method:"DELETE")
 }
}
