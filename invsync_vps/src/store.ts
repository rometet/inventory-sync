import fs from "node:fs/promises";
import path from "node:path";
import { serverConfig } from "./config";
import type { IdentityType, InventoryAuditEvent, InventorySnapshot, SnapshotSource } from "./types";
import { isInventorySnapshot } from "./types";

const AUDIT_LOG_TIME_ZONE = "Asia/Tokyo";
const fileOperationLocks = new Map<string, Promise<unknown>>();

export interface ConsumableSnapshotResult {
  snapshot?: InventorySnapshot;
  consumed: boolean;
  consumedAt?: string;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return sanitized.length > 0 ? sanitized : "anonymous";
}

async function withFileLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileOperationLocks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const cleanup = run.catch(() => undefined);
  fileOperationLocks.set(key, cleanup);

  try {
    return await run;
  } finally {
    if (fileOperationLocks.get(key) === cleanup) {
      fileOperationLocks.delete(key);
    }
  }
}

function createTimestampFilePart(value: string): string {
  const safe = value.replace(/[:.]/g, "-");
  return sanitizePathSegment(safe);
}

function getSnapshotFilePath(namespace: string, identityType: IdentityType, playerKey: string): string {
  return path.join(
    serverConfig.dataDir,
    sanitizePathSegment(namespace),
    identityType,
    `${sanitizePathSegment(playerKey)}.json`,
  );
}

function getBackupDirectoryPath(namespace: string, identityType: IdentityType, playerKey: string): string {
  return path.join(
    serverConfig.dataDir,
    "_backups",
    sanitizePathSegment(namespace),
    identityType,
    sanitizePathSegment(playerKey),
  );
}

function getLatestBackupFilePath(namespace: string, identityType: IdentityType, playerKey: string): string {
  return path.join(getBackupDirectoryPath(namespace, identityType, playerKey), "latest.json");
}

function getBackupFilePaths(snapshot: InventorySnapshot): { latestFilePath: string; historyFilePath: string } {
  const backupDirectoryPath = getBackupDirectoryPath(snapshot.namespace, snapshot.identityType, snapshot.playerKey);
  const baseName = [
    createTimestampFilePart(snapshot.savedAt),
    sanitizePathSegment(snapshot.snapshotId ?? "snapshot"),
  ].join("-");

  return {
    latestFilePath: path.join(backupDirectoryPath, "latest.json"),
    historyFilePath: path.join(backupDirectoryPath, `${baseName}.json`),
  };
}

function getAuditFilePath(occurredAt: string): string {
  const datePart = occurredAt.slice(0, 10) || "unknown-date";
  return path.join(serverConfig.dataDir, "_audit", `${sanitizePathSegment(datePart)}.ndjson`);
}

function createLoadableSnapshot(snapshot: InventorySnapshot): InventorySnapshot {
  const loadableSnapshot = { ...snapshot };
  delete loadableSnapshot.loadConsumedAt;
  return loadableSnapshot;
}

async function loadSnapshotFromFile(filePath: string, label: string): Promise<InventorySnapshot | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isInventorySnapshot(parsed)) {
      throw new Error(`${label} at ${filePath} has an invalid shape.`);
    }

    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function consumeSnapshotFile(filePath: string, label: string): Promise<ConsumableSnapshotResult> {
  return withFileLock(filePath, async () => {
    const snapshot = await loadSnapshotFromFile(filePath, label);
    if (!snapshot) {
      return { consumed: false };
    }

    if (snapshot.loadConsumedAt) {
      return {
        snapshot,
        consumed: true,
        consumedAt: snapshot.loadConsumedAt,
      };
    }

    const consumedAt = new Date().toISOString();
    const consumedSnapshot = {
      ...snapshot,
      loadConsumedAt: consumedAt,
    };

    await fs.writeFile(filePath, JSON.stringify(consumedSnapshot, null, 2), "utf8");

    return {
      snapshot: consumedSnapshot,
      consumed: false,
      consumedAt,
    };
  });
}

function getJstDateTimeParts(value: string): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
} | undefined {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  const formatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone: AUDIT_LOG_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const lookup = new Map(parts.map((part) => [part.type, part.value]));

  return {
    year: lookup.get("year") ?? "0000",
    month: lookup.get("month") ?? "00",
    day: lookup.get("day") ?? "00",
    hour: lookup.get("hour") ?? "00",
    minute: lookup.get("minute") ?? "00",
    second: lookup.get("second") ?? "00",
  };
}

function formatTimestampForReadableLog(value: string | undefined): string {
  if (!value) {
    return "不明";
  }

  const parts = getJstDateTimeParts(value);
  if (!parts) {
    return value;
  }

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} JST`;
}

function getReadableAuditFilePath(occurredAt: string): string {
  const parts = getJstDateTimeParts(occurredAt);
  const datePart = parts ? `${parts.year}-${parts.month}-${parts.day}` : occurredAt.slice(0, 10) || "unknown-date";
  return path.join(serverConfig.dataDir, "_audit_readable", `${sanitizePathSegment(datePart)}.log`);
}

function formatSourceForReadableLog(source: SnapshotSource | undefined): string {
  if (!source) {
    return "不明";
  }

  return `${source.worldName} (serverId=${source.serverId}, worldId=${source.worldId})`;
}

function formatReadableAuditLine(event: InventoryAuditEvent): string {
  const occurredAt = formatTimestampForReadableLog(event.occurredAt);
  const player = event.playerKey;
  const executedSource = formatSourceForReadableLog(event.executedSource ?? event.source);
  const restoredSource = formatSourceForReadableLog(event.source);
  const snapshotSavedAt = formatTimestampForReadableLog(event.snapshotSavedAt);

  switch (event.action) {
    case "save":
      return `${occurredAt} | SAVE | player=${player} | ワールド=${executedSource}`;
    case "backup_before_load":
      return `${occurredAt} | LOAD前バックアップ | player=${player} | ワールド=${executedSource}`;
    case "load":
      return `${occurredAt} | LOAD | player=${player} | 実行ワールド=${executedSource} | 読み込み元=${restoredSource} | 読み込んだ保存日時=${snapshotSavedAt}`;
    case "load_backup":
      return `${occurredAt} | LOADBACKUP | player=${player} | 実行ワールド=${executedSource} | 復元元バックアップ=${restoredSource} | バックアップ保存日時=${snapshotSavedAt}`;
    default:
      return `${occurredAt} | ${event.action} | player=${player}`;
  }
}

export async function saveInventorySnapshot(snapshot: InventorySnapshot): Promise<void> {
  const filePath = getSnapshotFilePath(snapshot.namespace, snapshot.identityType, snapshot.playerKey);
  await withFileLock(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(createLoadableSnapshot(snapshot), null, 2), "utf8");
  });
}

export async function saveBackupSnapshot(snapshot: InventorySnapshot): Promise<void> {
  const { latestFilePath, historyFilePath } = getBackupFilePaths(snapshot);
  await withFileLock(latestFilePath, async () => {
    await fs.mkdir(path.dirname(historyFilePath), { recursive: true });

    const payload = JSON.stringify(createLoadableSnapshot(snapshot), null, 2);
    await Promise.all([
      fs.writeFile(historyFilePath, payload, "utf8"),
      fs.writeFile(latestFilePath, payload, "utf8"),
    ]);
  });
}

export async function appendInventoryAuditEvent(event: InventoryAuditEvent): Promise<void> {
  const ndjsonFilePath = getAuditFilePath(event.occurredAt);
  const readableFilePath = getReadableAuditFilePath(event.occurredAt);
  const readableLine = formatReadableAuditLine(event);

  await Promise.all([
    fs.mkdir(path.dirname(ndjsonFilePath), { recursive: true }),
    fs.mkdir(path.dirname(readableFilePath), { recursive: true }),
  ]);

  await Promise.all([
    fs.appendFile(ndjsonFilePath, `${JSON.stringify(event)}\n`, "utf8"),
    fs.appendFile(readableFilePath, `${readableLine}\n`, "utf8"),
  ]);
}

export async function loadInventorySnapshot(
  namespace: string,
  identityType: IdentityType,
  playerKey: string,
): Promise<InventorySnapshot | undefined> {
  const filePath = getSnapshotFilePath(namespace, identityType, playerKey);

  return loadSnapshotFromFile(filePath, "Snapshot");
}

export async function consumeInventorySnapshot(
  namespace: string,
  identityType: IdentityType,
  playerKey: string,
): Promise<ConsumableSnapshotResult> {
  return consumeSnapshotFile(getSnapshotFilePath(namespace, identityType, playerKey), "Snapshot");
}

export async function loadLatestBackupSnapshot(
  namespace: string,
  identityType: IdentityType,
  playerKey: string,
): Promise<InventorySnapshot | undefined> {
  const filePath = getLatestBackupFilePath(namespace, identityType, playerKey);

  return loadSnapshotFromFile(filePath, "Backup snapshot");
}

export async function consumeLatestBackupSnapshot(
  namespace: string,
  identityType: IdentityType,
  playerKey: string,
): Promise<ConsumableSnapshotResult> {
  return consumeSnapshotFile(getLatestBackupFilePath(namespace, identityType, playerKey), "Backup snapshot");
}
