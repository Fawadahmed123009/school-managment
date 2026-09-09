@echo off
REM ──────────────────────────────────────────────────────────────
REM Windows batch wrapper for MongoDB backup script.
REM Use this in Windows Task Scheduler.
REM
REM Setup:
REM   1. Install Git for Windows (provides bash)
REM   2. Install MongoDB Database Tools (provides mongodump)
REM   3. R2 credentials set in .env (same as photo uploads, for cloud backup)
REM   4. In Task Scheduler, create a task that runs this .bat
REM      - Start in: C:\inetpub\wwwroot\httpdocs  (or your path)
REM      - Program:  C:\path\to\this\backupMongo.bat
REM      - Schedule: Daily at 3:00 AM (or your preference)
REM ──────────────────────────────────────────────────────────────

cd /d "%~dp0\.."
set "PATH=%PATH%;C:\Program Files\Git\bin;C:\Program Files\MongoDB\Tools\100\bin"

echo [%date% %time%] Starting MongoDB backup...
bash scripts\backupMongo.sh

if %ERRORLEVEL% EQU 0 (
    echo [%date% %time%] Backup completed successfully.
) else (
    echo [%date% %time%] Backup FAILED with error code %ERRORLEVEL%.
)
