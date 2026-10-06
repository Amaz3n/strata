require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {PDFDocument,PDFName,PDFString,degrees,StandardFonts}=require('pdf-lib')
const {syntheticPdf}=require('./fixtures/drawing-lifecycle/synthetic.cjs')
const {fingerprintDrawingPage}=require('../lib/drawings/page-artifact-key')
const recipe='mupdf-test/150dpi/512px/webp85/vector-v1'
async function keys(bytes, recipeOverride=recipe){const m=await import('mupdf'),doc=m.Document.openDocument(bytes,'application/pdf');try{return Array.from({length:doc.countPages()},(_,i)=>fingerprintDrawingPage(m,doc,i,recipeOverride))}finally{doc.destroy()}}
test('300 pages with one edit produce 299 exact page keys and one miss',async()=>{
 const before=await keys(await syntheticPdf(300)),after=await keys(await syntheticPdf(300,{changedPage:151}))
 assert.ok(before.every(x=>x.supported));assert.ok(after.every(x=>x.supported))
 assert.equal(before.filter((v,i)=>v.fingerprint===after[i].fingerprint).length,299)
})
test('metadata changes and reordering original pages preserve exact keys',async()=>{
 const original=await syntheticPdf(3),before=await keys(original),doc=await PDFDocument.load(original,{updateMetadata:false})
 doc.setTitle('New issue metadata');const first=doc.getPage(0);doc.removePage(0);doc.addPage(first)
 const after=await keys(await doc.save());assert.deepEqual(after.map(x=>x.fingerprint),[before[1],before[2],before[0]].map(x=>x.fingerprint))
})
test('render recipe, rotation, crop, tiny text, font and image edits never match',async()=>{
 const original=await syntheticPdf(1),before=(await keys(original))[0]
 assert.notEqual((await keys(original,recipe+'-new'))[0].fingerprint,before.fingerprint)
 const edits=[p=>p.setRotation(degrees(90)),p=>p.setCropBox(5,5,500,300),p=>p.drawText('.',{x:20,y:20,size:1}),async(p,d)=>p.drawText('x',{font:await d.embedFont(StandardFonts.Courier),x:20,y:20}),async(p,d)=>p.drawImage(await d.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64')),{x:1,y:1,width:10,height:10})]
 for(const edit of edits){const doc=await PDFDocument.load(original,{updateMetadata:false});await edit(doc.getPage(0),doc);const next=(await keys(await doc.save()))[0];assert.ok(!next.supported||next.fingerprint!==before.fingerprint)}
})
test('annotations, optional layers, unknown page state and missing resources decline reuse',async()=>{
 for(const edit of [(d,p)=>p.node.set(PDFName.of('Annots'),d.context.obj([{Type:'Annot',Subtype:'Text',Contents:PDFString.of('changed')}])) ,(d)=>d.catalog.set(PDFName.of('OCProperties'),d.context.obj({OCGs:[]})),(d,p)=>p.node.set(PDFName.of('UserUnit'),d.context.obj(2)),(d,p)=>p.node.delete(PDFName.of('Resources'))]){
  const doc=await PDFDocument.load(await syntheticPdf(1),{updateMetadata:false});edit(doc,doc.getPage(0));assert.equal((await keys(await doc.save()))[0].supported,false)
 }
})
