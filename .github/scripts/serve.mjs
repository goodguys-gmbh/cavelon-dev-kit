// Serve ./release over HTTP on 127.0.0.1, as a stand-in for a GitHub release:
// CI tests the install scripts and the Homebrew formula against it. Only the
// files listed at start are served, under their paths relative to the folder.
//
//   node .github/scripts/serve.mjs <port>
import { createReadStream, readdirSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const root = path.resolve("release");
const port = Number(process.argv[2] ?? 8000);

const files = new Map();
for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const file = path.join(entry.parentPath, entry.name);
  files.set("/" + path.relative(root, file).split(path.sep).join("/"), file);
}

createServer((req, res) => {
  const file = files.get(new URL(req.url ?? "/", "http://localhost").pathname);
  if (!file) {
    res.writeHead(404).end("not found\n");
    return;
  }
  res.writeHead(200, { "Content-Type": "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => process.stdout.write(`Serving ${root} on http://127.0.0.1:${port}\n`));
