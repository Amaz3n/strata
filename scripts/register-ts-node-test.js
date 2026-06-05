const fs = require("fs")
const Module = require("module")
const path = require("path")
const ts = require("typescript")

const rootDir = path.resolve(__dirname, "..")
const originalResolveFilename = Module._resolveFilename

Module._resolveFilename = function resolveAlias(request, parent, isMain, options) {
  if (request.startsWith("@/")) {
    return originalResolveFilename.call(this, path.join(rootDir, request.slice(2)), parent, isMain, options)
  }
  if (request.startsWith("@midday/ui/")) {
    return originalResolveFilename.call(
      this,
      path.join(rootDir, "components/midday/ui", request.slice("@midday/ui/".length)),
      parent,
      isMain,
      options,
    )
  }
  if (request === "@midday/invoice") {
    return originalResolveFilename.call(this, path.join(rootDir, "packages/invoice/src"), parent, isMain, options)
  }
  if (request.startsWith("@midday/invoice/")) {
    return originalResolveFilename.call(
      this,
      path.join(rootDir, "packages/invoice/src", request.slice("@midday/invoice/".length)),
      parent,
      isMain,
      options,
    )
  }
  return originalResolveFilename.call(this, request, parent, isMain, options)
}

function compileTs(module, filename) {
  const source = fs.readFileSync(filename, "utf8")
  const output = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      allowJs: true,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      resolveJsonModule: true,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText
  module._compile(output, filename)
}

require.extensions[".ts"] = compileTs
require.extensions[".tsx"] = compileTs
