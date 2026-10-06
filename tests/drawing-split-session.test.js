const test=require('node:test'),assert=require('node:assert/strict')
const {createSplitFixture:fixture}=require("./fixtures/drawing-lifecycle/split-harness.cjs")
for(const pages of [24,25,300])test(`${pages} pages fetch/open once and emit the first page before the final split`,async()=>{
 const f=await fixture(pages);await f.run();assert.equal(f.counts.downloads,1);assert.equal(f.counts.opens,1);assert.equal(f.tables.outbox.length,pages);assert.equal(f.counts.firstEmittedAfterPuts,1);assert.equal(f.counts.registrationCalls,Math.ceil(pages/8));assert.ok(f.counts.registrationBatchSizes.every(n=>n<=8))
 const puts=f.counts.puts;await f.run();assert.equal(f.tables.outbox.length,pages);assert.equal(f.counts.puts,puts,'retry retains committed page outputs')
})
test('crash after prior pages committed resumes without duplicate jobs or rewriting completed pages',async()=>{
 const f=await fixture(25);f.fail(5);await assert.rejects(f.run(),/interrupted/);assert.equal(f.tables.outbox.length,4);assert.equal(f.tables.drawing_split_pages.length,8,'pre-PUT intent survives failure')
 f.fail(null);await f.run();assert.equal(f.tables.outbox.length,25);assert.equal(f.counts.puts,26)
})
test('deleted page tombstone prevents recreation and rendering work',async()=>{
 const f=await fixture(3);f.tables.drawing_deleted_pages.push({org_id:'org',revision_id:'revision',page_index:1});await f.run();assert.deepEqual(f.tables.outbox.map(p=>p.pageIndex),[0,2])
})
test('effective renderer configuration changes artifact recipe and includes native engine identity',async()=>{
 const first=await fixture(1),before=await first.pipeline.drawingRenderRecipe(),original=process.env.DRAWINGS_TILE_SIZE
 try{process.env.DRAWINGS_TILE_SIZE='256';const next=await fixture(1),after=await next.pipeline.drawingRenderRecipe();assert.notEqual(before,after);const recipe=JSON.parse(after);assert.equal(recipe.tileSize,256);assert.match(recipe.mupdfWasm,/^[a-f0-9]{64}$/);assert.ok(recipe.encoders.vips);assert.ok(recipe.encoders.webp)}finally{if(original===undefined)delete process.env.DRAWINGS_TILE_SIZE;else process.env.DRAWINGS_TILE_SIZE=original}
})
