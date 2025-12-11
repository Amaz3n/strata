"use client"

import { useEffect } from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Link from "@tiptap/extension-link"
import Underline from "@tiptap/extension-underline"
import Placeholder from "@tiptap/extension-placeholder"
import type { JSONContent } from "@tiptap/react"

type RichEditorProps = {
  value?: JSONContent | null
  onChange?: (content: JSONContent | null) => void
  placeholder?: string
  className?: string
  minHeight?: string
}

export function RichEditor({ value, onChange, placeholder, className, minHeight = "72px" }: RichEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Underline,
      Link.configure({
        autolink: true,
        openOnClick: true,
        linkOnPaste: true,
        HTMLAttributes: { rel: "noreferrer", target: "_blank" },
      }),
      Placeholder.configure({
        placeholder: placeholder ?? "",
      }),
    ],
    content: value ?? undefined,
    onUpdate: ({ editor }) => {
      const json = editor.getJSON()
      const text = editor.getText().trim()
      onChange?.(text.length === 0 ? null : json)
    },
  })

  useEffect(() => {
    if (!editor) return
    if (value) {
      editor.commands.setContent(value)
    } else {
      editor.commands.clearContent()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, JSON.stringify(value)])

  return (
    <div
      className={`rounded-lg border bg-background/60 px-3 py-2 text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] ${className ?? ""}`}
      style={{ minHeight }}
    >
      <EditorContent editor={editor} className="prose prose-sm max-w-none focus:outline-none [&_*]:outline-none" />
    </div>
  )
}




