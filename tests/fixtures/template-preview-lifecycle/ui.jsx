import { useEffect, useMemo, useState } from "react"
import { createRoot } from "react-dom/client"
import LivePreview from "@/components/settings/waiver-template-live-preview"
import PresetPreview from "@/components/settings/preset-template-preview"
import { documentFromBody } from "@/lib/templates/waiver-document"
const kind=new URLSearchParams(window.location.search).get("kind")
const nativeFetch=window.fetch.bind(window)
window.fetch=(url,options)=>{
  if(String(url).startsWith("/api/settings/templates/"))return new Promise((resolve,reject)=>(window.sourceReads??=[]).push({url,signal:options?.signal,resolve,reject}))
  return nativeFetch(url,options)
}
const createUrl=URL.createObjectURL.bind(URL),revokeUrl=URL.revokeObjectURL.bind(URL)
URL.createObjectURL=blob=>{
  const url=createUrl(blob)
  ;(window.previewBlobs??={})[url]=blob
  ;(window.createdUrls??=[]).push(url)
  return url
}
URL.revokeObjectURL=url=>{(window.revokedUrls??=[]).push(url);revokeUrl(url)}
function Fixture(){
  const [mounted,setMounted]=useState(true)
  const [frame,setFrame]=useState({source:"A",title:"Initial",metadata:"Original",body:"Project {{project_name}}"})
  useEffect(()=>{window.previewFixture={change:patch=>setFrame(current=>({...current,...patch})),unmount:()=>setMounted(false)}},[])
  const document=useMemo(()=>({...documentFromBody(frame.body),mode:"original"}),[frame.body])
  const draft={name:frame.metadata,title:frame.title,body:frame.body,waiverType:"conditional_progress",status:"draft",reviewed:false,document}
  if(!mounted)return <p>Preview removed</p>
  return kind==="preset"?<PresetPreview data={{kind:"Budget",name:frame.title,rows:[]}}/>:<LivePreview draft={draft} sample sourceFileId={frame.source}/>
}
createRoot(document.getElementById("root")).render(<Fixture/> )
