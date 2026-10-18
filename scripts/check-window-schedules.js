#!/usr/bin/env node
/** Local-only source diagnostic; does not upload a PDF or change a project. */
require('./register-ts-node-test')
const fs = require('node:fs')
const {createHash} = require('node:crypto')
const {extractWindowSchedules} = require('../lib/drawings/window-schedules')
async function main() {
  const [file, pagesArg, output] = process.argv.slice(2)
  if(!file || !pagesArg || !output) throw Error('Usage: node scripts/check-window-schedules.js plan.pdf PAGE_1_BASED[,PAGE...] output.json')
  const numbers=pagesArg.split(',').map(Number)
  if(!numbers.length || numbers.some(n=>!Number.isInteger(n)||n<1) || new Set(numbers).size!==numbers.length) throw Error('Supply distinct positive page numbers')
  const bytes=fs.readFileSync(file),sha256=createHash('sha256').update(bytes).digest('hex')
  const mupdf=await import('mupdf'),doc=mupdf.Document.openDocument(bytes,'application/pdf')
  try {
    if(numbers.some(n=>n>doc.countPages())) throw Error('Page is outside the document')
    const pages=[]
    for(const pageNumber of numbers){
      const page=doc.loadPage(pageNumber-1)
      try {
        const [x0,y0,x1,y1]=page.getBounds(),text=page.toStructuredText('preserve-whitespace')
        try {
          const json=JSON.parse(text.asJSON())
          const textRuns=(json.blocks??[]).flatMap(b=>(b.lines??[]).map(l=>({text:l.text??'',x:(l.bbox.x-x0)/(x1-x0),y:(l.bbox.y-y0)/(y1-y0),w:l.bbox.w/(x1-x0),h:l.bbox.h/(y1-y0)})))
          pages.push({sourceId:`${sha256}:page:${pageNumber}`,pageNumber,textRuns})
        } finally {text.destroy()}
      } finally {page.destroy()}
    }
    const extraction=extractWindowSchedules(pages)
    fs.writeFileSync(output,JSON.stringify({version:1,source:{sha256,pages:numbers},qualification:'unqualified',releaseReady:false,...extraction},null,2))
    console.log(JSON.stringify({rows:extraction.rows.length,unresolvedRows:extraction.rows.filter(r=>r.issues.length).length,tableIssues:extraction.issues.length,output}))
  } finally {doc.destroy()}
}
main().catch(error=>{console.error(error.message);process.exitCode=1})
