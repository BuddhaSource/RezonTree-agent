// modules/wallets/index.ts — module entry point.
//
// Exports a default ModuleConfig that the framework loads via
// INSTALLED_MODULES. Re-exports the public surface other modules will
// consume (the service layer + types).

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ModuleConfig, MigrationFile } from "../../core/module.js";
import { registerWalletsCommands } from "./commands.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const walletsModule: ModuleConfig = {
  name: "wallets",

  migrations(): MigrationFile[] {
    return [
      {
        id: "0001",
        path: resolve(__dirname, "migrations/0001_initial.sql"),
        description: "wallets, wallet_roles, wallet_topics, wallet_settings",
      },
    ];
  },

  registerCommands(program) {
    registerWalletsCommands(program);
  },
};

export default walletsModule;

// Public surface for other modules.
export {
  registerWallet,
  listWallets,
  getWallet,
  loadAccount,
  deactivateWallet,
  setRole,
  getRoles,
  setTopicInterest,
  setWalletSetting,
  getWalletSetting,
  walletRegistered,
  walletDeactivated,
} from "./service.js";

export {
  wallets,
  walletRoles,
  walletTopics,
  walletSettings,
  type Wallet,
  type WalletRole,
  type WalletTopic,
} from "./schema.js";

export type { ProviderType, WalletProvider } from "./providers/types.js";
