import path from "node:path";
import { promises as fs } from "node:fs";
import { configDir } from "./paths.js";
import { readJsonFile, writeFileAtomic } from "./fsutil.js";

/**
 * Where a token lives between sessions: the operating system's credential
 * store, or a file only the user can read (0600) where there is none.
 * The token never goes into the config file, the repository or a log.
 */

export interface CredentialStore {
  readonly kind: "keyring" | "file";
  get(url: string): Promise<string | undefined>;
  set(url: string, token: string): Promise<void>;
  /** True when something was deleted. */
  delete(url: string): Promise<boolean>;
}

type Env = Record<string, string | undefined>;

const SERVICE = "cavelon";

/** The subset of `@napi-rs/keyring`'s `Entry` the kit uses. */
export interface KeyringEntry {
  getPassword(): string | null | undefined;
  setPassword(password: string): void;
  deletePassword(): boolean | void;
}

export type KeyringEntryFactory = (service: string, account: string) => KeyringEntry;

export class KeyringStore implements CredentialStore {
  readonly kind = "keyring" as const;
  constructor(private readonly entry: KeyringEntryFactory) {}

  async get(url: string): Promise<string | undefined> {
    return this.entry(SERVICE, url).getPassword() ?? undefined;
  }

  async set(url: string, token: string): Promise<void> {
    this.entry(SERVICE, url).setPassword(token);
    // Some backends accept a write they cannot read back (no unlocked keyring).
    if (this.entry(SERVICE, url).getPassword() !== token) throw new Error("the credential store did not keep the token");
  }

  async delete(url: string): Promise<boolean> {
    try {
      return this.entry(SERVICE, url).deletePassword() !== false;
    } catch {
      return false;
    }
  }
}

interface CredentialsFile {
  tokens: Record<string, string>;
}

export class FileStore implements CredentialStore {
  readonly kind = "file" as const;
  constructor(private readonly env: Env) {}

  get file(): string {
    return path.join(configDir(this.env), "credentials.json");
  }

  private async read(): Promise<CredentialsFile> {
    const raw = await readJsonFile<Partial<CredentialsFile>>(this.file);
    return { tokens: raw?.tokens ?? {} };
  }

  private async write(content: CredentialsFile): Promise<void> {
    if (Object.keys(content.tokens).length === 0) {
      await fs.rm(this.file, { force: true });
      return;
    }
    await writeFileAtomic(this.file, JSON.stringify(content, null, 2) + "\n", 0o600, 0o700);
  }

  async get(url: string): Promise<string | undefined> {
    return (await this.read()).tokens[url];
  }

  async set(url: string, token: string): Promise<void> {
    const content = await this.read();
    content.tokens[url] = token;
    await this.write(content);
  }

  async delete(url: string): Promise<boolean> {
    const content = await this.read();
    if (!(url in content.tokens)) return false;
    delete content.tokens[url];
    await this.write(content);
    return true;
  }
}

let keyringFactory: KeyringEntryFactory | null | undefined;

/** Load the native credential store binding once; null when it is unavailable. */
async function loadKeyring(): Promise<KeyringEntryFactory | null> {
  if (keyringFactory !== undefined) return keyringFactory;
  try {
    const mod = (await import("@napi-rs/keyring")) as { Entry: new (service: string, account: string) => KeyringEntry };
    keyringFactory = (service, account) => new mod.Entry(service, account);
  } catch {
    keyringFactory = null;
  }
  return keyringFactory;
}

/** Tests replace the native binding with a fake. */
export function setKeyringFactoryForTests(factory: KeyringEntryFactory | null | undefined): void {
  keyringFactory = factory;
}

/**
 * The stores to try, best first. `CAVELON_CREDENTIAL_STORE=file` skips the
 * operating system's store, for headless machines and tests.
 */
export async function credentialStores(env: Env): Promise<CredentialStore[]> {
  const file = new FileStore(env);
  if (env.CAVELON_CREDENTIAL_STORE === "file") return [file];
  const factory = await loadKeyring();
  return factory ? [new KeyringStore(factory), file] : [file];
}

export async function storeFor(env: Env, kind: "keyring" | "file" | undefined): Promise<CredentialStore[]> {
  const stores = await credentialStores(env);
  if (!kind) return stores;
  const preferred = stores.filter((s) => s.kind === kind);
  return [...preferred, ...stores.filter((s) => s.kind !== kind)];
}

/** Save a token in the best store that keeps it; returns which one did. */
export async function saveToken(env: Env, url: string, token: string): Promise<CredentialStore> {
  const errors: string[] = [];
  for (const store of await credentialStores(env)) {
    try {
      await store.set(url, token);
      // Only one copy: a stale token in the other store would confuse logout.
      for (const other of await credentialStores(env)) if (other.kind !== store.kind) await other.delete(url);
      return store;
    } catch (error) {
      errors.push(`${store.kind}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No credential store kept the token (${errors.join("; ")})`);
}

export async function readToken(
  env: Env,
  url: string,
  preferred?: "keyring" | "file",
): Promise<{ token: string; store: "keyring" | "file" } | undefined> {
  for (const store of await storeFor(env, preferred)) {
    try {
      const token = await store.get(url);
      if (token) return { token, store: store.kind };
    } catch {
      // An unavailable store is the same as an empty one.
    }
  }
  return undefined;
}

export async function deleteToken(env: Env, url: string): Promise<boolean> {
  let deleted = false;
  for (const store of await credentialStores(env)) {
    try {
      deleted = (await store.delete(url)) || deleted;
    } catch {
      // Nothing to delete there.
    }
  }
  return deleted;
}
