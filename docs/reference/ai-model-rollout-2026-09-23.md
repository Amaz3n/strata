# AI routing upgrade — implementation and rollout

Implemented September 23, 2026. The database migration is applied; application deployment is still required to activate the new routes. No application deployment or git commit was made from this shared, heavily modified workspace.

## Routing

- Routine assistant: GPT-6 Luna. Explicit reconciliation, root-cause, forecast, scenario and cross-project comparison queries select GPT-6 Sol through a deterministic routing hint. This is not a learned classifier. Organization model overrides remain authoritative.
- Assistant availability recovery: Gemini 3.8 Flash. Only before any output text or tool call, and inside the shared 25-second model budget. Never replay tools that might create drafts.
- Financial document extraction: Luna → Gemini 3.8 → Sol, retaining existing arithmetic, provenance, page-completeness and domain validation.
- Meeting minutes: Luna → Gemini 3.8 → Sol. Luna is now the entry model, so its route is actually used.
- Bank coding: Luna; no quality escalation, with one bounded cross-provider availability recovery. Existing rule/match precedence, allowed IDs and abstention remain intact.
- New independent routes: `text_assistance`, `photo_analysis`, `document_naming`, `drawing_metadata`. Email classification, CSV mapping, quick-capture drafts, AP coding, commitment matching and scope-note polish use text assistance. Photo captions and file names have separate controls.
- Drawing title blocks retain Gemini 3.1 Flash-Lite, with Luna/Sol recovery. Complex drawing work starts at Gemini 3.8 and can escalate to Sol. Existing deterministic geometry remains authoritative.
- Embeddings, base spec classification and transcription remain on their existing models.
- DeepSeek V4.1 Flash is listed as an optional OpenRouter evaluation model. No OpenRouter API key is configured in the tested environment; it was not activated. No direct DeepSeek integration or global endpoint replacement was introduced.

## Reliability and billing

- Explicit GPT-6 reasoning support through the installed SDK's `forceReasoning` option; routine Luna uses none, Sol/bank coding use low. Temperature is omitted from assistant requests. Legacy models that do not support none use low.
- SDK retries disabled where Arc owns attempt handling. Gateway defaults to one attempt per tier and reserves budget for recovery. Authentication, schema, invalid-request and quota errors stop rather than paying for stronger models. Overload/rate-limit/timeout recovery skips the failed provider. Unknown errors stop conservatively.
- Existing waiver schema fixes were verified by regression tests: no numeric version enum and required signer fields. Historical invalid credentials were not reproduced by the current API checks; no secrets were modified.
- Usage now retains cache read/write tokens, reasoning tokens, audio duration when supplied, and OpenRouter's reported upstream provider when available. Reasoning tokens are not billed twice. Validation errors retain provider-reported usage, and completed assistant steps survive a later failure.
- Gateway, assistant and transcription await non-throwing usage recording rather than leaving writes to serverless teardown. Unknown usage stays unpriced. Audio uses minute rates. GPT-6 long-context and Gemini promotion expiry are reflected in estimates.
- Console text clarifies routing and estimated billing. The console continues showing aggregate token totals; detailed usage is stored in `ai_usage_events.usage_details` for analysis. Estimates are not provider invoices and do not include every provider fee/storage charge.

## Database and rollback

Applied migration: `20260924011003_ai_routing_usage_details.sql`.

It adds nullable JSONB `usage_details` to the existing usage table and seeds `platform_settings.ai_routing_v2`. The new application reads/writes this versioned key; the old application continues reading `ai_search_defaults`. The old routing blob is unchanged. No RLS policies, grants or customer records were changed.

A post-migration read verified the new column and routes: v2 search/extraction use Luna 6, while the old settings still name Gemini 3.7/GPT-5.6 Luna. Existing application versions remain compatible. Deploy these code changes to activate the routing upgrade. Reverting the application restores its old settings key; leave the additive column in place during rollback.

The Supabase security advisor reported pre-existing, unrelated findings, including a security-definer drawing view. This migration creates no views or functions and changes no permissions. Those findings were not modified in this AI task. [Advisor remediation reference](https://supabase.com/docs/guides/database/database-linter?lint=0010_security_definer_view).

## Verification

- TypeScript: `pnpm typecheck` passed.
- Targeted ESLint: passed.
- Focused regression suite: 101/101 passed. Coverage: model/effort compatibility, terminal errors, cross-provider recovery, bounded fallback, deterministic verification, failed-output usage, cached pricing, audio pricing, no tool replay, tenant overrides, waiver schema, grounding, numeric claims, visibility, evaluation scoring and banking behavior.
- Full `pnpm test:node`: two failures outside changed AI behavior: `payment-notification-coverage.test.js` category count (66 vs 67), and `project-read-model.test.js` overview band count (6 vs 4). Their relevant source files were not changed by this task.
- Live synthetic checks: 18/18 passed, three fixtures each on Luna 6, Sol 6, Gemini 3.8, Luna 5.6, Gemini 3.7 and Gemini 3.1 Flash-Lite. Fixtures covered classification, a generated invoice PDF and tool execution. No customer data or database writes were involved in these model checks. [Recorded results](./ai-model-validation-2026-09-23.json).
- Repeat checks with `node scripts/ai-model-smoke.mjs --baseline --openrouter`; the script reads local environment credentials without printing them. It incurs small model charges. OpenRouter is skipped when unconfigured.

Synthetic results establish API compatibility, not real-document accuracy or a statistically meaningful latency ranking. A representative, labeled Arc-document comparison remains necessary to claim better extraction quality or faster end-to-end user workflows. Existing human review and deterministic gates remain in place.
