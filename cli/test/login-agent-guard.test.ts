import { readFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_VARIABLES } from "../src/agent-env.js";
import { run } from "../src/main.js";
import type { InStream, Io } from "../src/io.js";
import { startFakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox;
beforeEach(() => { sb = sandbox(); });
afterEach(() => sb.cleanup());

describe("person-only login", () => {
  it("refuses an agent's piped token without requests or replacing the stored login", async () => {
    const server = await startFakeServer();
    try {
      const tenant = server.addTenant("example", "Example");
      const old = server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant });
      const next = server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant });
      await login(sb, server.url, old);
      const credentials = path.join(sb.env.CAVELON_CONFIG_DIR!, "credentials.json");
      const prior = readFileSync(credentials, "utf8");
      const before = server.state.requests.length;
      const result = await cli(sb, ["login", "--instance", server.url, "--token-stdin", "--json"],
        { env: { CLAUDECODE: "1" }, stdin: next });
      expect(result.code).toBe(5);
      expect(result.json()).toHaveProperty("error.code", "operation_for_a_person");
      expect(server.state.requests.slice(before)).toEqual([]);
      expect(readFileSync(credentials, "utf8")).toBe(prior);
      expect(result.stdout + result.stderr).not.toContain(next);
      expect((await login(sb, server.url, next)).code).toBe(0);
    } finally { await server.close(); }
  });

  it.each([false, true])("refuses every recognized agent before reading input (token stdin: %s)", async tokenStdin => {
    for (const marker of AGENT_VARIABLES) {
      let reads = 0;
      const stdin = Readable.from((function* () { reads++; yield "synthetic-token\n"; })()) as unknown as InStream;
      stdin.isTTY = true;
      let output = "";
      const io: Io = {
        stdin, stdout: { write: text => { output += text; return true; }, isTTY: true },
        stderr: { write: text => { output += text; return true; }, isTTY: true },
        env: { ...sb.env, [marker.variable]: marker.value ?? "1" }, cwd: sb.home,
        now: () => new Date(), sleep: async () => {},
      };
      const exit = await run(["login", ...(tokenStdin ? ["--token-stdin"] : [])], io);
      expect(exit, marker.agent).toBe(5);
      expect(output).toContain("own terminal");
      expect(reads, marker.agent).toBe(0);
      (stdin as unknown as Readable).destroy();
    }
  });
});
