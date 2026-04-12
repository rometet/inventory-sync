# Inventory Sync

Minecraft Bedrock Dedicated Server inventory sync project.

This repository contains:

- `behavior_packs/invsync_bp`
  - The Bedrock Behavior Pack source written in TypeScript
- `invsync_vps`
  - The Node.js API that stores snapshots and audit logs
- `tools/prepare_invsync_bds_pack.ps1`
  - A helper script that builds a BDS-ready bundle

## What It Does

- Saves a player's inventory and equipment to a VPS API
- Clears synchronized items after `save` to reduce duplication risk
- Allows each saved snapshot to be loaded only once
- Creates an automatic backup before each `load`
- Supports restoring the latest automatic backup with `loadbackup`
- Writes audit logs for `save`, `load`, and backup operations

## Before Use

This repository is sanitized for GitHub.

- Replace the placeholder values in `behavior_packs/invsync_bp/scripts/util/config.ts`
- Set your VPS environment variables for `invsync_vps`
- Update `tools/prepare_invsync_bds_pack.ps1` arguments or pass your API URL when generating a bundle

## Quick Start

Behavior Pack:

```bash
cd behavior_packs/invsync_bp
npm install
npm run build
```

VPS API:

```bash
cd invsync_vps
npm install
npm run build
npm start
```

Bundle generation:

```powershell
pwsh -File .\tools\prepare_invsync_bds_pack.ps1 -ApiBaseUrl "https://your-invsync-api.example.com"
```
