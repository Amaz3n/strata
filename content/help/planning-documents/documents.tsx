import Link from "next/link"

export default function DocumentsArticle() {
  return (
    <>
      <p>
        The Documents tool in Arc serves as the central repository for all project-related files.
        You can upload any file type, organize items using a flexible folder structure, and manage 
        access permissions to ensure sensitive information remains secure.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Folder Management:</strong> Create hierarchical folder structures to organize files by category, phase, or contractor.</li>
        <li><strong>File Uploads:</strong> Drag and drop single files or batch uploads. Arc supports PDFs, spreadsheets, images, word documents, and more.</li>
        <li><strong>Version Control:</strong> Keep track of file revisions automatically without cluttering folders. Older versions are archived but remain accessible.</li>
        <li><strong>Security & Permissions:</strong> Control folder-level access for team members and external stakeholders.</li>
      </ul>

      <h2>Uploading and Organizing Files</h2>
      <p>
        To upload a file, navigate to the <strong>Documents</strong> page from your project dashboard. 
        You can click the <strong>Upload</strong> button or simply drag and drop files from your computer into the browser.
      </p>
      <h3>Creating folders</h3>
      <p>
        Keep your files structured by creating folders. Click the <strong>New Folder</strong> button, 
        provide a clear name, and press enter. You can drag and drop existing files into the folder 
        or open it to upload files directly into that directory.
      </p>
      <h3>Moving and managing files</h3>
      <p>
        Right-click or click the actions menu (...) next to any file or folder to rename, move, download, 
        or delete it. Organizing files early ensures your field team and subcontractors can easily locate 
        the latest resources.
      </p>

      <h2>Sharing Documents Externally</h2>
      <p>
        You can securely share files with clients, architects, and subcontractors who do not have full 
        access to your Arc workspace.
      </p>
      <blockquote>
        <strong>Note:</strong> When you share a folder or file, Arc generates a secure token-based link. 
        Recipients can view and download the content without needing to create an account.
      </blockquote>
      <p>
        To share, open the file details and click <strong>Share</strong>. You can enter the email addresses 
        of the recipients and write a custom message. Arc will email them the secure link and track when 
        they view or download the documents.
      </p>
    </>
  )
}
