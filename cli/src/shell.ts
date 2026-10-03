/**
 * Commands the kit prints for a person or an agent to run next. Each word
 * that came from a name (a Sandbox called "Lab VM 4073", a path, a key name)
 * is quoted for the shell that runs cavelon, so the line can be copied as it
 * is. Ids and flags stay bare.
 */

export type Shell = "posix" | "powershell" | "cmd";

const SHELLS: readonly Shell[] = ["posix", "powershell", "cmd"];

/**
 * The shell the printed commands are for. CAVELON_SHELL names one; otherwise
 * POSIX outside Windows and in Git Bash, MSYS or Cygwin on Windows. On
 * Windows, PowerShell adds the user's module folder to PSModulePath, so three
 * or more entries mean PowerShell, and fewer mean cmd.
 */
export function detectShell(env: Record<string, string | undefined>, platform: string = process.platform): Shell {
  const named = env.CAVELON_SHELL?.trim().toLowerCase();
  if (named && (SHELLS as readonly string[]).includes(named)) return named as Shell;
  if (platform !== "win32") return "posix";
  if (env.MSYSTEM || env.SHELL) return "posix";
  const modules = (env.PSModulePath ?? "").split(";").filter(Boolean);
  return modules.length >= 3 ? "powershell" : "cmd";
}

let current: Shell = detectShell({}, process.platform);

/** Set once per invocation, from the environment the command runs in. */
export function useShell(shell: Shell): void {
  current = shell;
}

export function currentShell(): Shell {
  return current;
}

/** Characters every word may hold bare, per shell (`,` makes a list in PowerShell; `%` expands in cmd). */
const BARE: Record<Shell, RegExp> = {
  posix: /^[\w.@%+=:,/-]+$/,
  powershell: /^[\w.%+=:/\\-]+$/,
  cmd: /^[\w.@+=:,/\\-]+$/,
};

/** A single quote inside a single-quoted POSIX word: close, escaped quote, reopen. */
const POSIX_QUOTE = String.raw`'\''`;

/** PowerShell reads typographic single quotes as quotes too; each is doubled inside a quoted word. */
const POWERSHELL_QUOTES = new Set(["'", "\u2018", "\u2019", "\u201a", "\u201b"]);

/** A word the shell passes as one argument, unchanged. */
export function shellWord(word: string, shell: Shell = current): string {
  if (word !== "" && BARE[shell].test(word) && !(shell === "powershell" && word.startsWith("@"))) return word;
  switch (shell) {
    case "posix":
      return "'" + word.replaceAll("'", POSIX_QUOTE) + "'";
    case "powershell":
      // Single quotes take everything literally ($, `, ", spaces).
      return `'${[...word].map((c) => (POWERSHELL_QUOTES.has(c) ? c + c : c)).join("")}'`;
    case "cmd":
      // Inside double quotes cmd passes spaces, &, | and ^ on; a quote doubles. A %NAME% of a set variable still expands.
      return `"${word.replaceAll('"', '""')}"`;
  }
}

/** `cavelon` and its words, each quoted where needed. */
export function cavelonCommand(...words: string[]): string {
  return ["cavelon", ...words.map((w) => shellWord(w))].join(" ");
}
