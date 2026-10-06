require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),sharp=require('sharp')
let tile,missing=false
const originalLoad=Module._load
Module._load=function(request,parent,main){
 if(parent?.filename.endsWith('/lib/services/drawings-sheet-images.ts')&&request==='@/lib/storage/drawings-tiles-storage')return {downloadTilesObject:async()=>{if(missing)throw new Error('Missing tile');return tile}}
 return originalLoad.call(this,request,parent,main)
}
const {renderSheetWindowImage}=require('../lib/services/drawings-sheet-images')
Module._load=originalLoad

test('measurement crops preserve source pixels and registration across fractional window edges',async()=>{
 const pixels=Buffer.alloc(512*512*3,255)
 for(let y=40;y<43;y++)for(let x=30;x<33;x++)for(let c=0;c<3;c++)pixels[(y*512+x)*3+c]=0
 tile=await sharp(pixels,{raw:{width:512,height:512,channels:3}}).png().toBuffer();missing=false
 const requested={x0:.103,y0:.107,x1:.809,y1:.813}
 const image=await renderSheetWindowImage({supabase:{},tilesBasePath:'test',imageWidth:101,imageHeight:99,window:requested,maxEdge:512,requireComplete:true,lossless:true})
 assert.equal(image.mediaType,'image/png')
 const {data,info}=await sharp(image.data).raw().toBuffer({resolveWithObject:true})
 assert.equal(data[(30*info.width+20)*info.channels],0)
 const r=image.sourceRegion
 assert.ok(Math.abs((r.x0+(20/info.width)*(r.x1-r.x0))*101-30)<1e-9)
 assert.ok(Math.abs((r.y0+(30/info.height)*(r.y1-r.y0))*99-40)<1e-9)
 assert.ok(r.x0<=requested.x0&&r.y0<=requested.y0&&r.x1>=requested.x1&&r.y1>=requested.y1)
})
test('recognition refuses an incomplete tiled crop',async()=>{
 missing=true
 const image=await renderSheetWindowImage({supabase:{},tilesBasePath:'test',imageWidth:101,imageHeight:99,window:{x0:0,y0:0,x1:1,y1:1},requireComplete:true,lossless:true})
 assert.equal(image,null)
})

test('provider overlays retain original sheet coordinates after crop rounding',()=>{
 const {registerRecognitionImage}=require('../lib/drawings/recognition-overlay')
 const request={region:{x0:.2,y0:.3,x1:.5,y1:.6},catalogue:[{id:8,prior:'wall',kind:'stroke',bounds:[0,0,1,1],commands:[['M',0,0],['L',1,1]]}]}
 const imageRegion={x0:.19,y0:.29,x1:.51,y1:.61},registered=registerRecognitionImage(request,imageRegion)
 const end=registered.catalogue[0].commands[1]
 assert.equal(registered.catalogue[0].id,8)
 assert.ok(Math.abs(imageRegion.x0+end[1]*(imageRegion.x1-imageRegion.x0)-.5)<1e-12)
 assert.ok(Math.abs(imageRegion.y0+end[2]*(imageRegion.y1-imageRegion.y0)-.6)<1e-12)
 assert.deepEqual(request.catalogue[0].commands,[['M',0,0],['L',1,1]])
})
