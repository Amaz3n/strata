import { get, set, del } from "idb-keyval"

/** Writes outlive a composer mount; a replacement waits for its predecessor. */
export function createDraftStorage(storage: {
  get: <T>(key: string) => Promise<T | undefined>
  set: (key: string, value: unknown) => Promise<void>
  del: (key: string) => Promise<void>
}) {
  const pending = new Map<string, Promise<void>>()
  const memory = new Map<string, unknown>()
  const serialize = (key: string, operation: () => Promise<void>) => {
    const next = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(operation)
    pending.set(key, next)
    return next
  }
  return {
    async load<T>(key: string): Promise<T | undefined> {
      await pending.get(key)?.catch(() => {})
      if (memory.has(key)) return memory.get(key) as T | undefined
      return storage.get<T>(key)
    },
    save(key: string, value: unknown) {
      memory.set(key, value)
      return serialize(key, () => storage.set(key, value))
    },
    remove(key: string) {
      memory.set(key, undefined)
      return serialize(key, () => storage.del(key))
    },
  }
}

export const dailyLogDraftStorage = createDraftStorage({ get, set, del })
