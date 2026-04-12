import {
  Container,
  EnchantmentTypes,
  ItemComponentTypes,
  ItemDurabilityComponent,
  ItemEnchantableComponent,
  ItemInventoryComponent,
  ItemLockMode,
  ItemStack,
} from "@minecraft/server";
import type { Enchantment } from "@minecraft/server";
import type { SerializedItem } from "../domain/types";
import { logger } from "../util/logger";

const MAX_ITEM_STORAGE_DEPTH = 8;

function normalizeEnchantmentId(id: string): string {
  return id.includes(":") ? id : `minecraft:${id}`;
}

function isItemLockMode(value: string): value is ItemLockMode {
  return Object.values(ItemLockMode).includes(value as ItemLockMode);
}

function restoreStoredItems(item: ItemStack, data: SerializedItem, depth: number): void {
  if (!data.storage) {
    return;
  }

  if (depth >= MAX_ITEM_STORAGE_DEPTH) {
    logger.warn("Skipping nested item storage because the maximum nesting depth was reached.", {
      typeId: data.typeId,
      depth,
    });
    return;
  }

  let inventoryComponent: ItemInventoryComponent | undefined;

  try {
    inventoryComponent = item.getComponent(ItemComponentTypes.Inventory) as ItemInventoryComponent | undefined;
  } catch (error) {
    logger.warn("Failed to access item inventory component while restoring nested items.", {
      typeId: data.typeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (!inventoryComponent) {
    logger.warn("Stored item inventory data was provided for an item without an inventory component.", {
      typeId: data.typeId,
    });
    return;
  }

  let containerSize: number;

  try {
    containerSize = inventoryComponent.container.size;
  } catch (error) {
    logger.warn("Failed to access item inventory container while restoring nested items.", {
      typeId: data.typeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  restoreStoredItemsIntoContainer(inventoryComponent.container, data.storage.items, data.typeId, depth + 1);
}

function restoreStoredItemsIntoContainer(
  container: Container,
  items: Array<SerializedItem | null>,
  ownerTypeId: string,
  depth: number,
): void {
  let containerSize: number;

  try {
    containerSize = container.size;
  } catch (error) {
    logger.warn("Failed to access item inventory container while restoring nested items.", {
      typeId: ownerTypeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  items.forEach((nestedItem, index) => {
    if (!nestedItem) {
      return;
    }

    const targetSlot = nestedItem.slot ?? index;
    if (targetSlot < 0 || targetSlot >= containerSize) {
      logger.warn("Skipping nested item outside the current item inventory size.", {
        typeId: ownerTypeId,
        targetSlot,
        containerSize,
      });
      return;
    }

    try {
      container.setItem(targetSlot, createBaseItem(nestedItem));
    } catch (error) {
      logger.warn("Failed to place nested item into item inventory.", {
        typeId: ownerTypeId,
        targetSlot,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (!nestedItem.storage) {
      return;
    }

    try {
      const placedItem = container.getItem(targetSlot);
      if (!placedItem) {
        logger.warn("Nested item disappeared before its internal storage could be restored.", {
          typeId: ownerTypeId,
          targetSlot,
        });
        return;
      }

      restoreStoredItems(placedItem, nestedItem, depth);
      container.setItem(targetSlot, placedItem);
    } catch (error) {
      logger.warn("Failed to restore nested item storage.", {
        typeId: ownerTypeId,
        targetSlot,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function createBaseItem(data: SerializedItem): ItemStack {
  if (!data.typeId || !Number.isFinite(data.amount) || data.amount <= 0) {
    throw new Error("SerializedItem is missing a valid typeId or amount.");
  }

  const item = new ItemStack(data.typeId, data.amount);

  if (data.nameTag !== undefined) {
    item.nameTag = data.nameTag;
  }

  if (data.lore) {
    item.setLore(data.lore);
  }

  if (typeof data.keepOnDeath === "boolean") {
    item.keepOnDeath = data.keepOnDeath;
  }

  if (typeof data.lockMode === "string" && isItemLockMode(data.lockMode)) {
    item.lockMode = data.lockMode;
  }

  if (Array.isArray(data.canDestroy)) {
    item.setCanDestroy(data.canDestroy);
  }

  if (Array.isArray(data.canPlaceOn)) {
    item.setCanPlaceOn(data.canPlaceOn);
  }

  if (data.durability) {
    const durabilityComponent = item.getComponent(
      ItemComponentTypes.Durability,
    ) as ItemDurabilityComponent | undefined;

    if (durabilityComponent) {
      if (typeof data.durability.damage === "number") {
        durabilityComponent.damage = data.durability.damage;
      }

      if (typeof data.durability.unbreakable === "boolean") {
        durabilityComponent.unbreakable = data.durability.unbreakable;
      }
    } else {
      logger.warn("Durability data was provided for an item without durability.", {
        typeId: data.typeId,
      });
    }
  }

  if (Array.isArray(data.enchantments) && data.enchantments.length > 0) {
    const enchantableComponent = item.getComponent(
      ItemComponentTypes.Enchantable,
    ) as ItemEnchantableComponent | undefined;

    if (enchantableComponent) {
      const enchantmentsToAdd: Enchantment[] = [];

      for (const enchantmentData of data.enchantments) {
        const enchantmentType = EnchantmentTypes.get(normalizeEnchantmentId(enchantmentData.type));
        if (!enchantmentType) {
          logger.warn("Skipping unknown enchantment.", enchantmentData);
          continue;
        }

        const enchantment: Enchantment = {
          type: enchantmentType,
          level: enchantmentData.level,
        };

        if (!enchantableComponent.canAddEnchantment(enchantment)) {
          logger.warn("Skipping incompatible enchantment.", {
            typeId: data.typeId,
            enchantment: enchantmentData.type,
          });
          continue;
        }

        enchantmentsToAdd.push(enchantment);
      }

      if (enchantmentsToAdd.length > 0) {
        enchantableComponent.addEnchantments(enchantmentsToAdd);
      }
    } else {
      logger.warn("Enchantments were provided for an item without enchantable component.", {
        typeId: data.typeId,
      });
    }
  }

  if (data.dynamicProperties) {
    for (const [propertyId, value] of Object.entries(data.dynamicProperties)) {
      try {
        item.setDynamicProperty(propertyId, value);
      } catch (error) {
        logger.warn("Failed to restore item dynamic property.", {
          propertyId,
          typeId: data.typeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return item;
}

export function deserializeItem(data: SerializedItem): ItemStack {
  return createBaseItem(data);
}

export function hydrateItemStorage(item: ItemStack, data: SerializedItem): ItemStack {
  restoreStoredItems(item, data, 0);
  return item;
}
