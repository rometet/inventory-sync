export type IdentityType = "xuid" | "name";
export type DynamicPropertyScalar = boolean | number | string;
export type InventoryEquipmentSlotKey = "head" | "chest" | "legs" | "feet" | "offhand";
export type InventoryAuditAction = "save" | "load" | "load_backup" | "backup_before_load";
export type InventoryAuditRecordAction = Extract<InventoryAuditAction, "load" | "load_backup">;
export type RestoreSourceKind = "snapshot" | "backup";

export interface SnapshotSource {
  serverId: string;
  worldId: string;
  worldName: string;
}

export interface SerializedItemStorage {
  size?: number;
  items: Array<SerializedItem | null>;
}

export interface PortableStorageExclusion {
  typeId: string;
  reason: "portable_storage_unsupported";
}

export interface SerializedItem {
  slot?: number;
  typeId: string;
  amount: number;
  nameTag?: string;
  lore?: string[];
  keepOnDeath?: boolean;
  lockMode?: string;
  canDestroy?: string[];
  canPlaceOn?: string[];
  dynamicProperties?: Record<string, DynamicPropertyScalar>;
  durability?: {
    damage?: number;
    unbreakable?: boolean;
  };
  enchantments?: Array<{
    type: string;
    level: number;
  }>;
  storage?: SerializedItemStorage;
}

export interface InventoryOuterItem {
  slot: number | string;
  typeId: string;
  amount: number;
}

export interface InventoryOutline {
  main: InventoryOuterItem[];
  equipment: InventoryOuterItem[];
}

export interface RawNbtListSnapshot {
  elementType: number;
  entriesBase64: string[];
}

export interface RawNbtNamedTagSnapshot {
  name: string;
  tagBase64: string;
}

export interface DbInventorySnapshot {
  schemaVersion: 1;
  playerRecordKey: string;
  playerUniqueId?: string;
  selectedInventorySlot?: number;
  inventory: RawNbtListSnapshot;
  armor: RawNbtListSnapshot;
  offhand: RawNbtListSnapshot;
  experience?: RawNbtNamedTagSnapshot[];
  outline: InventoryOutline;
}

export interface InventorySnapshot {
  schemaVersion: number;
  namespace: string;
  identityType: IdentityType;
  playerKey: string;
  snapshotId?: string;
  savedAt: string;
  loadConsumedAt?: string;
  restorePendingAt?: string;
  restorePendingId?: string;
  source: SnapshotSource;
  db?: DbInventorySnapshot;
  inventory: {
    selectedSlotIndex?: number;
    exclusions?: {
      main?: Array<PortableStorageExclusion & { slot: number }>;
      equipment?: Array<PortableStorageExclusion & { slot: InventoryEquipmentSlotKey }>;
    };
    main: Array<SerializedItem | null>;
    equipment: {
      head: SerializedItem | null;
      chest: SerializedItem | null;
      legs: SerializedItem | null;
      feet: SerializedItem | null;
      offhand: SerializedItem | null;
    };
  };
}

export interface InventoryDbSaveRequest {
  schemaVersion: number;
  namespace: string;
  identityType: IdentityType;
  playerKey: string;
  savedAt?: string;
  source: SnapshotSource;
  expectedInventory?: InventoryOutline;
}

export interface InventoryRestoreRequest {
  namespace: string;
  identityType: IdentityType;
  playerKey: string;
  restoreSource: RestoreSourceKind;
  requestedBy: string;
  executedSource: SnapshotSource;
}

export interface PendingRestoreRequest {
  schemaVersion: 1;
  pendingId: string;
  createdAt: string;
  restoreSource: RestoreSourceKind;
  namespace: string;
  identityType: IdentityType;
  playerKey: string;
  requestedBy: string;
  executedSource: SnapshotSource;
  snapshot: InventorySnapshot;
}

export interface InventoryAuditEvent {
  action: InventoryAuditAction;
  occurredAt: string;
  namespace: string;
  identityType: IdentityType;
  playerKey: string;
  snapshotId?: string;
  snapshotSavedAt?: string;
  source?: SnapshotSource;
  executedSource?: SnapshotSource;
  found?: boolean;
}

export interface InventoryAuditRecordRequest {
  action: InventoryAuditRecordAction;
  namespace: string;
  identityType: IdentityType;
  playerKey: string;
  occurredAt?: string;
  snapshotId?: string;
  snapshotSavedAt?: string;
  source?: SnapshotSource;
  executedSource: SnapshotSource;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isIdentityType(value: unknown): value is IdentityType {
  return value === "name" || value === "xuid";
}

function isInventoryAuditRecordAction(value: unknown): value is InventoryAuditRecordAction {
  return value === "load" || value === "load_backup";
}

function isRestoreSourceKind(value: unknown): value is RestoreSourceKind {
  return value === "snapshot" || value === "backup";
}

function isInventoryEquipmentSlotKey(value: unknown): value is InventoryEquipmentSlotKey {
  return value === "head" || value === "chest" || value === "legs" || value === "feet" || value === "offhand";
}

function isDynamicPropertyScalar(value: unknown): value is DynamicPropertyScalar {
  return typeof value === "boolean" || typeof value === "number" || typeof value === "string";
}

function isDynamicPropertyRecord(value: unknown): value is Record<string, DynamicPropertyScalar> {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every((entry) => isDynamicPropertyScalar(entry));
}

function isSerializedEnchantment(value: unknown): value is NonNullable<SerializedItem["enchantments"]>[number] {
  return isRecord(value) && typeof value.type === "string" && isNumber(value.level);
}

function isSerializedItemStorage(value: unknown): value is SerializedItemStorage {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return false;
  }

  if (value.size !== undefined && !isNumber(value.size)) {
    return false;
  }

  return value.items.every((entry) => entry === null || isSerializedItem(entry));
}

function isPortableStorageExclusion(value: unknown): value is PortableStorageExclusion {
  return (
    isRecord(value) &&
    typeof value.typeId === "string" &&
    value.reason === "portable_storage_unsupported"
  );
}

function isMainPortableStorageExclusion(
  value: unknown,
): value is NonNullable<NonNullable<InventorySnapshot["inventory"]["exclusions"]>["main"]>[number] {
  return isRecord(value) && isPortableStorageExclusion(value) && isNumber(value.slot);
}

function isEquipmentPortableStorageExclusion(
  value: unknown,
): value is NonNullable<NonNullable<InventorySnapshot["inventory"]["exclusions"]>["equipment"]>[number] {
  return isRecord(value) && isPortableStorageExclusion(value) && isInventoryEquipmentSlotKey(value.slot);
}

function isSerializedItem(value: unknown): value is SerializedItem {
  if (!isRecord(value) || typeof value.typeId !== "string" || !isNumber(value.amount)) {
    return false;
  }

  if (value.slot !== undefined && !isNumber(value.slot)) {
    return false;
  }

  if (value.nameTag !== undefined && typeof value.nameTag !== "string") {
    return false;
  }

  if (value.lore !== undefined && !isStringArray(value.lore)) {
    return false;
  }

  if (value.keepOnDeath !== undefined && typeof value.keepOnDeath !== "boolean") {
    return false;
  }

  if (value.lockMode !== undefined && typeof value.lockMode !== "string") {
    return false;
  }

  if (value.canDestroy !== undefined && !isStringArray(value.canDestroy)) {
    return false;
  }

  if (value.canPlaceOn !== undefined && !isStringArray(value.canPlaceOn)) {
    return false;
  }

  if (value.dynamicProperties !== undefined && !isDynamicPropertyRecord(value.dynamicProperties)) {
    return false;
  }

  if (value.durability !== undefined) {
    if (!isRecord(value.durability)) {
      return false;
    }

    if (value.durability.damage !== undefined && !isNumber(value.durability.damage)) {
      return false;
    }

    if (value.durability.unbreakable !== undefined && typeof value.durability.unbreakable !== "boolean") {
      return false;
    }
  }

  if (value.enchantments !== undefined) {
    if (!Array.isArray(value.enchantments) || !value.enchantments.every((entry) => isSerializedEnchantment(entry))) {
      return false;
    }
  }

  if (value.storage !== undefined && !isSerializedItemStorage(value.storage)) {
    return false;
  }

  return true;
}

function isInventoryOuterItem(value: unknown): value is InventoryOuterItem {
  return (
    isRecord(value) &&
    (typeof value.slot === "number" || typeof value.slot === "string") &&
    typeof value.typeId === "string" &&
    isNumber(value.amount)
  );
}

function isInventoryOutline(value: unknown): value is InventoryOutline {
  return (
    isRecord(value) &&
    Array.isArray(value.main) &&
    value.main.every((entry) => isInventoryOuterItem(entry)) &&
    Array.isArray(value.equipment) &&
    value.equipment.every((entry) => isInventoryOuterItem(entry))
  );
}

function isRawNbtListSnapshot(value: unknown): value is RawNbtListSnapshot {
  return (
    isRecord(value) &&
    isNumber(value.elementType) &&
    Array.isArray(value.entriesBase64) &&
    value.entriesBase64.every((entry) => typeof entry === "string")
  );
}

function isRawNbtNamedTagSnapshot(value: unknown): value is RawNbtNamedTagSnapshot {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.tagBase64 === "string"
  );
}

function isDbInventorySnapshot(value: unknown): value is DbInventorySnapshot {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.playerRecordKey === "string" &&
    (value.playerUniqueId === undefined || typeof value.playerUniqueId === "string") &&
    (value.selectedInventorySlot === undefined || isNumber(value.selectedInventorySlot)) &&
    isRawNbtListSnapshot(value.inventory) &&
    isRawNbtListSnapshot(value.armor) &&
    isRawNbtListSnapshot(value.offhand) &&
    (value.experience === undefined ||
      (Array.isArray(value.experience) && value.experience.every((entry) => isRawNbtNamedTagSnapshot(entry)))) &&
    isInventoryOutline(value.outline)
  );
}

function isSnapshotSource(value: unknown): value is SnapshotSource {
  return (
    isRecord(value) &&
    typeof value.serverId === "string" &&
    typeof value.worldId === "string" &&
    typeof value.worldName === "string"
  );
}

function isEquipmentSnapshot(value: unknown): value is InventorySnapshot["inventory"]["equipment"] {
  if (!isRecord(value)) {
    return false;
  }

  const entries = [value.head, value.chest, value.legs, value.feet, value.offhand];
  return entries.every((entry) => entry === null || isSerializedItem(entry));
}

function isInventoryExclusions(value: unknown): value is NonNullable<InventorySnapshot["inventory"]["exclusions"]> {
  if (!isRecord(value)) {
    return false;
  }

  if (value.main !== undefined) {
    if (!Array.isArray(value.main) || !value.main.every((entry) => isMainPortableStorageExclusion(entry))) {
      return false;
    }
  }

  if (value.equipment !== undefined) {
    if (!Array.isArray(value.equipment) || !value.equipment.every((entry) => isEquipmentPortableStorageExclusion(entry))) {
      return false;
    }
  }

  return true;
}

export function isInventorySnapshot(value: unknown): value is InventorySnapshot {
  if (
    !isRecord(value) ||
    !isNumber(value.schemaVersion) ||
    typeof value.namespace !== "string" ||
    !isIdentityType(value.identityType) ||
    typeof value.playerKey !== "string" ||
    typeof value.savedAt !== "string" ||
    !isSnapshotSource(value.source)
  ) {
    return false;
  }

  if (value.snapshotId !== undefined && typeof value.snapshotId !== "string") {
    return false;
  }

  if (value.loadConsumedAt !== undefined && typeof value.loadConsumedAt !== "string") {
    return false;
  }

  if (value.restorePendingAt !== undefined && typeof value.restorePendingAt !== "string") {
    return false;
  }

  if (value.restorePendingId !== undefined && typeof value.restorePendingId !== "string") {
    return false;
  }

  if (value.db !== undefined && !isDbInventorySnapshot(value.db)) {
    return false;
  }

  if (!isRecord(value.inventory)) {
    return false;
  }

  if (value.inventory.selectedSlotIndex !== undefined && !isNumber(value.inventory.selectedSlotIndex)) {
    return false;
  }

  if (value.inventory.exclusions !== undefined && !isInventoryExclusions(value.inventory.exclusions)) {
    return false;
  }

  if (
    !Array.isArray(value.inventory.main) ||
    !value.inventory.main.every((entry) => entry === null || isSerializedItem(entry)) ||
    !isEquipmentSnapshot(value.inventory.equipment)
  ) {
    return false;
  }

  return true;
}

export function isInventoryDbSaveRequest(value: unknown): value is InventoryDbSaveRequest {
  return (
    isRecord(value) &&
    isNumber(value.schemaVersion) &&
    typeof value.namespace === "string" &&
    isIdentityType(value.identityType) &&
    typeof value.playerKey === "string" &&
    (value.savedAt === undefined || typeof value.savedAt === "string") &&
    isSnapshotSource(value.source) &&
    (value.expectedInventory === undefined || isInventoryOutline(value.expectedInventory))
  );
}

export function isInventoryRestoreRequest(value: unknown): value is InventoryRestoreRequest {
  return (
    isRecord(value) &&
    typeof value.namespace === "string" &&
    isIdentityType(value.identityType) &&
    typeof value.playerKey === "string" &&
    isRestoreSourceKind(value.restoreSource) &&
    typeof value.requestedBy === "string" &&
    isSnapshotSource(value.executedSource)
  );
}

export function isPendingRestoreRequest(value: unknown): value is PendingRestoreRequest {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.pendingId === "string" &&
    typeof value.createdAt === "string" &&
    isRestoreSourceKind(value.restoreSource) &&
    typeof value.namespace === "string" &&
    isIdentityType(value.identityType) &&
    typeof value.playerKey === "string" &&
    typeof value.requestedBy === "string" &&
    isSnapshotSource(value.executedSource) &&
    isInventorySnapshot(value.snapshot)
  );
}

export function isInventoryAuditRecordRequest(value: unknown): value is InventoryAuditRecordRequest {
  if (
    !isRecord(value) ||
    !isInventoryAuditRecordAction(value.action) ||
    typeof value.namespace !== "string" ||
    !isIdentityType(value.identityType) ||
    typeof value.playerKey !== "string" ||
    !isSnapshotSource(value.executedSource)
  ) {
    return false;
  }

  if (value.occurredAt !== undefined && typeof value.occurredAt !== "string") {
    return false;
  }

  if (value.snapshotId !== undefined && typeof value.snapshotId !== "string") {
    return false;
  }

  if (value.snapshotSavedAt !== undefined && typeof value.snapshotSavedAt !== "string") {
    return false;
  }

  if (value.source !== undefined && !isSnapshotSource(value.source)) {
    return false;
  }

  return true;
}
