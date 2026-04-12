export type IdentityType = "xuid" | "name";
export type InventoryAction = "save" | "load" | "loadbackup" | "status";
export type DynamicPropertyScalar = boolean | number | string;

export interface ResolvedPlayerIdentity {
  identityType: IdentityType;
  playerKey: string;
}

export interface SnapshotSource {
  serverId: string;
  worldId: string;
  worldName: string;
}

export type InventoryEquipmentSlotKey = "head" | "chest" | "legs" | "feet" | "offhand";

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

export interface InventorySnapshot {
  schemaVersion: number;
  namespace: string;
  identityType: IdentityType;
  playerKey: string;
  snapshotId?: string;
  savedAt: string;
  loadConsumedAt?: string;
  source: SnapshotSource;
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

export interface InventorySaveResponse {
  ok: boolean;
  playerKey: string;
  identityType: IdentityType;
  savedAt: string;
}

export interface InventoryLoadResponse {
  ok: boolean;
  found: boolean;
  consumed?: boolean;
  consumedAt?: string;
  playerKey: string;
  identityType: IdentityType;
  savedAt?: string;
  snapshot?: InventorySnapshot;
}

export interface InventoryStatusResponse {
  ok: boolean;
  found: boolean;
  consumed?: boolean;
  consumedAt?: string;
  playerKey: string;
  identityType: IdentityType;
  savedAt?: string;
  source?: SnapshotSource;
}

export type InventoryAuditRecordAction = "load" | "load_backup";

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

export interface ApiOkResponse {
  ok: boolean;
}

type UnknownRecord = Record<string, unknown>;

export function isInventoryAction(value: unknown): value is InventoryAction {
  return value === "save" || value === "load" || value === "loadbackup" || value === "status";
}

export function isIdentityType(value: unknown): value is IdentityType {
  return value === "name" || value === "xuid";
}

export function isDynamicPropertyScalar(value: unknown): value is DynamicPropertyScalar {
  return typeof value === "boolean" || typeof value === "number" || typeof value === "string";
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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

export function isSerializedItem(value: unknown): value is SerializedItem {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.typeId !== "string" || !isNumber(value.amount)) {
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

function isInventoryEquipmentSlotKey(value: unknown): value is InventoryEquipmentSlotKey {
  return value === "head" || value === "chest" || value === "legs" || value === "feet" || value === "offhand";
}

function isEquipmentSnapshot(
  value: unknown,
): value is InventorySnapshot["inventory"]["equipment"] {
  if (!isRecord(value)) {
    return false;
  }

  const entries = [value.head, value.chest, value.legs, value.feet, value.offhand];
  return entries.every((entry) => entry === null || isSerializedItem(entry));
}

function isSnapshotSource(value: unknown): value is SnapshotSource {
  return (
    isRecord(value) &&
    typeof value.serverId === "string" &&
    typeof value.worldId === "string" &&
    typeof value.worldName === "string"
  );
}

function isInventoryExclusions(value: unknown): value is NonNullable<InventorySnapshot["inventory"]["exclusions"]> {
  if (!isRecord(value)) {
    return false;
  }

  if (value.main !== undefined) {
    if (
      !Array.isArray(value.main) ||
      !value.main.every((entry) => isMainPortableStorageExclusion(entry))
    ) {
      return false;
    }
  }

  if (value.equipment !== undefined) {
    if (
      !Array.isArray(value.equipment) ||
      !value.equipment.every((entry) => isEquipmentPortableStorageExclusion(entry))
    ) {
      return false;
    }
  }

  return true;
}

export function isInventorySnapshot(value: unknown): value is InventorySnapshot {
  if (!isRecord(value)) {
    return false;
  }

  if (
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

export function isInventorySaveResponse(value: unknown): value is InventorySaveResponse {
  return (
    isRecord(value) &&
    typeof value.ok === "boolean" &&
    typeof value.playerKey === "string" &&
    isIdentityType(value.identityType) &&
    typeof value.savedAt === "string"
  );
}

export function isInventoryLoadResponse(value: unknown): value is InventoryLoadResponse {
  if (
    !isRecord(value) ||
    typeof value.ok !== "boolean" ||
    typeof value.found !== "boolean" ||
    typeof value.playerKey !== "string" ||
    !isIdentityType(value.identityType)
  ) {
    return false;
  }

  if (value.savedAt !== undefined && typeof value.savedAt !== "string") {
    return false;
  }

  if (value.consumed !== undefined && typeof value.consumed !== "boolean") {
    return false;
  }

  if (value.consumedAt !== undefined && typeof value.consumedAt !== "string") {
    return false;
  }

  if (!value.found) {
    return true;
  }

  if (value.consumed) {
    return true;
  }

  return value.snapshot !== undefined && isInventorySnapshot(value.snapshot);
}

export function isInventoryStatusResponse(value: unknown): value is InventoryStatusResponse {
  if (
    !isRecord(value) ||
    typeof value.ok !== "boolean" ||
    typeof value.found !== "boolean" ||
    typeof value.playerKey !== "string" ||
    !isIdentityType(value.identityType)
  ) {
    return false;
  }

  if (value.consumed !== undefined && typeof value.consumed !== "boolean") {
    return false;
  }

  if (value.consumedAt !== undefined && typeof value.consumedAt !== "string") {
    return false;
  }

  if (!value.found) {
    return true;
  }

  return typeof value.savedAt === "string" && isSnapshotSource(value.source);
}

export function isApiOkResponse(value: unknown): value is ApiOkResponse {
  return isRecord(value) && typeof value.ok === "boolean";
}
