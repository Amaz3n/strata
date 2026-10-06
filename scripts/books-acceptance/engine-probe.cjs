const http = require("node:http");
function parseEngineVersion(status, bytes) {
  if (status !== 200)
    throw Error("Docker version endpoint did not return HTTP 200");
  let data;
  try {
    data = JSON.parse(bytes);
  } catch {
    throw Error("Docker version endpoint returned empty or invalid JSON");
  }
  if (
    !data ||
    typeof data !== "object" ||
    !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(data.Version ?? "") ||
    !/^\d+\.\d+$/.test(data.ApiVersion ?? "")
  )
    throw Error(
      "Docker version endpoint did not prove engine and API versions",
    );
  return { version: data.Version, apiVersion: data.ApiVersion };
}
function probeEngine(host, { request = http.request, timeoutMs = 5000 } = {}) {
  if (
    typeof host !== "string" ||
    !host.startsWith("unix:///") ||
    host.includes("\0") ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 5000
  )
    return Promise.reject(
      Error(
        "Docker readiness requires a local Unix socket and bounded deadline",
      ),
    );
  return new Promise((resolve, reject) => {
    let settled = false,
      req;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        req?.destroy();
        reject(error);
      } else resolve(result);
    };
    const timer = setTimeout(
      () => finish(Error("Docker version endpoint timed out")),
      timeoutMs,
    );
    try {
      req = request(
        {
          socketPath: host.slice("unix://".length),
          path: "/version",
          method: "GET",
          headers: { Accept: "application/json" },
        },
        (res) => {
          let chunks = [],
            size = 0;
          res.on("data", (chunk) => {
            size += Buffer.byteLength(chunk);
            if (size > 65536) {
              res.destroy();
              finish(
                Error("Docker version response exceeded its readiness limit"),
              );
            } else chunks.push(Buffer.from(chunk));
          });
          res.on("error", () =>
            finish(Error("Docker version response was interrupted")),
          );
          res.on("aborted", () =>
            finish(Error("Docker version response was interrupted")),
          );
          res.on("end", () => {
            try {
              finish(
                null,
                parseEngineVersion(
                  res.statusCode,
                  Buffer.concat(chunks).toString("utf8"),
                ),
              );
            } catch (error) {
              finish(error);
            }
          });
        },
      );
      req.on("error", () =>
        finish(Error("Docker version endpoint could not be reached")),
      );
      req.end();
    } catch {
      finish(Error("Docker version endpoint could not be reached"));
    }
  });
}
if (require.main === module)
  probeEngine(process.argv[2])
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
module.exports = { parseEngineVersion, probeEngine };
