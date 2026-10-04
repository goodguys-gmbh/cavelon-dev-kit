import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectInstall, type Install, type InstallFacts } from "../src/install.js";
import { DAY_MS, newer, quietReason } from "../src/update-check.js";
import { KIT_VERSION } from "../src/version.js";
import { cli, sandbox, type RunOptions, type Sandbox } from "./helpers.js";

/**
 * The update notice: how each install method is recognised, the one command
 * it offers, at most once a day, and silence everywhere it does not belong.
 */

function facts(file: string, overrides: Partial<InstallFacts> = {}): InstallFacts {
  return {
    executable: true,
    file,
    platform: "linux",
    env: { HOME: "/u/ada", LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" },
    exists: () => false,
    ...overrides,
  };
}

const CURL = "curl -fsSL https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.sh | sh";
const IRM = "irm https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.ps1 | iex";

describe("the install method", () => {
  it("is the install script for an executable named cavelon, re-run into the same folder", () => {
    expect(detectInstall(facts("/u/ada/.local/bin/cavelon"))).toMatchObject({ method: "script", update: CURL, source: "github" });
    expect(detectInstall(facts("/opt/my tools/cavelon")).update).toBe(`${CURL} -s -- --dir '/opt/my tools'`);
    expect(detectInstall(facts("/u/ada/tools/cavelon")).update).toBe(`${CURL} -s -- --dir /u/ada/tools`);
    // A home folder that is a symbolic link, as on some Linux systems.
    const linked = facts("/var/u/ada/.local/bin/cavelon", { real: (f) => f.replace(/^\/u\//, "/var/u/") });
    expect(detectInstall(linked).update).toBe(CURL);
  });

  it("is the install script on Windows, with the folder it used when that is not its default", () => {
    const win = { platform: "win32" as const };
    expect(detectInstall(facts("C:\\Users\\ada\\AppData\\Local\\Programs\\cavelon\\cavelon.exe", win))).toMatchObject({ method: "script", update: IRM });
    expect(detectInstall(facts("D:\\Ada's tools\\cavelon.exe", win)).update).toBe(`$env:CAVELON_INSTALL_DIR = 'D:\\Ada''s tools'; ${IRM}`);
  });

  it("is Homebrew for an executable in its Cellar, on macOS and Linux", () => {
    for (const file of ["/opt/homebrew/Cellar/cavelon/0.1.2/bin/cavelon", "/u/ada/.linuxbrew/Cellar/cavelon/0.1.2/bin/cavelon"]) {
      expect(detectInstall(facts(file, { platform: file.startsWith("/opt") ? "darwin" : "linux" }))).toMatchObject({
        method: "homebrew",
        update: "brew upgrade cavelon",
        source: "github",
      });
    }
  });

  it("is winget for an executable in its packages folder", () => {
    const file = "C:\\Users\\ada\\AppData\\Local\\Microsoft\\WinGet\\Packages\\goodguys.Cavelon_Microsoft.Winget.Source_8wekyb3d8bbwe\\cavelon-windows-x64.exe";
    expect(detectInstall(facts(file, { platform: "win32" }))).toMatchObject({ method: "winget", update: "winget upgrade goodguys.Cavelon", source: "github" });
  });

  it("is a download by hand for an executable that kept the release's file name", () => {
    const install = detectInstall(facts("/u/ada/Downloads/cavelon-linux-x64"));
    expect(install).toMatchObject({ method: "executable", source: "github" });
    expect(install.update).toBeUndefined();
    expect(install.advice).toContain("https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest");
  });

  it("is npm i -g for the package in npm's global folder, next to npm's cavelon command", () => {
    const unix = "/u/ada/.local/lib/node_modules/@cavelon/cli";
    expect(detectInstall(facts(unix, { executable: false, exists: (f) => f === "/u/ada/.local/bin/cavelon" }))).toMatchObject({
      method: "npm",
      update: "npm i -g @cavelon/cli",
      source: "npm",
    });
    const win = "C:\\Users\\ada\\AppData\\Roaming\\npm\\node_modules\\@cavelon\\cli";
    const shim = "C:\\Users\\ada\\AppData\\Roaming\\npm\\cavelon.cmd";
    expect(detectInstall(facts(win, { executable: false, platform: "win32", exists: (f) => f === shim }))).toMatchObject({ method: "npm", source: "npm" });
  });

  it("is npx for the package in npx's cache, with nothing to update or look up", () => {
    const install = detectInstall(facts("/u/ada/.npm/_npx/0123abcd/node_modules/@cavelon/cli", { executable: false, exists: () => true }));
    expect(install).toMatchObject({ method: "npx" });
    expect(install.source).toBeUndefined();
    expect(install.update).toBeUndefined();
  });

  it("is another package manager or a project's dependency without npm's global command", () => {
    const install = detectInstall(facts("/work/app/node_modules/@cavelon/cli", { executable: false }));
    expect(install).toMatchObject({ method: "package", source: "npm" });
    expect(install.update).toBeUndefined();
  });

  it("is a source checkout anywhere else, which is never looked up", () => {
    const install = detectInstall(facts("/work/cavelon-dev-kit/cli", { executable: false }));
    expect(install).toMatchObject({ method: "source" });
    expect(install.source).toBeUndefined();
  });
});

describe("versions", () => {
  it("compare by number, and a release is later than its pre-releases", () => {
    expect(newer("0.1.10", "0.1.9")).toBe(true);
    expect(newer("v0.2.0", "0.1.9")).toBe(true);
    expect(newer("0.1.2", "0.1.2")).toBe(false);
    expect(newer("0.1.1", "0.1.2")).toBe(false);
    expect(newer("0.1.2", "0.1.2-rc.1")).toBe(true);
    expect(newer("not a version", "0.1.2")).toBe(false);
  });
});

const INSTALLS: Record<string, Install> = {
  script: detectInstall(facts("/u/ada/.local/bin/cavelon")),
  homebrew: detectInstall(facts("/opt/homebrew/Cellar/cavelon/0.1.2/bin/cavelon", { platform: "darwin" })),
  winget: detectInstall(
    facts("C:\\Users\\ada\\AppData\\Local\\Microsoft\\WinGet\\Packages\\goodguys.Cavelon_Microsoft.Winget.Source_8wekyb3d8bbwe\\cavelon-windows-x64.exe", { platform: "win32" }),
  ),
  npm: detectInstall(facts("/usr/local/lib/node_modules/@cavelon/cli", { executable: false, exists: () => true })),
  npx: detectInstall(facts("/u/ada/.npm/_npx/0123abcd/node_modules/@cavelon/cli", { executable: false })),
  source: detectInstall(facts("/work/cavelon-dev-kit/cli", { executable: false })),
};

interface FakeNetwork {
  calls: string[];
  fetch: typeof fetch;
}

function network(answer: (url: string) => Response | Promise<Response>): FakeNetwork {
  const calls: string[] = [];
  return {
    calls,
    fetch: (async (input: string | URL | Request) => {
      calls.push(String(input));
      return answer(String(input));
    }) as typeof fetch,
  };
}

const LATEST = "99.0.0";
const releases = () =>
  network((url) =>
    url.includes("api.github.com")
      ? Response.json({ tag_name: `v${LATEST}`, assets: [] })
      : Response.json({ name: "@cavelon/cli", version: LATEST }),
  );

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const start = new Date("2026-10-04T08:00:00Z");
function at(ms: number): RunOptions["now"] {
  return () => new Date(start.getTime() + ms);
}

/** A person at a terminal runs a quick command. */
function person(install: Install, net: FakeNetwork, options: RunOptions = {}) {
  return cli(sb, ["commands"], { tty: true, now: at(0), ...options, updates: { install, fetch: net.fetch } });
}

describe("the update notice", () => {
  it.each([
    ["script", "api.github.com", CURL],
    ["homebrew", "api.github.com", "brew upgrade cavelon"],
    ["winget", "api.github.com", "winget upgrade goodguys.Cavelon"],
    ["npm", "registry.npmjs.org", "npm i -g @cavelon/cli"],
  ])("names the newer release and the update command for %s, looked up at %s", async (method, host, command) => {
    const net = releases();
    const result = await person(INSTALLS[method]!, net);
    expect(result.code).toBe(0);
    expect(net.calls).toHaveLength(1);
    expect(new URL(net.calls[0]!).host).toBe(host);
    expect(result.stderr).toContain(`cavelon ${LATEST} is out; this is ${KIT_VERSION}. Update with:\n  ${command}\n`);
    // The command's own output is unchanged.
    expect(result.stdout).not.toContain(LATEST);
  });

  it("checks and speaks at most once a day, and again the next day", async () => {
    const net = releases();
    expect((await person(INSTALLS.script!, net)).stderr).toContain(LATEST);
    const again = await person(INSTALLS.script!, net, { now: at(DAY_MS / 2) });
    expect(again.stderr).toBe("");
    expect(net.calls).toHaveLength(1);
    const tomorrow = await person(INSTALLS.script!, net, { now: at(DAY_MS + 1000) });
    expect(tomorrow.stderr).toContain(LATEST);
    expect(net.calls).toHaveLength(2);
  });

  it("keeps what it learnt in the kit's cache directory", async () => {
    await person(INSTALLS.npm!, releases());
    const file = path.join(sb.env.CAVELON_CACHE_DIR!, "update-check.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ source: "npm", latest: LATEST, checked_at: start.toISOString() });
  });

  it("says nothing when this is the latest release, or the latest is a pre-release", async () => {
    const same = network(() => Response.json({ tag_name: `v${KIT_VERSION}` }));
    expect((await person(INSTALLS.script!, same)).stderr).toBe("");
    const pre = network(() => Response.json({ tag_name: "v99.0.0-rc.1" }));
    expect((await person(INSTALLS.script!, pre, { now: at(2 * DAY_MS) })).stderr).toBe("");
  });

  it.each([
    ["the network fails", () => Promise.reject(new TypeError("fetch failed"))],
    ["the release is missing", () => new Response("Not Found", { status: 404 })],
    ["the answer is not JSON", () => new Response("<html>")],
    ["the answer has no version", () => Response.json({ message: "rate limited" })],
  ])("stays silent when %s, and does not try again that day", async (_, answer) => {
    const net = network(answer as () => Response);
    const result = await person(INSTALLS.homebrew!, net);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    await person(INSTALLS.homebrew!, net, { now: at(60_000) });
    expect(net.calls).toHaveLength(1);
  });

  it("gives up after a short timeout, without failing the command", async () => {
    const calls: string[] = [];
    const hanging = ((input: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        calls.push(input);
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;
    const began = Date.now();
    const result = await person(INSTALLS.script!, { calls, fetch: hanging });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(calls).toHaveLength(1);
    expect(Date.now() - began).toBeLessThan(5000);
  });

  it.each([
    ["--json", { args: ["commands", "--json"] }],
    ["CI", { env: { CI: "true" } }],
    ["GitHub Actions", { env: { GITHUB_ACTIONS: "true" } }],
    ["CAVELON_NO_UPDATE_CHECK=1", { env: { CAVELON_NO_UPDATE_CHECK: "1" } }],
    ["no terminal", { tty: false }],
  ])("is never looked up with %s", async (_, how: { args?: string[]; env?: Record<string, string>; tty?: boolean }) => {
    const net = releases();
    const result = await cli(sb, how.args ?? ["commands"], {
      tty: how.tty ?? true,
      env: how.env,
      now: at(0),
      updates: { install: INSTALLS.script!, fetch: net.fetch },
    });
    expect(result.code).toBe(0);
    expect(net.calls).toEqual([]);
    expect(result.stderr).toBe("");
  });

  it.each([["npx"], ["source"]])("is never looked up for %s", async (method) => {
    const net = releases();
    const result = await person(INSTALLS[method]!, net);
    expect(net.calls).toEqual([]);
    expect(result.stderr).toBe("");
  });

  it("is never looked up in MCP mode", () => {
    const io = { env: {}, stderr: { write: () => true, isTTY: true } } as never;
    expect(quietReason({ io, version: KIT_VERSION, install: INSTALLS.script!, json: false, command: "mcp" })).toBe("mcp");
  });
});

describe("--version", () => {
  it("prints the version alone on the first line, then the install method and its update command", async () => {
    const result = await cli(sb, ["--version"], { updates: { install: INSTALLS.homebrew! } });
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe(KIT_VERSION);
    expect(lines[1]).toBe("installed with: Homebrew (/opt/homebrew/Cellar/cavelon/0.1.2/bin/cavelon)");
    expect(lines[2]).toBe("update with: brew upgrade cavelon");
  });

  it("says npx needs no update", async () => {
    const result = await cli(sb, ["--version"], { updates: { install: INSTALLS.npx! } });
    expect(result.stdout).toContain("installed with: npx");
    expect(result.stdout).toContain("nothing to update");
  });

  it("answers --json with the version and the install", async () => {
    const result = await cli(sb, ["--version", "--json"], { updates: { install: INSTALLS.npm! } });
    expect(result.json()).toEqual({
      version: KIT_VERSION,
      install: { method: "npm", path: "/usr/local/lib/node_modules/@cavelon/cli", update: "npm i -g @cavelon/cli" },
    });
  });

  it("recognises this checkout as a source checkout", async () => {
    const result = await cli(sb, ["--version", "--json"]);
    expect(result.json<{ install: { method: string } }>().install.method).toBe("source");
  });
});
