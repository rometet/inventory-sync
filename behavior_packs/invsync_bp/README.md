# InvSync BP

Minecraft Bedrock Dedicated Server 用のインベントリ共有 Behavior Pack です。

この BP は Node.js API と通信して、プレイヤーのインベントリを保存・復元します。用途に応じて、DB に触れない BP/script 方式と、world DB を使う DB 方式を使い分けます。

## 使い方の種類

| 方式 | DBに触れるか | 停止が必要か | 主なコマンド |
| --- | --- | --- | --- |
| BP/script方式 | 触れない | 不要 | `/invsync:inventorybp ...` |
| DB方式 | 触れる | 復元適用時のみ必要 | `/invsync:inventory ...` |

まず動作確認する場合は BP/script 方式を使ってください。XP や raw NBT を含めて正確に戻したい場合は DB 方式を使います。

## DBに触れない方式

BDS を停止せず、Script API で読める範囲のインベントリを API に保存します。復元もオンラインのまま即時適用します。

### コマンド

- `/invsync:inventorybp status`
- `/invsync:inventorybp save`
- `/invsync:inventorybp load`
- `/invsync:inventorybp loadbackup`

短縮形:

- `/invsync:statusbp`
- `/invsync:savebp`
- `/invsync:loadbp`
- `/invsync:loadbpbackup`

### 動作

- `savebp` は現在のインベントリと装備を保存し、保存できたものだけ消します。
- `loadbp` は保存済みスナップショットを即時復元し、成功後に消費します。
- `loadbpbackup` は直近の復元前バックアップを即時復元します。
- XP は対象外です。
- Script API から中身を読めない収納系アイテムは、ロスト防止のため消さない場合があります。

## DBに触れる方式

API 側が BDS の `world/db` を読んで、raw NBT と XP を含むスナップショットを保存します。復元は予約だけを作り、BDS 停止中に API 側 CLI で DB に反映します。

### コマンド

- `/invsync:inventory status`
- `/invsync:inventory save`
- `/invsync:inventory load`
- `/invsync:inventory loadbackup`

短縮形:

- `/invsync:status`
- `/invsync:save`
- `/invsync:load`
- `/invsync:loadbackup`

### 動作

- `save` は API に DB 読み取り保存を依頼し、保存成功後にゲーム内のインベントリ・装備・XP を消します。
- `load` と `loadbackup` は即時復元せず、オフライン復元予約を作ります。
- 復元予約を反映するには、対象 BDS を停止してから API 側で `node dist/cli.js apply-pending --server-id <serverId>` を実行します。
- スナップショットは DB 書き込み成功後にだけ消費されます。
- DB 復元系コマンドは `adminTag` を持つプレイヤーだけが使えます。

## 設定

`scripts/util/config.ts` を環境に合わせて編集します。

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

DB 方式の復元操作を許可するプレイヤーには、ゲーム内でタグを付けます。

```mcfunction
tag <playerName> add invsync_admin
```

## ビルド

```bash
npm install --legacy-peer-deps
npm run build
```

## 注意点

- `@minecraft/server-net` を使うため、対応する `permissions.json` が必要です。
- DB 方式の `save` は、BP から見えるインベントリ概要と DB 側の概要が一致しない場合に失敗します。直前にアイテムを動かした場合は、数秒待ってから再実行してください。
- API 側には保存、復元予約、オフライン反映、自動バックアップの監査ログが残ります。
- 公開前に `apiBaseUrl` と `apiToken` は必ず自分の環境の値へ置き換えてください。
