import { CommandPermissionLevel } from "@minecraft/server";

export const config = {
  schemaVersion: 1,
  namespace: "invsync",
  scriptNamespace: "invsync_script",
  apiBaseUrl: "https://your-invsync-api.example.com",
  apiToken: "replace-me",
  requestTimeoutMs: 60000,
  serverId: "server-a",
  worldId: "world_a",
  worldName: "World A",
  adminTag: "invsync_admin",
  commandPermissionLevel: CommandPermissionLevel.Any,
} as const;
