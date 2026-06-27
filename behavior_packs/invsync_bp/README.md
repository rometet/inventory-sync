# InvSync BP

Inventory sync behavior pack for Minecraft Bedrock Dedicated Server.

The pack now uses the Node.js sidecar as the source of truth for saved inventory data. `save` asks the API to read the player's inventory and XP from the copied world DB and clears the in-game inventory/XP only after the DB snapshot is stored successfully.

It also exposes a separate BP/script mode for online immediate restore. DB mode uses `namespace: "invsync"` and BP mode uses `scriptNamespace: "invsync_script"`, so the two modes do not overwrite each other.

## Commands

### DB-backed mode

- `/invsync:inventory save`
- `/invsync:inventory load`
- `/invsync:inventory loadbackup`
- `/invsync:inventory status`
- `/invsync:save`
- `/invsync:load`
- `/invsync:loadbackup`
- `/invsync:status`

### BP/script immediate mode

- `/invsync:inventorybp save`
- `/invsync:inventorybp load`
- `/invsync:inventorybp loadbackup`
- `/invsync:inventorybp status`
- `/invsync:savebp`
- `/invsync:loadbp`
- `/invsync:loadbpbackup`
- `/invsync:statusbp`

### Debug

- `/invsync:debugslot [slot]`

## Current Behavior

- Player identity is based on `player.name`.
- `save` stores raw DB inventory and XP NBT on the sidecar API.
- `save` clears the player's current inventory, equipment, and XP after the DB-backed snapshot is stored successfully.
- `load` and `loadbackup` create an offline restore reservation instead of applying items immediately.
- Restore commands require the configured admin tag, default `invsync_admin`.
- The operator must stop BDS and run `node dist/cli.js apply-pending --server-id <serverId>` on the sidecar host.
- A saved snapshot is consumed only after the offline DB write succeeds.
- `savebp` saves the live Script API snapshot to `invsync_script`, then clears saved inventory/equipment slots. XP is not changed in BP/script mode.
- `loadbp` immediately applies a BP/script snapshot without stopping BDS and consumes the snapshot once.
- `loadbpbackup` immediately applies the latest BP/script pre-load backup once.
- `loadbp` and `loadbpbackup` are available to all players because they are separate from the admin-only DB restore reservation flow.
- If Script API cannot read a portable storage item's contents, `savebp` leaves that item uncleared to avoid losing contents.

## Config

Edit `scripts/util/config.ts`:

```ts
export const config = {
  namespace: "invsync",
  scriptNamespace: "invsync_script",
  apiBaseUrl: "https://your-invsync-api.example.com",
  apiToken: "replace-me",
  requestTimeoutMs: 5000,
  serverId: "resource",
  worldId: "bedrock_level_new",
  worldName: "Bedrock level_new",
  adminTag: "invsync_admin",
};
```

Give restore operators the tag in-game:

```mcfunction
tag <playerName> add invsync_admin
```

## Build

```bash
npm install --legacy-peer-deps
npm run build
```

## Notes

- `@minecraft/server-net` requires a matching `permissions.json`.
- `save` may fail if the copied DB is older than the live inventory. Wait a few seconds and retry.
- The API keeps readable audit logs for save, restore reservation, offline apply, and automatic backups.
- Before publishing your pack, replace the placeholder API URL and token with your own values.
