#!/bin/bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

export DEV_AGENT_FAMILY="${DEV_AGENT_FAMILY:-codex}"
export DEV_REVIEW_AGENT_FAMILY="${DEV_REVIEW_AGENT_FAMILY:-codex}"
export DEV_SCRIPT_NAME="script/dev_codex.sh"

exec bash "$SCRIPT_DIR/dev-workflow.sh" "$@"
