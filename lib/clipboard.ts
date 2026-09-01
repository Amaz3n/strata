/**
 * Copying is a gesture, not a network call.
 *
 * The clipboard is only writable while the click's transient user activation is
 * alive, and awaiting a server round trip spends it — WebKit then rejects the
 * write with a bare `NotAllowedError` whose message reads like the user denied
 * a permission prompt they were never shown. So `copyText` must be called with
 * the string already in hand; when the string can only be minted on the server,
 * `copyTextWhenReady` hands the clipboard the pending promise instead, which is
 * the one shape browsers accept from a click that is still in flight.
 */

/** Copies text the caller already holds. Returns whether it landed. */
export async function copyText(value: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      // Activation may have lapsed, or this is an older WebKit — try the textarea.
    }
  }
  return legacyCopy(value)
}

/**
 * Registers a clipboard write against the click that is still running, for a
 * value that has not arrived yet. Returns `null` where `ClipboardItem` is
 * missing so the caller can fall back to `copyText` once the value lands.
 */
export function copyTextWhenReady(pending: Promise<string>): Promise<boolean> | null {
  if (typeof navigator === "undefined" || !navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    return null
  }

  const blob = pending.then((text) => new Blob([text], { type: "text/plain" }))
  // The clipboard consumes `blob`; this handler only keeps its rejection from
  // being reported as unhandled, and leaves the rejection itself intact.
  blob.catch(() => {})

  try {
    return navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]).then(
      () => true,
      () => false,
    )
  } catch {
    return null
  }
}

function legacyCopy(value: string): boolean {
  if (typeof document === "undefined") return false
  try {
    const textArea = document.createElement("textarea")
    textArea.value = value
    textArea.style.position = "fixed"
    textArea.style.left = "-9999px"
    document.body.appendChild(textArea)
    textArea.select()
    const copied = document.execCommand("copy")
    textArea.remove()
    return copied
  } catch {
    return false
  }
}
