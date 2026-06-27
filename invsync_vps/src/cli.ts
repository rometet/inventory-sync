import { serverConfig } from "./config";
import { applyDbInventorySnapshot, readCurrentPlayerSnapshotFromDirectDb } from "./dbInventory";
import {
  appendInventoryAuditEvent,
  completePendingRestore,
  listInventorySnapshots,
  listPendingRestores,
  saveBackupSnapshot,
} from "./store";
import type { InventoryAuditEvent, InventorySnapshot, PendingRestoreRequest, SnapshotSource } from "./types";

function normalizeServerId(value: string): string {
  return value.trim().toLowerCase();
}

function getArgValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function getIntegerArg(args: string[], name: string, fallback: number): number {
  const raw = getArgValue(args, name);
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatDateTime(value: string | undefined): string {
  if (!value) {
    return "unknown";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date).replaceAll("/", "-") + " JST";
}

function formatSource(source: SnapshotSource | undefined): string {
  if (!source) {
    return "unknown";
  }

  return `${source.worldName} (serverId=${source.serverId}, worldId=${source.worldId})`;
}

function compareBySavedAtDesc(left: InventorySnapshot, right: InventorySnapshot): number {
  return new Date(right.savedAt).getTime() - new Date(left.savedAt).getTime();
}

function comparePendingByCreatedAtDesc(left: PendingRestoreRequest, right: PendingRestoreRequest): number {
  return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
}

function createAuditEvent(pending: PendingRestoreRequest, appliedAt: string): InventoryAuditEvent {
  return {
    action: pending.restoreSource === "backup" ? "load_backup" : "load",
    occurredAt: appliedAt,
    namespace: pending.namespace,
    identityType: pending.identityType,
    playerKey: pending.playerKey,
    snapshotId: pending.snapshot.snapshotId,
    snapshotSavedAt: pending.snapshot.savedAt,
    source: pending.snapshot.source,
    executedSource: pending.executedSource,
  };
}

async function savePreApplyBackup(pending: PendingRestoreRequest, appliedAt: string): Promise<void> {
  const source = serverConfig.worldDbSources[normalizeServerId(pending.executedSource.serverId)];
  if (!source) {
    throw new Error(`No world db source is configured for serverId "${pending.executedSource.serverId}".`);
  }

  const backup = await readCurrentPlayerSnapshotFromDirectDb(
    source,
    pending.namespace,
    pending.identityType,
    pending.playerKey,
    pending.executedSource,
  );
  backup.snapshotId = `pre-apply-${pending.pendingId}`;
  backup.savedAt = appliedAt;
  await saveBackupSnapshot(backup);
  await appendInventoryAuditEvent({
    action: "backup_before_load",
    occurredAt: appliedAt,
    namespace: pending.namespace,
    identityType: pending.identityType,
    playerKey: pending.playerKey,
    snapshotId: backup.snapshotId,
    snapshotSavedAt: backup.savedAt,
    source: backup.source,
    executedSource: pending.executedSource,
  });
}

async function applyPendingRestore(pending: PendingRestoreRequest): Promise<void> {
  const source = serverConfig.worldDbSources[normalizeServerId(pending.executedSource.serverId)];
  if (!source) {
    throw new Error(`No world db source is configured for serverId "${pending.executedSource.serverId}".`);
  }

  const appliedAt = new Date().toISOString();
  await savePreApplyBackup(pending, appliedAt);
  await applyDbInventorySnapshot(source, pending.snapshot, {
    identityType: pending.identityType,
    playerKey: pending.playerKey,
  });
  await completePendingRestore(pending, appliedAt);
  await appendInventoryAuditEvent(createAuditEvent(pending, appliedAt));
}

async function applyPending(args: string[]): Promise<void> {
  const serverId = normalizeServerId(getArgValue(args, "--server-id") ?? "");
  if (!serverId) {
    throw new Error("Usage: node dist/cli.js apply-pending --server-id <serverId>");
  }

  if (!serverConfig.worldDbSources[serverId]) {
    throw new Error(`No world db source is configured for serverId "${serverId}".`);
  }

  const pending = await listPendingRestores(serverId);
  if (pending.length === 0) {
    console.info(`[InvSync CLI] No pending restores for serverId=${serverId}.`);
    return;
  }

  for (const entry of pending) {
    console.info(
      `[InvSync CLI] Applying pending restore ${entry.pendingId} for ${entry.playerKey} (${entry.restoreSource}).`,
    );
    await applyPendingRestore(entry);
    console.info(`[InvSync CLI] Applied pending restore ${entry.pendingId}.`);
  }
}

async function showStatus(args: string[]): Promise<void> {
  const limit = getIntegerArg(args, "--limit", 8);
  const pendingLimit = getIntegerArg(args, "--pending-limit", 8);
  const serverId = getArgValue(args, "--server-id");
  const allSnapshots = (await listInventorySnapshots("invsync"))
    .filter((snapshot) => !serverId || normalizeServerId(snapshot.source.serverId) === normalizeServerId(serverId))
    .sort(compareBySavedAtDesc);
  const snapshots = allSnapshots.slice(0, limit);
  const allPending = (await listPendingRestores(serverId ? normalizeServerId(serverId) : undefined))
    .sort(comparePendingByCreatedAtDesc);
  const pending = allPending.slice(0, pendingLimit);

  console.info("[InvSync Status]");
  console.info(`保存データ: ${snapshots.length}/${allSnapshots.length}件表示 / 復元予約: ${pending.length}/${allPending.length}件表示`);

  if (snapshots.length === 0) {
    console.info("- 保存データ: なし");
  } else {
    console.info("- 直近の保存データ:");
    for (const snapshot of snapshots) {
      const state = snapshot.loadConsumedAt
        ? `適用済み ${formatDateTime(snapshot.loadConsumedAt)}`
        : snapshot.restorePendingId
          ? `予約中 ${snapshot.restorePendingId}`
          : "未使用";
      console.info(
        `  - 保存者/対象: ${snapshot.playerKey} | 保存日時: ${formatDateTime(snapshot.savedAt)} | 保存元: ${formatSource(snapshot.source)} | 状態: ${state}`,
      );
    }
  }

  if (pending.length === 0) {
    console.info("- 復元予約: なし");
    return;
  }

  console.info("- 復元予約:");
  for (const entry of pending) {
    console.info(
      `  - pendingId: ${entry.pendingId} | 対象: ${entry.playerKey} | 作成者: ${entry.requestedBy} | 作成日時: ${formatDateTime(entry.createdAt)} | 予約先: ${formatSource(entry.executedSource)} | 復元元: ${formatSource(entry.snapshot.source)} | 種別: ${entry.restoreSource}`,
    );
  }
  if (allPending.length > pending.length) {
    console.info(`  - 他 ${allPending.length - pending.length} 件の復元予約があります。`);
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "apply-pending":
      await applyPending(args);
      return;
    case "status":
      await showStatus(args);
      return;
    default:
      throw new Error("Usage: node dist/cli.js <apply-pending|status> [--server-id <serverId>]");
  }
}

void main().catch((error) => {
  console.error("[InvSync CLI] Failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
