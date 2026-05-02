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
  let resolved: Settings;
  if (network === "mainnet") {
    const mod = await import("../settings/mainnet.js");
    resolved = mod.mainnet;
  } else {
    const mod = await import("../settings/testnet.js");
    resolved = mod.testnet;
  }

  // Optional local overrides — gitignored. Wrap in try/catch because
  // most installs won't have one.
  try {
    const localSpecifier = "../settings/local.js";
    const local = (await import(localSpecifier)) as {
      local?: Partial<Settings>;
    };
    if (local.local) resolved = { ...resolved, ...local.local };
  } catch {
    // no local overrides — fine
  }

  const frozen = Object.freeze(resolved);
  current = frozen;
  return frozen;
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
