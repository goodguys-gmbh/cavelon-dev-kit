import { describe, expect, it } from "vitest";
import { CavelonError } from "../src/errors.js";
import { ApiClient } from "../src/http.js";

/**
 * The token goes only to the instance. Paths come from the instance too
 * (published limit links, OpenAPI paths, docs index URLs), so every one is
 * resolved first and its origin compared, whatever the URL parser makes of it.
 */

function refusal(fn: () => unknown): CavelonError {
  try {
    fn();
  } catch (error) {
    return error as CavelonError;
  }
  throw new Error("expected a refusal");
}

describe("ApiClient.resolve", () => {
  const client = new ApiClient({ url: "https://cavelon.example.com", token: "cvpat_test" });
  const mounted = new ApiClient({ url: "https://cavelon.example.com/cavelon", token: "cvpat_test" });

  it.each([
    "\\\\evil.example/x",
    "/\\evil.example/x",
    " //evil.example/x",
    "\t//evil.example/x",
    "\n//evil.example/x",
    "http:evil.example/x",
    "http://cavelon.example.com/x",
    "https:evil.example/x",
    "https://evil.example/x",
    "HTTPS://evil.example/x",
    "//evil.example/x",
    "ftp://evil.example/x",
  ])("refuses %j, which would leave the instance", (input) => {
    const error = refusal(() => client.resolve(input));
    expect(error).toBeInstanceOf(CavelonError);
    expect(error.code).toBe("foreign_url");
    expect(error.message).not.toContain("cvpat_test");
  });

  it("refuses a relative path that climbs out of the instance's base path", () => {
    expect(refusal(() => mounted.resolve("../admin/x")).code).toBe("foreign_url");
    expect(refusal(() => mounted.resolve("/api/%2e%2e/%2e%2e/admin")).code).toBe("foreign_url");
  });

  it("resolves the instance's own paths under its base path", () => {
    expect(client.resolve("/api/v1/harnesses").href).toBe("https://cavelon.example.com/api/v1/harnesses");
    expect(client.resolve("api/v1/harnesses", { limit: 5 }).href).toBe("https://cavelon.example.com/api/v1/harnesses?limit=5");
    expect(client.resolve("https://cavelon.example.com/docs/llms.txt").href).toBe("https://cavelon.example.com/docs/llms.txt");
    expect(mounted.resolve("/api/v1/harnesses").href).toBe("https://cavelon.example.com/cavelon/api/v1/harnesses");
    expect(mounted.resolve("https://cavelon.example.com/cavelon/docs/a.md").href).toBe("https://cavelon.example.com/cavelon/docs/a.md");
  });
});
