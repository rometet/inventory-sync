# InvSync VPS

Simple JSON storage API for the InvSync behavior pack.

Saved snapshots are single-use. A successful `GET /api/inventory/load`
marks the snapshot as consumed before returning it, so the same save data
cannot be loaded repeatedly.

## Endpoints

- `POST /api/inventory/save`
- `POST /api/inventory/backup-before-load`
- `GET /api/inventory/load`
- `GET /api/inventory/status`

Backup restore support:

- `GET /api/inventory/load?source=backup`
- `POST /api/inventory/audit/load?mode=backup`

## Build

```bash
npm install
npm run build
```

## Run

```bash
set INVSYNC_API_TOKEN=replace-me
set INVSYNC_DATA_DIR=E:\data\invsync
npm start
```

Environment variables:

- `INVSYNC_API_TOKEN`: required bearer token
- `INVSYNC_DATA_DIR`: data directory
- `INVSYNC_BIND_HOST`: bind host, default `127.0.0.1`
- `PORT`: listen port, default `3000`

## Storage Layout

- Latest main snapshot:
  - `<dataDir>/<namespace>/<identityType>/<playerKey>.json`
- Automatic pre-load backups:
  - `<dataDir>/_backups/<namespace>/<identityType>/<playerKey>/latest.json`
  - `<dataDir>/_backups/<namespace>/<identityType>/<playerKey>/<timestamp>-<snapshotId>.json`
- Audit log:
  - `<dataDir>/_audit/YYYY-MM-DD.ndjson`
  - `<dataDir>/_audit_readable/YYYY-MM-DD.log`

Audit events are written for:

- `save`
- `load`
- `load_backup`
- `backup_before_load`

Readable logs include:

- who triggered `save` or `load`
- when it happened in JST
- which world executed the action
- which world the restored snapshot originally came from
