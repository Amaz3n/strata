/** Read a bounded date scope completely without silently hitting the API row cap. */
export async function readDailyLogPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ data: T[]; error: null }> {
  const rows: T[] = []
  const size = 200
  for (let from = 0; from < 10000; from += size) {
    const { data, error } = await fetchPage(from, from + size - 1)
    if (error) throw new Error(`Unable to load daily records: ${error.message}`)
    rows.push(...(data ?? []))
    if ((data?.length ?? 0) < size) return { data: rows, error: null }
  }
  throw new Error("This date range contains too many records. Choose a shorter range.")
}
