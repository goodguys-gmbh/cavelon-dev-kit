// Serve a folder over HTTP on 127.0.0.1, as a stand-in for a GitHub release:
// CI tests the install scripts and the Homebrew formula against it.
//
//   node .github/scripts/serve.mjs <folder> <port>
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? 8000);

createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  const file = path.join(root, path.normalize(name));
  let size = -1;
  try {
    if (file.startsWith(root + path.sep)) size = statSync(file).isFile() ? statSync(file).size : -1;
  } catch {
    size = -1;
  }
  if (size < 0) {
    res.writeHead(404).end("not found\n");
    return;
  }
  res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": size });
  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => process.stdout.write(`Serving ${root} on http://127.0.0.1:${port}\n`));
