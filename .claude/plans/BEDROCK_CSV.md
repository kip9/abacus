# AWS Bedrock Usage Sync for Claude Code

**Branch:** `feat/aws-bedrock-sync`

## Overview

Add support for importing and tracking AWS Bedrock usage from CloudWatch logs, enabling usage statistics tied to specific users via IAM user to email mapping.

## Log Format

CSV with columns: `timestamp`, `message` (JSON)

## Implementation Phases

1. Core Bedrock Sync Module (`src/lib/sync/bedrock.ts`)
2. CLI Commands (`scripts/cli/bedrock.ts`)
3. Identity Mapping (uses existing `identity_mappings` table)
4. Model Name Normalization
5. Export from sync module

## Files Created/Modified

- `src/lib/sync/bedrock.ts` - Core sync module
- `src/lib/sync/bedrock.test.ts` - Unit tests
- `scripts/cli/bedrock.ts` - CLI commands
- `scripts/cli/index.ts` - Register CLI commands
- `src/lib/utils.ts` - Model name normalization
- `src/lib/sync/index.ts` - Export bedrock module
