import { Zip, ZipPassThrough } from "fflate"

export interface ZipEntrySource {
  name: string
  modifiedAt?: string | null
  open: () => Promise<ReadableStream<Uint8Array>>
}

export function uniqueZipName(name: string, usedNames: Set<string>) {
  const cleaned = name.replace(/\\/g, "/").split("/").filter(part => part && part !== "." && part !== "..")
    .join("/").replace(/[\x00-\x1f]/g, "_").trim() || "file"
  const slash = cleaned.lastIndexOf("/")
  const folder = cleaned.slice(0, slash + 1)
  const basename = cleaned.slice(slash + 1)
  const dot = basename.lastIndexOf(".")
  const stem = dot > 0 ? basename.slice(0, dot) : basename
  const extension = dot > 0 ? basename.slice(dot) : ""
  let candidate = cleaned
  for (let index = 2; usedNames.has(candidate); index++) candidate = `${folder}${stem} (${index})${extension}`
  usedNames.add(candidate)
  return candidate
}

/** Backpressure extends to the active R2 body; at most one source chunk is retained. */
export function streamZip(entries: ZipEntrySource[], maxBytes: number, signal?: AbortSignal): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let stopped = false
  const abort = () => { stopped = true; void reader?.cancel().catch(() => undefined) }
  signal?.addEventListener("abort", abort, { once: true })
  async function* chunks() {
    const pending: Uint8Array[] = []
    let zipError: Error | undefined
    const zip = new Zip((error, data) => {
      if (error) zipError = error
      else if (data.length) pending.push(data)
    })
    let total = 0
    try {
      for (const entry of entries) {
        if (stopped || signal?.aborted) throw new DOMException("Download cancelled", "AbortError")
        reader = (await entry.open()).getReader()
        const member = new ZipPassThrough(entry.name)
        const modified = entry.modifiedAt ? new Date(entry.modifiedAt) : new Date()
        if (Number.isFinite(modified.getTime()) && modified.getFullYear() >= 1980 && modified.getFullYear() <= 2099) member.mtime = modified
        zip.add(member)
        while (pending.length) yield pending.shift()!
        while (true) {
          if (stopped || signal?.aborted) throw new DOMException("Download cancelled", "AbortError")
          const { value, done } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > maxBytes) throw new Error("Selected files exceed the ZIP size limit")
          member.push(value)
          if (zipError) throw zipError
          while (pending.length) yield pending.shift()!
        }
        reader.releaseLock()
        reader = undefined
        member.push(new Uint8Array(), true)
        if (zipError) throw zipError
        while (pending.length) yield pending.shift()!
      }
      zip.end()
      if (zipError) throw zipError
      while (pending.length) yield pending.shift()!
    } finally {
      stopped = true
      await reader?.cancel().catch(() => undefined)
      zip.terminate()
      signal?.removeEventListener("abort", abort)
    }
  }
  const iterator = chunks()
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next()
        if (done) controller.close()
        else controller.enqueue(value)
      } catch (error) { controller.error(error) }
    },
    async cancel() {
      abort()
      await iterator.return(undefined)
      signal?.removeEventListener("abort", abort)
    },
  }, { highWaterMark: 1 })
}
