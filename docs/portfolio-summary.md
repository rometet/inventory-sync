# Portfolio Summary

## Short Summary (100-150 chars, Japanese)

Minecraft Bedrock Dedicated Server 向けに、Behavior Pack と Node.js API を組み合わせた自己ホスト型インベントリ同期機能を実装。保存、復元、監査ログ、重複防止まで一通り担当。

## Medium Summary (around 300 chars, Japanese)

Minecraft Bedrock Dedicated Server で使うためのインベントリ同期システムを個人で設計・実装したプロジェクトです。Behavior Pack 側では save / load / loadbackup / status コマンド、インベントリのシリアライズと復元、同期対象スロットのクリア、重複防止ロジックを実装しました。VPS 側では Node.js / Express で JSON 保存 API、監査ログ、自動バックアップ、単回ロード制御を構築しています。

## Short Summary (English)

Self-hosted inventory sync system for Minecraft Bedrock Dedicated Server, combining a TypeScript Behavior Pack with a Node.js API, audit logging, backup restore, and simple duplication prevention.

## Technical Keywords

- Minecraft Bedrock Dedicated Server
- Bedrock Script API
- TypeScript
- Node.js
- Express
- JSON-based storage
- VPS deployment
- Audit logging
- Backup / restore workflow
- Self-hosted game tooling

## Scope I Handled

- Bedrock-side commands and serialization logic
- VPS API design and storage logic
- audit log design
- duplication prevention flow
- bundle preparation for BDS deployment
