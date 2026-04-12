import { CommandPermissionLevel } from "@minecraft/server";

export const config = {
  schemaVersion: 1,
  namespace: "invsync",
  apiBaseUrl: "https://your-invsync-api.example.com",
  apiToken: "replace-me",
  requestTimeoutMs: 5000,
  serverId: "server-a",
  worldId: "world_a",
  worldName: "World A",
  commandPermissionLevel: CommandPermissionLevel.Any,
} as const;
