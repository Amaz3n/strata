# Arc AI model review — September 23, 2026

Recommendation: evaluate GPT-6 Luna as the routine structured-output model, GPT-6 Sol as the difficult-task escalation, and Gemini 3.8 Flash as the visual-work challenger. Keep embeddings and inexpensive transcription. Test DeepSeek V4.1 Flash as a provider-diverse challenger; do not switch every feature to it on the assumption it is cheapest.

This is an inventory and selection review, not a completed model benchmark. No application code, routing settings, or production data were changed. Evidence: current working-tree call sites, live Arc Supabase platform settings and aggregate usage, and current provider documentation. The working tree contains uncommitted application changes; it is not proof of the deployed build. Deployment environment overrides and account access to the new models were not verified. No model/provider overrides were found in local `.env.local`; no organization search overrides were stored in the database.

## Current routing

`lib/services/ai-config.ts` resolves platform settings before environment variables before built-in defaults. Search additionally supports organization overrides. The following table combines the live platform overrides with working-tree defaults; rows marked observed also appeared in the last 30 days of usage.

| Feature | Base model | Higher tiers | Evidence |
|---|---|---|---|
| Search and assistant | Gemini 3.7 Flash | Fast: Gemini 3.1 Flash-Lite; heavy: GPT-5.6 Terra | Live platform setting; no recent usage rows |
| Search embeddings | text-embedding-3-small | Same at every tier | Default + observed |
| Document extraction | GPT-5.6 Luna | Gemini 3.7 Flash → GPT-5.6 Terra | Live fast override + all three observed |
| Drawing vision | Gemini 3.1 Flash-Lite | Standard/heavy: Gemini 3.7 Flash | Live base override + fast/standard observed |
| Spec classification | GPT-5 nano | GPT-5.6 Luna → Gemini 3.7 Flash | Defaults; no recent usage rows |
| Transcription | GPT-4o mini Transcribe | GPT Transcribe; Google audio at heavy | Defaults; no recent usage rows |
| Meeting minutes | Gemini 3.7 Flash | Fast: GPT-5.6 Luna; heavy: GPT-5.6 Terra | Defaults; no recent usage rows |
| Bank transaction coding | GPT-5.6 Luna | Same at every tier | Defaults; no recent usage rows |

Higher tiers are not necessarily automatic fallbacks. Assistant does not automatically escalate. Drawing wrapper disables escalation by default. Specs, bank coding, and several lightweight extraction consumers also disable escalation. Minutes starts at standard, so its configured fast Luna tier is not a fallback: the gateway only moves upward to heavy.

## Feature-specific choices

These are proposed targets conditional on evaluation, not measured winners.

| Arc operation and source under `lib/services/` | Proposed choice | What must hold |
|---|---|---|
| Assistant and global search — `ai-assistant/harness.ts` | Luna for routine retrieval; Sol for complex multi-tool questions; Gemini 3.8 as challenger/fallback | Grounded citations, correct tool arguments, permission boundaries; fit 10-second step / 25-second total budget. Requires explicit routing/fallback implementation. |
| Invoice, receipt, pay-application extraction — `document-extraction.ts` | Luna → Gemini 3.8 → Sol | Preserve every line, arithmetic, dates, currency, and tight provenance boxes; include scanned and multipage PDFs. |
| AP category suggestions and invoice-to-commitment line matching — `document-extraction.ts` | Luna, no automatic expensive escalation | Choose only supplied IDs and abstain when ambiguous. |
| Bank transaction coding — `books/bank-ai-suggestions.ts` | Luna, initially retain low reasoning | Exactly one result per transaction; valid account/vendor IDs; abstention; 20-second budget and 6,000 output-token cap. |
| Waiver extraction and template mapping — `invoice-waiver-extraction.ts`, `waiver-template-extraction.ts`, `payable-waivers.ts` | Luna; Sol for difficult forms | Correct parties, amounts, dates, signer fields, and page geometry; retain review. Validate schemas independently of model quality. |
| Insurance/compliance document extraction — `ap-document-verification.ts` | Luna → visual challenger → Sol | Preserve policy limits, dates, endorsements, and checkbox evidence. |
| File naming — `document-ai-rename.ts` | Luna, no reasoning initially | Accurate concise names, no invented metadata. |
| Project email classification — `project-email-ingest.ts` | Luna, no reasoning initially | Correct enum, safe handling of untrusted email content. |
| Photo captions/tags — `photo-intelligence.ts` | Luna; compare with Gemini on small visual details | No invented defects, materials, or progress. |
| CSV import mapping — `import-mapping.ts` | Luna after deterministic aliases | Exact source headers; never invent or merge columns. |
| Budget scope-note polish — `budget-from-estimate.ts` | Luna, no reasoning | Preserve trade scope; finish within 12 seconds. |
| Quick capture field-note drafts — `quick-capture.ts` | Luna | No invented people/dates/locations; correct draft type. Audio transcription remains separate. |
| Submittal-register extraction — `submittal-register-extraction.ts` | Luna; Sol for ambiguous obligations | Recall all required submittals, avoid inventing obligations. |
| Spec-section classification — `specs-pipeline.ts` | Keep GPT-5 nano initially; compare Luna | Existing model is cheaper per token. Upgrade only for fewer errors/timeouts or lower total billed work. |
| Drawing title blocks — `drawings-pipeline.ts` | Keep 3.1 Flash-Lite baseline; test Luna | Exact sheet number/title/scale, null when unreadable. Recent baseline latency is good. |
| Takeoff symbol checks, revision semantics, floorplan proposals — `takeoff-assist.ts`, `drawings-change-semantics.ts`, `floorplan-vision-assist.ts` | Test Gemini 3.8 against Luna/Sol; DeepSeek as additional vision challenger | Tiny symbols, before/after changes, counts and coordinates. Keep deterministic geometry authoritative. Split from title-block routing if winner differs. |
| Meeting minutes — `meeting-transcripts.ts` | Luna baseline candidate; Sol for ambiguous item reconciliation; Gemini 3.8 speed challenger | Correct existing-item IDs, decisions, owners and dates; no invented action items; complete output within 90 seconds. |
| Transcription — `meeting-transcripts.ts` | Keep mini; test GPT Transcribe for noisy meetings | Construction terminology, names, numbers and negations. GPT-6 Luna/Sol are not audio models. |
| Embeddings — `search-embeddings.ts` | Keep text-embedding-3-small | Current vectors are 1,536 dimensions. Any embedding-model change requires a consistent re-index of documents and queries, even if vector width matches. |

## Current model economics

USD per million uncached text input/output tokens, Standard processing and short-context rates. These are rate comparisons, not equivalent-quality benchmarks or invoice forecasts.

| Candidate | Input | Output | Role |
|---|---:|---:|---|
| GPT-6 Luna | $0.10 | $0.50 | Routine structured work |
| GPT-6 Sol | $2.00 | $10.00 | Difficult reasoning/tool work |
| DeepSeek V4.1 Flash, direct off-peak | $0.15 | $0.60 | Cached/repeated workloads and independent-provider challenger |
| DeepSeek V4.1 Flash, direct peak | $0.30 | $1.20 | Same model; account for schedule |
| Gemini 3.8 Flash | $0.75 | $3.75 | Visual and complex-work challenger |
| Claude Sonnet 5 | $2.00 | $10.00 | Alternative to Sol if it wins Arc evaluations |
| Claude Haiku 4.5 | $1.00 | $5.00 | No obvious rate advantage over Luna |
| GPT-6 Astra / Claude Fable 5.1 | $10.00 | $50.00 | Difficult-case quality reference, not routine default |

OpenAI rates and capabilities: [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), [pricing](https://developers.openai.com/api/docs/pricing). DeepSeek rates: [official pricing](https://api-docs.deepseek.com/quick_start/pricing/). Other candidates: [Google pricing](https://ai.google.dev/gemini-api/docs/pricing), [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing).

Gemini 3.8 and 3.7 rates double on January 1, 2027. DeepSeek's direct API ID is `deepseek-flash`; the OpenRouter ID is `deepseek/deepseek-v4.1-flash`. OpenRouter currently lists providers with different rates, throughput and availability, so direct peak/off-peak economics cannot be applied to every routed request. Some OpenRouter providers match Luna's $0.10/$0.50 rates. [OpenRouter model/provider listing](https://openrouter.ai/deepseek/deepseek-v4.1-flash).

Using Arc's existing catalog as the old-rate baseline, Luna 5.6 → 6 cuts input rates 50% and output rates 58.3%. Gemini 3.7 → Luna cuts both rates 86.7%. Terra → Sol retains the $2 input rate and reduces $12 output to $10. These comparisons assume equal billable token counts; image tokenization, reasoning, retries, caching and quality can change actual savings.

Example: 10,000 tasks, each with 5,000 input and 1,000 output tokens, cost $22 at Arc's old Luna rates, $10 with Luna 6, $13.50/$27 with direct DeepSeek off-peak/peak, $75 with current Gemini Flash rates, or $200 with Sol. Excludes cache writes/hits, image differences, retries, extra reasoning and tools.

DeepSeek can win cache-heavy workloads despite higher uncached rates: direct off-peak cached input is $0.003/M versus Luna's $0.01/M. Its native vision makes it eligible for visual trials, but provider claims do not establish superiority on Arc drawings. [DeepSeek release](https://api-docs.deepseek.com/news/news260910/).

## What the live evidence says

The rolling 30-day usage query returned 482 attempt rows and about $0.326 in recorded estimated cost. This is too little, and telemetry too incomplete, to forecast meaningful monthly dollar savings.

| Feature/model | Successful attempts / attempts | Mean attempt latency |
|---|---:|---:|
| Drawings / Gemini 3.1 Flash-Lite | 128 / 207 | 12.35 s |
| Drawings / Gemini 3.7 Flash | 1 / 53 | 11.33 s |
| Extraction / GPT-5.6 Luna | 15 / 21 | 12.32 s |
| Extraction / Gemini 3.7 Flash | 0 / 6 | 32.73 s |
| Extraction / GPT-5.6 Terra | 1 / 6 | 5.35 s |
| Embeddings / small | 188 / 189 | 0.97 s |

These are attempt success rates, not user-task success or extraction accuracy. Drawing errors comprised 55 provider errors, 55 rate limits and 21 timeouts, concentrated September 16–17. Most provider errors explicitly reported high demand. In the latest seven days, all 40 drawing attempts succeeded: 39 Flash-Lite at a mean 2.95 seconds and one Flash at 5.75 seconds. Recent Luna extraction had two successes averaging 5.45 seconds. Samples are not matched, so do not use them to rank models.

Extraction history also includes invalid credentials, incompatible schema errors (missing required signer field and numeric enum incompatibility), and four arithmetic-verification failures across the three models. Replacing a model does not repair credentials or malformed schemas. Verify whether those old defects remain before spending on more expensive fallback calls.

## Integration and evaluation before rollout

1. **Check GPT-6 request compatibility.** Arc's native OpenAI provider already uses Responses. The assistant supplies temperature without explicit reasoning effort; explicitly select none/low per workload and make temperature conditional. GPT-6 requires removing temperature for reasoning modes other than none. Check the installed SDK's handling of new IDs rather than assuming name substitution handles it. [Official model guidance](https://developers.openai.com/api/docs/guides/latest-model).
2. **Separate routing by task.** One extraction switch affects financial PDFs, text classification, captions and cosmetic notes. Drawing routing similarly combines title blocks with harder geometry. Introduce subtask routing if evaluations favor different models. Explicitly wire escalation where intended; editing an unused heavy tier accomplishes nothing.
3. **Add cross-provider availability fallback.** Do not repeatedly retry the same overloaded provider or treat authentication/schema faults as a need for a stronger model. Keep bounded total deadlines. Preserve deterministic validation and review.
4. **Treat OpenRouter integration as a real compatibility test.** Arc uses the OpenAI-compatible adapter and rasterizes PDFs for that provider. Verify vision, strict schema support, thinking controls and tool streaming on the chosen backend. Direct DeepSeek needs a dedicated provider path or carefully scoped adapter; do not repoint the shared OpenRouter endpoint and break other models.
5. **Improve accounting.** New model IDs are valid but currently absent from the seed price catalog. Add prices and track cached input, reasoning, audio duration and actual provider where applicable. Caught failures currently record empty usage; the database totals are not provider invoices.
6. **Run a matched evaluation before changing defaults.** Start with at least 50 representative examples per major workload, including known failures. Compare current model, Luna, the best modality-specific challenger, and Sol on difficult cases. Score field accuracy, schema validity, arithmetic, provenance, grounded tools, and human corrections; measure p50/p95 time to usable result and total cost per accepted result, including retries. Existing assistant invariant evaluations provide a starting point but do not establish model ranking.
7. **Roll out in order.** Luna 5.6 → 6 first after compatibility checks; then minutes and routine assistant; then complex drawing routing. Preserve original configs for rollback. Keep embeddings, transcription and cheap spec classification unless the evaluation justifies a change.

For audio, published estimated rates are $0.003/minute for mini and $0.0045/minute for GPT Transcribe: about $0.18 versus $0.27 per hour. [OpenAI audio pricing](https://developers.openai.com/api/docs/pricing). Paying the extra $0.09/hour can be sensible if terminology accuracy materially improves, but that improvement was not measured here.
