import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "basic-ftp";
import { LevelDB } from "@8crafter/leveldb-zlib";
import type { FtpWorldDbSourceConfig, SshWorldDbSourceConfig, WorldDbSourceConfig } from "./config";
import {
  getCompoundValue,
  getListValue,
  getNumberValue,
  getStringValue,
  getTag,
  parseLittleEndianNbt,
  setTag,
  TAG,
  type NbtCompound,
  type NbtList,
  type NbtTag,
  type TagType,
  type NbtValue,
  writeLittleEndianNbt,
} from "./bedrockNbt";
import type {
  DbInventorySnapshot,
  IdentityType,
  InventoryDbSaveRequest,
  InventoryOutline,
  InventoryOuterItem,
  InventorySnapshot,
  RawNbtListSnapshot,
  RawNbtNamedTagSnapshot,
  SnapshotSource,
} from "./types";

const PLAYER_LIST_PREFIX = "db:player_list:";
const PLAYER_KEY_PREFIX = "player_server_";
const TEMP_DB_PREFIX = "invsync-world-db-";
const TEMP_DB_STALE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_INVENTORY_SIZE = 36;
const execFileAsync = promisify(execFile);
const EXPERIENCE_TAG_NAMES = [
  "PlayerLevel",
  "PlayerLevelProgress",
  "XpLevel",
  "XpP",
  "XpTotal",
  "XpSeed",
];

type LevelDbHandle = InstanceType<typeof LevelDB>;

export class InventoryDbError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
    this.name = "InventoryDbError";
  }
}

function normalizeTypeId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.includes(":") ? trimmed : `minecraft:${trimmed}`;
}

function normalizePlayerName(value: string): string {
  return value.trim().toLowerCase();
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(value.trim());
}

function getScalarStringValue(compound: NbtCompound, name: string): string {
  const tag = compound.get(name);
  if (!tag) {
    return "";
  }

  if (typeof tag.value === "string" || typeof tag.value === "number" || typeof tag.value === "bigint") {
    return String(tag.value);
  }

  return "";
}

function getPlayerListMap(dynamicPropertiesRoot: NbtCompound, headerUuid: string): Map<string, string> {
  const addonProperties = getCompoundValue(dynamicPropertiesRoot, headerUuid);
  if (!addonProperties) {
    return new Map();
  }

  const chunks: Array<[number, string]> = [];
  for (const [key, tag] of addonProperties.entries()) {
    if (!key.startsWith(PLAYER_LIST_PREFIX) || tag.type !== TAG.String) {
      continue;
    }

    const index = Number.parseInt(key.slice(PLAYER_LIST_PREFIX.length), 10);
    if (Number.isFinite(index)) {
      chunks.push([index, String(tag.value)]);
    }
  }

  chunks.sort((left, right) => left[0] - right[0]);
  const serialized = chunks.map(([, value]) => value).join("");
  if (!serialized) {
    return new Map();
  }

  const decoded = JSON.parse(serialized) as unknown;
  if (!Array.isArray(decoded)) {
    return new Map();
  }

  const entries: Array<[string, string]> = decoded
    .filter((entry): entry is [unknown, unknown] => Array.isArray(entry) && entry.length >= 2)
    .map(([playerId, playerName]): [string, string] => [
      normalizePlayerName(String(playerName ?? "")),
      String(playerId ?? "").trim(),
    ])
    .filter(([playerName, playerId]) => playerName.length > 0 && playerId.length > 0);

  return new Map(
    entries,
  );
}

async function cleanupTempDbCopies(): Promise<void> {
  const tempRoot = path.resolve(tmpdir());
  let entries = [];
  try {
    entries = await readdir(tempRoot, { withFileTypes: true });
  } catch {
    return;
  }

  const now = Date.now();
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(TEMP_DB_PREFIX))
      .map(async (entry) => {
        const fullPath = path.resolve(tempRoot, entry.name);
        if (!fullPath.startsWith(tempRoot + path.sep)) {
          return;
        }

        try {
          const info = await stat(fullPath);
          if (now - info.mtimeMs > TEMP_DB_STALE_MS) {
            await rm(fullPath, { recursive: true, force: true });
          }
        } catch {
          // Temporary cleanup should never block inventory operations.
        }
      }),
  );
}

function normalizeRemotePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").trim();
  if (!normalized) {
    return "/";
  }

  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function joinRemotePath(basePath: string, entryName: string): string {
  return `${basePath.replace(/\/+$/, "")}/${entryName}`;
}

function getFtpErrorMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error ?? "");
}

function getCommandErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const details = error as { message?: unknown; stderr?: unknown; stdout?: unknown };
    const stderr = String(details.stderr ?? "").trim();
    if (stderr) {
      return stderr;
    }

    const stdout = String(details.stdout ?? "").trim();
    if (stdout) {
      return stdout;
    }

    if (details.message) {
      return String(details.message);
    }
  }

  return String(error instanceof Error ? error.message : error ?? "");
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function createSshCommand(source: SshWorldDbSourceConfig): string {
  return [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-p",
    String(source.ssh.port),
    "-i",
    shellSingleQuote(source.ssh.keyPath),
  ].join(" ");
}

function createSshRemoteSpec(source: SshWorldDbSourceConfig): string {
  return `${source.ssh.user}@${source.ssh.host}:${normalizeRemotePath(source.dbPath).replace(/\/+$/, "") + "/"}`;
}

async function runRsync(args: string[], label: string): Promise<void> {
  try {
    await execFileAsync("rsync", args, {
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === 24) {
      // BDS can rotate LevelDB log/table files while a live snapshot is being copied.
      return;
    }

    throw new InventoryDbError(`${label}: ${getCommandErrorMessage(error)}`, 502);
  }
}

async function withFtpClient<T>(
  source: FtpWorldDbSourceConfig,
  callback: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(20_000);
  try {
    await client.access({
      host: source.ftp.host,
      port: source.ftp.port,
      user: source.ftp.user,
      password: source.ftp.password,
      secure: source.ftp.secure,
    });
    return await callback(client);
  } catch (error) {
    const message = getFtpErrorMessage(error);
    throw new InventoryDbError(`FTP world db source "${source.serverId}" could not be accessed: ${message}`, 502);
  } finally {
    client.close();
  }
}

async function downloadRemoteDbDirectory(
  client: Client,
  remoteDirPath: string,
  localDirPath: string,
): Promise<void> {
  await mkdir(localDirPath, { recursive: true });
  const entries = await client.list(remoteDirPath);
  for (const entry of entries) {
    const remoteEntryPath = joinRemotePath(remoteDirPath, entry.name);
    const localEntryPath = path.join(localDirPath, entry.name);

    if (entry.isDirectory) {
      await downloadRemoteDbDirectory(client, remoteEntryPath, localEntryPath);
      continue;
    }

    if (entry.isFile) {
      await client.downloadTo(localEntryPath, remoteEntryPath);
    }
  }
}

async function uploadLocalDbDirectory(
  client: Client,
  localDirPath: string,
  remoteDirPath: string,
): Promise<void> {
  await client.ensureDir(remoteDirPath);
  const entries = await readdir(localDirPath, { withFileTypes: true });
  for (const entry of entries) {
    const localEntryPath = path.join(localDirPath, entry.name);
    const remoteEntryPath = joinRemotePath(remoteDirPath, entry.name);

    if (entry.isDirectory()) {
      await uploadLocalDbDirectory(client, localEntryPath, remoteEntryPath);
      continue;
    }

    if (entry.isFile()) {
      await client.uploadFrom(localEntryPath, remoteEntryPath);
    }
  }
}

async function copySourceDbToTemp(source: WorldDbSourceConfig, tempDbPath: string): Promise<void> {
  await mkdir(path.dirname(tempDbPath), { recursive: true });
  if (source.kind === "ftp") {
    const remoteDbPath = normalizeRemotePath(source.dbPath);
    await withFtpClient(source, async (client) => {
      try {
        await downloadRemoteDbDirectory(client, remoteDbPath, tempDbPath);
      } catch (error) {
        const message = getFtpErrorMessage(error);
        const status = /550|not found|no such file/i.test(message) ? 404 : 502;
        throw new InventoryDbError(`FTP world db path "${remoteDbPath}" could not be copied: ${message}`, status);
      }
    });
    return;
  }

  if (source.kind === "ssh") {
    await mkdir(tempDbPath, { recursive: true });
    const args = [
      "-a",
      "-s",
      "--delete",
      "-e",
      createSshCommand(source),
      createSshRemoteSpec(source),
      `${tempDbPath.replace(/[\\/]+$/, "")}/`,
    ];
    await runRsync(args, `SSH world db path "${source.dbPath}" could not be copied`);
    await runRsync(args, `SSH world db path "${source.dbPath}" could not be copied on retry`);
    return;
  }

  await cp(path.resolve(source.dbPath), tempDbPath, {
    recursive: true,
    force: true,
    errorOnExist: false,
  });
}

function isRepairableLevelDbError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error ?? "");
  return /corruption|missing files|sst file|manifest/i.test(message);
}

async function openDb(dbPath: string): Promise<LevelDbHandle> {
  let db = new LevelDB(dbPath, { createIfMissing: false });
  try {
    await db.open();
    return db;
  } catch (error) {
    await db.close().catch(() => {});
    if (!isRepairableLevelDbError(error)) {
      throw error;
    }

    await LevelDB.repair(dbPath);
    db = new LevelDB(dbPath, { createIfMissing: false });
    await db.open();
    return db;
  }
}

async function withCopiedDb<T>(source: WorldDbSourceConfig, callback: (db: LevelDbHandle) => Promise<T>): Promise<T> {
  await cleanupTempDbCopies();
  const tempRoot = await mkdtemp(path.join(tmpdir(), TEMP_DB_PREFIX));
  const tempDbPath = path.join(tempRoot, "db");
  let db: LevelDbHandle | undefined;

  try {
    await copySourceDbToTemp(source, tempDbPath);
    db = await openDb(tempDbPath);
    return await callback(db);
  } finally {
    if (db?.isOpen()) {
      await db.close().catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function syncTempDbBackToSource(source: FtpWorldDbSourceConfig, tempDbPath: string): Promise<void> {
  const remoteDbPath = normalizeRemotePath(source.dbPath);
  await withFtpClient(source, async (client) => {
    try {
      await client.removeDir(remoteDbPath).catch(() => {});
      await uploadLocalDbDirectory(client, tempDbPath, remoteDbPath);
    } catch (error) {
      const message = getFtpErrorMessage(error);
      throw new InventoryDbError(`Updated FTP world db "${remoteDbPath}" could not be uploaded: ${message}`, 502);
    }
  });
}

async function syncTempDbBackToSshSource(source: SshWorldDbSourceConfig, tempDbPath: string): Promise<void> {
  await runRsync(
    [
      "-a",
      "-s",
      "--delete",
      "-e",
      createSshCommand(source),
      `${tempDbPath.replace(/[\\/]+$/, "")}/`,
      createSshRemoteSpec(source),
    ],
    `Updated SSH world db "${source.dbPath}" could not be uploaded`,
  );
}

async function withWritableCopiedDb<T>(
  source: FtpWorldDbSourceConfig | SshWorldDbSourceConfig,
  callback: (db: LevelDbHandle) => Promise<T>,
): Promise<T> {
  await cleanupTempDbCopies();
  const tempRoot = await mkdtemp(path.join(tmpdir(), TEMP_DB_PREFIX));
  const tempDbPath = path.join(tempRoot, "db");
  let db: LevelDbHandle | undefined;

  try {
    await copySourceDbToTemp(source, tempDbPath);
    db = await openDb(tempDbPath);
    const result = await callback(db);
    await db.close().catch(() => {});
    db = undefined;
    if (source.kind === "ftp") {
      await syncTempDbBackToSource(source, tempDbPath);
    } else {
      await syncTempDbBackToSshSource(source, tempDbPath);
    }
    return result;
  } finally {
    if (db?.isOpen()) {
      await db.close().catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function withDirectDb<T>(source: WorldDbSourceConfig, callback: (db: LevelDbHandle) => Promise<T>): Promise<T> {
  if (source.kind === "ftp" || source.kind === "ssh") {
    return withWritableCopiedDb(source, callback);
  }

  const db = await openDb(path.resolve(source.dbPath));
  try {
    return await callback(db);
  } finally {
    if (db.isOpen()) {
      await db.close().catch(() => {});
    }
  }
}

async function resolvePlayerIdentifier(
  db: LevelDbHandle,
  source: WorldDbSourceConfig,
  identityType: IdentityType,
  playerKey: string,
): Promise<string> {
  const normalizedKey = playerKey.trim();
  if (!normalizedKey) {
    return "";
  }

  if (identityType === "xuid" || isUuidLike(normalizedKey)) {
    return normalizedKey;
  }

  const dynamicPropertiesBuffer = await db.get("DynamicProperties");
  if (!dynamicPropertiesBuffer) {
    throw new InventoryDbError("world db did not contain DynamicProperties.", 409);
  }

  const dynamicProperties = parseLittleEndianNbt(dynamicPropertiesBuffer);
  const playerNameMap = getPlayerListMap(dynamicProperties.root, source.headerUuid);
  return playerNameMap.get(normalizePlayerName(normalizedKey)) ?? "";
}

async function findPlayerRecord(
  db: LevelDbHandle,
  playerIdentifier: string,
): Promise<{ key: string; value: Buffer } | undefined> {
  if (!playerIdentifier) {
    return undefined;
  }

  if (isUuidLike(playerIdentifier)) {
    const directKey = PLAYER_KEY_PREFIX + playerIdentifier;
    const direct = await db.get(directKey);
    if (direct) {
      return { key: directKey, value: direct };
    }
  }

  const iterator = db.getIterator({ keyAsBuffer: false, valueAsBuffer: true, gte: PLAYER_KEY_PREFIX, lt: `${PLAYER_KEY_PREFIX}~` });
  try {
    while (true) {
      const next = await iterator.next();
      if (!next) {
        return undefined;
      }

      const [value, key] = next as [Buffer, string];
      if (!String(key).startsWith(PLAYER_KEY_PREFIX)) {
        continue;
      }

      if (String(key) === PLAYER_KEY_PREFIX + playerIdentifier) {
        return { key: String(key), value };
      }

      const playerData = parseLittleEndianNbt(value);
      if (getScalarStringValue(playerData.root, "UniqueID") === playerIdentifier) {
        return { key: String(key), value };
      }
    }
  } finally {
    await iterator.end().catch(() => {});
  }
}

function encodeCompoundEntry(value: NbtValue): string {
  if (!(value instanceof Map)) {
    throw new InventoryDbError("Inventory list contained a non-compound entry.", 409);
  }

  return writeLittleEndianNbt({ rootName: "", root: value }).toString("base64");
}

function encodeList(list: NbtList | undefined): RawNbtListSnapshot {
  const safeList = list ?? { elementType: TAG.Compound, values: [] };
  return {
    elementType: safeList.elementType,
    entriesBase64: safeList.values.map((value) => encodeCompoundEntry(value)),
  };
}

function decodeList(snapshot: RawNbtListSnapshot): NbtList {
  return {
    elementType: snapshot.elementType as TagType,
    values: snapshot.entriesBase64.map((entry) => parseLittleEndianNbt(Buffer.from(entry, "base64")).root),
  };
}

function encodeNamedTag(root: NbtCompound, name: string): RawNbtNamedTagSnapshot | undefined {
  const tag = getTag(root, name);
  if (!tag) {
    return undefined;
  }

  return {
    name,
    tagBase64: writeLittleEndianNbt({ rootName: "", root: new Map([[name, tag]]) }).toString("base64"),
  };
}

function encodeExperienceTags(root: NbtCompound): RawNbtNamedTagSnapshot[] {
  return EXPERIENCE_TAG_NAMES
    .map((name) => encodeNamedTag(root, name))
    .filter((entry): entry is RawNbtNamedTagSnapshot => Boolean(entry));
}

function decodeNamedTag(snapshot: RawNbtNamedTagSnapshot): NbtTag {
  const parsed = parseLittleEndianNbt(Buffer.from(snapshot.tagBase64, "base64"));
  const tag = getTag(parsed.root, snapshot.name) ?? parsed.root.values().next().value;
  if (!tag) {
    throw new InventoryDbError(`Raw DB experience tag "${snapshot.name}" could not be decoded.`, 409);
  }

  return tag;
}

function extractCustomName(itemCompound: NbtCompound): string | undefined {
  const itemTag = getCompoundValue(itemCompound, "tag");
  if (!itemTag) {
    return undefined;
  }

  const displayTag = getCompoundValue(itemTag, "display");
  const displayName = displayTag ? getStringValue(displayTag, "Name") : "";
  return displayName || getStringValue(itemTag, "Name") || undefined;
}

function toSerializedItem(itemCompound: NbtCompound, slot: number): InventorySnapshot["inventory"]["main"][number] {
  const typeId = getStringValue(itemCompound, "Name");
  const amount = getNumberValue(itemCompound, "Count", 0);
  if (!typeId || amount <= 0) {
    return null;
  }

  const damage = getNumberValue(itemCompound, "Damage", 0);
  const nameTag = extractCustomName(itemCompound);
  return {
    slot,
    typeId: normalizeTypeId(typeId),
    amount,
    ...(nameTag ? { nameTag } : {}),
    ...(damage > 0 ? { durability: { damage } } : {}),
  };
}

function extractMainInventory(list: NbtList | undefined): InventorySnapshot["inventory"]["main"] {
  const values = list?.values ?? [];
  const maxSlot = values.reduce<number>((max, value, index) => {
    if (!(value instanceof Map)) {
      return max;
    }
    return Math.max(max, getNumberValue(value as NbtCompound, "Slot", index));
  }, DEFAULT_INVENTORY_SIZE - 1);

  const main: InventorySnapshot["inventory"]["main"] = Array.from({ length: Math.max(DEFAULT_INVENTORY_SIZE, maxSlot + 1) }, () => null);
  values.forEach((value, index) => {
    if (!(value instanceof Map)) {
      return;
    }

    const slot = getNumberValue(value, "Slot", index);
    if (slot < 0 || slot >= main.length) {
      return;
    }

    main[slot] = toSerializedItem(value, slot);
  });

  return main;
}

function extractOutlineEntry(value: NbtValue, fallbackSlot: number | string): InventoryOuterItem | undefined {
  if (!(value instanceof Map)) {
    return undefined;
  }

  const typeId = getStringValue(value, "Name");
  const amount = getNumberValue(value, "Count", 0);
  if (!typeId || amount <= 0) {
    return undefined;
  }

  return {
    slot: getNumberValue(value, "Slot", typeof fallbackSlot === "number" ? fallbackSlot : 0) || fallbackSlot,
    typeId: normalizeTypeId(typeId),
    amount,
  };
}

function extractOutline(root: NbtCompound): InventoryOutline {
  const inventory = getListValue(root, "Inventory")?.values ?? [];
  const armor = getListValue(root, "Armor")?.values ?? [];
  const offhand = getListValue(root, "Offhand")?.values ?? [];

  return {
    main: inventory
      .map((value, index) => extractOutlineEntry(value, index))
      .filter((entry): entry is InventoryOuterItem => Boolean(entry)),
    equipment: [
      ...armor
        .map((value, index) => extractOutlineEntry(value, `armor:${index}`))
        .filter((entry): entry is InventoryOuterItem => Boolean(entry)),
      ...offhand
        .map((value, index) => extractOutlineEntry(value, `offhand:${index}`))
        .filter((entry): entry is InventoryOuterItem => Boolean(entry)),
    ],
  };
}

function createDbInventorySnapshot(playerRecordKey: string, root: NbtCompound): DbInventorySnapshot {
  return {
    schemaVersion: 1,
    playerRecordKey,
    playerUniqueId: getScalarStringValue(root, "UniqueID") || undefined,
    selectedInventorySlot: getNumberValue(root, "SelectedInventorySlot", 0),
    inventory: encodeList(getListValue(root, "Inventory")),
    armor: encodeList(getListValue(root, "Armor")),
    offhand: encodeList(getListValue(root, "Offhand")),
    experience: encodeExperienceTags(root),
    outline: extractOutline(root),
  };
}

function createSnapshotFromDb(
  request: InventoryDbSaveRequest,
  playerRecordKey: string,
  root: NbtCompound,
  savedAt: string,
): InventorySnapshot {
  const db = createDbInventorySnapshot(playerRecordKey, root);

  return {
    schemaVersion: request.schemaVersion,
    namespace: request.namespace,
    identityType: request.identityType,
    playerKey: request.playerKey,
    snapshotId: `${request.identityType}-${Date.now()}-${randomUUID()}`,
    savedAt,
    source: request.source,
    db,
    inventory: {
      selectedSlotIndex: db.selectedInventorySlot,
      main: extractMainInventory(getListValue(root, "Inventory")),
      equipment: {
        head: null,
        chest: null,
        legs: null,
        feet: null,
        offhand: null,
      },
    },
  };
}

function canonicalMainOutline(outline: InventoryOutline): string[] {
  return outline.main
    .map((entry) => `${entry.slot}:${normalizeTypeId(entry.typeId)}:${entry.amount}`)
    .sort();
}

function assertExpectedInventoryMatches(expected: InventoryOutline | undefined, actual: InventoryOutline): void {
  if (!expected) {
    return;
  }

  const expectedMain = canonicalMainOutline(expected);
  const actualMain = canonicalMainOutline(actual);
  if (
    expectedMain.length !== actualMain.length ||
    expectedMain.some((entry, index) => entry !== actualMain[index])
  ) {
    throw new InventoryDbError("DB inventory did not match the live player inventory. Save was aborted before clear.", 409);
  }
}

async function readPlayerSnapshotFromDb(
  db: LevelDbHandle,
  source: WorldDbSourceConfig,
  request: InventoryDbSaveRequest,
): Promise<InventorySnapshot> {
  const playerIdentifier = await resolvePlayerIdentifier(db, source, request.identityType, request.playerKey);
  const record = await findPlayerRecord(db, playerIdentifier);
  if (!record) {
    throw new InventoryDbError("Player data was not found in the world db.", 404);
  }

  const playerData = parseLittleEndianNbt(record.value);
  const savedAt = request.savedAt ?? new Date().toISOString();
  const snapshot = createSnapshotFromDb(request, record.key, playerData.root, savedAt);
  assertExpectedInventoryMatches(request.expectedInventory, snapshot.db!.outline);
  return snapshot;
}

export async function createInventorySnapshotFromCopiedDb(
  source: WorldDbSourceConfig,
  request: InventoryDbSaveRequest,
): Promise<InventorySnapshot> {
  return withCopiedDb(source, (db) => readPlayerSnapshotFromDb(db, source, request));
}

export async function readCurrentPlayerSnapshotFromDirectDb(
  source: WorldDbSourceConfig,
  namespace: string,
  identityType: IdentityType,
  playerKey: string,
  snapshotSource: SnapshotSource,
): Promise<InventorySnapshot> {
  const request: InventoryDbSaveRequest = {
    schemaVersion: 1,
    namespace,
    identityType,
    playerKey,
    source: snapshotSource,
  };
  return withCopiedDb(source, (db) => readPlayerSnapshotFromDb(db, source, request));
}

function restoreRawInventory(root: NbtCompound, dbSnapshot: DbInventorySnapshot): void {
  setTag(root, "Inventory", TAG.List, decodeList(dbSnapshot.inventory));
  setTag(root, "Armor", TAG.List, decodeList(dbSnapshot.armor));
  setTag(root, "Offhand", TAG.List, decodeList(dbSnapshot.offhand));

  if (typeof dbSnapshot.selectedInventorySlot === "number") {
    setTag(root, "SelectedInventorySlot", TAG.Int, dbSnapshot.selectedInventorySlot);
  }

  for (const entry of dbSnapshot.experience ?? []) {
    const tag = decodeNamedTag(entry);
    setTag(root, entry.name, tag.type, tag.value);
  }
}

export async function applyDbInventorySnapshot(
  source: WorldDbSourceConfig,
  snapshot: InventorySnapshot,
  target?: {
    identityType: IdentityType;
    playerKey: string;
  },
): Promise<void> {
  if (!snapshot.db) {
    throw new InventoryDbError("Snapshot does not contain raw DB inventory data.", 409);
  }

  await withDirectDb(source, async (db) => {
    let record: { key: string; value: Buffer } | undefined;
    if (target) {
      const playerIdentifier = await resolvePlayerIdentifier(db, source, target.identityType, target.playerKey);
      record = await findPlayerRecord(db, playerIdentifier);
    } else {
      const currentBuffer = await db.get(snapshot.db!.playerRecordKey);
      if (currentBuffer) {
        record = { key: snapshot.db!.playerRecordKey, value: currentBuffer };
      }
    }

    if (!record) {
      throw new InventoryDbError("Target player record was not found in the world db.", 404);
    }

    const playerData = parseLittleEndianNbt(record.value);
    restoreRawInventory(playerData.root, snapshot.db!);
    await db.put(record.key, writeLittleEndianNbt(playerData));
  });
}
