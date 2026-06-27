# Inventory Sync

Minecraft Bedrock Dedicated Server (BDS) 向けの、セルフホスト型インベントリ共有システムです。

Behavior Pack と Node.js API を組み合わせて、プレイヤーのインベントリを保存・復元します。用途に合わせて、BDS の `world/db` に触れないオンライン方式と、DB を読む/書く高精度方式を選べます。

## 使い方の全体像

Inventory Sync には2つの運用モードがあります。

| モード | DBに触れるか | BDS停止 | 主なコマンド | 向いている用途 |
| --- | --- | --- | --- | --- |
| BP/script方式 | 触れない | 不要 | `/invsync:inventorybp ...` | すぐにオンラインで保存・復元したい場合 |
| DB方式 | 触れる | 復元適用時のみ必要 | `/invsync:inventory ...` | XPやraw NBTを含めてできるだけ完全に移したい場合 |

迷った場合は、まずBP/script方式で動作確認してください。実運用でXPやraw NBTまで含めた移行が必要な場合だけDB方式を使います。

## 構成

```text
.
├─ behavior_packs/
│  └─ invsync_bp/              # Bedrock Behavior Pack source
├─ invsync_vps/                # Node.js API and offline apply CLI
├─ tools/
│  └─ prepare_invsync_bds_pack.ps1
├─ docs/
│  ├─ architecture.md
│  ├─ portfolio-summary.md
│  ├─ release-v0.1.0.md
│  └─ manual-github-checklist.md
└─ CHANGELOG.md
```

## 共通セットアップ

### 1. APIをビルドする

```bash
cd invsync_vps
npm install
npm run build
```

### 2. Behavior Packをビルドする

```bash
cd behavior_packs/invsync_bp
npm install --legacy-peer-deps
npm run build
```

### 3. Behavior Pack設定を変更する

`behavior_packs/invsync_bp/scripts/util/config.ts` を環境に合わせます。

```ts
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
```

複数サーバーで使う場合は、サーバーごとに `serverId` / `worldId` / `worldName` を変えてください。

### 4. BDSへ配置する

ビルド後に、次をBDSへ配置します。

- `behavior_packs/invsync_bp`
- `config/<script-module-uuid>/permissions.json`

`@minecraft/server-net` を使うため、`permissions.json` の `allowed_uris` にはAPIのURLを入れる必要があります。

バンドル生成スクリプトを使う場合:

```powershell
pwsh -File .\tools\prepare_invsync_bds_pack.ps1 -ApiBaseUrl "https://your-invsync-api.example.com"
```

生成物:

- `bds_ready/invsync_bundle`
- `bds_ready/invsync_bds_bundle.zip`

`bds_ready` は生成物なのでGit管理対象外です。

## パターンA: DBに触れない使い方

BP/script方式です。BDSの `world/db` をコピーしたり書き換えたりしません。BDSを止めずに、その場で保存・復元できます。

### API起動

DBパス設定は不要です。

```bash
export INVSYNC_API_TOKEN=replace-me
export INVSYNC_DATA_DIR=/srv/invsync-data
export INVSYNC_BIND_HOST=0.0.0.0
export PORT=3000

cd invsync_vps
npm start
```

### ゲーム内コマンド

```mcfunction
/invsync:inventorybp status
/invsync:inventorybp save
/invsync:inventorybp load
/invsync:inventorybp loadbackup
```

短縮エイリアス:

```mcfunction
/invsync:statusbp
/invsync:savebp
/invsync:loadbp
/invsync:loadbpbackup
```

### 動作

1. `/invsync:inventorybp save` でScript APIから読めるインベントリをAPIへ保存します。
2. 保存成功後、保存できたインベントリ/装備スロットをclearします。
3. XPは保存・復元・clearの対象外です。
4. `/invsync:inventorybp load` はBDSを止めずに即時復元します。
5. `/invsync:inventorybp loadbackup` は直前バックアップを即時復元します。

### 注意点

- Script APIから中身を安全に読めないポータブル収納アイテムは、保存後clearの対象から外します。
- XP共有はできません。
- raw NBT完全復元ではありません。
- オンラインで手早く移したい場合に向いています。

## パターンB: DBに触れる使い方

DB方式です。APIがBDSの `world/db` をコピーしてプレイヤーNBTを読み、復元時はBDS停止後にCLIでDBへ書き戻します。

XPやraw NBTを含めた復元に向いていますが、扱いを間違えるとプレイヤーデータを壊す可能性があります。

### API起動

DB方式では、対象サーバーごとにDBパスを設定します。

```bash
export INVSYNC_API_TOKEN=replace-me
export INVSYNC_DATA_DIR=/srv/invsync-data
export INVSYNC_BIND_HOST=0.0.0.0
export PORT=3000

export INVSYNC_WORLD_SOURCE_SURVIVAL_TYPE=local
export INVSYNC_WORLD_SOURCE_SURVIVAL_DB_PATH="/srv/bds/survival/worlds/Bedrock level/db"

export INVSYNC_WORLD_SOURCE_RESOURCE_TYPE=local
export INVSYNC_WORLD_SOURCE_RESOURCE_DB_PATH="/srv/bds/resource/worlds/Bedrock level_new/db"

cd invsync_vps
npm start
```

`TYPE` は `local` / `ftp` / `ssh` を指定できます。通常はAPIをBDSと同じホストまたは同じボリューム上で動かし、`local` を使うのが一番安全です。

### 復元管理者タグ

DB方式の `load` / `loadbackup` は復元予約を作る操作なので、管理者タグが必要です。

```mcfunction
tag <playerName> add invsync_admin
```

### ゲーム内コマンド

```mcfunction
/invsync:inventory status
/invsync:inventory save
/invsync:inventory load
/invsync:inventory loadbackup
```

短縮エイリアス:

```mcfunction
/invsync:status
/invsync:save
/invsync:load
/invsync:loadbackup
```

他アドオンと短縮名が競合する場合は、必ず `/invsync:inventory ...` の完全名を使ってください。

### 保存フロー

1. プレイヤーが `/invsync:inventory save` を実行します。
2. Behavior Packがプレイヤー識別子と見えているインベントリ概要をAPIへ送ります。
3. APIが設定済みの `world/db` をコピーし、LevelDB内のプレイヤーNBTを読みます。
4. JSON概要とraw NBTを保存します。
5. 保存成功後、プレイヤーのインベントリ/装備/XPをclearします。

### 復元フロー

1. 管理者タグを持つプレイヤーが `/invsync:inventory load` を実行します。
2. APIはその場でDBを書き換えず、保留中の復元予約を作ります。
3. 管理者が対象BDSを停止します。
4. APIホストでCLIを実行します。

```bash
cd invsync_vps
node dist/cli.js apply-pending --server-id survival
```

または:

```bash
node dist/cli.js apply-pending --server-id resource
```

5. CLIが現在のDB内インベントリ/XPをバックアップしてから、保存済みraw NBTを書き戻します。
6. 書き込み成功後にスナップショットを消費済みにします。
7. BDSを起動して復元結果を確認します。

### 注意点

- `apply-pending` は必ず対象BDSを停止してから実行してください。
- 稼働中BDSが開いているLevelDBへ直接書き込まないでください。
- 保存時のDBコピーは少し古い場合があります。DB上の内容とBPから見える内容が明らかに違う場合、保存は拒否されます。少し待って再実行してください。
- 保存済みスナップショットは一度だけ適用できます。
- DB方式とBP/script方式は別namespaceを使うため、保存データは混ざりません。

## APIエンドポイント

DB方式:

- `POST /api/inventory/save-db`
- `POST /api/inventory/restore/request`
- `GET /api/inventory/status`

BP/script方式:

- `POST /api/inventory/save`
- `POST /api/inventory/backup-before-load`
- `GET /api/inventory/load`
- `GET /api/inventory/load?source=backup`
- `POST /api/inventory/audit/load`

すべてBearer token認証を使います。

## 安全機構

- 保存成功後に元インベントリをclearして複製を防ぎます。
- DB方式の復元はBDS停止後のCLI適用に限定します。
- 復元前に現在のDBインベントリ/XPをバックアップします。
- スナップショットは一度だけ適用できます。
- 監査ログをJSONLと読みやすいログ形式で残します。
- DB方式の復元予約は `adminTag` を持つプレイヤーだけが作れます。

## 制限

- プレイヤー識別は現在 `player.name` ベースです。
- BP/script方式はXPを保存・復元しません。
- BP/script方式はScript APIが読める範囲だけを扱います。
- DB方式の復元はBDS停止とCLI適用が必要です。
- スナップショット保存はJSONファイルベースです。
- `loadbackup` は最新の自動バックアップを対象にします。

## 開発用コマンド

```bash
cd invsync_vps
npm run check
npm run build

cd ../behavior_packs/invsync_bp
npm run check
npm run build
```

## 関連ドキュメント

- [docs/architecture.md](docs/architecture.md)
- [docs/portfolio-summary.md](docs/portfolio-summary.md)
- [docs/release-v0.1.0.md](docs/release-v0.1.0.md)
- [CHANGELOG.md](CHANGELOG.md)
