import { createHash } from "node:crypto";
import path from "node:path";
import { CavelonError, ExitCode } from "./errors.js";
import { NOT_HERE, type ApiClient } from "./http.js";
import { cacheDir, instanceKey } from "./paths.js";
import { cavelonCommand } from "./printed.js";
import { readJsonFile, readTextFile, writePrivateFile } from "./fsutil.js";
import { SUPPORTED_CONTRACTS } from "./version.js";

/**
 * The instance's published contracts, cached per instance and version under
 * `~/.cache/cavelon/<instance>/<version>/`. A new instance version gets a new
 * folder, so the kit learns a core release's features without a kit release.
 * A development build keeps one version string while its contracts change, so
 * its copies are read again after a short time, and a copy the instance gave
 * an ETag for is checked with it instead of read again.
 *
 * Most contracts are the same for every caller of an instance version. The
 * capabilities are not: their `limits` are one tenant's, so they are kept once
 * per tenant (`capabilities.<tenant key>.json`), and the docs index once per
 * audience (`llms.<audience>.txt`). Every file is written for its owner only.
 */

export interface Capabilities {
  instance: { version: string; phase?: string };
  contracts: { api_version: string; package_versions?: { current: string; accepted: string[] } };
  features: Record<string, boolean>;
  [key: string]: unknown;
}

export interface OpenApiDoc {
  openapi: string;
  info?: { title?: string; version?: string };
  paths: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
}

export interface CatalogEntry {
  code: string;
  message: string;
  hint?: string | null;
  /** The instance's docs page; the kit's own codes have none. */
  docs?: string;
  /** Rule codes: the rule that raises it, and why the rule exists. */
  rule?: string | null;
  explanation?: string | null;
  /** API error codes: the area of the API. */
  area?: string | null;
}

export interface ErrorCatalog {
  rule_codes: CatalogEntry[];
  api_error_codes: CatalogEntry[];
}

/** A package JSON Schema as `/api/v1/meta/package-schema` publishes it. */
export interface PackageSchema {
  $id?: string;
  title?: string;
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
  "x-package-version"?: string;
  "x-current-package-version"?: string;
  "x-accepted-package-versions"?: string[];
  [key: string]: unknown;
}

interface CacheState {
  version: string;
  checked_at: string;
}

/** Beside each cached file: when it was read from the instance, and the ETag the instance sent with it. */
interface CacheMeta {
  fetched_at: string;
  etag?: string;
}

/** A cached contract file as `validate` reads it: whether it is still trusted, and which copy it is. */
export interface CachedContract<T> {
  value: T;
  version: string;
  fetched_at: string | null;
  etag: string | null;
  /** The first 12 hex digits of the file's SHA-256, to tell two copies of one version apart. */
  sha256: string;
  /** A development build's copy past the time-to-live: read it again when the instance is reachable. */
  stale: boolean;
}

type Loaded<T> = { value: T; serialized: string; etag?: string };

/** What a loader answers when the instance confirms the copy behind the ETag it was sent. */
const NOT_MODIFIED = Symbol("not modified");

type Env = Record<string, string | undefined>;

const RELEASE_TTL_SECONDS = 3600;
const DEVELOPMENT_TTL_SECONDS = 60;

const OPENAPI_PATHS = ["/openapi.json", "/api/v1/openapi.json"];

export class Contracts {
  private caps?: Capabilities | null;
  /** Whether `caps` was read from the instance during this command, not from the cache. */
  private live = false;
  private versionValue?: string;
  /** True when the instance needs a tenant before it answers (a token in Platform mode). */
  needsTenant = false;
  /** When the capabilities this command uses were read from the instance, if they came from the cache; undefined when read now. */
  cachedAt?: string;

  constructor(
    private readonly client: ApiClient,
    private readonly env: Env,
    private readonly now: () => Date,
  ) {}

  private get root(): string {
    return path.join(cacheDir(this.env), instanceKey(this.client.url));
  }

  /** How long a copy is trusted: CAVELON_CONTRACT_TTL_SECONDS, else an hour for a release and a minute for a development build. */
  ttlSeconds(version: string): number {
    const raw = this.env.CAVELON_CONTRACT_TTL_SECONDS;
    const seconds = Number(raw);
    if (raw !== undefined && raw !== "" && Number.isFinite(seconds) && seconds >= 0) return seconds;
    return Contracts.isDevelopment(version) ? DEVELOPMENT_TTL_SECONDS : RELEASE_TTL_SECONDS;
  }

  /** Development builds keep one version string for many contracts; never trust their cache past the TTL. */
  static isDevelopment(version: string): boolean {
    return version === "unknown" || /dev|snapshot|local/i.test(version);
  }

  /** Every cache file is 0600 in 0700 folders: it names the instance and its tenants, and holds a tenant's limits. */
  private async write(file: string, content: string): Promise<void> {
    await writePrivateFile(cacheDir(this.env), file, content);
  }

  private versionDir(version: string): string {
    return path.join(this.root, version.replace(/[^A-Za-z0-9._-]+/g, "_"));
  }

  private fresh(fetchedAt: string | undefined, version: string): boolean {
    if (!fetchedAt) return false;
    return this.now().getTime() - new Date(fetchedAt).getTime() < this.ttlSeconds(version) * 1000;
  }

  /** The instance's capabilities, or null when it does not publish them. */
  async capabilities(options: { refresh?: boolean } = {}): Promise<Capabilities | null> {
    if (this.caps !== undefined && !options.refresh) return this.caps;
    const state = await readJsonFile<CacheState>(path.join(this.root, "state.json"));
    if (!options.refresh && state) {
      // The version is the instance's, the capabilities this tenant's: a copy
      // another tenant read, or one this tenant read for an older version, is
      // not used.
      const file = path.join(this.versionDir(state.version), this.cacheName("capabilities.json"));
      const meta = await readJsonFile<CacheMeta>(`${file}.meta.json`);
      const cached = this.fresh(meta?.fetched_at, state.version) ? await readJsonFile<Capabilities>(file) : undefined;
      if (cached) {
        this.caps = cached;
        this.versionValue = state.version;
        this.cachedAt = meta?.fetched_at;
        return cached;
      }
    }
    const response = await this.client.get<Capabilities>("/api/v1/meta/capabilities", { allow: [400, 404] });
    this.live = true;
    this.cachedAt = undefined;
    if (response.status === 400) {
      // A platform token without a tenant cannot read tenant routes yet. Keep
      // the last known version, and remember nothing new.
      this.needsTenant = true;
      this.caps = null;
      this.versionValue = state?.version ?? "unknown";
      return null;
    }
    this.needsTenant = false;
    const now = this.now().toISOString();
    if (response.status === 404 || !response.data?.instance) {
      this.caps = null;
      this.versionValue = "unknown";
    } else {
      this.caps = response.data;
      this.versionValue = response.data.instance.version || "unknown";
      const file = path.join(this.versionDir(this.versionValue), this.cacheName("capabilities.json"));
      await this.write(file, JSON.stringify(response.data, null, 2));
      await this.write(`${file}.meta.json`, JSON.stringify({ fetched_at: now } satisfies CacheMeta));
    }
    await this.write(
      path.join(this.root, "state.json"),
      JSON.stringify({ version: this.versionValue, checked_at: now } satisfies CacheState, null, 2),
    );
    return this.caps;
  }

  /**
   * The capabilities as the instance answers them now, read at most once per
   * command: a tenant may lower or raise some of its own `limits` at any time,
   * which its cached copy does not know yet.
   */
  async liveCapabilities(): Promise<Capabilities | null> {
    if (this.live && this.caps !== undefined) return this.caps;
    return this.capabilities({ refresh: true });
  }

  async version(): Promise<string> {
    if (this.versionValue === undefined) await this.capabilities();
    return this.versionValue ?? "unknown";
  }

  private async cached<T>(
    file: string,
    load: (etag: string | undefined) => Promise<Loaded<T> | typeof NOT_MODIFIED>,
    parse: (text: string) => T,
    options: { refresh?: boolean } = {},
  ): Promise<T> {
    const version = await this.version();
    const target = path.join(this.versionDir(version), file);
    const metaFile = path.join(this.versionDir(version), `${file}.meta.json`);
    const text = await readTextFile(target);
    const meta = await readJsonFile<CacheMeta>(metaFile);
    let cached: { value: T } | undefined;
    if (text !== undefined) {
      try {
        cached = { value: parse(text) };
      } catch {
        // A damaged cache file is fetched again.
      }
    }
    if (cached && !options.refresh && (!Contracts.isDevelopment(version) || this.fresh(meta?.fetched_at, version))) return cached.value;
    const loaded = await load(cached ? meta?.etag : undefined);
    const fetchedAt = this.now().toISOString();
    if (loaded === NOT_MODIFIED) {
      if (!cached) throw new Error(`${file}: the instance answered 304 Not Modified without being sent an ETag.`);
      await this.write(metaFile, JSON.stringify({ ...meta, fetched_at: fetchedAt } satisfies CacheMeta));
      return cached.value;
    }
    await this.write(target, loaded.serialized);
    await this.write(metaFile, JSON.stringify({ fetched_at: fetchedAt, ...(loaded.etag ? { etag: loaded.etag } : {}) } satisfies CacheMeta));
    return loaded.value;
  }

  /**
   * GET a JSON contract, conditionally when there is an ETag to check the
   * cached copy with. Undefined only for a status the caller allowed.
   */
  private async getJson<T>(
    route: string,
    etag: string | undefined,
    options: { query?: Record<string, string | undefined>; allow?: number[]; timeoutMs?: number } = {},
  ): Promise<Loaded<T> | typeof NOT_MODIFIED | undefined> {
    const response = await this.client.get<T>(route, {
      query: options.query,
      timeoutMs: options.timeoutMs,
      allow: [...(options.allow ?? []), ...(etag ? [304] : [])],
      headers: etag ? { "If-None-Match": etag } : undefined,
    });
    if (etag && response.status === 304) return NOT_MODIFIED;
    if (response.status < 200 || response.status >= 300) return undefined;
    return { value: response.data, serialized: response.text, etag: response.headers.get("etag") ?? undefined };
  }

  /** A contract route without allowed statuses answers or throws. */
  private async getRequired<T>(route: string, etag: string | undefined, query?: Record<string, string | undefined>): Promise<Loaded<T> | typeof NOT_MODIFIED> {
    const loaded = await this.getJson<T>(route, etag, { query });
    if (!loaded) throw new Error(`${route} answered neither a body nor an error.`);
    return loaded;
  }

  async openapi(options: { refresh?: boolean } = {}): Promise<OpenApiDoc> {
    return this.cached(
      "openapi.json",
      async (etag) => {
        for (const candidate of OPENAPI_PATHS) {
          const loaded = await this.getJson<OpenApiDoc>(candidate, etag, { allow: NOT_HERE, timeoutMs: 120_000 });
          if (loaded === NOT_MODIFIED) return loaded;
          if (loaded?.value && typeof loaded.value === "object" && "paths" in loaded.value) return loaded;
        }
        throw new CavelonError(ExitCode.failure, {
          code: "openapi_unavailable",
          message: `${this.client.url} does not serve its OpenAPI at ${OPENAPI_PATHS.join(" or ")}.`,
          hint: "`cavelon api` needs the instance's OpenAPI; ask the instance's operator to route it.",
        });
      },
      (text) => JSON.parse(text) as OpenApiDoc,
      options,
    );
  }

  async errorCatalog(options: { refresh?: boolean } = {}): Promise<ErrorCatalog | null> {
    try {
      return await this.cached(
        "error-catalog.json",
        (etag) => this.getRequired<ErrorCatalog>("/api/v1/meta/error-catalog", etag),
        (text) => JSON.parse(text) as ErrorCatalog,
        options,
      );
    } catch (error) {
      if (error instanceof CavelonError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * The package JSON Schema of one package version (the instance's current
   * one when none is named), or null when the instance does not publish it.
   */
  async packageSchema(version?: string, options: { refresh?: boolean } = {}): Promise<PackageSchema | null> {
    const wanted = version ?? (await this.capabilities())?.contracts?.package_versions?.current;
    const file = Contracts.packageSchemaFile(wanted ?? "current");
    try {
      return await this.cached(
        file,
        (etag) => this.getRequired<PackageSchema>("/api/v1/meta/package-schema", etag, { version: wanted }),
        (text) => JSON.parse(text) as PackageSchema,
        options,
      );
    } catch (error) {
      if (error instanceof CavelonError && error.status === 404) {
        // The route answers 404 for a version it does not accept, and an older
        // instance has no route at all; the body tells the two apart.
        if (error.message.includes("package_version_unsupported") || error.code === "package_version_unsupported") {
          throw new CavelonError(ExitCode.validation, {
            code: "package_version_unsupported",
            message: `${this.client.url} does not accept package version ${wanted}.`,
            hint: `Read contracts.package_versions.accepted from \`${cavelonCommand("status", "--json")}\`, or pull the package again.`,
          });
        }
        return null;
      }
      throw error;
    }
  }

  /**
   * A contract file from the cache only, never from the network: the newest
   * cached copy for the instance version seen last (for the capabilities, this
   * tenant's copy), and whether a development build's copy is past its
   * time-to-live. For `validate`, which runs offline.
   */
  async cachedOnly<T>(file: string): Promise<CachedContract<T> | undefined> {
    const state = await readJsonFile<CacheState>(path.join(this.root, "state.json"));
    if (!state) return undefined;
    const target = path.join(this.versionDir(state.version), this.cacheName(file));
    const text = await readTextFile(target);
    if (text === undefined) return undefined;
    let value: T;
    try {
      value = JSON.parse(text) as T;
    } catch {
      return undefined;
    }
    const meta = await readJsonFile<CacheMeta>(`${target}.meta.json`);
    return {
      value,
      version: state.version,
      fetched_at: meta?.fetched_at ?? null,
      etag: meta?.etag ?? null,
      sha256: createHash("sha256").update(text).digest("hex").slice(0, 12),
      stale: Contracts.isDevelopment(state.version) && !this.fresh(meta?.fetched_at, state.version),
    };
  }

  static packageSchemaFile(version: string): string {
    return `package-schema-${version.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`;
  }

  /**
   * Who a document that depends on the caller is cached for: the first 16 hex
   * digits of a SHA-256 over the token and the tenant it is sent with, never
   * the token itself. The instance lists different docs pages to a tenant
   * member and to a platform operator in Platform mode, so one cache shared by
   * every token on the machine showed whichever index was read first.
   */
  audience(): string {
    const { token = "", tenantId = "" } = this.client.target;
    const tenant = token.startsWith("cbp_") ? "" : tenantId;
    return createHash("sha256").update(`cavelon-audience\0${token}\0${tenant}`).digest("hex").slice(0, 16);
  }

  /**
   * Whose limits a capabilities copy holds: the first 16 hex digits of a
   * SHA-256 over the tenant the token is sent with. Without one (a tenant API
   * key, bound to its own tenant, or a token that reads its default tenant),
   * the token decides the tenant, so its audience keys the copy. Keyed by the
   * tenant rather than the token, a copy survives a new login, so `validate
   * --offline` still checks against the tenant's own limits.
   */
  tenantKey(): string {
    const { token = "", tenantId = "" } = this.client.target;
    if (!tenantId || token.startsWith("cbp_")) return this.audience();
    return createHash("sha256").update(`cavelon-tenant\0${tenantId}`).digest("hex").slice(0, 16);
  }

  /** The name a contract is cached under: the capabilities once per tenant, every other file once per instance version. */
  private cacheName(file: string): string {
    return file === "capabilities.json" ? Contracts.keyedName(file, this.tenantKey()) : file;
  }

  private static keyedName(file: string, key: string): string {
    const dot = file.lastIndexOf(".");
    return dot > 0 ? `${file.slice(0, dot)}.${key}${file.slice(dot)}` : `${file}.${key}`;
  }

  /**
   * Cache a text document of this instance version that the instance answers
   * per caller (the docs index), once per audience: `llms.txt` is kept as
   * `llms.<audience>.txt`.
   */
  async text(file: string, load: () => Promise<string>, options: { refresh?: boolean } = {}): Promise<string> {
    return this.cached(
      Contracts.keyedName(file, this.audience()),
      async () => {
        const text = await load();
        return { value: text, serialized: text };
      },
      (text) => text,
      options,
    );
  }
}

/** Warnings for contract versions this binary does not understand. */
export function compareContracts(caps: Capabilities | null): string[] {
  if (!caps) {
    return ["The instance does not publish /api/v1/meta/capabilities; the kit cannot check that it understands this instance's contracts."];
  }
  const warnings: string[] = [];
  const api = caps.contracts?.api_version;
  if (api && !(SUPPORTED_CONTRACTS.api_versions as readonly string[]).includes(api)) {
    warnings.push(
      `The instance speaks API ${api}; this cavelon understands ${SUPPORTED_CONTRACTS.api_versions.join(", ")}. Update cavelon.`,
    );
  }
  const pkg = caps.contracts?.package_versions;
  if (pkg?.current && !(SUPPORTED_CONTRACTS.package_versions as readonly string[]).includes(pkg.current)) {
    const overlap = pkg.accepted?.filter((v) => (SUPPORTED_CONTRACTS.package_versions as readonly string[]).includes(v)) ?? [];
    warnings.push(
      `The instance writes package format ${pkg.current}; this cavelon understands ${SUPPORTED_CONTRACTS.package_versions.join(", ")}` +
        (overlap.length ? ` (the instance still accepts ${overlap.join(", ")}).` : ". Update cavelon."),
    );
  }
  return warnings;
}
