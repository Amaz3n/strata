/** Partial-object streams suppress provider errors. Consume the full stream so
 * an error cannot leave us waiting forever for an object/usage finish event. */
export async function consumeObjectStream<T, U>(stream: {
  fullStream: AsyncIterable<{ type: string; error?: unknown; object?: unknown }>
  object: PromiseLike<T>
  usage: PromiseLike<U>
}, onPartial: (value: unknown) => void | Promise<void>) {
  let finished = false
  let lastEmission = 0
  for await (const part of stream.fullStream) {
    if (part.type === "error") throw part.error instanceof Error ? part.error : new Error(String(part.error ?? "AI provider stream failed"))
    if (part.type === "finish") finished = true
    if (part.type === "object" && Date.now() - lastEmission >= 2000) {
      lastEmission = Date.now()
      await onPartial(part.object)
    }
  }
  if (!finished) throw new Error("The AI provider ended its response before finishing the invoice read.")
  return { object: await stream.object, usage: await stream.usage }
}
