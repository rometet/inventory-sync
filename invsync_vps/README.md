# InvSync API / BDS Sidecar

Node.js API and offline apply CLI for the InvSync Behavior Pack.

The API supports two usage patterns:

- BP/script mode: stores snapshots sent by the Behavior Pack and does not touch the BDS world DB.
- DB mode: copies the target world DB for save, then writes raw inventory/XP NBT back during an offline apply step.

## Build

```bash
npm install
npm run build
```

## Run for BP/script mode

Use this when you do not want Inventory Sync to read or write `world/db`.

```bash
export INVSYNC_API_TOKEN=replace-me
export INVSYNC_DATA_DIR=/srv/invsync-data
export INVSYNC_BIND_HOST=0.0.0.0
export PORT=3000

npm start
```

Supported endpoints in this mode:

- `POST /api/inventory/save`
- `POST /api/inventory/backup-before-load`
- `GET /api/inventory/load`
- `GET /api/inventory/load?source=backup`
- `POST /api/inventory/audit/load`
- `GET /api/inventory/status`

## Run for DB mode

Use this when you need raw NBT and XP restore. Configure a world DB source for each server ID.

```bash
export INVSYNC_API_TOKEN=replace-me
export INVSYNC_DATA_DIR=/srv/invsync-data
export INVSYNC_BIND_HOST=0.0.0.0
export PORT=3000

export INVSYNC_WORLD_SOURCE_SURVIVAL_TYPE=local
export INVSYNC_WORLD_SOURCE_SURVIVAL_DB_PATH="/srv/bds/survival/worlds/Bedrock level/db"

export INVSYNC_WORLD_SOURCE_RESOURCE_TYPE=local
export INVSYNC_WORLD_SOURCE_RESOURCE_DB_PATH="/srv/bds/resource/worlds/Bedrock level_new/db"

npm start
```

Supported DB source types:

- `local`: API process can read the local filesystem path.
- `ftp`: API downloads/uploads the DB directory over FTP.
- `ssh`: API downloads/uploads the DB directory over SSH.

Environment variable pattern:

- `INVSYNC_WORLD_SOURCE_<SERVER_ID>_TYPE`
- `INVSYNC_WORLD_SOURCE_<SERVER_ID>_DB_PATH`
- `INVSYNC_WORLD_SOURCE_<SERVER_ID>_HEADER_UUID`
- `INVSYNC_WORLD_SOURCE_<SERVER_ID>_FTP_HOST`
- `INVSYNC_WORLD_SOURCE_<SERVER_ID>_FTP_PORT`
- `INVSYNC_WORLD_SOURCE_<SERVER_ID>_FTP_USER`
- `INVSYNC_WORLD_SOURCE_<SERVER_ID>_FTP_PASSWORD`
- `INVSYNC_WORLD_SOURCE_<SERVER_ID>_FTP_SECURE`
- `INVSYNC_WORLD_SOURCE_<SERVER_ID>_SSH_HOST`
- `INVSYNC_WORLD_SOURCE_<SERVER_ID>_SSH_PORT`
- `INVSYNC_WORLD_SOURCE_<SERVER_ID>_SSH_USER`
- `INVSYNC_WORLD_SOURCE_<SERVER_ID>_SSH_KEY_PATH`

DB mode endpoints:

- `POST /api/inventory/save-db`
- `POST /api/inventory/restore/request`
- `GET /api/inventory/status`

## Apply Pending Restores

Run this only while the target BDS is stopped:

```bash
node dist/cli.js apply-pending --server-id survival
node dist/cli.js apply-pending --server-id resource
```

The CLI:

- reads pending restore files for the selected server
- saves a pre-apply backup of the current player DB inventory and XP
- writes only `Inventory`, `Armor`, `Offhand`, `SelectedInventorySlot`, and XP-related player tags
- marks the snapshot as consumed only after DB write succeeds
- appends readable audit logs

## Status

```bash
node dist/cli.js status --server-id survival
node dist/cli.js status --server-id resource
```

## Storage Layout

- Latest main snapshot:
  - `<dataDir>/<namespace>/<identityType>/<playerKey>.json`
- Automatic backups:
  - `<dataDir>/_backups/<namespace>/<identityType>/<playerKey>/latest.json`
  - `<dataDir>/_backups/<namespace>/<identityType>/<playerKey>/<timestamp>-<snapshotId>.json`
- Pending restores:
  - `<dataDir>/_pending_restores/<serverId>/<namespace>/<identityType>/<playerKey>.json`
- Applied restore history:
  - `<dataDir>/_pending_restores_applied/YYYY-MM-DD/<pendingId>.json`
- Audit log:
  - `<dataDir>/_audit/YYYY-MM-DD.ndjson`
  - `<dataDir>/_audit_readable/YYYY-MM-DD.log`

## Safety Notes

- `save-db` compares the live BP-visible main inventory outline with the copied DB outline. If they differ, save is rejected.
- Live DB copy is allowed, so a very recent inventory change may not be flushed yet. Retry save if the API reports a mismatch.
- Raw NBT restore is intentionally offline. Do not run `apply-pending` while BDS has the world DB open.
- Keep real tokens and server paths out of Git. Use environment variables on the deployment host.
