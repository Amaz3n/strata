import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DocumentTransferProvider, useDocumentTransfers } from '@/components/documents/transfer-provider'
function Launcher() {
  const queue = useDocumentTransfers()
  return <button onClick={() => { void queue.submit(new File(['fixture'], 'fixture.pdf', {type:'application/pdf'}), {projectId:'fixture-project'}) }}>Queue file</button>
}
function App() {
  const [page, setPage] = useState(false)
  return <DocumentTransferProvider scope="fixture-user:fixture-org"><button onClick={() => setPage(value=>!value)}>Navigate</button>{page ? <p>Other page</p> : <Launcher />}</DocumentTransferProvider>
}
createRoot(document.getElementById('root')!).render(<App />)
