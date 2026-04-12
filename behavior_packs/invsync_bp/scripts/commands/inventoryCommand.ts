import {
  CustomCommandParamType,
  CustomCommandOrigin,
  CustomCommandRegistry,
  CustomCommandSource,
  CustomCommandStatus,
  EntityComponentTypes,
  ItemComponentTypes,
  ItemInventoryComponent,
  Player,
} from "@minecraft/server";
import { playerIdentityResolver } from "../domain/playerIdentity";
import type { InventoryAction, InventorySnapshot, ResolvedPlayerIdentity } from "../domain/types";
import { isInventoryAction } from "../domain/types";
import { createInventorySnapshot, getPortableStorageExclusions } from "../inventory/readInventory";
import { serializeItem } from "../inventory/itemSerializer";
import { applyInventorySnapshot, clearSyncedInventory } from "../inventory/writeInventory";
import {
  ApiClientError,
  backupSnapshotBeforeLoad,
  fetchSnapshotStatus,
  loadBackupSnapshot,
  loadSnapshot,
  recordLoadApplied,
  recordLoadBackupApplied,
  saveSnapshot,
} from "../net/apiClient";
import { sendError, sendInfo, sendLines, sendSuccess } from "../util/chat";
import { config } from "../util/config";
import { logger } from "../util/logger";

const ACTION_ENUM_NAME = "invsync:inventory_action";
const DEFAULT_DEBUG_PREVIEW_LIMIT = 5;

function getPlayerFromOrigin(origin: CustomCommandOrigin): Player | undefined {
  if (origin.sourceType !== CustomCommandSource.Entity) {
    return undefined;
  }

  const entity = origin.sourceEntity;
  if (!entity || entity.typeId !== "minecraft:player") {
    return undefined;
  }

  return entity as Player;
}

function notifyPortableStorageExclusions(
  player: Player,
  excludedPortableStorage: string[],
  summaryMessage: string,
  slotsLabel: string,
): void {
  if (excludedPortableStorage.length === 0) {
    return;
  }

  sendInfo(player, summaryMessage);
  sendInfo(player, `${slotsLabel}: ${excludedPortableStorage.join(", ")}`);
}

async function savePreRestoreBackup(
  player: Player,
  identity: ResolvedPlayerIdentity,
  successMessage: string,
): Promise<void> {
  const backupSnapshot = createInventorySnapshot(player, identity);
  const excludedPortableStorage = getPortableStorageExclusions(backupSnapshot);
  const backupResponse = await backupSnapshotBeforeLoad(backupSnapshot);

  sendInfo(player, `${successMessage} (${backupResponse.savedAt})`);

  if (excludedPortableStorage.length > 0) {
    logger.warn("Portable storage items were excluded from the pre-restore backup.", excludedPortableStorage);
    notifyPortableStorageExclusions(
      player,
      excludedPortableStorage,
      "\u73fe\u5728\u306e\u30a4\u30f3\u30d9\u30f3\u30c8\u30ea\u5185\u306e\u643a\u5e2f\u53ce\u7d0d\u30a2\u30a4\u30c6\u30e0\u306f\u30d0\u30c3\u30af\u30a2\u30c3\u30d7\u5bfe\u8c61\u5916\u3067\u3059\u3002",
      "\u30d0\u30c3\u30af\u30a2\u30c3\u30d7\u9664\u5916\u30b9\u30ed\u30c3\u30c8",
    );
  }
}

async function applyRestoredSnapshot(
  player: Player,
  snapshot: InventorySnapshot,
  successMessage: string,
  recordAudit: (snapshot: InventorySnapshot) => Promise<unknown>,
  auditErrorMessage: string,
): Promise<void> {
  const result = await applyInventorySnapshot(player, snapshot);
  sendSuccess(player, successMessage);

  try {
    await recordAudit(snapshot);
  } catch (error) {
    logger.warn(auditErrorMessage, error instanceof Error ? error.message : String(error));
  }

  if (result.skippedPortableStorage.length > 0) {
    notifyPortableStorageExclusions(
      player,
      result.skippedPortableStorage,
      "\u643a\u5e2f\u53ce\u7d0d\u30a2\u30a4\u30c6\u30e0\u306e\u30b9\u30ed\u30c3\u30c8\u306f\u5b89\u5168\u306e\u305f\u3081\u5909\u66f4\u3057\u3066\u3044\u307e\u305b\u3093\u3002",
      "\u672a\u5909\u66f4\u30b9\u30ed\u30c3\u30c8",
    );
  }

  if (result.warnings.length > 0) {
    sendInfo(player, "\u4e00\u90e8\u306e\u30a2\u30a4\u30c6\u30e0\u306f\u5fa9\u5143\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f\u3002\u8a73\u3057\u304f\u306f\u30b5\u30fc\u30d0\u30fc\u30ed\u30b0\u3092\u78ba\u8a8d\u3057\u3066\u304f\u3060\u3055\u3044\u3002");
    logger.warn("Inventory restoration completed with warnings.", result.warnings);
  }
}

async function handleSave(player: Player): Promise<void> {
  const identity = playerIdentityResolver.resolve(player);
  const snapshot = createInventorySnapshot(player, identity);
  const excludedPortableStorage = getPortableStorageExclusions(snapshot);

  const response = await saveSnapshot(snapshot);
  let clearResult: Awaited<ReturnType<typeof clearSyncedInventory>>;

  try {
    clearResult = await clearSyncedInventory(player, snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Inventory snapshot was saved, but clearing the player's inventory failed.", message);
    sendError(
      player,
      `インベントリは保存されましたが、同期対象アイテムのクリアに失敗しました。管理者へ連絡してください。詳細: ${message}`,
    );
    return;
  }

  sendSuccess(player, `インベントリを保存し、同期対象アイテムをクリアしました。 (${response.savedAt})`);

  if (excludedPortableStorage.length > 0) {
    logger.warn("Portable storage items were excluded from sync.", excludedPortableStorage);
    notifyPortableStorageExclusions(
      player,
      excludedPortableStorage,
      "\u3053\u306e\u30b5\u30fc\u30d0\u30fc\u30d3\u30eb\u30c9\u3067\u306f\u643a\u5e2f\u53ce\u7d0d\u30a2\u30a4\u30c6\u30e0\u306f\u540c\u671f\u5bfe\u8c61\u5916\u3067\u3059\u3002",
      "\u9664\u5916\u30b9\u30ed\u30c3\u30c8",
    );
  }

  if (clearResult.warnings.length > 0) {
    sendInfo(player, "一部のスロットはクリアできませんでした。詳しくはサーバーログを確認してください。");
    logger.warn("Inventory clearing after save completed with warnings.", clearResult.warnings);
  }
}

async function handleLoad(player: Player): Promise<void> {
  const identity = playerIdentityResolver.resolve(player);
  const status = await fetchSnapshotStatus(config.namespace, identity.identityType, identity.playerKey);

  if (!status.found) {
    sendInfo(player, "\u4fdd\u5b58\u6e08\u307f\u306e\u30a4\u30f3\u30d9\u30f3\u30c8\u30ea\u30b9\u30ca\u30c3\u30d7\u30b7\u30e7\u30c3\u30c8\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3002");
    return;
  }

  if (status.consumed) {
    sendInfo(player, `この保存データはすでに読み込み済みです。新しく /${config.namespace}:inventory save を実行してください。`);
    return;
  }

  await savePreRestoreBackup(
    player,
    identity,
    "\u4e0a\u66f8\u304d\u524d\u306e\u30a4\u30f3\u30d9\u30f3\u30c8\u30ea\u3092\u81ea\u52d5\u30d0\u30c3\u30af\u30a2\u30c3\u30d7\u3057\u307e\u3057\u305f\u3002",
  );

  const response = await loadSnapshot(config.namespace, identity.identityType, identity.playerKey);

  if (!response.found || !response.snapshot) {
    if (response.consumed) {
      sendInfo(player, `この保存データはすでに読み込み済みです。新しく /${config.namespace}:inventory save を実行してください。`);
      return;
    }

    sendInfo(player, "\u4fdd\u5b58\u6e08\u307f\u306e\u30a4\u30f3\u30d9\u30f3\u30c8\u30ea\u30b9\u30ca\u30c3\u30d7\u30b7\u30e7\u30c3\u30c8\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3002");
    return;
  }

  await applyRestoredSnapshot(
    player,
    response.snapshot,
    "\u30a4\u30f3\u30d9\u30f3\u30c8\u30ea\u306e\u30b9\u30ca\u30c3\u30d7\u30b7\u30e7\u30c3\u30c8\u3092\u8aad\u307f\u8fbc\u307f\u307e\u3057\u305f\u3002",
    recordLoadApplied,
    "Failed to record completed inventory load.",
  );
}

async function handleLoadBackup(player: Player): Promise<void> {
  const identity = playerIdentityResolver.resolve(player);
  const response = await loadBackupSnapshot(config.namespace, identity.identityType, identity.playerKey);

  if (!response.found || !response.snapshot) {
    if (response.consumed) {
      sendInfo(player, "この自動バックアップはすでに復元済みです。");
      return;
    }

    sendInfo(player, "\u5fa9\u5143\u3067\u304d\u308b\u81ea\u52d5\u30d0\u30c3\u30af\u30a2\u30c3\u30d7\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3002");
    return;
  }

  await savePreRestoreBackup(
    player,
    identity,
    "\u30d0\u30c3\u30af\u30a2\u30c3\u30d7\u5fa9\u5143\u524d\u306b\u73fe\u5728\u306e\u30a4\u30f3\u30d9\u30f3\u30c8\u30ea\u3092\u81ea\u52d5\u30d0\u30c3\u30af\u30a2\u30c3\u30d7\u3057\u307e\u3057\u305f\u3002",
  );

  await applyRestoredSnapshot(
    player,
    response.snapshot,
    "\u81ea\u52d5\u30d0\u30c3\u30af\u30a2\u30c3\u30d7\u304b\u3089\u30a4\u30f3\u30d9\u30f3\u30c8\u30ea\u3092\u5fa9\u5143\u3057\u307e\u3057\u305f\u3002",
    recordLoadBackupApplied,
    "Failed to record completed inventory backup restore.",
  );
}

async function handleStatus(player: Player): Promise<void> {
  const identity = playerIdentityResolver.resolve(player);
  const response = await fetchSnapshotStatus(config.namespace, identity.identityType, identity.playerKey);

  if (!response.found) {
    sendLines(player, "\u00A7e\u30a4\u30f3\u30d9\u30f3\u30c8\u30ea\u30b9\u30ca\u30c3\u30d7\u30b7\u30e7\u30c3\u30c8\u72b6\u6cc1", [
      `playerKey: ${identity.playerKey}`,
      `identityType: ${identity.identityType}`,
      "\u4fdd\u5b58\u6e08\u307f: \u3044\u3044\u3048",
    ]);
    return;
  }

  sendLines(player, "\u00A7e\u30a4\u30f3\u30d9\u30f3\u30c8\u30ea\u30b9\u30ca\u30c3\u30d7\u30b7\u30e7\u30c3\u30c8\u72b6\u6cc1", [
    `playerKey: ${response.playerKey}`,
    `identityType: ${response.identityType}`,
    "\u4fdd\u5b58\u6e08\u307f: \u306f\u3044",
    `読み込み済み: ${response.consumed ? "はい" : "いいえ"}`,
    `読み込み日時: ${response.consumedAt ?? "未読み込み"}`,
    `\u4fdd\u5b58\u65e5\u6642: ${response.savedAt ?? "\u4e0d\u660e"}`,
    `\u4fdd\u5b58\u5143: ${response.source?.worldName ?? "\u4e0d\u660e"} (${response.source?.serverId ?? "\u4e0d\u660e"} / ${response.source?.worldId ?? "\u4e0d\u660e"})`,
  ]);
}

function getInventorySlotItem(player: Player, slot: number) {
  const inventory = player.getComponent(EntityComponentTypes.Inventory);
  if (!inventory) {
    throw new Error("minecraft:inventory component is not available.");
  }

  if (slot < 0 || slot >= inventory.container.size) {
    throw new Error(`slot ${slot} is outside the current inventory size ${inventory.container.size}.`);
  }

  const slotRef = inventory.container.getSlot(slot);

  return {
    containerSize: inventory.container.size,
    slotRef,
    item: slotRef.getItem(),
  };
}

function inspectNestedItemInventory(slot: number, player: Player): string[] {
  const { containerSize, item } = getInventorySlotItem(player, slot);

  const lines = [
    `\u8981\u6c42\u30b9\u30ed\u30c3\u30c8: ${slot}`,
    `\u9078\u629e\u4e2d\u30b9\u30ed\u30c3\u30c8: ${player.selectedSlotIndex}`,
    `\u30a4\u30f3\u30d9\u30f3\u30c8\u30ea\u30b5\u30a4\u30ba: ${containerSize}`,
  ];

  if (!item) {
    lines.push("\u30a2\u30a4\u30c6\u30e0\u3042\u308a: \u3044\u3044\u3048");
    return lines;
  }

  lines.push("\u30a2\u30a4\u30c6\u30e0\u3042\u308a: \u306f\u3044");
  lines.push(`typeId: ${item.typeId}`);
  lines.push(`\u500b\u6570: ${item.amount}`);

  let inventoryComponent: ItemInventoryComponent | undefined;
  try {
    inventoryComponent = item.getComponent(ItemComponentTypes.Inventory) as ItemInventoryComponent | undefined;
    lines.push(`inventoryComponent: ${inventoryComponent ? "\u3042\u308a" : "\u306a\u3057"}`);
  } catch (error) {
    lines.push(`inventoryComponent: \u30a8\u30e9\u30fc (${error instanceof Error ? error.message : String(error)})`);
  }

  const serialized = serializeItem(item, slot);
  lines.push(`serializedStorage: ${serialized?.storage ? "\u3042\u308a" : "\u306a\u3057"}`);

  if (serialized?.storage) {
    const serializedNonEmpty = serialized.storage.items.filter((entry) => entry !== null).length;
    lines.push(`serializedStorage \u30b5\u30a4\u30ba: ${serialized.storage.size ?? serialized.storage.items.length}`);
    lines.push(`serializedStorage \u975e\u7a7a\u30b9\u30ed\u30c3\u30c8\u6570: ${serializedNonEmpty}`);
    const preview = serialized.storage.items
      .map((entry, index) => (entry ? `${index}:${entry.typeId}x${entry.amount}` : undefined))
      .filter((entry): entry is string => entry !== undefined)
      .slice(0, DEFAULT_DEBUG_PREVIEW_LIMIT);

    lines.push(`serialized \u30d7\u30ec\u30d3\u30e5\u30fc: ${preview.length > 0 ? preview.join(", ") : "\u7a7a"}`);
  }

  if (!inventoryComponent) {
    return lines;
  }

  try {
    const nestedContainer = inventoryComponent.container;
    const nestedSize = nestedContainer.size;
    lines.push(`nestedContainer \u30b5\u30a4\u30ba: ${nestedSize}`);

    const preview: string[] = [];
    let nonEmpty = 0;

    for (let nestedSlot = 0; nestedSlot < nestedSize; nestedSlot += 1) {
      const nestedItem = nestedContainer.getItem(nestedSlot);
      if (!nestedItem) {
        continue;
      }

      nonEmpty += 1;
      if (preview.length < DEFAULT_DEBUG_PREVIEW_LIMIT) {
        preview.push(`${nestedSlot}:${nestedItem.typeId}x${nestedItem.amount}`);
      }
    }

    lines.push(`nestedContainer \u975e\u7a7a\u30b9\u30ed\u30c3\u30c8\u6570: ${nonEmpty}`);
    lines.push(`nested \u30d7\u30ec\u30d3\u30e5\u30fc: ${preview.length > 0 ? preview.join(", ") : "\u7a7a"}`);
  } catch (error) {
    lines.push(`nestedContainer: \u30a8\u30e9\u30fc (${error instanceof Error ? error.message : String(error)})`);
  }

  return lines;
}

function getUnexpectedErrorMessage(action: InventoryAction, error: unknown): string {
  const reason = error instanceof Error && error.message ? ` \u8a73\u7d30: ${error.message}` : "";

  switch (action) {
    case "save":
      return `\u30a4\u30f3\u30d9\u30f3\u30c8\u30ea\u306e\u30b9\u30ca\u30c3\u30d7\u30b7\u30e7\u30c3\u30c8\u4fdd\u5b58\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002${reason}`;
    case "load":
      return `\u30a4\u30f3\u30d9\u30f3\u30c8\u30ea\u306e\u30b9\u30ca\u30c3\u30d7\u30b7\u30e7\u30c3\u30c8\u8aad\u307f\u8fbc\u307f\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002${reason}`;
    case "loadbackup":
      return `\u81ea\u52d5\u30d0\u30c3\u30af\u30a2\u30c3\u30d7\u304b\u3089\u306e\u5fa9\u5143\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002${reason}`;
    case "status":
      return `\u30a4\u30f3\u30d9\u30f3\u30c8\u30ea\u72b6\u6cc1\u306e\u53d6\u5f97\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002${reason}`;
  }
}

async function runInventoryAction(player: Player, action: InventoryAction): Promise<void> {
  try {
    switch (action) {
      case "save":
        await handleSave(player);
        return;
      case "load":
        await handleLoad(player);
        return;
      case "loadbackup":
        await handleLoadBackup(player);
        return;
      case "status":
        await handleStatus(player);
        return;
    }
  } catch (error) {
    logger.error(`Inventory command failed for action "${action}".`, error);

    if (error instanceof ApiClientError) {
      sendError(player, error.playerMessage);
      return;
    }

    sendError(player, getUnexpectedErrorMessage(action, error));
  }
}

export function registerInventoryCommand(customCommandRegistry: CustomCommandRegistry): void {
  customCommandRegistry.registerEnum(ACTION_ENUM_NAME, ["save", "load", "loadbackup", "status"]);

  customCommandRegistry.registerCommand(
    {
      name: `${config.namespace}:inventory`,
      description: "\u30a4\u30f3\u30d9\u30f3\u30c8\u30ea\u306e\u4fdd\u5b58\u3001\u8aad\u307f\u8fbc\u307f\u3001\u30d0\u30c3\u30af\u30a2\u30c3\u30d7\u5fa9\u5143\u3001\u72b6\u614b\u78ba\u8a8d\u3092\u884c\u3044\u307e\u3059\u3002",
      permissionLevel: config.commandPermissionLevel,
      mandatoryParameters: [
        {
          name: "action",
          type: CustomCommandParamType.Enum,
          enumName: ACTION_ENUM_NAME,
        },
      ],
    },
    (origin, action) => {
      const player = getPlayerFromOrigin(origin);
      if (!player) {
        return {
          status: CustomCommandStatus.Failure,
          message: "\u3053\u306e\u30b3\u30de\u30f3\u30c9\u306f\u30d7\u30ec\u30a4\u30e4\u30fc\u306e\u307f\u5b9f\u884c\u3067\u304d\u307e\u3059\u3002",
        };
      }

      if (!isInventoryAction(action)) {
        return {
          status: CustomCommandStatus.Failure,
          message: "action \u306b\u306f save / load / loadbackup / status \u306e\u3044\u305a\u308c\u304b\u3092\u6307\u5b9a\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
        };
      }

      void runInventoryAction(player, action);
      return undefined;
    },
  );

  customCommandRegistry.registerCommand(
    {
      name: `${config.namespace}:debugslot`,
      description: "\u6307\u5b9a\u30b9\u30ed\u30c3\u30c8\u306e\u643a\u5e2f\u53ce\u7d0d\u30b3\u30f3\u30dd\u30fc\u30cd\u30f3\u30c8\u60c5\u5831\u3092\u78ba\u8a8d\u3057\u307e\u3059\u3002",
      permissionLevel: config.commandPermissionLevel,
      optionalParameters: [
        {
          name: "slot",
          type: CustomCommandParamType.Integer,
        },
      ],
    },
    (origin, slot) => {
      const player = getPlayerFromOrigin(origin);
      if (!player) {
        return {
          status: CustomCommandStatus.Failure,
          message: "\u3053\u306e\u30b3\u30de\u30f3\u30c9\u306f\u30d7\u30ec\u30a4\u30e4\u30fc\u306e\u307f\u5b9f\u884c\u3067\u304d\u307e\u3059\u3002",
        };
      }

      const targetSlot = typeof slot === "number" ? slot : player.selectedSlotIndex;

      try {
        const lines = inspectNestedItemInventory(targetSlot, player);
        sendLines(player, "\u00A7e\u643a\u5e2f\u53ce\u7d0d\u30c7\u30d0\u30c3\u30b0", lines);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendError(player, `\u30c7\u30d0\u30c3\u30b0\u78ba\u8a8d\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002\u8a73\u7d30: ${message}`);
      }

      return undefined;
    },
  );
}
