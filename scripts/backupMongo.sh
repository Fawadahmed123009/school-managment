#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# MongoDB Atlas backup script
# - Runs mongodump → compressed archive in a local directory.
# - Optionally syncs to Google Drive via rclone.
# - Designed to run as a Windows Task Scheduler task (via Git Bash / WSL)
#   or a cron job on Linux.
#
# Usage:
#   bash scripts/backupMongo.sh
#
# Environment:
#   DB            — MongoDB connection string (read from .env if not exported)
#   RCLONE_REMOTE — rclone remote path, e.g. "gdrive:school-backups/mongo"
#   BACKUP_DIR    — local backup directory (default: ./backups/mongo)
#   RETAIN_DAYS   — how many days of local backups to keep (default: 7)
#
# Prerequisites:
#   1. mongodump installed (comes with MongoDB Database Tools)
#      Windows: download from https://www.mongodb.com/try/download/database-tools
#   2. rclone installed and configured (for Google Drive sync)
#      Install: https://rclone.org/install/
#      Config:  rclone config  (set up "gdrive" remote)
# ──────────────────────────────────────────────────────────────────
set -euo pipefail

# Load .env if it exists (for DB connection string)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/.env"
  set +a
fi

# ── Configuration ────────────────────────────────────────────────
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups/mongo}"
RETAIN_DAYS="${RETAIN_DAYS:-7}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"  # e.g. "gdrive:school-backups/mongo"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
DUMP_NAME="school-mgmt_${TIMESTAMP}"

# ── Create backup directory ──────────────────────────────────────
mkdir -p "$BACKUP_DIR"

echo "═══════════════════════════════════════════════════════════"
echo " MongoDB Backup — $(date)"
echo "═══════════════════════════════════════════════════════════"

# ── Check for connection string ─────────────────────────────────
if [ -z "${DB:-}" ]; then
  echo "ERROR: DB environment variable is not set."
  echo "  Set it in .env or export it before running this script."
  exit 1
fi

# ── Run mongodump ────────────────────────────────────────────────
echo ""
echo "→ Running mongodump..."
mongodump \
  --uri="$DB" \
  --archive="$BACKUP_DIR/${DUMP_NAME}.archive.gz" \
  --gzip

ARCHIVE_SIZE=$(du -h "$BACKUP_DIR/${DUMP_NAME}.archive.gz" | cut -f1)
echo "✓ Dump complete: ${DUMP_NAME}.archive.gz ($ARCHIVE_SIZE)"

# ── Clean up old local backups ──────────────────────────────────
echo ""
echo "→ Cleaning up local backups older than ${RETAIN_DAYS} days..."
DELETED=$(find "$BACKUP_DIR" -name "*.archive.gz" -mtime +${RETAIN_DAYS} -delete -print | wc -l)
echo "  Removed $DELETED old backup(s)."

# ── Sync to Google Drive via rclone ─────────────────────────────
if [ -n "$RCLONE_REMOTE" ]; then
  echo ""
  echo "→ Syncing to Google Drive ($RCLONE_REMOTE)..."
  if command -v rclone &> /dev/null; then
    rclone copy "$BACKUP_DIR" "$RCLONE_REMOTE" \
      --include "*.archive.gz" \
      --transfers=2 \
      --verbose=1
    echo "✓ Sync complete."

    # Also clean old remote backups
    echo "→ Cleaning remote backups older than ${RETAIN_DAYS} days..."
    rclone delete "$RCLONE_REMOTE" \
      --include "*.archive.gz" \
      --min-age "${RETAIN_DAYS}d" \
      --verbose=1 2>/dev/null || true
    echo "✓ Remote cleanup done."
  else
    echo "  WARNING: rclone not found. Skipping Google Drive sync."
    echo "  Install rclone: https://rclone.org/install/"
  fi
else
  echo ""
  echo "  NOTE: RCLONE_REMOTE not set. Skipping cloud sync."
  echo "  To enable: export RCLONE_REMOTE=gdrive:school-backups/mongo"
fi

# ── Summary ──────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Backup summary"
echo "  Local:  $BACKUP_DIR/${DUMP_NAME}.archive.gz ($ARCHIVE_SIZE)"
echo "  Retain: $RETAIN_DAYS days"
TOTAL_LOCAL=$(find "$BACKUP_DIR" -name "*.archive.gz" | wc -l)
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
echo "  Total local backups: $TOTAL_LOCAL ($TOTAL_SIZE)"
echo "═══════════════════════════════════════════════════════════"
echo "✓ All done."
