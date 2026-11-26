# Fitness Tracker V1.0

中文优先的多用户健康管理应用。MIT 开源。**仓库公开不代表用户健康记录公开**。

## 技术架构

- Web：Next.js 16 App Router / TypeScript / React，响应式 PC 与手机界面。
- iOS：SwiftUI / Swift Charts / HealthKit，iOS 17+；URLSession 调用 Supabase Auth / PostgREST。
- 服务：Supabase Auth + PostgreSQL（所有业务表均启用 Row Level Security）。
- Web 部署：Vercel。iOS：XcodeGen 生成 Xcode 工程，开发者自行签名。

## 已实现功能

| 模块 | Web | iOS |
| --- | --- | --- |
| 邮箱注册、登录、退出 | 支持，含邮箱确认提示和密码重置 | 支持；密码重置通过配置的网页地址 |
| 身体数据与目标 | 体重、体脂、腰围、身高、目标体重和营养目标 | 同左 |
| 训练计划与打卡 | 每周计划 CRUD、默认计划、一日训练记录 | 同左 |
| 饮食 | 分餐次手动录入热量与三大营养素、编辑删除 | 同左 |
| 热量管理 | 日消耗、摄入、缺口，缺失消耗保持未知 | 同左 |
| 分析 | 体重趋势、近七天热量与蛋白质 | 体重图表、近七天热量 |
| HealthKit | 查看同步记录，无法直接读取设备 | 原生授权、主动同步、运行期间注册后台观察 |
| 数据与隐私 | JSON 导出、删除账号和全部记录 | 系统分享导出、删除账号和全部记录 |

网页未配置 Supabase 时显示明确的配置提示和**只读虚构演示**。演示不模拟注册成功，不写入服务器。新注册账号为空，不自动填充演示健康记录。

默认计划周一和周五休息；周二、周四、周六力量，周三和周日有氧。所有用户可独立调整。

## 本地启动 Web

需要 Node.js 22+：

~~~sh
npm install
cp .env.example .env.local
npm run dev
~~~

在 .env.local 中填写自己的 Supabase URL 和 publishable/anon key。它们是客户端配置；**禁止填写 service_role 或 secret key**。

打开 http://localhost:3000。未配置时可直接查看演示。

## 配置 Supabase

1. 创建项目，在 SQL Editor 中执行 supabase/migrations/202611260001_initial.sql，或通过 Supabase CLI migrations 部署。
2. 开启 Email/Password 登录，开启邮箱确认，设置最低密码长度 12；在生产环境配置 SMTP、Auth rate limits 和 CAPTCHA。
3. Auth → URL Configuration：Site URL 填网页生产地址；Redirect URLs 仅加入明确的开发/生产地址。重置密码邮件返回该站点。
4. 将项目 URL 与 publishable/anon key 写入 Web 环境变量及 iOS 本地配置。无需任何 service-role 密钥。
5. 通过真实的两个测试账号验证隔离与注册邮件。CI 的 PostgreSQL 测试只模拟 auth.uid，不能替代对托管 Auth 邮件与速率限制的验收。

迁移从 auth.users 建立外键，删除账号后所有业务行级联删除。delete_my_account 不接受用户 ID，只操作 JWT 当前用户。sync_health_batch 采用 SECURITY INVOKER，服务端从 JWT 派生 user_id。

supabase/tests/bootstrap.sql **仅供空白 CI 测试数据库**，不可在生产 Supabase 上执行。

## 部署 Vercel

导入此 GitHub 仓库，Framework 选择 Next.js，设置两个 NEXT_PUBLIC_SUPABASE_* 环境变量后部署。此仓库不包含生产服务凭据；需先拥有可用的 Supabase 与 Vercel 项目。部署后把域名加入 Supabase 的 URL allowlist。

## 构建 iOS

需要 macOS、Xcode（iOS 17+ SDK）、XcodeGen；Windows 不能运行 iOS 签名与真机调试。

~~~sh
brew install xcodegen
cd ios
cp Config.example.xcconfig Config.xcconfig
# 填写本地配置：Supabase、已部署 Web URL 和开发者 Team
xcodegen generate
open FitnessTracker.xcodeproj
~~~

选择自己的 Team 与唯一 Bundle Identifier，确保 App ID 开启 HealthKit 和后台交付能力，再用真实 iPhone 运行。iOS 不依赖第三方 SDK。登录相同账号后，可直接管理记录，或在“健康同步”中明确同意云同步并请求系统授权。

Config.xcconfig 被 git 忽略，发布前自行填入。App 只请求读取、不写入 HealthKit。登录会话和同步游标存储在此设备的 Keychain，退出清除会话。游标按账号隔离。

## HealthKit 数据语义与边界

- 同步活动能量、静息能量、步数、Apple 运动分钟、每日平均心率、体重、体脂和训练类型/时长/活动能量。腰围手动。
- 每次重算最近 90 天每日汇总；身体测量与训练使用 anchored queries 同步全部可读历史及增量删除。每批上限 10,000 测量、10,000 训练与 20,000 删除；超限会明确失败，不推进游标。
- 服务器事务按当前账号与 HealthKit UUID 去重。事务成功后才保存本地游标；失败安全重试。删除对象使用同一事务删除已导入样本。
- HealthKit 每日汇总优先于手动日消耗。全天消耗 = 活动 + 静息；不再累加训练热量，避免重复。
- 权限拒绝、缺失数据用 null 表示，不伪装成零，也不由此推断已获授权。重新授权后重算 90 天；更早每日汇总不会自动重算。
- App 在用户当次明确同意后注册观察与后台交付；重新启动需再次同意。iOS 决定交付时机，不保证小时同步或 App 被强制退出后的自动同步。
- 用户资料时区优先；未设置使用手机时区。更改时区后每日汇总重新计算，而已导入历史样本日期保留其首次同步时区，必要时需重新导入。V1 建议固定一个时区。
- 同一账号建议仅用一部 iPhone 作为同步源。多 iPhone 汇总目前采用最近一次同步覆盖，不进行跨设备服务端融合。
- 从云端删除账号不会删除 Apple Health 原始数据；在健康 App 撤销授权也不会删除已有云端记录，需使用账号删除功能。

## 验证

~~~sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
~~~

GitHub Actions 包括：
- Web TypeScript、领域计算与校验测试、生产构建、桌面与手机 Playwright 演示流程。
- PostgreSQL 16 执行真实迁移，验证跨账号读写阻止、匿名阻止、HealthKit 幂等与删除、账号级联删除。
- macOS 生成 iOS 工程、模拟器构建和 XCTest；模拟器测试不读取真实 HealthKit。

依赖 lockfile 由首次 CI 安装解析并作为 web-validation artifact 提供；请将通过验证的 package-lock.json 固定入仓库后日常采用 npm ci。查看实际 Actions 结果，不能把仅新增测试文件视作已通过测试。

真机上线验收清单见 docs/ACCEPTANCE.md。未经真实项目配置、双账号登录与真机 HealthKit 验收，不能视为已上线成品。

## 隐私

- 不采集真实数据到示例、日志或 Git；不集成广告与健康追踪分析服务。
- 数据只发送到用户配置的 Supabase 服务；公开仓库仅含源码、配置模板与虚构测试。
- 数据库存取依赖 RLS；前端校验之外保留数据库约束。默认使用 HTTPS。
- Web 会话由 Supabase 客户端保存在浏览器中；请避免共享浏览器账号环境。iOS 使用设备 Keychain。
- JSON 导出包含敏感健康记录，应由用户自行妥善保存。
- 本应用用于个人记录；用户自行设定目标，估算不构成医疗诊断。

## 参考

- [Next.js 安装与部署](https://nextjs.org/docs/app/getting-started/installation)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [HealthKit 授权](https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data)
- [HKAnchoredObjectQuery](https://developer.apple.com/documentation/healthkit/hkanchoredobjectquery)
- [HealthKit 后台交付](https://developer.apple.com/documentation/healthkit/hkhealthstore/enablebackgrounddelivery(for:frequency:withcompletion:))

## License

[MIT](LICENSE)
