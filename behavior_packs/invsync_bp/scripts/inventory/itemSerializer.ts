import {
  ItemComponentTypes,
  ItemDurabilityComponent,
  ItemEnchantableComponent,
  ItemInventoryComponent,
  ItemStack,
} from "@minecraft/server";
import type { DynamicPropertyScalar, SerializedItem } from "../domain/types";
import { logger } from "../util/logger";

const MAX_ITEM_STORAGE_DEPTH = 8;

function normalizeEnchantmentId(id: string): string {
  return id.startsWith("minecraft:") ? id.slice("minecraft:".length) : id;
}

function logSkippedItemProperty(item: ItemStack, property: string, error: unknown): void {
  logger.warn("Skipping item property while serializing inventory.", {
    typeId: item.typeId,
    property,
    error: error instanceof Error ? error.message : String(error),
  });
}

function tryReadItemProperty<T>(
  item: ItemStack,
  property: string,
  reader: () => T,
): T | undefined {
  try {
    return reader();
  } catch (error) {
    logSkippedItemProperty(item, property, error);
    return undefined;
  }
}

function readDynamicProperties(item: ItemStack): Record<string, DynamicPropertyScalar> | undefined {
  const dynamicProperties: Record<string, DynamicPropertyScalar> = {};

  const propertyIds = tryReadItemProperty(item, "dynamicPropertyIds", () => item.getDynamicPropertyIds());
  if (!propertyIds) {
    return undefined;
  }

  for (const propertyId of propertyIds) {
    const value = tryReadItemProperty(item, `dynamicProperty:${propertyId}`, () => item.getDynamicProperty(propertyId));
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      dynamicProperties[propertyId] = value;
      continue;
    }

    if (value !== undefined) {
      logger.warn("Skipping unsupported item dynamic property.", {
        propertyId,
        typeId: item.typeId,
      });
    }
  }

  return Object.keys(dynamicProperties).length > 0 ? dynamicProperties : undefined;
}

function readStoredItems(item: ItemStack, depth: number): SerializedItem["storage"] | undefined {
  if (depth >= MAX_ITEM_STORAGE_DEPTH) {
    logger.warn("Skipping nested item storage because the maximum nesting depth was reached.", {
      typeId: item.typeId,
      depth,
    });
    return undefined;
  }

  const inventoryComponent = tryReadItemProperty(
    item,
    "inventoryComponent",
    () => item.getComponent(ItemComponentTypes.Inventory) as ItemInventoryComponent | undefined,
  );

  if (!inventoryComponent) {
    return undefined;
  }

  const container = tryReadItemProperty(item, "inventory.container", () => inventoryComponent.container);
  const containerSize = container ? tryReadItemProperty(item, "inventory.size", () => container.size) : undefined;

  if (!container || typeof containerSize !== "number") {
    return undefined;
  }

  return {
    size: containerSize,
    items: Array.from({ length: containerSize }, (_, nestedSlot) => {
      const nestedItem = tryReadItemProperty(item, `inventory.slot:${nestedSlot}`, () => container.getItem(nestedSlot));
      return serializeItem(nestedItem, nestedSlot, depth + 1);
    }),
  };
}

export function serializeItem(item: ItemStack | undefined, slot?: number, depth = 0): SerializedItem | null {
  if (!item) {
    return null;
  }

  const serialized: SerializedItem = {
    slot,
    typeId: item.typeId,
    amount: item.amount,
  };

  const keepOnDeath = tryReadItemProperty(item, "keepOnDeath", () => item.keepOnDeath);
  if (typeof keepOnDeath === "boolean") {
    serialized.keepOnDeath = keepOnDeath;
  }

  const lockMode = tryReadItemProperty(item, "lockMode", () => item.lockMode);
  if (typeof lockMode === "string") {
    serialized.lockMode = lockMode;
  }

  const nameTag = tryReadItemProperty(item, "nameTag", () => item.nameTag);
  if (nameTag) {
    serialized.nameTag = nameTag;
  }

  const lore = tryReadItemProperty(item, "lore", () => item.getLore());
  if (lore && lore.length > 0) {
    serialized.lore = lore;
  }

  const canDestroy = tryReadItemProperty(item, "canDestroy", () => item.getCanDestroy());
  if (canDestroy && canDestroy.length > 0) {
    serialized.canDestroy = canDestroy;
  }

  const canPlaceOn = tryReadItemProperty(item, "canPlaceOn", () => item.getCanPlaceOn());
  if (canPlaceOn && canPlaceOn.length > 0) {
    serialized.canPlaceOn = canPlaceOn;
  }

  const dynamicProperties = readDynamicProperties(item);
  if (dynamicProperties) {
    serialized.dynamicProperties = dynamicProperties;
  }

  const durabilityComponent = tryReadItemProperty(
    item,
    "durabilityComponent",
    () => item.getComponent(ItemComponentTypes.Durability) as ItemDurabilityComponent | undefined,
  );
  if (durabilityComponent) {
    serialized.durability = {
      damage: tryReadItemProperty(item, "durability.damage", () => durabilityComponent.damage),
      unbreakable: tryReadItemProperty(item, "durability.unbreakable", () => durabilityComponent.unbreakable),
    };
  }

  const enchantableComponent = tryReadItemProperty(
    item,
    "enchantableComponent",
    () => item.getComponent(ItemComponentTypes.Enchantable) as ItemEnchantableComponent | undefined,
  );
  if (enchantableComponent) {
    const enchantments = tryReadItemProperty(item, "enchantments", () => enchantableComponent.getEnchantments());
    if (enchantments && enchantments.length > 0) {
      serialized.enchantments = enchantments.map((enchantment) => ({
        type: normalizeEnchantmentId(enchantment.type.id),
        level: enchantment.level,
      }));
    }
  }

  const storage = readStoredItems(item, depth);
  if (storage) {
    serialized.storage = storage;
  }

  return serialized;
}
