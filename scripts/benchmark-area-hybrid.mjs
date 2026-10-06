#!/usr/bin/env node
/** Explicit local model experiment. Sends only selected drawing crops to the
 * configured model provider, writes local evidence/usage, never touches the DB.
 * Run: node scripts/benchmark-area-hybrid.mjs PDF PAGE SCALE OUTPUT MODEL
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { generateText, Output } from 'ai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import * as mupdf from 'mupdf'
const require = createRequire(import.meta.url)
require('./register-ts-node-test')
const { runAreaEngine, areaRecognitionPrompt } = require('../lib/drawings/area-engine')
const { visualInterpretationSchema } = require('../lib/drawings/area-semantics')
const { createAreaReplay } = require('../lib/drawings/area-replay')
const [pdf, pageArg, scale, output, modelId] = process.argv.slice(2).filter((arg) => arg !== '--gate')
if (pdf) require('./holdout-guard.js').assertNotHoldout({ sha256: require('./holdout-guard.js').fileSha256(pdf), label: pdf, script: 'benchmark-area-hybrid', gate: process.argv.includes('--gate') })
if (!modelId || !output || !pdf) throw Error('Usage: node scripts/benchmark-area-hybrid.mjs PDF PAGE SCALE OUTPUT PROVIDER/MODEL')
process.loadEnvFile('.env.local')
const [provider, ...modelParts] = modelId.split('/'), modelName = modelParts.join('/')
const model = provider === 'google' ? createGoogleGenerativeAI({apiKey:process.env.GOOGLE_GENERATIVE_AI_API_KEY})(modelName)
  : provider === 'openai' ? createOpenAI({apiKey:process.env.OPENAI_API_KEY,baseURL:process.env.OPENAI_BASE_URL})(modelName) : null
if (!model) throw Error('Use an existing configured google or openai provider for this isolated benchmark.')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'arc-hybrid-'))
let doc, page
try {
  const inputFile = path.join(tmp,'input.json')
  execFileSync(process.execPath,['scripts/import-area-pdf.js',pdf,pageArg,scale,inputFile])
  const { input } = JSON.parse(fs.readFileSync(inputFile,'utf8'))
  input.region = {x0:0,y0:0,x1:1,y1:1}
  doc=mupdf.Document.openDocument(fs.readFileSync(pdf),'application/pdf');page=doc.loadPage(Number(pageArg)-1)
  const bounds=page.getBounds(),w=bounds[2]-bounds[0],h=bounds[3]-bounds[1]
  const usage=[],requests=[]
  const started=performance.now()
  const result=await runAreaEngine(input,{wholeSheet:true,recognize:async request=>{
    const r=request.region, crop=[bounds[0]+r.x0*w,bounds[1]+r.y0*h,bounds[0]+r.x1*w,bounds[1]+r.y1*h]
    const factor=2000/Math.max(crop[2]-crop[0],crop[3]-crop[1])
    const pix=new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB,[0,0,Math.ceil((crop[2]-crop[0])*factor),Math.ceil((crop[3]-crop[1])*factor)],false)
    pix.clear(255)
    const device=new mupdf.DrawDevice(mupdf.Matrix.identity,pix)
    let image
    try {page.run(device,[factor,0,0,factor,-crop[0]*factor,-crop[1]*factor]);device.close();image=pix.asPNG()}
    finally {device.destroy();pix.destroy()}
    const begin=performance.now(),index=requests.length+1
    fs.writeFileSync(output+`.crop-${index}.png`,image)
    requests.push({region:r,catalogue:request.catalogue})
    try {
      const answer=await generateText({model,output:Output.object({schema:visualInterpretationSchema}),maxRetries:0,abortSignal:AbortSignal.timeout(30_000),
        messages:[{role:'user',content:[{type:'text',text:areaRecognitionPrompt(request)},{type:'image',image}]}]})
      usage.push({window:index,model:modelId,elapsedMs:performance.now()-begin,usage:answer.usage,status:'completed'})
      return answer.output
    } catch(error) {
      // Avoid logging provider URLs, request bodies or credential-bearing errors.
      usage.push({window:index,model:modelId,elapsedMs:performance.now()-begin,status:'failed',errorType:error?.name ?? 'Error'})
      return null
    }
  }})
  const replay=createAreaReplay({...input,visualObservations:result.observations},true,{},result.recognition)
  fs.writeFileSync(output+'.replay.json',JSON.stringify(replay))
  fs.writeFileSync(output,JSON.stringify({qualification:'Unqualified development model experiment; no independent truth.',model:modelId,elapsedMs:performance.now()-started,usage,requests,...result},null,2))
  console.log(JSON.stringify({output,recognition:result.recognition,areas:result.detection.proposals.length,usage}))
} finally {page?.destroy();doc?.destroy();fs.rmSync(tmp,{recursive:true,force:true})}
