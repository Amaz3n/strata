import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { DitherLabClient } from "@/components/animation/dither-lab-client"
Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText(text){return new Promise((resolve,reject)=>(window.copyCalls??=[]).push({text,resolve,reject}))}}})
const nativeSetTimeout=window.setTimeout.bind(window),nativeClearTimeout=window.clearTimeout.bind(window)
window.setTimeout=(callback,delay,...args)=>{
  const timer=nativeSetTimeout(callback,delay,...args)
  if(delay===1200)(window.copyTimers??=[]).push(timer)
  return timer
}
window.clearTimeout=timer=>{if(window.copyTimers?.includes(timer))(window.clearedCopyTimers??=[]).push(timer);return nativeClearTimeout(timer)}
function Fixture(){
  const [mounted,setMounted]=useState(true)
  useEffect(()=>{window.ditherFixture={unmount:()=>setMounted(false)}},[])
  return mounted?<DitherLabClient/>:<p>Lab removed</p>
}
createRoot(document.getElementById("root")).render(<Fixture/> )
