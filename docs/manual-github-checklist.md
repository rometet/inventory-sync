# Manual GitHub Checklist

Use this file after pushing documentation updates.

## inventory-sync

### Description candidates

- Experimental self-hosted inventory sync system for Minecraft Bedrock Dedicated Server using a Behavior Pack and Node.js API.
- Self-hosted BDS inventory transfer project with audit logs, backup restore, and duplication prevention.

### About text candidates

- Self-hosted BDS inventory sync with audit logs and single-use load protection.
- Behavior Pack + Node.js API for Minecraft Bedrock inventory transfer.

### Topics candidates

- `minecraft-bedrock`
- `bedrock-dedicated-server`
- `typescript`
- `nodejs`
- `express`
- `self-hosted`
- `vps`

## BedrockBridge

### Description candidates

- Fork of BedrockBridge focused on self-hosted, multi-server Bedrock + Discord bridging.
- BedrockBridge fork with a compatible self-hosted Discord bot, multi-server routing, and setup docs.

### About text candidates

- Fork for self-hosted multi-server BedrockBridge deployment.
- BedrockBridge fork with a compatible Discord bot and self-host docs.

### Topics candidates

- `minecraft-bedrock`
- `discord-bot`
- `discordjs`
- `nodejs`
- `self-hosted`
- `multi-server`
- `fork`

## Recommended Pinned Repositories

Recommended order:

1. `inventory-sync`
2. `BedrockBridge`
3. your next standalone repo that is fully your own and not a fork

Reason:

- `inventory-sync` shows an original end-to-end project
- `BedrockBridge` shows practical fork-based customization and operation work
- the third slot should eventually show another original repo to balance the profile

## Profile README Setup

1. Create a public repository named `rometet`
2. Copy the draft from `docs/github-profile/README_PROFILE_DRAFT.md`
3. Adjust links to real repository URLs
4. Pin `inventory-sync` and `BedrockBridge`

## Release Setup

### inventory-sync

1. Create tag `v0.1.0`
2. Open a GitHub Release
3. Paste text from `docs/release-v0.1.0.md`
4. Attach extra assets only if they are sanitized

### BedrockBridge

1. Keep fork attribution visible
2. If you publish a release note, describe only your fork-specific additions
3. Do not present upstream features as if you created them

## Final UI Checks

- confirm the repository description is short and specific
- add only accurate topics
- make sure screenshots do not expose tokens or private URLs
- keep fork attribution visible on `BedrockBridge`
