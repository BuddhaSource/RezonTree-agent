// modules/wallets/service.ts — CRUD + role/topic management.
//
// Anything that touches the wallets tables goes through here. Other
// modules import this; they never write to wallets.* directly. That's
// what keeps the module boundary honest.

import { eq, and } from "drizzle-orm";
import type { Account, Address } from "viem";

import { getDb } from "../../core/db.js";
import { getSettings } from "../../core/settings.js";
import { getLogger } from "../../core/logger.js";
import { createSignal } from "../../core/signals.js";

import {
  wallets,
  walletRoles,
  walletTopics,
  walletSettings,
  type Wallet,
  type WalletRole,
} from "./schema.js";
import { getProvider } from "./providers/registry.js";
import type { ProviderType, RegisterWalletInput } from "./providers/types.js";

const log = getLogger("wallets");

// ── Signals ──────────────────────────────────────────────────────────
export const walletRegistered = createSignal<{ wallet: Wallet }>(
  "wallet_registered",
);
export const walletDeactivated = createSignal<{ address: Address }>(
  "wallet_deactivated",
);

// ── Register / import ────────────────────────────────────────────────
export interface RegisterArgs {
  providerType: ProviderType;
  alias?: string;
  /** Pass-through to the provider. */
  details: Record<string, unknown>;
}

export async function registerWallet(args: RegisterArgs): Promise<Wallet> {
  const provider = getProvider(args.providerType);
  const { address, providerData } = await provider.register({
    alias: args.alias,
    details: args.details,
  });

  const network = getSettings().NETWORK;
  const db = getDb();

  // Idempotent: same address registered twice is a no-op (returns existing).
  const existing = await db
    .select()
    .from(wallets)
    .where(eq(wallets.address, address))
    .all();
  if (existing.length > 0) {
    log.info({ address }, "wallet already registered — skipping");
    return existing[0];
  }

  const row: Wallet = {
    address,
    network,
    alias: args.alias ?? null,
    providerType: args.providerType,
    providerData: JSON.stringify(providerData),
    active: 1,
    createdAt: Date.now(),
    metadataJson: null,
  };
  await db.insert(wallets).values(row).run();
  log.info({ address, providerType: args.providerType }, "wallet registered");

  await walletRegistered.emit({ wallet: row });
  return row;
}

// ── Reads ────────────────────────────────────────────────────────────
export async function listWallets(opts?: {
  network?: "testnet" | "mainnet";
  activeOnly?: boolean;
}): Promise<Wallet[]> {
  const db = getDb();
  const network = opts?.network ?? getSettings().NETWORK;
  const activeOnly = opts?.activeOnly ?? true;

  const rows = activeOnly
    ? await db
        .select()
        .from(wallets)
        .where(and(eq(wallets.network, network), eq(wallets.active, 1)))
        .all()
    : await db.select().from(wallets).where(eq(wallets.network, network)).all();

  return rows;
}

export async function getWallet(
  address: Address | string,
): Promise<Wallet | null> {
  const db = getDb();
  const a = address.toLowerCase();
  const rows = await db.select().from(wallets).where(eq(wallets.address, a)).all();
  return rows[0] ?? null;
}

export async function loadAccount(address: Address | string): Promise<Account> {
  const w = await getWallet(address);
  if (!w) throw new Error(`Wallet not registered: ${address}`);
  const provider = getProvider(w.providerType);
  return provider.loadAccount({
    address: w.address as Address,
    providerData: JSON.parse(w.providerData),
  });
}

// ── Deactivate ───────────────────────────────────────────────────────
export async function deactivateWallet(address: Address | string): Promise<void> {
  const db = getDb();
  const a = address.toLowerCase() as Address;
  await db
    .update(wallets)
    .set({ active: 0 })
    .where(eq(wallets.address, a))
    .run();
  log.info({ address: a }, "wallet deactivated");
  await walletDeactivated.emit({ address: a });
}

// ── Roles ────────────────────────────────────────────────────────────
export async function setRole(args: {
  address: Address | string;
  role: "sponsor" | "resolver" | "voter";
  enabled?: boolean;
  dailyBudgetUsd?: number;
}): Promise<void> {
  const db = getDb();
  const address = args.address.toLowerCase() as Address;
  const enabled = args.enabled === false ? 0 : 1;

  await db
    .insert(walletRoles)
    .values({
      address,
      role: args.role,
      enabled,
      dailyBudgetUsd: args.dailyBudgetUsd ?? null,
    })
    .onConflictDoUpdate({
      target: [walletRoles.address, walletRoles.role],
      set: { enabled, dailyBudgetUsd: args.dailyBudgetUsd ?? null },
    })
    .run();
}

export async function getRoles(
  address: Address | string,
): Promise<WalletRole[]> {
  const db = getDb();
  const a = address.toLowerCase();
  return db.select().from(walletRoles).where(eq(walletRoles.address, a)).all();
}

// ── Topic interests ──────────────────────────────────────────────────
export async function setTopicInterest(args: {
  address: Address | string;
  topicId: string;
  weight?: number;
}): Promise<void> {
  const db = getDb();
  const address = args.address.toLowerCase() as Address;
  const weight = args.weight ?? 1.0;
  await db
    .insert(walletTopics)
    .values({ address, topicId: args.topicId, weight })
    .onConflictDoUpdate({
      target: [walletTopics.address, walletTopics.topicId],
      set: { weight },
    })
    .run();
}

// ── Per-wallet settings ──────────────────────────────────────────────
export async function setWalletSetting(args: {
  address: Address | string;
  key: string;
  value: unknown;
}): Promise<void> {
  const db = getDb();
  const address = args.address.toLowerCase() as Address;
  await db
    .insert(walletSettings)
    .values({ address, key: args.key, valueJson: JSON.stringify(args.value) })
    .onConflictDoUpdate({
      target: [walletSettings.address, walletSettings.key],
      set: { valueJson: JSON.stringify(args.value) },
    })
    .run();
}

export async function getWalletSetting<T = unknown>(
  address: Address | string,
  key: string,
): Promise<T | undefined> {
  const db = getDb();
  const a = address.toLowerCase();
  const rows = await db
    .select()
    .from(walletSettings)
    .where(and(eq(walletSettings.address, a), eq(walletSettings.key, key)))
    .all();
  if (rows.length === 0) return undefined;
  return JSON.parse(rows[0].valueJson ?? "null") as T;
}
