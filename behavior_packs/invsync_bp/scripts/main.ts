import { system } from "@minecraft/server";
import { registerInventoryCommand } from "./commands/inventoryCommand";

system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
  registerInventoryCommand(customCommandRegistry);
});
