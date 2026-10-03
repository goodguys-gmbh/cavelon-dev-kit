import path from "node:path";
import { CavelonError, ExitCode } from "./errors.js";
import { NOT_HERE, type ApiClient } from "./http.js";
import { cacheDir, instanceKey } from "./paths.js";
import { readJsonFile, readTextFile, writeFileAtomic } from "./fsutil.js";
import { SUPPORTED_CONTRACTS } from "./version.js";

/**
 * The instance's published contracts, cached per instance and version under
 * `~/.cache/cavelon/<instance>/<version>/`. A new instance version gets a new
 * folder, so the kit learns a core release's features without a kit release.
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
  docs: string;
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

type Env = Record<string, string | undefined>;

const OPENAPI_PATHS = ["/openapi.json", "/api/v1/openapi.json"];

export class Contracts {
  private caps?: Capabilities | null;
  /** Whether `caps` was read from the instance during this command, not from the cache. */
  private live = false;
  private versionValue?: string;
  /** True when the instance needs a tenant before it answers (a token in Platform mode). */
  needsTenant = false;

  constructor(
    private readonly client: ApiClient,
    private readonly env: Env,
    private readonly now: () => Date,
  ) {}

  private get root(): string {
    return path.join(cacheDir(this.env), instanceKey(this.client.url));
  }

  private get ttlMs(): number {
    const seconds = Number(this.env.CAVELON_CONTRACT_TTL_SECONDS);
    return (Number.isFinite(seconds) && seconds >= 0 && this.env.CAVELON_CONTRACT_TTL_SECONDS !== "" ? seconds : 3600) * 1000;
  }

  /** Development builds keep one version string for many contracts; never trust their cache past the TTL. */
  private isMoving(version: string): boolean {
    return version === "unknown" || /dev|snapshot|local/i.test(version);
  }

  private versionDir(version: string): string {
    return path.join(this.root, version.replace(/[^A-Za-z0-9._-]+/g, "_"));
  }

  private fresh(fetchedAt: string | undefined): boolean {
    if (!fetchedAt) return false;
    return this.now().getTime() - new Date(fetchedAt).getTime() < this.ttlMs;
  }

  /** The instance's capabilities, or null when it does not publish them. */
  async capabilities(options: { refresh?: boolean } = {}): Promise<Capabilities | null> {
    if (this.caps !== undefined && !options.refresh) return this.caps;
    const state = await readJsonFile<CacheState>(path.join(this.root, "state.json"));
    if (!options.refresh && state && this.fresh(state.checked_at)) {
      const cached = await readJsonFile<Capabilities>(path.join(this.versionDir(state.version), "capabilities.json"));
      if (cached) {
        this.caps = cached;
        this.versionValue = state.version;
        return cached;
      }
    }
    const response = await this.client.get<Capabilities>("/api/v1/meta/capabilities", { allow: [400, 404] });
    this.live = true;
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
      await writeFileAtomic(
        path.join(this.versionDir(this.versionValue), "capabilities.json"),
        JSON.stringify(response.data, null, 2),
      );
    }
    await writeFileAtomic(
      path.join(this.root, "state.json"),
      JSON.stringify({ version: this.versionValue, checked_at: now } satisfies CacheState, null, 2),
    );
    return this.caps;
  }

  /**
   * The capabilities as the instance answers them now, read at most once per
   * command. The cache is per instance, but `limits` is per tenant: a tenant
   * may lower or raise some of its own.
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
    load: () => Promise<{ value: T; serialized: string }>,
    parse: (text: string) => T,
    options: { refresh?: boolean } = {},
  ): Promise<T> {
    const version = await this.version();
    const target = path.join(this.versionDir(version), file);
    const meta = path.join(this.versionDir(version), `${file}.meta.json`);
    if (!options.refresh) {
      const text = await readTextFile(target);
      const info = await readJsonFile<{ fetched_at: string }>(meta);
      if (text !== undefined && (!this.isMoving(version) || this.fresh(info?.fetched_at))) {
        try {
          return parse(text);
        } catch {
          // A damaged cache file is fetched again.
        }
      }
    }
    const { value, serialized } = await load();
    await writeFileAtomic(target, serialized);
    await writeFileAtomic(meta, JSON.stringify({ fetched_at: this.now().toISOString() }));
    return value;
  }

  async openapi(options: { refresh?: boolean } = {}): Promise<OpenApiDoc> {
    return this.cached(
      "openapi.json",
      async () => {
        for (const candidate of OPENAPI_PATHS) {
          const response = await this.client.get<OpenApiDoc>(candidate, { allow: NOT_HERE, timeoutMs: 120_000 });
          if (response.status === 200 && response.data && typeof response.data === "object" && "paths" in response.data) {
            return { value: response.data, serialized: response.text };
          }
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
        async () => {
          const response = await this.client.get<ErrorCatalog>("/api/v1/meta/error-catalog");
          return { value: response.data, serialized: response.text };
        },
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
        async () => {
          const response = await this.client.get<PackageSchema>("/api/v1/meta/package-schema", {
            query: { version: wanted },
          });
          return { value: response.data, serialized: response.text };
        },
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
            hint: "Read contracts.package_versions.accepted from `cavelon status --json`, or pull the package again.",
          });
        }
        return null;
      }
      throw error;
    }
  }

  /**
   * A contract file from the cache only, never from the network: the newest
   * cached copy for the instance version seen last. For `validate`, which runs
   * offline.
   */
  async cachedOnly<T>(file: string): Promise<{ value: T; version: string } | undefined> {
    const state = await readJsonFile<CacheState>(path.join(this.root, "state.json"));
    if (!state) return undefined;
    const value = await readJsonFile<T>(path.join(this.versionDir(state.version), file));
    return value === undefined ? undefined : { value, version: state.version };
  }

  static packageSchemaFile(version: string): string {
    return `package-schema-${version.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`;
  }

  /** Cache any text document of this instance version (the docs index). */
  async text(file: string, load: () => Promise<string>, options: { refresh?: boolean } = {}): Promise<string> {
    return this.cached(
      file,
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
