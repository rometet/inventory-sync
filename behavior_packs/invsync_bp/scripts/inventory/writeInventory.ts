import {
  Container,
  EntityComponentTypes,
  EntityEquippableComponent,
  EntityInventoryComponent,
  EquipmentSlot,
  Player,
  system,
} from "@minecraft/server";
import { deserializeItem, hydrateItemStorage } from "./itemDeserializer";
import type { InventoryEquipmentSlotKey, InventorySnapshot, SerializedItem } from "../domain/types";
import { isInventorySnapshot } from "../domain/types";
import { logger } from "../util/logger";

const ARMOR_SLOTS: Array<[keyof InventorySnapshot["inventory"]["equipment"], EquipmentSlot]> = [
  ["head", EquipmentSlot.Head],
  ["chest", EquipmentSlot.Chest],
  ["legs", EquipmentSlot.Legs],
  ["feet", EquipmentSlot.Feet],
  ["offhand", EquipmentSlot.Offhand],
];

export interface ApplyInventoryResult {
  skippedPortableStorage: string[];
  warnings: string[];
}

export interface ClearSyncedInventoryResult {
  skippedPortableStorage: string[];
  warnings: string[];
}

function getExcludedMainSlots(snapshot: InventorySnapshot): Set<number> {
  return new Set(snapshot.inventory.exclusions?.main?.map((entry) => entry.slot) ?? []);
}

function getExcludedEquipmentSlots(snapshot: InventorySnapshot): Set<InventoryEquipmentSlotKey> {
  return new Set(snapshot.inventory.exclusions?.equipment?.map((entry) => entry.slot) ?? []);
}

function describePortableStorageSkips(snapshot: InventorySnapshot): string[] {
  const skipped: string[] = [];

  snapshot.inventory.exclusions?.main?.forEach((entry) => {
    skipped.push(`inventory slot ${entry.slot} (${entry.typeId})`);
  });

  snapshot.inventory.exclusions?.equipment?.forEach((entry) => {
    skipped.push(`equipment ${entry.slot} (${entry.typeId})`);
  });

  return skipped;
}

function restoreInventorySlot(
  container: Container,
  slot: number,
  itemData: SerializedItem,
  warnings: string[],
): void {
  if (slot < 0 || slot >= container.size) {
    warnings.push(`Slot ${slot} is outside the current inventory size and was skipped.`);
    return;
  }

  try {
    container.setItem(slot, deserializeItem(itemData));

    if (!itemData.storage) {
      return;
    }

    const placedItem = container.getItem(slot);
    if (!placedItem) {
      warnings.push(`Failed to re-read slot ${slot} after placing a storage item.`);
      return;
    }

    container.setItem(slot, hydrateItemStorage(placedItem, itemData));
  } catch (error) {
    warnings.push(`Failed to restore the item in slot ${slot}.`);
    logger.warn("Failed to restore inventory slot.", {
      slot,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function restoreEquipmentItem(
  equippable: EntityEquippableComponent,
  equipmentSlot: EquipmentSlot,
  key: keyof InventorySnapshot["inventory"]["equipment"],
  itemData: SerializedItem,
  warnings: string[],
): void {
  try {
    const success = equippable.setEquipment(equipmentSlot, deserializeItem(itemData));
    if (!success) {
      warnings.push(`Failed to restore the ${key} equipment slot.`);
      return;
    }

    if (!itemData.storage) {
      return;
    }

    const placedItem = equippable.getEquipment(equipmentSlot);
    if (!placedItem) {
      warnings.push(`Failed to re-read the ${key} equipment slot after placing a storage item.`);
      return;
    }

    const persisted = equippable.setEquipment(equipmentSlot, hydrateItemStorage(placedItem, itemData));
    if (!persisted) {
      warnings.push(`Failed to persist nested item storage in the ${key} equipment slot.`);
    }
  } catch (error) {
    warnings.push(`Failed to restore the ${key} equipment slot.`);
    logger.warn("Failed to restore equipment slot.", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function restoreEquipment(
  equippable: EntityEquippableComponent,
  equipment: InventorySnapshot["inventory"]["equipment"],
  warnings: string[],
): void {
  for (const [key, equipmentSlot] of ARMOR_SLOTS) {
    const itemData = equipment[key];
    if (!itemData) {
      continue;
    }

    restoreEquipmentItem(equippable, equipmentSlot, key, itemData, warnings);
  }
}

function clearInventoryForSnapshot(
  player: Player,
  snapshot: InventorySnapshot,
): ClearSyncedInventoryResult {
  const inventory = player.getComponent(EntityComponentTypes.Inventory) as EntityInventoryComponent | undefined;
  if (!inventory) {
    throw new Error("minecraft:inventory component is not available.");
  }

  const equippable = player.getComponent(EntityComponentTypes.Equippable) as EntityEquippableComponent | undefined;
  if (!equippable) {
    throw new Error("minecraft:equippable component is not available.");
  }

  const warnings: string[] = [];
  const skippedPortableStorage = describePortableStorageSkips(snapshot);
  const excludedMainSlots = getExcludedMainSlots(snapshot);
  const excludedEquipmentSlots = getExcludedEquipmentSlots(snapshot);

  for (let slot = 0; slot < inventory.container.size; slot += 1) {
    if (excludedMainSlots.has(slot)) {
      continue;
    }

    try {
      inventory.container.setItem(slot, undefined);
    } catch (error) {
      warnings.push(`Failed to clear inventory slot ${slot}.`);
      logger.warn("Failed to clear inventory slot after save.", {
        slot,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const [key, equipmentSlot] of ARMOR_SLOTS) {
    if (excludedEquipmentSlots.has(key)) {
      continue;
    }

    try {
      const success = equippable.setEquipment(equipmentSlot, undefined);
      if (!success) {
        warnings.push(`Failed to clear equipment ${key}.`);
      }
    } catch (error) {
      warnings.push(`Failed to clear equipment ${key}.`);
      logger.warn("Failed to clear equipment slot after save.", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { skippedPortableStorage, warnings };
}

export function clearSyncedInventory(player: Player, snapshot: InventorySnapshot): Promise<ClearSyncedInventoryResult> {
  return new Promise((resolve, reject) => {
    system.run(() => {
      try {
        if (!player.isValid) {
          throw new Error("Player became invalid before inventory clearing started.");
        }

        resolve(clearInventoryForSnapshot(player, snapshot));
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function applyInventorySnapshot(player: Player, snapshot: unknown): Promise<ApplyInventoryResult> {
  if (!isInventorySnapshot(snapshot)) {
    throw new Error("Inventory snapshot payload is invalid.");
  }

  return new Promise((resolve, reject) => {
    system.run(() => {
      try {
        if (!player.isValid) {
          throw new Error("Player became invalid before inventory restoration started.");
        }

        const inventory = player.getComponent(EntityComponentTypes.Inventory) as EntityInventoryComponent | undefined;
        if (!inventory) {
          throw new Error("minecraft:inventory component is not available.");
        }

        const equippable = player.getComponent(EntityComponentTypes.Equippable) as EntityEquippableComponent | undefined;
        if (!equippable) {
          throw new Error("minecraft:equippable component is not available.");
        }

        const warnings: string[] = [];
        const skippedPortableStorage = describePortableStorageSkips(snapshot);
        const excludedMainSlots = getExcludedMainSlots(snapshot);
        const excludedEquipmentSlots = getExcludedEquipmentSlots(snapshot);

        for (let slot = 0; slot < inventory.container.size; slot += 1) {
          if (excludedMainSlots.has(slot)) {
            continue;
          }

          inventory.container.setItem(slot, undefined);
        }

        for (const [key, equipmentSlot] of ARMOR_SLOTS) {
          if (excludedEquipmentSlots.has(key)) {
            continue;
          }

          equippable.setEquipment(equipmentSlot, undefined);
        }

        snapshot.inventory.main.forEach((itemData, index) => {
          if (!itemData) {
            return;
          }

          const targetSlot = itemData.slot ?? index;
          if (excludedMainSlots.has(targetSlot)) {
            return;
          }

          restoreInventorySlot(inventory.container, targetSlot, itemData, warnings);
        });

        restoreEquipment(equippable, snapshot.inventory.equipment, warnings);

        if (
          typeof snapshot.inventory.selectedSlotIndex === "number" &&
          snapshot.inventory.selectedSlotIndex >= 0 &&
          snapshot.inventory.selectedSlotIndex < Math.min(9, inventory.container.size)
        ) {
          player.selectedSlotIndex = snapshot.inventory.selectedSlotIndex;
        }

        resolve({ skippedPortableStorage, warnings });
      } catch (error) {
        reject(error);
      }
    });
  });
}
