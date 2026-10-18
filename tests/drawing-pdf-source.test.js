require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict')
const {drawingPdfSourceKey} = require('../lib/storage/drawing-pdf-source')
test('native drawing uploads retain their object while a library PDF is used directly',()=>{
 assert.equal(drawingPdfSourceKey('org/job/drawings/uploads/plan.pdf'),'drawings-pdfs/org/job/drawings/uploads/plan.pdf')
 assert.equal(drawingPdfSourceKey('org/job/drawings/sets/plan.pdf'),'drawings-pdfs/org/job/drawings/sets/plan.pdf')
 assert.equal(drawingPdfSourceKey('org/job/123_plan.pdf'),'project-files/org/job/123_plan.pdf')
 assert.equal(drawingPdfSourceKey('org/job/plans/version/plan.pdf'),'project-files/org/job/plans/version/plan.pdf')
 assert.equal(drawingPdfSourceKey('/org/job/drawings-notes.pdf'),'project-files/org/job/drawings-notes.pdf')
})

test('library versions in drawing folders fall back only when the native object is absent', async()=>{
 const {resolveDrawingPdfSourceKey} = require('../lib/storage/drawing-pdf-source')
 const path='org/job/drawings/uploads/version.pdf'
 assert.equal(await resolveDrawingPdfSourceKey(path,async()=>false),'project-files/'+path)
 assert.equal(await resolveDrawingPdfSourceKey(path,async()=>true),'drawings-pdfs/'+path)
 await assert.rejects(()=>resolveDrawingPdfSourceKey(path,async()=>{throw new Error('Forbidden')}),/Forbidden/)
})
