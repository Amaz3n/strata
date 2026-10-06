"use client"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useLayoutEffect, useMemo, useRef, useTransition } from "react"
import { resumePurchaseAgreementSigningAction } from "@/app/(app)/sales/actions"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { unwrapAction } from "@/lib/action-result"
import type { AgreementSigningState } from "@/lib/sales/agreement-signing-state"

export function AgreementSigningRecovery({contractId,projectId,state}:{contractId:string;projectId:string;state:AgreementSigningState}) {
  const router=useRouter(),{toast}=useToast(),[pending,startTransition]=useTransition()
  const view=useMemo(()=>({contractId,projectId,stage:state.stage,canResume:state.canResume}),[contractId,projectId,state.stage,state.canResume]),committed=useRef<typeof view|null>(null),submitting=useRef<typeof view|null>(null)
  useLayoutEffect(()=>{committed.current=view;return()=>{if(committed.current===view)committed.current=null}},[view])
  const resume=()=>{
    if(!state.canResume || committed.current!==view || submitting.current===view)return
    submitting.current=view
    startTransition(async()=>{
      try {
        const result=unwrapAction(await resumePurchaseAgreementSigningAction({contractId,projectId}))
        if(committed.current!==view)return
        toast({title:result.documentId && result.envelopeId ? "Signing packet prepared" : "Signing remains unprepared",description:result.reason??"Reload the signing record to review its delivery status."})
      }catch(error){
        if(committed.current===view){toast({title:"Could not resume signing",description:(error as Error).message});router.refresh()}
      }finally{if(submitting.current===view)submitting.current=null}
    })
  }
  return <div className="border-b px-5 py-3" aria-live="polite">
    <p className="text-sm font-medium">{state.title}</p>
    <p className="mt-1 text-xs text-muted-foreground">{state.detail}</p>
    <div className="mt-2 flex flex-wrap gap-2">
      {state.canResume?<Button size="sm" variant="outline" disabled={pending} onClick={resume}>{pending?"Resuming…":"Resume signing preparation"}</Button>:null}
      {state.documentId?<Button size="sm" variant="ghost" asChild><Link href={`/projects/${projectId}/documents`}>Review signing document</Link></Button>:null}
    </div>
  </div>
}
