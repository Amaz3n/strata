/** Synthetic compatibility checks only: no customer data or database writes.
 * node scripts/ai-model-smoke.mjs [--baseline] [--openrouter]
 */
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { generateObject, generateText, stepCountIs, tool } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { z } from 'zod'
import { PDFDocument, StandardFonts } from 'pdf-lib'
const require = createRequire(import.meta.url)
require('../scripts/register-ts-node-test.js')
process.loadEnvFile('.env.local')
const { generationOptions, redactAiError } = require('../lib/services/ai/policy.ts')
const { toTokenUsage, estimateCostUsd } = require('../lib/services/ai/usage.ts')
const pdf = await PDFDocument.create()
const page = pdf.addPage([612, 792])
const font = await pdf.embedFont(StandardFonts.Helvetica)
page.drawText('SYNTHETIC QA INVOICE\nVendor: Acme Test Supply\nInvoice: QA-104\nDate: 2026-09-23\n2 pumps at $125.00 = $250.00\nTax: $20.00\nTotal: $270.00', { x: 50, y: 700, size: 18, font, lineHeight: 28 })
const pdfBytes = await pdf.save()
const models = [ ['openai', 'gpt-6-luna'], ['openai', 'gpt-6-sol'], ['google', 'gemini-3.8-flash'] ]
if (process.argv.includes('--baseline')) models.push(['openai', 'gpt-5.6-luna'], ['google', 'gemini-3.7-flash'], ['google', 'gemini-3.1-flash-lite'])
if (process.argv.includes('--openrouter')) models.push(['openrouter', 'deepseek/deepseek-v4.1-flash'])
let failures = 0
for (const [provider, id] of models) {
  const key = provider === 'openai' ? process.env.OPENAI_API_KEY?.trim() : provider === 'google' ? (process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY)?.trim() : process.env.OPENROUTER_API_KEY?.trim()
  if (!key) { console.log(JSON.stringify({provider, model: id, status: 'skipped_missing_key'})); continue }
  const model = provider === 'openai' ? createOpenAI({apiKey:key, baseURL:process.env.OPENAI_BASE_URL})(id) : provider === 'google' ? createGoogleGenerativeAI({apiKey:key})(id) : createOpenAICompatible({name:'openrouter',apiKey:key,baseURL:'https://openrouter.ai/api/v1'})(id)
  const options = { model, maxRetries: 0, ...generationOptions(provider,id,'document_extraction'), abortSignal: AbortSignal.timeout(35000) }
  for (const fixture of ['classification', 'invoice_pdf', 'tool_call']) {
    if (provider === 'openrouter' && fixture === 'invoice_pdf') continue // App rasterization is covered separately.
    const start = performance.now()
    try {
      let result
      if (fixture === 'classification') {
        result = await generateObject({...options,abortSignal:AbortSignal.timeout(35000),schema:z.object({kind:z.enum(['rfi','invoice','general']),reference:z.string().nullable()}),prompt:'Classify: Please clarify the specified roof insulation thickness. Reference RFI-12. Return rfi and the reference.'})
        if (result.object.kind !== 'rfi' || result.object.reference !== 'RFI-12') throw new Error('classification mismatch')
      } else if (fixture === 'invoice_pdf') {
        result = await generateObject({...options,abortSignal:AbortSignal.timeout(35000),schema:z.object({vendor:z.string(),invoice:z.string(),total:z.number(),tax:z.number()}),messages:[{role:'user',content:[{type:'text',text:'Extract the invoice exactly. Amounts in dollars.'},{type:'file',data:pdfBytes,mediaType:'application/pdf'}]}]})
        if (result.object.invoice !== 'QA-104' || result.object.total !== 270 || result.object.tax !== 20) throw new Error('invoice mismatch')
      } else {
        let called = false
        result = await generateText({...options,abortSignal:AbortSignal.timeout(35000),tools:{lookup:tool({description:'Look up the invoice total',inputSchema:z.object({invoice:z.string()}),execute:async({invoice})=>{if(invoice!=='QA-104')throw new Error('wrong tool input');called=true;return {total:270}}})},toolChoice:'required',stopWhen:stepCountIs(1),prompt:'Use lookup for invoice QA-104.'})
        if (!called) throw new Error('tool was not executed')
      }
      const usage=toTokenUsage(result.usage)
      console.log(JSON.stringify({provider,model:id,fixture,status:'ok',latencyMs:Math.round(performance.now()-start),usage,costUsd:estimateCostUsd({provider,model:id,usage})}))
    } catch(error) {
      failures++
      console.log(JSON.stringify({provider,model:id,fixture,status:'error',latencyMs:Math.round(performance.now()-start),error:redactAiError(error.message)}))
      if (/api key|unauthorized|authentication|not found|does not exist/i.test(error.message)) break
    }
  }
}
process.exitCode=failures?1:0
