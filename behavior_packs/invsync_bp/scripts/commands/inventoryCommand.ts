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
import type { InventoryAction } from "../domain/types";
import { isInventoryAction } from "../domain/types";
import { createInventoryOutline, createInventorySnapshot } from "../inventory/readInventory";
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
  requestRestore,
  saveSnapshot,
  saveSnapshotFromDb,
} from "../net/apiClient";
import { sendError, sendInfo, sendLines, sendSuccess } from "../util/chat";
import { config } from "../util/config";
import { logger } from "../util/logger";

const ACTION_ENUM_NAME = "invsync:inventory_action";
const BP_ACTION_ENUM_NAME = "invsync:inventorybp_action";
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

function isRestoreAdmin(player: Player): boolean {
  try {
    return player.hasTag(config.adminTag);
  } catch {
    return false;
  }
}

function getSource() {
  return {
    serverId: config.serverId,
    worldId: config.worldId,
    worldName: config.worldName,
  };
}

function createScriptSnapshot(player: Player) {
  const identity = playerIdentityResolver.resolve(player);
  const snapshot = createInventorySnapshot(player, identity);

  return {
    identity,
    snapshot: {
      ...snapshot,
      namespace: config.scriptNamespace,
    },
  };
}

async function handleSave(player: Player): Promise<void> {
  const identity = playerIdentityResolver.resolve(player);
  const snapshot = createInventorySnapshot(player, identity);
  const expectedInventory = createInventoryOutline(player);

  const response = await saveSnapshotFromDb({
    schemaVersion: config.schemaVersion,
    namespace: config.namespace,
    identityType: identity.identityType,
    playerKey: identity.playerKey,
    savedAt: snapshot.savedAt,
    source: snapshot.source,
    expectedInventory,
  });

  let clearResult;
  try {
    clearResult = await clearSyncedInventory(player, snapshot, {
      clearExcludedPortableStorage: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Inventory snapshot was saved, but clearing the player's inventory failed.", message);
    sendError(
      player,
      `インベントリはDBから保存されましたが、保存後のclearに失敗しました。運営に連絡してください。詳細: ${message}`,
    );
    return;
  }

  sendSuccess(player, `インベントリをDBから保存し、保存後にclearしました。(${response.savedAt})`);
  if (clearResult.warnings.length > 0) {
    sendInfo(player, "一部スロットのclearに失敗した可能性があります。詳しくはサーバーログを確認してください。");
    logger.warn("Inventory clearing after save completed with warnings.", clearResult.warnings);
  }
}

async function handleSaveBp(player: Player): Promise<void> {
  const { snapshot } = createScriptSnapshot(player);
  const response = await saveSnapshot(snapshot);

  let clearResult;
  try {
    clearResult = await clearSyncedInventory(player, snapshot, {
      clearExperience: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Script inventory snapshot was saved, but clearing the player's inventory failed.", message);
    sendError(
      player,
      `BP方式でインベントリは保存されましたが、保存後のclearに失敗しました。運営に連絡してください。詳細: ${message}`,
    );
    return;
  }

  sendSuccess(player, `BP方式でインベントリを保存し、保存後にインベントリ/装備をclearしました。XPはBP方式では対象外です。(${response.savedAt})`);
  if (clearResult.skippedPortableStorage.length > 0) {
    sendInfo(
      player,
      `Script APIで中身を読めない携帯収納は、消失防止のためclearせず残しました: ${clearResult.skippedPortableStorage.join(", ")}`,
    );
  }
  if (clearResult.warnings.length > 0) {
    sendInfo(player, "一部スロットのclearに失敗した可能性があります。詳しくはサーバーログを確認してください。");
    logger.warn("Script inventory clearing after save completed with warnings.", clearResult.warnings);
  }
}

async function requestOfflineRestore(player: Player, restoreSource: "snapshot" | "backup"): Promise<void> {
  if (!isRestoreAdmin(player)) {
    sendError(player, `この操作は管理者専用です。必要なタグ: ${config.adminTag}`);
    return;
  }

  const identity = playerIdentityResolver.resolve(player);
  const response = await requestRestore({
    namespace: config.namespace,
    identityType: identity.identityType,
    playerKey: identity.playerKey,
    restoreSource,
    requestedBy: player.name,
    executedSource: getSource(),
  });

  if (!response.found) {
    const label = restoreSource === "backup" ? "復元できる自動バックアップ" : "保存済みインベントリ";
    sendInfo(player, `${label}が見つかりません。`);
    return;
  }

  if (response.consumed) {
    sendInfo(player, "このデータはすでに適用済みです。必要なら新しくsaveしてください。");
    return;
  }

  if (response.pending) {
    const already = response.alreadyPending ? "既存の" : "新しい";
    sendSuccess(player, `${already}復元予約があります。pendingId=${response.pendingId ?? "不明"}`);
    sendInfo(player, `BDSを停止したあと、sidecarで node dist/cli.js apply-pending --server-id ${config.serverId} を実行してください。`);
    return;
  }

  sendError(player, "復元予約を作成できませんでした。サーバーログを確認してください。");
}

async function handleLoad(player: Player): Promise<void> {
  await requestOfflineRestore(player, "snapshot");
}

async function handleLoadBackup(player: Player): Promise<void> {
  await requestOfflineRestore(player, "backup");
}

async function handleStatus(player: Player): Promise<void> {
  const identity = playerIdentityResolver.resolve(player);
  const response = await fetchSnapshotStatus(
    config.namespace,
    identity.identityType,
    identity.playerKey,
    config.serverId,
  );

  if (!response.found) {
    sendLines(player, "§eインベントリ保存状況", [
      `playerKey: ${identity.playerKey}`,
      `identityType: ${identity.identityType}`,
      "保存済み: いいえ",
    ]);
    return;
  }

  sendLines(player, "§eインベントリ保存状況", [
    `playerKey: ${response.playerKey}`,
    `identityType: ${response.identityType}`,
    "保存済み: はい",
    `保存方式: ${response.snapshotMode === "db" ? "DB raw NBT" : "Script API"}`,
    `適用済み: ${response.consumed ? "はい" : "いいえ"}`,
    `適用日時: ${response.consumedAt ?? "未適用"}`,
    `復元予約中: ${response.pending ? "はい" : "いいえ"}`,
    `予約ID: ${response.pendingId ?? "なし"}`,
    `予約日時: ${response.pendingAt ?? "なし"}`,
    `保存日時: ${response.savedAt ?? "不明"}`,
    `保存元: ${response.source?.worldName ?? "不明"} (${response.source?.serverId ?? "不明"} / ${response.source?.worldId ?? "不明"})`,
  ]);
}

async function handleStatusBp(player: Player): Promise<void> {
  const identity = playerIdentityResolver.resolve(player);
  const response = await fetchSnapshotStatus(
    config.scriptNamespace,
    identity.identityType,
    identity.playerKey,
    config.serverId,
  );

  if (!response.found) {
    sendLines(player, "§eBP方式インベントリ保存状況", [
      `playerKey: ${identity.playerKey}`,
      `identityType: ${identity.identityType}`,
      `namespace: ${config.scriptNamespace}`,
      "保存済み: いいえ",
    ]);
    return;
  }

  sendLines(player, "§eBP方式インベントリ保存状況", [
    `playerKey: ${response.playerKey}`,
    `identityType: ${response.identityType}`,
    `namespace: ${config.scriptNamespace}`,
    "保存済み: はい",
    `保存方式: ${response.snapshotMode === "db" ? "DB raw NBT" : "Script API"}`,
    `適用済み: ${response.consumed ? "はい" : "いいえ"}`,
    `適用日時: ${response.consumedAt ?? "未適用"}`,
    `保存日時: ${response.savedAt ?? "不明"}`,
    `保存元: ${response.source?.worldName ?? "不明"} (${response.source?.serverId ?? "不明"} / ${response.source?.worldId ?? "不明"})`,
  ]);
}

async function handleLoadBp(player: Player): Promise<void> {
  const identity = playerIdentityResolver.resolve(player);
  const status = await fetchSnapshotStatus(
    config.scriptNamespace,
    identity.identityType,
    identity.playerKey,
    config.serverId,
  );

  if (!status.found) {
    sendInfo(player, "BP方式の保存済みインベントリが見つかりません。");
    return;
  }

  if (status.consumed) {
    sendInfo(player, "BP方式の保存データはすでに適用済みです。必要なら新しくsavebpしてください。");
    return;
  }

  const beforeLoad = createScriptSnapshot(player).snapshot;
  await backupSnapshotBeforeLoad(beforeLoad);

  const response = await loadSnapshot(config.scriptNamespace, identity.identityType, identity.playerKey);
  if (!response.found) {
    sendInfo(player, "BP方式の保存済みインベントリが見つかりません。");
    return;
  }

  if (response.consumed) {
    sendInfo(player, "BP方式の保存データはすでに適用済みです。必要なら新しくsavebpしてください。");
    return;
  }

  if (!response.snapshot) {
    sendError(player, "BP方式の保存データを取得できませんでした。サーバーログを確認してください。");
    return;
  }

  const applyResult = await applyInventorySnapshot(player, response.snapshot);
  try {
    await recordLoadApplied(response.snapshot);
  } catch (error) {
    logger.warn("Failed to record script inventory load audit event.", error);
  }

  sendSuccess(player, `BP方式でインベントリを即時復元しました。保存日時: ${response.savedAt ?? "不明"}`);
  if (applyResult.skippedPortableStorage.length > 0) {
    sendInfo(
      player,
      `Script APIで中身を読めない携帯収納は復元対象から除外されました: ${applyResult.skippedPortableStorage.join(", ")}`,
    );
  }
  if (applyResult.warnings.length > 0) {
    sendInfo(player, "一部アイテムの復元に失敗した可能性があります。詳しくはサーバーログを確認してください。");
    logger.warn("Script inventory load completed with warnings.", applyResult.warnings);
  }
}

async function handleLoadBackupBp(player: Player): Promise<void> {
  const identity = playerIdentityResolver.resolve(player);
  const response = await loadBackupSnapshot(config.scriptNamespace, identity.identityType, identity.playerKey);

  if (!response.found) {
    sendInfo(player, "BP方式で復元できる直前バックアップが見つかりません。");
    return;
  }

  if (response.consumed) {
    sendInfo(player, "BP方式の直前バックアップはすでに適用済みです。");
    return;
  }

  if (!response.snapshot) {
    sendError(player, "BP方式の直前バックアップを取得できませんでした。サーバーログを確認してください。");
    return;
  }

  const applyResult = await applyInventorySnapshot(player, response.snapshot);
  try {
    await recordLoadBackupApplied(response.snapshot);
  } catch (error) {
    logger.warn("Failed to record script inventory backup load audit event.", error);
  }

  sendSuccess(player, `BP方式の直前バックアップを即時復元しました。保存日時: ${response.savedAt ?? "不明"}`);
  if (applyResult.skippedPortableStorage.length > 0) {
    sendInfo(
      player,
      `Script APIで中身を読めない携帯収納は復元対象から除外されました: ${applyResult.skippedPortableStorage.join(", ")}`,
    );
  }
  if (applyResult.warnings.length > 0) {
    sendInfo(player, "一部アイテムの復元に失敗した可能性があります。詳しくはサーバーログを確認してください。");
    logger.warn("Script inventory backup load completed with warnings.", applyResult.warnings);
  }
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
    `要求スロット: ${slot}`,
    `選択中スロット: ${player.selectedSlotIndex}`,
    `インベントリサイズ: ${containerSize}`,
  ];

  if (!item) {
    lines.push("アイテムあり: いいえ");
    return lines;
  }

  lines.push("アイテムあり: はい");
  lines.push(`typeId: ${item.typeId}`);
  lines.push(`個数: ${item.amount}`);

  let inventoryComponent: ItemInventoryComponent | undefined;
  try {
    inventoryComponent = item.getComponent(ItemComponentTypes.Inventory) as ItemInventoryComponent | undefined;
    lines.push(`inventoryComponent: ${inventoryComponent ? "あり" : "なし"}`);
  } catch (error) {
    lines.push(`inventoryComponent: エラー (${error instanceof Error ? error.message : String(error)})`);
  }

  const serialized = serializeItem(item, slot);
  lines.push(`serializedStorage: ${serialized?.storage ? "あり" : "なし"}`);

  if (serialized?.storage) {
    const serializedNonEmpty = serialized.storage.items.filter((entry) => entry !== null).length;
    lines.push(`serializedStorage サイズ: ${serialized.storage.size ?? serialized.storage.items.length}`);
    lines.push(`serializedStorage 非空スロット数: ${serializedNonEmpty}`);
    const preview = serialized.storage.items
      .map((entry, index) => (entry ? `${index}:${entry.typeId}x${entry.amount}` : undefined))
      .filter((entry): entry is string => entry !== undefined)
      .slice(0, DEFAULT_DEBUG_PREVIEW_LIMIT);

    lines.push(`serialized プレビュー: ${preview.length > 0 ? preview.join(", ") : "空"}`);
  }

  if (!inventoryComponent) {
    return lines;
  }

  try {
    const nestedContainer = inventoryComponent.container;
    const nestedSize = nestedContainer.size;
    lines.push(`nestedContainer サイズ: ${nestedSize}`);

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

    lines.push(`nestedContainer 非空スロット数: ${nonEmpty}`);
    lines.push(`nested プレビュー: ${preview.length > 0 ? preview.join(", ") : "空"}`);
  } catch (error) {
    lines.push(`nestedContainer: エラー (${error instanceof Error ? error.message : String(error)})`);
  }

  return lines;
}

function getUnexpectedErrorMessage(action: InventoryAction, error: unknown): string {
  const reason = error instanceof Error && error.message ? ` 詳細: ${error.message}` : "";

  switch (action) {
    case "save":
      return `DBからのインベントリ保存に失敗しました。${reason}`;
    case "load":
      return `インベントリ復元予約の作成に失敗しました。${reason}`;
    case "loadbackup":
      return `バックアップ復元予約の作成に失敗しました。${reason}`;
    case "status":
      return `インベントリ状態の取得に失敗しました。${reason}`;
  }
}

function getUnexpectedBpErrorMessage(action: InventoryAction, error: unknown): string {
  const reason = error instanceof Error && error.message ? ` 詳細: ${error.message}` : "";

  switch (action) {
    case "save":
      return `BP方式のインベントリ保存に失敗しました。${reason}`;
    case "load":
      return `BP方式のインベントリ即時復元に失敗しました。${reason}`;
    case "loadbackup":
      return `BP方式の直前バックアップ復元に失敗しました。${reason}`;
    case "status":
      return `BP方式のインベントリ状態の取得に失敗しました。${reason}`;
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

async function runInventoryBpAction(player: Player, action: InventoryAction): Promise<void> {
  try {
    switch (action) {
      case "save":
        await handleSaveBp(player);
        return;
      case "load":
        await handleLoadBp(player);
        return;
      case "loadbackup":
        await handleLoadBackupBp(player);
        return;
      case "status":
        await handleStatusBp(player);
        return;
    }
  } catch (error) {
    logger.error(`Script inventory command failed for action "${action}".`, error);

    if (error instanceof ApiClientError) {
      sendError(player, error.playerMessage);
      return;
    }

    sendError(player, getUnexpectedBpErrorMessage(action, error));
  }
}

export function registerInventoryCommand(customCommandRegistry: CustomCommandRegistry): void {
  customCommandRegistry.registerEnum(ACTION_ENUM_NAME, ["save", "load", "loadbackup", "status"]);
  customCommandRegistry.registerEnum(BP_ACTION_ENUM_NAME, ["save", "load", "loadbackup", "status"]);

  customCommandRegistry.registerCommand(
    {
      name: `${config.namespace}:inventory`,
      description: "インベントリの保存、復元予約、バックアップ復元予約、状態確認を行います。",
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
          message: "このコマンドはプレイヤーのみ実行できます。",
        };
      }

      if (!isInventoryAction(action)) {
        return {
          status: CustomCommandStatus.Failure,
          message: "action には save / load / loadbackup / status のいずれかを指定してください。",
        };
      }

      void runInventoryAction(player, action);
      return undefined;
    },
  );

  for (const action of ["save", "load", "loadbackup", "status"] as const) {
    customCommandRegistry.registerCommand(
      {
        name: `${config.namespace}:${action}`,
        description: `InvSync ${action}`,
        permissionLevel: config.commandPermissionLevel,
      },
      (origin) => {
        const player = getPlayerFromOrigin(origin);
        if (!player) {
          return {
            status: CustomCommandStatus.Failure,
            message: "このコマンドはプレイヤーのみ実行できます。",
          };
        }

        void runInventoryAction(player, action);
        return undefined;
      },
    );
  }

  customCommandRegistry.registerCommand(
    {
      name: `${config.namespace}:inventorybp`,
      description: "BP方式でインベントリの保存、即時復元、直前バックアップ復元、状態確認を行います。",
      permissionLevel: config.commandPermissionLevel,
      mandatoryParameters: [
        {
          name: "action",
          type: CustomCommandParamType.Enum,
          enumName: BP_ACTION_ENUM_NAME,
        },
      ],
    },
    (origin, action) => {
      const player = getPlayerFromOrigin(origin);
      if (!player) {
        return {
          status: CustomCommandStatus.Failure,
          message: "このコマンドはプレイヤーのみ実行できます。",
        };
      }

      if (!isInventoryAction(action)) {
        return {
          status: CustomCommandStatus.Failure,
          message: "action には save / load / loadbackup / status のいずれかを指定してください。",
        };
      }

      void runInventoryBpAction(player, action);
      return undefined;
    },
  );

  for (const [action, alias] of [
    ["save", "savebp"],
    ["load", "loadbp"],
    ["loadbackup", "loadbpbackup"],
    ["status", "statusbp"],
  ] as const) {
    customCommandRegistry.registerCommand(
      {
        name: `${config.namespace}:${alias}`,
        description: `InvSync BP ${action}`,
        permissionLevel: config.commandPermissionLevel,
      },
      (origin) => {
        const player = getPlayerFromOrigin(origin);
        if (!player) {
          return {
            status: CustomCommandStatus.Failure,
            message: "このコマンドはプレイヤーのみ実行できます。",
          };
        }

        void runInventoryBpAction(player, action);
        return undefined;
      },
    );
  }

  customCommandRegistry.registerCommand(
    {
      name: `${config.namespace}:debugslot`,
      description: "指定スロットの携帯収納コンポーネント情報を確認します。",
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
          message: "このコマンドはプレイヤーのみ実行できます。",
        };
      }

      const targetSlot = typeof slot === "number" ? slot : player.selectedSlotIndex;

      try {
        const lines = inspectNestedItemInventory(targetSlot, player);
        sendLines(player, "§e携帯収納デバッグ", lines);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendError(player, `デバッグ確認に失敗しました。詳細: ${message}`);
      }

      return undefined;
    },
  );

  logger.info("InvSync commands registered.", {
    inventory: `${config.namespace}:inventory`,
    aliases: ["save", "load", "loadbackup", "status"].map((action) => `${config.namespace}:${action}`),
    inventorybp: `${config.namespace}:inventorybp`,
    bpAliases: ["savebp", "loadbp", "loadbpbackup", "statusbp"].map((action) => `${config.namespace}:${action}`),
  });
}
