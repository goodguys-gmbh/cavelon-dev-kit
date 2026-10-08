import { fileURLToPath } from "node:url";
import { installPiExtension, type PiApi } from "./pi-extension.js";
import { loadNativeRuntime } from "./profile.js";

/** OMP's released extension API shares the transport, but owns a separate profile and tool identity. */
export default async function cavelon(omp: PiApi): Promise<void> {
  const runtime = await loadNativeRuntime(fileURLToPath(new URL("./profile.json", import.meta.url)), "omp");
  process.env.CAVELON_AGENT = "1";
  installPiExtension(omp, runtime, "omp");
}
