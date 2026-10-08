import { fileURLToPath } from "node:url";
import { startOpenCodeTui, type OpenCodeTui } from "./opencode-tui.js";
import { loadNativeRuntime, type NativeRuntime } from "./profile.js";

/** Kilo 7.8.8 exposes the same dialog lifecycle; ownership stays Kilo-specific. */
export const startKiloTui = (api: OpenCodeTui, options: NativeRuntime) => startOpenCodeTui(api, options, "kilo");

export default {
  id: "cavelon.native-approval.kilo",
  async tui(api: OpenCodeTui, options: { profile?: unknown } | undefined) {
    const profile = options?.profile === undefined ? fileURLToPath(new URL("./profile.json", import.meta.url)) : options.profile;
    if (typeof profile !== "string") throw new Error("Cavelon native approval needs its setup profile.");
    await startKiloTui(api, await loadNativeRuntime(profile, "kilo"));
  },
};
