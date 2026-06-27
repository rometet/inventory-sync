import {
  Container,
  ContainerSlot,
  EntityComponentTypes,
  EntityEquippableComponent,
  EntityInventoryComponent,
  EquipmentSlot,
  ItemStack,
  Player,
} from "@minecraft/server";
import type {
  InventoryEquipmentSlotKey,
  InventoryOutline,
  InventorySnapshot,
  ResolvedPlayerIdentity,
} from "../domain/types";
import { serializeItem } from "./itemSerializer";
import { config } from "../util/config";
import { logger } from "../util/logger";

const STORAGE_ITEM_TYPE_PATTERN = /(?:^minecraft:)?(?:[a-z_]+_)?shulker_box$/;

function getInventoryComponent(player: Player): EntityInventoryComponent {
  const inventory = player.getComponent(EntityComponentTypes.Inventory) as EntityInventoryComponent | undefined;
  if (!inventory) {
    throw new Error("minecraft:inventory component is not available for this player.");
  }

  return inventory;
}

function getEquippableComponent(player: Player): EntityEquippableComponent {
  const equippable = player.getComponent(EntityComponentTypes.Equippable) as EntityEquippableComponent | undefined;
  if (!equippable) {
    throw new Error("minecraft:equippable component is not available for this player.");
  }

  return equippable;
}

function createSnapshotId(identity: ResolvedPlayerIdentity): string {
  return `${identity.identityType}-${Date.now()}`;
}

function tryGetItemFromSlot(
  slotRef: ContainerSlot,
  context: string,
  slot?: number,
): ItemStack | undefined {
  try {
    return slotRef.getItem();
  } catch (error) {
    logger.warn("Failed to read item from container slot while creating inventory snapshot.", {
      context,
      slot,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function tryGetContainerSlot(
  container: Container,
  slot: number,
  context: string,
): ContainerSlot | undefined {
  try {
    return container.getSlot(slot);
  } catch (error) {
    logger.warn("Failed to access container slot while creating inventory snapshot.", {
      context,
      slot,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function safeSerializeItem(
  item: ItemStack | undefined,
  context: string,
  slot?: number,
) {
  if (!item) {
    return null;
  }

  try {
    return serializeItem(item, slot);
  } catch (error) {
    logger.warn("Skipping item while creating inventory snapshot.", {
      context,
      slot,
      typeId: item.typeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function itemRequiresPortableStorageCapture(typeId: string): boolean {
  return STORAGE_ITEM_TYPE_PATTERN.test(typeId);
}

function formatPortableStorageExclusion(
  location: string,
  typeId: string,
): string {
  return `${location} (${typeId})`;
}

export function getPortableStorageExclusions(snapshot: InventorySnapshot): string[] {
  const missing: string[] = [];

  snapshot.inventory.exclusions?.main?.forEach((entry) => {
    missing.push(formatPortableStorageExclusion(`inventory slot ${entry.slot}`, entry.typeId));
  });

  snapshot.inventory.exclusions?.equipment?.forEach((entry) => {
    missing.push(formatPortableStorageExclusion(`equipment ${entry.slot}`, entry.typeId));
  });

  return missing;
}

function createPortableStorageExclusion(
  typeId: string,
): { typeId: string; reason: "portable_storage_unsupported" } {
  return {
    typeId,
    reason: "portable_storage_unsupported",
  };
}

function shouldExcludePortableStorageItem(item: InventorySnapshot["inventory"]["main"][number]): item is NonNullable<typeof item> {
  return Boolean(item && itemRequiresPortableStorageCapture(item.typeId) && !item.storage);
}

export function createInventorySnapshot(
  player: Player,
  identity: ResolvedPlayerIdentity,
): InventorySnapshot {
  const inventoryComponent = getInventoryComponent(player);
  const equippableComponent = getEquippableComponent(player);
  const container = inventoryComponent.container;
  const slotCount = container.size;
  const excludedMain: NonNullable<NonNullable<InventorySnapshot["inventory"]["exclusions"]>["main"]> = [];
  const excludedEquipment: NonNullable<NonNullable<InventorySnapshot["inventory"]["exclusions"]>["equipment"]> = [];

  // Player inventories typically expose slots 0-8 as the hotbar and 9+ as the
  // main inventory, but we intentionally persist raw container indices.
  const main = Array.from({ length: slotCount }, (_, slot) => {
    const slotRef = tryGetContainerSlot(container, slot, "inventory");
    const item = slotRef ? tryGetItemFromSlot(slotRef, "inventory", slot) : undefined;
    const serialized = safeSerializeItem(item, "inventory", slot);

    if (shouldExcludePortableStorageItem(serialized)) {
      excludedMain.push({
        slot,
        ...createPortableStorageExclusion(serialized.typeId),
      });
      return null;
    }

    return serialized;
  });

  const headSlot = equippableComponent.getEquipmentSlot(EquipmentSlot.Head);
  const chestSlot = equippableComponent.getEquipmentSlot(EquipmentSlot.Chest);
  const legsSlot = equippableComponent.getEquipmentSlot(EquipmentSlot.Legs);
  const feetSlot = equippableComponent.getEquipmentSlot(EquipmentSlot.Feet);
  const offhandSlot = equippableComponent.getEquipmentSlot(EquipmentSlot.Offhand);

  function serializeEquipmentSlot(
    slotKey: InventoryEquipmentSlotKey,
    slotRef: ContainerSlot,
    context: string,
  ) {
    const serialized = safeSerializeItem(tryGetItemFromSlot(slotRef, context), context);

    if (shouldExcludePortableStorageItem(serialized)) {
      excludedEquipment.push({
        slot: slotKey,
        ...createPortableStorageExclusion(serialized.typeId),
      });
      return null;
    }

    return serialized;
  }

  const exclusions =
    excludedMain.length > 0 || excludedEquipment.length > 0
      ? {
          main: excludedMain.length > 0 ? excludedMain : undefined,
          equipment: excludedEquipment.length > 0 ? excludedEquipment : undefined,
        }
      : undefined;

  return {
    schemaVersion: config.schemaVersion,
    namespace: config.namespace,
    identityType: identity.identityType,
    playerKey: identity.playerKey,
    snapshotId: createSnapshotId(identity),
    savedAt: new Date().toISOString(),
    source: {
      serverId: config.serverId,
      worldId: config.worldId,
      worldName: config.worldName,
    },
    inventory: {
      selectedSlotIndex: player.selectedSlotIndex,
      exclusions,
      main,
      equipment: {
        head: serializeEquipmentSlot("head", headSlot, "equipment:head"),
        chest: serializeEquipmentSlot("chest", chestSlot, "equipment:chest"),
        legs: serializeEquipmentSlot("legs", legsSlot, "equipment:legs"),
        feet: serializeEquipmentSlot("feet", feetSlot, "equipment:feet"),
        offhand: serializeEquipmentSlot("offhand", offhandSlot, "equipment:offhand"),
      },
    },
  };
}

export function createInventoryOutline(player: Player): InventoryOutline {
  const inventoryComponent = getInventoryComponent(player);
  const equippableComponent = getEquippableComponent(player);
  const main: InventoryOutline["main"] = [];
  const equipment: InventoryOutline["equipment"] = [];

  for (let slot = 0; slot < inventoryComponent.container.size; slot += 1) {
    const slotRef = tryGetContainerSlot(inventoryComponent.container, slot, "inventory-outline");
    const item = slotRef ? tryGetItemFromSlot(slotRef, "inventory-outline", slot) : undefined;
    if (!item) {
      continue;
    }

    main.push({
      slot,
      typeId: item.typeId,
      amount: item.amount,
    });
  }

  const equipmentSlots: Array<[InventoryEquipmentSlotKey, EquipmentSlot]> = [
    ["head", EquipmentSlot.Head],
    ["chest", EquipmentSlot.Chest],
    ["legs", EquipmentSlot.Legs],
    ["feet", EquipmentSlot.Feet],
    ["offhand", EquipmentSlot.Offhand],
  ];

  for (const [slotKey, equipmentSlot] of equipmentSlots) {
    const item = tryGetItemFromSlot(equippableComponent.getEquipmentSlot(equipmentSlot), `equipment-outline:${slotKey}`);
    if (!item) {
      continue;
    }

    equipment.push({
      slot: slotKey,
      typeId: item.typeId,
      amount: item.amount,
    });
  }

  return { main, equipment };
}
