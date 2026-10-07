// Types of build-bundle.mjs, for the tests in cli/test/.

export declare const REPOSITORY: string;
export declare const BUNDLE_FORMAT: number;
export declare const PLATFORMS: string[];

export declare function executableName(platform: string): string;

export interface McpEntryFile {
  mcpServers: { cavelon: { command: string; args: string[]; env: Record<string, string> } };
}
export declare function offlineMcpEntry(pluginVersion?: string): McpEntryFile;

export interface BundleManifest {
  format: number;
  name: string;
  version: string;
  repository: string;
  commit?: string;
  instance_contracts: { api_versions: string[]; package_versions: string[] };
  executables: Array<{ platform: string; path: string }>;
  mcp: { plugin: string; entry: string };
  files: Array<{ path: string; size: number; sha256: string }>;
}

export declare function buildBundle(options: {
  root?: string;
  version: string;
  contracts: { readonly api_versions: readonly string[]; readonly package_versions: readonly string[] };
  executablesDir: string;
  pluginPackagesDir?: string;
  commit?: string;
  allowMissingExecutables?: boolean;
}): { name: string; tarball: Buffer; manifest: BundleManifest; manifestText: string };
