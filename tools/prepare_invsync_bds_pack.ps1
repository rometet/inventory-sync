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

$bundleConfigJs = Join-Path $bundleScriptsRoot "util\config.js"
if (Test-Path $bundleConfigJs) {
    $configJs = Get-Content -Raw -Encoding UTF8 -LiteralPath $bundleConfigJs
    $configJs = $configJs.Replace(
        'apiBaseUrl: "https://your-invsync-api.example.com"',
        'apiBaseUrl: "' + $ApiBaseUrl.TrimEnd("/") + '"'
    )
    Set-Content -LiteralPath $bundleConfigJs -Value $configJs -Encoding UTF8
}

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
$forceHttps = if ($ApiBaseUrl.Trim().ToLowerInvariant().StartsWith("https://")) { "true" } else { "false" }
$permissions = $permissions.Replace('"force_https": true', '"force_https": ' + $forceHttps)
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
- adminTag

apiBaseUrl and apiToken in scripts/util/config.js should match your own VPS.

## Commands

- /invsync:inventory status
- /invsync:inventory save
- /invsync:inventory load
- /invsync:inventory loadbackup
- /invsync:inventorybp status
- /invsync:inventorybp save
- /invsync:inventorybp load
- /invsync:inventorybp loadbackup
- /invsync:savebp
- /invsync:loadbp
- /invsync:loadbpbackup
- /invsync:statusbp

## Notes

- For multiple worlds, use different serverId / worldId / worldName values per world.
- Save reads inventory and XP from the BDS-local sidecar's world DB snapshot.
- After save succeeds, the player's current inventory/equipment/XP is cleared.
- Load and loadbackup create offline restore reservations instead of applying items immediately.
- Restore reservations require the configured adminTag, default invsync_admin.
- Stop BDS and run node dist/cli.js apply-pending --server-id <serverId> on the sidecar host to apply a pending restore.
- Each saved snapshot can be applied only once. Run save again to create a new loadable snapshot.
- BP/script mode commands use scriptNamespace=invsync_script and apply immediately without stopping BDS.
- BP/script mode can only restore what Bedrock Script API can serialize; use DB mode for full raw NBT restore.
- BP/script mode does not clear or restore XP; use DB mode when XP sharing is required.
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
- adminTag

## External API

- Base URL: $ApiBaseUrl
- Auth: bearer token configured

## Sync Limits

- Save uses the BDS-local sidecar to read raw inventory and XP NBT from the world DB.
- After save succeeds, the player's current inventory/equipment/XP is cleared.
- Load and loadbackup create offline restore reservations.
- Restore reservations require the configured adminTag.
- Stop BDS and run node dist/cli.js apply-pending --server-id <serverId> on the sidecar host to apply a pending restore.
- The latest automatic backup can be reserved with /invsync:inventory loadbackup.
- BP/script mode is available with /invsync:inventorybp save/load/loadbackup/status and the short aliases /invsync:savebp, /invsync:loadbp, /invsync:loadbpbackup, /invsync:statusbp.
- BP/script mode stores data under scriptNamespace=invsync_script and restores immediately while BDS is running.
- BP/script mode is less complete than DB raw NBT mode and should be used when online convenience is more important than perfect NBT fidelity.
- BP/script mode does not clear or restore XP; use DB mode when XP sharing is required.

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
