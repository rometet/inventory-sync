# InvSync BP

Inventory sync behavior pack for Minecraft Bedrock Dedicated Server.

## Commands

- `/invsync:inventory save`
- `/invsync:inventory load`
- `/invsync:inventory loadbackup`
- `/invsync:inventory status`
- `/invsync:debugslot [slot]`

## Current Behavior

- Player identity is based on `player.name`.
- Inventory and equipment are saved to the InvSync VPS API.
- After `save` succeeds, synchronized inventory/equipment slots are cleared to reduce duplication risk.
- A saved snapshot can be loaded only once. Run `save` again to create a new loadable snapshot.
- Every `load` first saves a backup of the player's current inventory on the VPS.
- `/invsync:inventory loadbackup` restores the latest automatic pre-load backup from the VPS.
- Portable storage items such as shulker boxes are excluded from sync on the current server build.
- Excluded portable storage slots are left untouched during save clearing and load.

## Config

Edit `scripts/util/config.ts`:

```ts
export const config = {
  namespace: "invsync",
  apiBaseUrl: "https://your-invsync-api.example.com",
  apiToken: "replace-me",
  requestTimeoutMs: 5000,
  serverId: "world-a",
  worldId: "world_a",
  worldName: "World A",
};
```

## Build

```bash
npm install
npm run build
```

## Notes

- `@minecraft/server-net` requires a matching `permissions.json`.
- The API keeps an audit log for `save`, `load`, and automatic pre-load backups.
- Before publishing your pack, replace the placeholder API URL and token with your own values.
