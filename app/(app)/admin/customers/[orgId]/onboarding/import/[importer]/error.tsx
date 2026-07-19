"use client"

import { Button } from "@/components/ui/button"

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) { return <div className="m-6 border p-6"><h2 className="font-semibold">Unable to load importer</h2><p className="mt-1 text-sm text-muted-foreground">The batch or its staged rows could not be loaded.</p><Button size="sm" variant="outline" className="mt-4" onClick={reset}>Try again</Button></div> }
