"use client";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { PresetPreviewData } from "@/lib/pdfs/preset-template";
const Preview = dynamic(() => import("./preset-template-preview"), {
  ssr: false,
});
export function PresetTemplateWorkspace({
  children,
  onClose,
  onSave,
  saveForm,
  busy,
  ...data
}: PresetPreviewData & {
  children: ReactNode;
  onClose: () => void;
  onSave?: () => void;
  saveForm?: string;
  busy: boolean;
}) {
  const [discard, setDiscard] = useState(false);
  const dirty = useRef(false);
  const initial = useRef<string | null>(busy ? null : JSON.stringify(data));
  if (!busy && initial.current === null) initial.current = JSON.stringify(data);
  const changed = useRef(false);
  changed.current =
    initial.current !== null && initial.current !== JSON.stringify(data);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (dirty.current || changed.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, []);
  function close() {
    if (busy) return;
    if (dirty.current || changed.current) setDiscard(true);
    else onClose();
  }
  return (
    <>
      <Dialog
        open
        onOpenChange={(v) => {
          if (!v) close();
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="flex h-[94dvh] w-[96vw] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-[1540px]"
        >
          <header className="flex shrink-0 items-center justify-between border-b px-6 py-4">
            <div className="flex items-center gap-4">
              <Button
                variant="ghost"
                size="icon"
                onClick={close}
                disabled={busy}
                aria-label="Back to templates"
              >
                <ArrowLeft className="size-4" />
              </Button>
              <div>
                <DialogTitle className="text-sm font-medium">
                  {data.kind} template
                </DialogTitle>
                <DialogDescription className="text-xs">
                  Edit the details. See the result.
                </DialogDescription>
              </div>
            </div>
            <Button
              onClick={onSave}
              type={saveForm ? "submit" : "button"}
              form={saveForm}
              disabled={busy || !data.name.trim()}
            >
              {busy ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Check className="mr-2 size-4" />
              )}
              {busy ? "Saving…" : "Save template"}
            </Button>
          </header>
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(580px,1.1fr)_minmax(440px,.9fr)]">
            <div
              className="overflow-y-auto border-r p-7"
              onChangeCapture={() => {
                dirty.current = true;
              }}
              onInputCapture={() => {
                dirty.current = true;
              }}
            >
              <fieldset disabled={busy} className="min-w-0">
                {children}
              </fieldset>
            </div>
            <div className="flex min-h-0 flex-col bg-muted/30">
              <Preview data={data} />
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={discard} onOpenChange={setDiscard}>
        <DialogContent>
          <DialogTitle>Discard unsaved changes?</DialogTitle>
          <DialogDescription>
            Your saved template will remain available.
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDiscard(false)}>
              Keep editing
            </Button>
            <Button onClick={onClose}>Discard changes</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
