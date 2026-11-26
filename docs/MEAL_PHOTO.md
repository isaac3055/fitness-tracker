# Meal photo estimation (web beta)

Workflow: take/upload one photo → choose 1–20 diners → explicitly consent to provider transmission → analyze → review per-person estimates → edit → save using the existing food form. Sharing assumes equal portions. Users can correct their own calories/macronutrients before saving. The stored name includes photo-estimate provenance and sharing count; existing exports and iOS food lists continue to work.

## Provider and zero-extra-cost constraint

Only `Qwen/Qwen3.5-4B` at `https://api.siliconflow.cn/v1/chat/completions` is allowed. The official model page listed both input and output tokens as free on **2026-11-26**:
https://www.siliconflow.cn/models/Qwen%2FQwen3.5-4B

This is a current provider price, not a permanent price guarantee. Do not recharge, attach a paid billing method, buy credits, enable paid upgrades or replace the model with a paid variant. No model selector, paid fallback, automatic retry or API SDK retry exists in this implementation. If provider availability or pricing changes, disable `MEAL_PHOTO_ENABLED` and review before using again. The app cannot enforce a third party's future billing policy. Vercel/Supabase free-plan quotas still apply; remain on free plans with no automatic paid upgrades.

Production stays disabled unless `MEAL_PHOTO_ENABLED=true` **and** the secret key and Supabase configuration are present. Missing quota migration fails closed before any model call.

## Enable after automated tests pass

1. Apply **only** `supabase/migrations/202611260002_meal_photo_quota.sql` in the existing Supabase project's SQL editor. It adds private counters and a quota RPC. Do not run CI bootstrap files in production.
2. In SiliconFlow, verify this exact free model is accessible from the verified account. Create an API key privately. Do not paste it into chat, source files or GitHub.
3. Add Vercel Production **Secret** `SILICONFLOW_API_KEY`. Never use a `NEXT_PUBLIC_` prefix.
4. Add Vercel Production **Config** `MEAL_PHOTO_ENABLED=true`. Existing public Supabase variables stay unchanged.
5. Redeploy. Sign in, test a non-sensitive food photo with one and two diners, confirm/edit/save, reload and verify the entry. Inspect SiliconFlow usage/billing details to confirm a zero charge before inviting others to use analysis.
6. For rollback set `MEAL_PHOTO_ENABLED=false` and redeploy. Manual food records remain available. Removing the API key also disables analysis.

## Limits and privacy

- Authenticated Supabase sessions only; server validates JWT with Auth, never trusts a client-supplied user ID.
- Quota is 10 attempts/user/day, 100 attempts/site/day, minimum 10 seconds between attempts, using a serialized PostgreSQL transaction. Day boundary is Asia/Shanghai. Provider failures count toward the cap.
- Private counters hold only user ID, date, count and last-attempt time; old counters expire during subsequent usage after seven days and are cascade-deleted with the account. No user can read/reset counters directly.
- Client decodes and re-encodes a JPEG up to 1280px and 900KB, removing original filename/EXIF/GPS metadata. Unsupported HEIC is reported, not silently uploaded.
- Only inline JPEG is accepted by the server. Arbitrary URLs/model names/extra fields are rejected. The request body is bounded even without Content-Length.
- Photos transit through the application's Vercel server to SiliconFlow. This app does not store photos or log request bodies, model output or provider error bodies. Provider handling is governed by its own policy:
https://api-docs.siliconflow.cn/docs/legals/privacy-policy
- Structured model output is validated; malformed/truncated/no-food responses never create records. User confirmation is required. Results are estimates; image analysis cannot measure hidden oil, exact weights or actual personal share.

## Validation boundaries

Automated tests use synthetic images and mocked provider replies, never a real key or personal health data. They cover auth/configuration, consent, payload bounds, quota failures, fixed model/no fallback, provider errors, response validation, serving arithmetic and mobile/desktop review/edit/save. SQL tests check counter access, cooldown, per-user/global limits and account deletion.

Real provider access, account billing and meal-photo estimate quality must be verified on the owner's account before considering this feature accepted. iOS currently displays saved food records; native camera analysis is a future client for the same authenticated endpoint, not included in this web change.

## Slow response handling

The upstream deadline is 120 seconds (previously 45); the Vercel function ceiling is 150 seconds. This fits Hobby's 300-second maximum with Fluid Compute, which is enabled by default on new projects:
https://vercel.com/docs/functions/configuring-functions/duration

No paid plan, model change or automatic retry is introduced. Requests still count toward the existing limits. Longer waiting consumes more of the hosting plan's included runtime allowance; it does not bypass that allowance.

Timeouts now return HTTP 504 and PROVIDER_TIMEOUT; connection failures return a safe code such as ENOTFOUND or PROVIDER_NETWORK. Runtime logs contain only stage, allowlisted code and elapsed milliseconds, never raw exception messages, photos, keys, user IDs, prompts or model output. This improves diagnosis; it does not establish that all live provider latency/network issues are resolved. A fresh live photo test is still required.
