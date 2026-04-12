param(
    [string]$WorkspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$ApiBaseUrl = "https://your-invsync-api.example.com"
)

$ErrorActionPreference = "Stop"

$sourcePackRoot = Join-Path $WorkspaceRoot "behavior_packs\invsync_bp"
$sourceManifestPath = Join-Path $sourcePackRoot "manifest.json"
$sourceDistRoot = Join-Path $sourcePackRoot "dist"

$bundleRoot = Join-Path $WorkspaceRoot "bds_ready\invsync_bundle"
$bundlePackRoot = Join-Path $bundleRoot "behavior_packs\invsync_bp"
$bundleScriptsRoot = Join-Path $bundlePackRoot "scripts"
$bundleConfigRoot = Join-Path $bundleRoot "config"
$zipPath = Join-Path $WorkspaceRoot "bds_ready\invsync_bds_bundle.zip"

if (-not (Test-Path $sourceManifestPath)) {
    throw "Source manifest not found: $sourceManifestPath"
}

if (-not (Test-Path $sourceDistRoot)) {
    throw "Compiled dist folder not found: $sourceDistRoot. Run the TypeScript build first."
}

$manifest = Get-Content -Raw $sourceManifestPath | ConvertFrom-Json
$scriptModule = $manifest.modules | Where-Object { $_.type -eq "script" } | Select-Object -First 1

if (-not $scriptModule) {
    throw "No script module found in manifest.json"
}

$moduleUuid = $scriptModule.uuid
$packName = $manifest.header.name

if (Test-Path $bundleRoot) {
    Remove-Item -LiteralPath $bundleRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $bundleScriptsRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $bundleConfigRoot $moduleUuid) -Force | Out-Null

$releaseManifest = [ordered]@{
    format_version = $manifest.format_version
    header = $manifest.header
    modules = @()
    dependencies = $manifest.dependencies
}

foreach ($module in $manifest.modules) {
    $copy = [ordered]@{}
    foreach ($property in $module.PSObject.Properties) {
        if ($property.Name -eq "entry" -and $module.type -eq "script") {
            $copy[$property.Name] = "scripts/main.js"
        } else {
            $copy[$property.Name] = $property.Value
        }
    }
    $releaseManifest.modules += $copy
}

$releaseManifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $bundlePackRoot "manifest.json") -Encoding UTF8

Copy-Item -Path (Join-Path $sourceDistRoot "*") -Destination $bundleScriptsRoot -Recurse -Force

$permissions = @'
{
  "allowed_modules": [
    "@minecraft/server",
    "@minecraft/server-net"
  ],
  "module_permissions": {
    "@minecraft/server-net": {
      "allowed_uris": [
        "__API_BASE_URL__/"
      ],
      "force_https": true,
      "max_body_bytes": 1048576,
      "max_concurrent_requests": 1
    }
  }
}
'@
$permissions = $permissions.Replace("__API_BASE_URL__", $ApiBaseUrl.TrimEnd("/"))
Set-Content -LiteralPath (Join-Path (Join-Path $bundleConfigRoot $moduleUuid) "permissions.json") -Value $permissions -Encoding UTF8

$setupGuide = @"
# InvSync BDS Bundle

This bundle is prepared for Minecraft Bedrock Dedicated Server.

## Contents

- behavior_packs/invsync_bp
  Runtime-only Behavior Pack files
- config/$moduleUuid/permissions.json
  Module-specific permission file for @minecraft/server-net

## Install To BDS

1. Copy behavior_packs/invsync_bp into your BDS behavior_packs folder.
2. Copy config/$moduleUuid into your BDS config folder.
3. Enable the behavior pack for your target world.

## Edit Before Use

If needed, edit these values in behavior_packs/invsync_bp/scripts/util/config.js:

- serverId
- worldId
- worldName

apiBaseUrl and apiToken in scripts/util/config.js should match your own VPS.

## Commands

- /invsync:inventory status
- /invsync:inventory save
- /invsync:inventory load
- /invsync:inventory loadbackup

## Notes

- For multiple worlds, use different serverId / worldId / worldName values per world.
- Portable storage items such as shulker boxes are excluded from sync on the current server build.
- After save succeeds, synchronized inventory/equipment slots are cleared to reduce duplication risk.
- Excluded portable storage slots are left untouched during save clearing and load.
- Each saved snapshot can be loaded only once. Run save again to create a new loadable snapshot.
- Every load first stores a pre-load backup of the current inventory on the VPS.
- /invsync:inventory loadbackup restores the latest automatic pre-load backup.
- This bundle uses config/$moduleUuid/permissions.json instead of config/default/permissions.json.
- Development-only files such as node_modules and TypeScript sources are not included.

Generated from pack: $packName
Script module UUID: $moduleUuid
"@
Set-Content -LiteralPath (Join-Path $bundleRoot "INSTALL_BDS_JA.md") -Value $setupGuide -Encoding UTF8

$packReadme = @"
# InvSync BP (BDS Ready)

This pack is a runtime-only BDS build.

## Edit

If you need different world metadata, edit scripts/util/config.js and adjust:

- serverId
- worldId
- worldName

## External API

- Base URL: $ApiBaseUrl
- Auth: bearer token configured

## Sync Limits

- Portable storage items such as shulker boxes are excluded from sync on the current server build.
- When excluded items are present, save succeeds but those slots are omitted from the snapshot.
- After save succeeds, synchronized slots are cleared. Excluded portable storage slots are left unchanged.
- Each saved snapshot can be loaded only once. Run save again to create a new loadable snapshot.
- During load, excluded slots are left unchanged.
- Before each load, the current inventory is backed up on the VPS.
- The latest automatic backup can be restored with /invsync:inventory loadbackup.

## Required Server Config

Also deploy:

config/$moduleUuid/permissions.json
"@
Set-Content -LiteralPath (Join-Path $bundlePackRoot "README_BDS_JA.md") -Value $packReadme -Encoding UTF8

if (Test-Path $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

Compress-Archive -Path (Join-Path $bundleRoot "*") -DestinationPath $zipPath -Force

Write-Output "Bundle root: $bundleRoot"
Write-Output "Zip: $zipPath"
