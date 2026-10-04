import { capacityCodeIn, capacityHint } from "./capacity.js";
import { ceilingRefusal, LIMIT_ABOVE_CEILING } from "./limits.js";
import { CavelonError, ExitCode, type ExitCodeValue } from "./errors.js";
import { KIT_VERSION } from "./version.js";

// The standalone executable runs on Bun, the npm package on Node.js.
const RUNTIME = process.versions.bun ? "bun/" + process.versions.bun : "node/" + process.versions.node;

/**
 * The one way the kit talks to an instance. It adds the credential and the
 * tenant, bounds every request in time, and turns every failure into a
 * CavelonError with the documented exit code. It never prints or logs the
 * token, and never puts it into an error.
 */

export interface Target {
  url: string;
  token?: string;
  /** Sent as `X-Tenant-Id`; a tenant API key is bound to its tenant and sends none. */
  tenantId?: string;
}

export type QueryValue = string | number | boolean | null | undefined | Array<string | number | boolean>;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  json?: unknown;
  form?: FormData;
  /** Raw bytes, sent as they are; the caller sets the Content-Type header. */
  bytes?: Uint8Array;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** False for platform calls that must not carry a tenant (tenant create, tenant list). */
  sendTenant?: boolean;
  /** False for anonymous calls (public docs). */
  sendAuth?: boolean;
  accept?: string;
  /** Statuses returned to the caller instead of thrown. */
  allow?: number[];
}

export interface ApiResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
  text: string;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

/** Statuses a probe of an optional document treats as "not here" (a proxy may send it to the Admin). */
export const NOT_HERE = [301, 302, 303, 307, 308, 401, 403, 404, 405, 406];

export const PERSONAL_ACCESS_TOKENS_DISABLED = "personal_access_tokens_disabled";

/**
 * A route of the personal access tokens. While an instance has them turned
 * off, these answer 404 before they look at the caller, and 401 to a caller
 * without a credential while they are on.
 */
const TOKEN_ROUTE = "/api/v1/personal-access-tokens/options";

/** The refusal of a personal access token by an instance that has them turned off. */
export function tokensDisabledError(url: string): CavelonError {
  return new CavelonError(ExitCode.unauthorized, {
    code: PERSONAL_ACCESS_TOKENS_DISABLED,
    status: 401,
    message: `${url} has personal access tokens turned off, so it refuses every cvpat_ token, this one included.`,
    hint:
      "The instance's operator turns them on with PERSONAL_ACCESS_TOKENS_ENABLED. Until then, a tenant API key (cbp_…) " +
      "works for the commands that accept one: a person runs `cavelon login` with it.",
  });
}

/** How many leading characters the URL parser drops (whitespace and controls), and slashes too when asked. */
function leading(text: string, slashes: boolean): number {
  let i = 0;
  while (i < text.length && (text.charCodeAt(i) <= 0x20 || (slashes && (text[i] === "/" || text[i] === "\\")))) i++;
  return i;
}

export class ApiClient {
  /** Whether the instance has personal access tokens turned off, asked once. */
  private tokensOff?: Promise<boolean>;

  constructor(
    readonly target: Target,
    private readonly env: Record<string, string | undefined> = {},
  ) {}

  get url(): string {
    return this.target.url;
  }

  /**
   * The URL of a path on the instance. Paths also come from the instance (limit
   * links, OpenAPI paths, docs index URLs), so a path is judged by what the URL
   * parser makes of it, never by its text: the parser drops leading
   * whitespace and tabs and reads backslashes as slashes.
   */
  resolve(pathOrUrl: string, query?: Record<string, QueryValue>): URL {
    const base = new URL(this.target.url.endsWith("/") ? this.target.url : `${this.target.url}/`);
    const foreign = (where: string, why = `the instance is ${base.origin}`) =>
      new CavelonError(ExitCode.usage, { code: "foreign_url", message: `Refusing to send the token to ${where}; ${why}.` });
    const parse = (input: string, against?: URL): URL => {
      try {
        return new URL(input, against);
      } catch {
        throw foreign(JSON.stringify(input), "it is not a URL on the instance");
      }
    };
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(pathOrUrl.slice(leading(pathOrUrl, false)));
    // A path is relative to the instance's base path, which may not be the root.
    const url = hasScheme ? parse(pathOrUrl) : parse(pathOrUrl.slice(leading(pathOrUrl, true)), base);
    // Read against the base as well, so an input that names a host in any spelling is refused, not reinterpreted.
    for (const candidate of [url, parse(pathOrUrl, base)]) {
      if (candidate.origin !== base.origin) throw foreign(candidate.origin === "null" ? candidate.protocol : candidate.origin);
    }
    if (!hasScheme && !url.pathname.startsWith(base.pathname)) throw foreign(url.pathname, `it is outside the instance's path ${base.pathname}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
      else url.searchParams.set(key, String(value));
    }
    return url;
  }

  headers(options: RequestOptions = {}): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent": `cavelon/${KIT_VERSION} ${RUNTIME}`,
      Accept: options.accept ?? "application/json",
      ...options.headers,
    };
    if (options.sendAuth !== false && this.target.token) headers.Authorization = `Bearer ${this.target.token}`;
    if (options.sendTenant !== false && this.target.tenantId && !this.target.token?.startsWith("cbp_")) {
      headers["X-Tenant-Id"] = this.target.tenantId;
    }
    return headers;
  }

  /** A raw response (for streams); the caller owns the body and the signal. */
  async fetchRaw(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const url = this.resolve(path, options.query);
    const headers = this.headers(options);
    let body: FormData | string | Uint8Array | undefined;
    if (options.form) body = options.form;
    else if (options.bytes) body = options.bytes;
    else if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    }
    try {
      return await fetch(url, { method, headers, body, signal: options.signal, redirect: "manual" });
    } catch (error) {
      throw networkError(error, url, options.signal);
    }
  }

  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    const timeoutMs = options.timeoutMs ?? (Number(this.env.CAVELON_HTTP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await this.fetchRaw(method, path, { ...options, signal });
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw networkError(error, this.resolve(path), signal);
    }
    const data = parseBody(text, response.headers.get("content-type"));
    if (response.status >= 300 && response.status < 400 && !options.allow?.includes(response.status)) {
      throw new CavelonError(ExitCode.server, {
        code: "unexpected_redirect",
        status: response.status,
        message: `${method} ${path} redirected to ${response.headers.get("location") ?? "?"}; check the instance URL.`,
      });
    }
    if (!response.ok && !options.allow?.includes(response.status)) {
      // A tenant call sent without a tenant, because none is chosen: a token without Platform mode is refused for that alone.
      const tenantless = options.sendTenant !== false && !this.headers(options)["X-Tenant-Id"] && Boolean(this.target.token?.startsWith("cvpat_"));
      throw await this.refusal(response.status, data, `${method} ${new URL(response.url || this.resolve(path)).pathname}`, response.headers, { tenantless });
    }
    return { status: response.status, headers: response.headers, data: data as T, text };
  }

  /**
   * The error for a refused request. A personal access token refused with 401
   * is first checked against the instance: one with the tokens turned off
   * refuses every token, and the person needs to hear that, not that theirs is
   * expired or revoked.
   */
  async refusal(status: number, body: unknown, what: string, headers?: Headers, sent: RefusalContext = {}): Promise<CavelonError> {
    if (status === 401 && this.target.token?.startsWith("cvpat_") && (await this.personalAccessTokensOff())) {
      return tokensDisabledError(this.url);
    }
    return errorFromResponse(status, body, what, headers, sent);
  }

  /**
   * Whether the instance has personal access tokens turned off: a token route
   * asked without a credential answers 404 then. The capabilities would say
   * it too, but they answer only a caller the instance accepts. Anything else
   * (401, a redirect, no answer) leaves the refusal as the instance sent it.
   */
  personalAccessTokensOff(): Promise<boolean> {
    this.tokensOff ??= (async () => {
      try {
        const response = await this.fetchRaw("GET", TOKEN_ROUTE, {
          sendAuth: false,
          sendTenant: false,
          signal: AbortSignal.timeout(Math.min(Number(this.env.CAVELON_HTTP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS, 10_000)),
        });
        await response.body?.cancel();
        return response.status === 404;
      } catch {
        return false;
      }
    })();
    return this.tokensOff;
  }

  get<T = unknown>(path: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>("GET", path, options);
  }
}

function parseBody(text: string, contentType: string | null): unknown {
  if (!text) return null;
  if (contentType?.includes("json") || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/**
 * A response body read to the end. A body that stalls or breaks off is a
 * network failure (exit 8, retry), as a request that got no answer is.
 */
export async function bodyBytes(response: Response, url: URL, signal?: AbortSignal): Promise<Uint8Array> {
  try {
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw networkError(error, url, signal);
  }
}

function networkError(error: unknown, url: URL, signal?: AbortSignal): CavelonError {
  const reason = signal?.reason as { name?: string } | undefined;
  if (reason?.name === "TimeoutError" || (error as { name?: string })?.name === "TimeoutError") {
    return new CavelonError(ExitCode.server, {
      code: "request_timeout",
      message: `${url.origin} did not answer in time.`,
      hint: "Retry; CAVELON_HTTP_TIMEOUT_MS raises the limit per request.",
    });
  }
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const detail = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
  return new CavelonError(ExitCode.server, {
    code: "network_error",
    message: `Cannot reach ${url.origin}: ${detail}`,
    hint: "Check the instance URL and the network (VPN, proxy, allowlist).",
  });
}

/** A machine code, as the instance's refusals spell them: `loop_review_reason_mismatch`. */
const BARE_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

/** The server's code, message, hint and docs link, from any error shape it sends. */
/** What the refused request carried, where the refusal alone does not say why. */
export interface RefusalContext {
  /** A personal access token's tenant call sent without X-Tenant-Id. */
  tenantless?: boolean;
}

/** Said where a personal access token was refused without a tenant. */
export const TENANT_ID_HINT =
  "A token without Platform mode works only inside a tenant. Run `cavelon use` to choose one of the tenants it reaches, " +
  "or pass --tenant <name, slug or id> (or set CAVELON_TENANT). An older instance tells such a token nothing without a tenant, " +
  "not even which tenants it reaches: pass --tenant <tenant-id> there; an operator copies the id in Platform › Tenants. " +
  "A token limited to one tenant needs none.";

export function errorFromResponse(status: number, body: unknown, what: string, headers?: Headers, sent: RefusalContext = {}): CavelonError {
  let code: string | undefined;
  let message: string | undefined;
  let hint: string | undefined;
  let docs: string | undefined;
  let details: unknown;
  let blockers: string[] | undefined;
  const pick = (source: Record<string, unknown>) => {
    if (typeof source.code === "string") code = source.code;
    if (typeof source.error === "string" && !code) code = source.error;
    if (typeof source.message === "string") message = source.message;
    if (typeof source.hint === "string") hint = source.hint;
    if (typeof source.docs === "string") docs = source.docs;
    // A refused import names what its own check found.
    const said = Array.isArray(source.blockers) ? source.blockers.filter((b): b is string => typeof b === "string" && b !== "") : [];
    if (said.length) blockers = said;
  };
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const map = body as Record<string, unknown>;
    pick(map);
    const detail = map.detail;
    if (typeof detail === "string") {
      message = detail;
      // Many refusals send their code alone as the detail (`{"detail": "loop_control_invalid"}`).
      if (!code && BARE_CODE.test(detail)) code = detail;
    } else if (Array.isArray(detail)) {
      details = detail;
      message = detail
        .slice(0, 5)
        .map((item) => {
          const entry = item as { loc?: unknown[]; msg?: string };
          return `${(entry.loc ?? []).join(".")}: ${entry.msg ?? "invalid"}`;
        })
        .join("; ");
    } else if (detail && typeof detail === "object") {
      pick(detail as Record<string, unknown>);
      if (!message && typeof (detail as Record<string, unknown>).detail === "string") {
        message = (detail as Record<string, string>).detail;
      }
      if (message === undefined) details = detail;
    }
  } else if (typeof body === "string" && body.trim() && !/^\s*</.test(body)) {
    message = body.trim().slice(0, 300);
  }
  const exitCode = exitCodeForStatus(status);
  const retryAfter = headers?.get("retry-after");
  if (status === 429 && !hint) hint = retryAfter ? `Retry after ${retryAfter} seconds.` : "Retry later.";
  // A refusal for run or endpoint capacity: which limit to raise, and who can.
  const capacity = capacityCodeIn(code) ?? (status === 429 || status === 503 ? capacityCodeIn(message) : undefined);
  if (capacity) hint = [hint, capacityHint(capacity), `\`cavelon explain ${capacity}\` says more.`].filter(Boolean).join(" ");
  // A value above a platform ceiling: the ceiling and the operator's setting that raises it, from the refusal's fields.
  const ceiling = code === LIMIT_ABOVE_CEILING ? ceilingRefusal(body) : undefined;
  if (ceiling) {
    hint = ceiling.hint;
    details = details && typeof details === "object" ? { ...(details as Record<string, unknown>), ...ceiling.details } : ceiling.details;
  }
  if (status === 400 && !hint && message && /select a tenant|tenant context|X-Tenant-Id/i.test(message)) {
    hint = "Choose a tenant with `cavelon use` (it lists your tenants), --tenant or CAVELON_TENANT.";
  }
  if ((status === 401 || status === 403) && !hint) {
    hint =
      status === 401
        ? "The token is missing, expired or revoked. A person runs `cavelon login` with a new one."
        : sent.tenantless
          ? `No tenant was named. ${TENANT_ID_HINT} Otherwise check the token's permission ceiling.`
          : "The token does not reach this. Check the tenant (`cavelon whoami`) and the token's permission ceiling.";
  }
  return new CavelonError(exitCode, {
    code: code ?? defaultCode(status),
    message: message ? `${what}: ${message}` : `${what} answered ${status}.`,
    hint,
    docs,
    status,
    details,
    blockers,
  });
}

export function exitCodeForStatus(status: number): ExitCodeValue {
  if (status === 401 || status === 403) return ExitCode.unauthorized;
  if (status === 400 || status === 422) return ExitCode.validation;
  if (status === 409 || status === 412) return ExitCode.conflict;
  if (status === 408 || status === 429 || status >= 500) return ExitCode.server;
  return ExitCode.failure;
}

function defaultCode(status: number): string {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 412:
      return "precondition_failed";
    case 422:
      return "validation_failed";
    case 429:
      return "rate_limited";
    default:
      return status >= 500 ? "server_error" : `http_${status}`;
  }
}
