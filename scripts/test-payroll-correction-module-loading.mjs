import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const request={
  id:"11111111-1111-4111-8111-111111111111",
  postingId:"22222222-2222-4222-8222-222222222222",
  accountingDate:"2026-10-04",
  reason:"Correct provider totals",
}
const directory=await mkdtemp(join(tmpdir(),"arc-payroll-module-"))
try { for(const [entry,schemaName,nested] of [
  ["plan","payrollCorrectionRequestSchema",false],
  ["context","correctionContextSchema",true],
  ["source","payrollCorrectionSourceSchema",true],
  ["posting","payrollCorrectionPostingSchema",false],
]){
  const built=await Bun.build({entrypoints:[`lib/services/books/payroll-correction-${entry}.ts`],target:"node",format:"esm"})
  assert.ok(built.success,built.logs.join("\n"))
  const output=join(directory,`${entry}.mjs`)
  await writeFile(output,await built.outputs[0].text())
  const loadedModule=await import(pathToFileURL(output).href)
  const schema=loadedModule[schemaName]
  assert.ok(schema,`${entry} must initialize its exported schema`)
  if(entry!=="posting"){
    const requestSchema=nested?schema.shape.request:schema
    assert.deepEqual(requestSchema.parse(request),request)
    assert.equal(requestSchema.safeParse({...request,reason:"Short"}).success,false)
    assert.equal(requestSchema.safeParse({...request,unexpected:true}).success,false)
  }
}} finally {await rm(directory,{recursive:true,force:true})}
console.log("Payroll correction schemas initialize from every module entry without changing request validation")
