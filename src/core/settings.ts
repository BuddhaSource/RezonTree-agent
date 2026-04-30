// core/settings.ts — settings loader.
//
// Resolution order (highest priority wins):
//   1. local.ts (gitignored, optional)
//   2. <network>.ts (testnet | mainnet, picked by env or --settings flag)
//   3. base.ts
//
// The chosen Settings object is frozen after load. Modules import
// `getSettings()` lazily so test code can call `loadSettings()` again.

import type { Settings } from "../settings/base.js";
export type { Settings, Network } from "../settings/base.js";

let current: Settings | null = null;

/** Load settings for a given network. Optionally merges local overrides. */
export async function loadSettings(
  network: "testnet" | "mainnet" = "testnet",
): Promise<Settings> {
  const mod =
    network === "mainnet"
      ? await import("../settings/mainnet.js")
      : await import("../settings/testnet.js");
  let resolved = mod[network];

  // Optional local overrides — gitignored. Wrap in try/catch because
  // most installs won't have one.
  try {
    const local = (await import("../settings/local.js")) as {
      local?: Partial<Settings>;
    };
    if (local.local) resolved = { ...resolved, ...local.local };
  } catch {
    // no local overrides — fine
  }

  current = Object.freeze(resolved);
  return current;
}

/** Synchronous accessor for already-loaded settings. */
export function getSettings(): Settings {
  if (!current) {
    throw new Error(
      "Settings not loaded. Call loadSettings() before any module accesses settings.",
    );
  }
  return current;
}

/** Test/utility: clear the loaded settings so a fresh load can run. */
export function resetSettingsForTests(): void {
  current = null;
}
