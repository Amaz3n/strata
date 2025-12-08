"use client"

import { useEffect } from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Link from "@tiptap/extension-link"
import Underline from "@tiptap/extension-underline"
import Placeholder from "@tiptap/extension-placeholder"
import type { Editor as EditorInstance, JSONContent } from "@tiptap/react"

type Props = {
  className?: string
  placeholder?: string
  initialContent?: JSONContent
  onUpdate?: (editor: EditorInstance) => void
  onFocus?: () => void
  onBlur?: () => void
  tabIndex?: number
}

export function Editor({
  className,
  placeholder,
  initialContent,
  onUpdate,
  onFocus,
  onBlur,
  tabIndex,
}: Props) {
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
    content: initialContent ?? undefined,
    onUpdate: ({ editor }) => {
      onUpdate?.(editor)
    },
    onFocus: () => onFocus?.(),
    onBlur: () => onBlur?.(),
  })

  useEffect(() => {
    if (!editor) return
    if (initialContent) {
      editor.commands.setContent(initialContent)
    } else {
      editor.commands.clearContent()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, JSON.stringify(initialContent)])

  return (
    <div className={className} tabIndex={tabIndex}>
      <EditorContent editor={editor} className="prose prose-sm max-w-none focus:outline-none [&_*]:outline-none" />
    </div>
  )
}



