/** Serializes autosave and explicit Save, draining edits made during an in-flight request. */
export function createDraftSaveQueue<T, Saved>({
  initial,
  save,
  onState,
  onSaved,
}: {
  initial?: Saved;
  save: (input: T, previous?: Saved) => Promise<Saved>;
  onState: (state: "idle" | "saving" | "saved" | "error") => void;
  onSaved?: (saved: Saved) => void;
}) {
  let previous = initial;
  let latest: { input: T; fingerprint: string } | null = null;
  let savedFingerprint = "";
  let inFlight: Promise<Saved | undefined> | null = null;
  return {
    update(input: T | null) {
      latest =
        input === null ? null : { input, fingerprint: JSON.stringify(input) };
      if (!latest || latest.fingerprint !== savedFingerprint) onState("idle");
    },
    restore(saved: Saved) {
      previous = saved;
    },
    getSaved() {
      return previous;
    },
    async flush(): Promise<Saved | undefined> {
      if (inFlight) return inFlight;
      const run = async () => {
        while (latest && latest.fingerprint !== savedFingerprint) {
          const current = latest;
          onState("saving");
          try {
            previous = await save(current.input, previous);
            savedFingerprint = current.fingerprint;
            onSaved?.(previous);
          } catch (error) {
            onState("error");
            throw error;
          }
        }
        if (latest) onState("saved");
        else onState("idle");
        return previous;
      };
      inFlight = run();
      try {
        return await inFlight;
      } finally {
        inFlight = null;
      }
    },
  };
}
