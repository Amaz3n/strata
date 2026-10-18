require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const { generationOptions, classifyAiError, isTerminalAiError, canRetryAssistant, assistantTier } = require('../lib/services/ai/policy')
const { estimateCostUsd, toTokenUsage, usageFromError } = require('../lib/services/ai/usage')
const { AI_FEATURE_TIER_DEFAULTS, AI_FEATURE_BASE_TIER } = require('../lib/services/ai-config')

test('Google thinking effort is explicit, supported and leaves unrequested defaults intact',()=>{
 assert.deepEqual(generationOptions('google','gemini-3.8-flash','drawings_vision'),{})
 assert.deepEqual(generationOptions('google','gemini-3.8-flash','drawings_vision','low'),{providerOptions:{google:{thinkingConfig:{thinkingLevel:'low'}}}})
 assert.equal(generationOptions('google','gemini-3.8-flash','drawings_vision','none').providerOptions.google.thinkingConfig.thinkingLevel,'low')
 assert.deepEqual(generationOptions('google','gemini-2.5-flash','drawings_vision','low'),{})
})

test('GPT-6 explicitly enables SDK reasoning support without unsupported temperature', () => {
  const options = generationOptions('openai','gpt-6-luna','text_assistance')
  assert.equal(options.providerOptions.openai.forceReasoning,true)
  assert.equal(options.providerOptions.openai.reasoningEffort,'none')
  assert.equal(options.temperature,undefined)
  assert.equal(generationOptions('openai','gpt-5-mini','search','none').providerOptions.openai.reasoningEffort,'low')
  assert.equal(generationOptions('openai','gpt-6-astra','search','none').providerOptions.openai.reasoningEffort,'low')
  assert.equal(generationOptions('openai','gpt-6-sol','search').providerOptions.openai.reasoningEffort,'low')
  assert.equal(generationOptions('openai','gpt-6-luna','search','minimal').providerOptions.openai.reasoningEffort,'low')
})
test('configuration faults stop; availability faults can recover', () => {
  for (const message of ['Incorrect API key provided','Invalid schema for response_format']) assert.ok(isTerminalAiError(classifyAiError(new Error(message))))
  assert.equal(classifyAiError(Object.assign(new Error('Busy'),{statusCode:503})),'unavailable')
  assert.equal(classifyAiError(new Error('This model is currently experiencing high demand.')),'unavailable')
  assert.equal(classifyAiError(new Error('The operation was aborted due to timeout')),'timeout')
})
test('assistant fallback cannot duplicate text or tool-side effects', () => {
  const base={kind:'unavailable',emittedText:false,calledTool:false,aborted:false,remainingMs:10000}
  assert.equal(canRetryAssistant(base),true)
  for (const patch of [{emittedText:true},{calledTool:true},{aborted:true},{remainingMs:0},{kind:'authentication'}]) assert.equal(canRetryAssistant({...base,...patch}),false)
  assert.equal(assistantTier('Reconcile payments against invoices'),'heavy')
  assert.equal(assistantTier('Which RFIs are open?'),'standard')
})
test('cache and reasoning accounting does not double-count output', () => {
  const usage=toTokenUsage({inputTokens:1000,outputTokens:100,totalTokens:1100,inputTokenDetails:{cacheReadTokens:800,cacheWriteTokens:100},outputTokenDetails:{reasoningTokens:60}})
  assert.equal(estimateCostUsd({provider:'openai',model:'gpt-6-luna',usage}),0.000081)
  assert.deepEqual(usageFromError({usage:{inputTokens:1000,outputTokens:100}}).inputTokens,1000)
  assert.equal(estimateCostUsd({provider:'openai',model:'gpt-6-luna',usage:{inputTokens:null,outputTokens:null,totalTokens:null}}),null)
  assert.equal(estimateCostUsd({provider:'openai',model:'gpt-6-luna',usage:{inputTokens:0,outputTokens:0,totalTokens:0}}),0)
})
test('long context pricing and audio pricing use their actual billing units', () => {
  assert.equal(estimateCostUsd({provider:'openai',model:'gpt-6-luna',usage:{inputTokens:300000,outputTokens:1000,totalTokens:301000}}),0.06075)
  assert.equal(estimateCostUsd({provider:'openai',model:'gpt-4o-mini-transcribe',usage:{inputTokens:null,outputTokens:null,totalTokens:null,audioSeconds:3600}}),0.18)
})
test('lightweight routes are independently overridable; embeddings stay compatible', () => {
  assert.equal(AI_FEATURE_TIER_DEFAULTS.document_naming.fast.model,'gpt-6-luna')
  assert.equal(AI_FEATURE_BASE_TIER.drawings_vision,'standard')
  assert.equal(AI_FEATURE_BASE_TIER.drawing_metadata,'fast')
  assert.equal(AI_FEATURE_TIER_DEFAULTS.drawing_metadata.fast.model,'gemini-3.1-flash-lite')
  assert.equal(AI_FEATURE_BASE_TIER.meeting_minutes,'fast')
  assert.equal(AI_FEATURE_TIER_DEFAULTS.embedding.fast.model,'text-embedding-3-small')
})

test('versioned settings take precedence and preserve organization search overrides', async () => {
  const config = require('../lib/services/ai-config')
  const keys=[]
  const supabase = {
    from(table) {
      return {
        select() { return this },
        eq(_, value) { keys.push(value); return this },
        async maybeSingle() {
          if (table === 'org_settings') return { data: { settings: {
            ai_search_provider: 'google', ai_search_model: 'gemini-3.1-flash-lite',
          } } }
          return { data: { value: { features: {
            document_naming: { tiers: { fast: { provider: 'openai', model: 'gpt-6-sol' } } },
          } } } }
        },
      }
    },
  }

  config.invalidatePlatformAiSearchDefaultCache()
  const naming=await config.getAiFeatureTierConfig({supabase,feature:'document_naming'})
  assert.equal(naming.model,'gpt-6-sol')
  assert.ok(keys.includes('ai_routing_v2'))
  assert.ok(!keys.includes('ai_search_defaults'))
  const search=await config.getOrgAiSearchConfig({supabase,orgId:'test-org'})
  assert.equal(search.source,'org')
  assert.equal(search.model,'gemini-3.1-flash-lite')
  config.invalidatePlatformAiSearchDefaultCache()
})

test('reported upstream provider and completed-step token totals survive later failure', () => {
  const {addTokenUsage}=require('../lib/services/ai/usage')
  const {openRouterMetadata}=require('../lib/services/ai/provider-metadata')
  const metadata=openRouterMetadata({provider:'example-host',messages:['private']})
  assert.deepEqual(metadata,{openrouter:{upstreamProvider:'example-host'}})
  const first=toTokenUsage({inputTokens:100,outputTokens:10,totalTokens:110},metadata)
  const second=toTokenUsage({inputTokens:200,outputTokens:20,totalTokens:220})
  const usage=addTokenUsage(first,second)
  assert.equal(usage.inputTokens,300)
  assert.equal(usage.outputTokens,30)
  assert.equal(usage.upstreamProvider,'example-host')
})
