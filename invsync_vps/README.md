# InvSync API / BDS Sidecar

InvSync Behavior Pack から呼び出される Node.js API と、DB 復元用のオフライン CLI です。

API は2つの使い方を持っています。

- BP/script方式: Behavior Pack から送られたスナップショットを保存し、BDS の `world/db` には触れません。
- DB方式: 対象ワールド DB をコピーして保存し、BDS 停止中に raw NBT と XP を DB へ書き戻します。

## ビルド

```bash
npm install
npm run build
```

## DBに触れない方式で起動する

Inventory Sync に `world/db` を読ませたり書かせたりしたくない場合の設定です。

```bash
export INVSYNC_API_TOKEN=replace-me
export INVSYNC_DATA_DIR=/srv/invsync-data
export INVSYNC_BIND_HOST=0.0.0.0
export PORT=3000

npm start
```

この方式で使う主な API:

- `POST /api/inventory/save`
- `POST /api/inventory/backup-before-load`
- `GET /api/inventory/load`
- `GET /api/inventory/load?source=backup`
- `POST /api/inventory/audit/load`
- `GET /api/inventory/status`

## DBに触れる方式で起動する

raw NBT や XP も含めて復元したい場合の設定です。サーバー ID ごとに DB の参照元を設定します。

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

対応している DB 参照元:

- `local`: API プロセスがローカルファイルシステム上の DB を読む/書く方式です。
- `ftp`: FTP で DB ディレクトリをダウンロード/アップロードする方式です。
- `ssh`: SSH で DB ディレクトリをダウンロード/アップロードする方式です。

環境変数の形式:

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

DB方式で使う主な API:

- `POST /api/inventory/save-db`
- `POST /api/inventory/restore/request`
- `GET /api/inventory/status`

## 復元予約をDBへ反映する

これは対象 BDS を停止している間だけ実行してください。

```bash
node dist/cli.js apply-pending --server-id survival
node dist/cli.js apply-pending --server-id resource
```

CLI の処理:

- 指定したサーバー ID の復元予約を読みます。
- 適用前のプレイヤー DB インベントリと XP をバックアップします。
- `Inventory`、`Armor`、`Offhand`、`SelectedInventorySlot`、XP 関連タグだけを書き戻します。
- DB 書き込み成功後にだけスナップショットを消費済みにします。
- 読める形式の監査ログを追記します。

## 状態確認

```bash
node dist/cli.js status --server-id survival
node dist/cli.js status --server-id resource
```

## データ保存先

- 最新スナップショット:
  - `<dataDir>/<namespace>/<identityType>/<playerKey>.json`
- 自動バックアップ:
  - `<dataDir>/_backups/<namespace>/<identityType>/<playerKey>/latest.json`
  - `<dataDir>/_backups/<namespace>/<identityType>/<playerKey>/<timestamp>-<snapshotId>.json`
- 復元予約:
  - `<dataDir>/_pending_restores/<serverId>/<namespace>/<identityType>/<playerKey>.json`
- 適用済み履歴:
  - `<dataDir>/_pending_restores_applied/YYYY-MM-DD/<pendingId>.json`
- 監査ログ:
  - `<dataDir>/_audit/YYYY-MM-DD.ndjson`
  - `<dataDir>/_audit_readable/YYYY-MM-DD.log`

## 安全上の注意

- `save-db` は BP から見えるインベントリ概要と、コピーした DB 側の概要を比較します。一致しない場合は保存を拒否します。
- ライブ DB のコピーは可能ですが、直近のインベントリ変更がまだ DB に反映されていないことがあります。その場合は少し待ってから再実行してください。
- raw NBT の復元は意図的にオフライン処理です。BDS がワールド DB を開いている間に `apply-pending` を実行しないでください。
- 実トークンや実サーバーパスは Git に入れず、運用環境の環境変数で設定してください。
