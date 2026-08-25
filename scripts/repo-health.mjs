import fs from "node:fs"
import path from "node:path"
import process from "node:process"

const root = process.cwd()
const check = process.argv.includes("--check")
const scanRoots = ["app", "components", "lib", "scripts", "tests"]
const scanExtensions = new Set([".css", ".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"])
const ignoredDirectories = new Set([".git", ".next", "archive", "node_modules", "plans"])
const runtimeOnlyPackages = new Set(["next", "react", "react-dom", "server-only", "sharp", "three"])
const importPattern = /(?:from\s*|import\s*\(|require\s*\(|@import\s+)["']([^"']+)["']/g

function walk(directory) {
  if (!fs.existsSync(directory)) return []
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(absolute))
    else if (scanExtensions.has(path.extname(entry.name))) files.push(absolute)
  }
  return files
}

function packageName(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("/")) return null
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/")
  return specifier.split("/", 1)[0]
}

const files = scanRoots.flatMap((directory) => walk(path.join(root, directory)))
for (const config of [
  "eslint.config.js",
  "next.config.mjs",
  "playwright.config.ts",
  "postcss.config.mjs",
  "proxy.ts",
]) {
  const absolute = path.join(root, config)
  if (fs.existsSync(absolute)) files.push(absolute)
}

const imports = new Set()
const largeFiles = []
let sourceLines = 0
for (const file of files) {
  const source = fs.readFileSync(file, "utf8")
  const lines = source.split("\n").length
  sourceLines += lines
  if (lines >= 1000) largeFiles.push({ file: path.relative(root, file), lines })
  for (const match of source.matchAll(importPattern)) {
    const dependency = packageName(match[1])
    if (dependency) imports.add(dependency)
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
const unusedDependencies = Object.keys(manifest.dependencies ?? {})
  .filter((dependency) => !imports.has(dependency) && !runtimeOnlyPackages.has(dependency))
  .sort()
largeFiles.sort((a, b) => b.lines - a.lines)

const report = {
  scannedFiles: files.length,
  sourceLines,
  unusedDependencies,
  largeFiles,
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (check && unusedDependencies.length > 0) {
  process.stderr.write("Direct dependencies without a discovered source/config import must be removed or explicitly classified as runtime-only.\n")
  process.exitCode = 1
}
