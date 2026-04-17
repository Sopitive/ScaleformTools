#!/usr/bin/env node
/**
 * GFX Live Edit Watcher
 *
 * Monitors a staging folder for exported .gfx files and copies them to the
 * original game directory, backing up the original first.
 *
 * Usage:
 *   node watcher.mjs --watch <staging-dir> --source <game-file> [--backup-dir <dir>] [--interval <ms>]
 *
 * Example:
 *   node watcher.mjs \
 *     --watch "C:\Users\Wyatt\Desktop\gfx-staging" \
 *     --source "C:\Program Files (x86)\Steam\steamapps\common\Halo The Master Chief Collection\data\ui\Screens\loadingscreen.gfx" \
 *     --backup-dir "C:\Users\Wyatt\Desktop\gfx-backups"
 *
 * Notes:
 *   - Run as administrator if the destination is inside Program Files.
 *   - The backup of the original file is created once per watcher session (first copy).
 *   - Only the file matching the basename of --source is watched.
 */

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Parse arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

const watchDir  = getArg('--watch');
const sourceFile = getArg('--source');
const interval  = parseInt(getArg('--interval') ?? '500', 10);

if (!watchDir || !sourceFile) {
  console.error('GFX Live Edit Watcher\n');
  console.error('Usage:');
  console.error('  node watcher.mjs --watch <staging-dir> --source <game-file> [--backup-dir <dir>] [--interval <ms>]\n');
  console.error('Arguments:');
  console.error('  --watch       Folder the GFX Editor exports to (staging area)');
  console.error('  --source      Original game .gfx file to overwrite on each export');
  console.error('  --backup-dir  Where to save backups (default: <source-dir>/gfx-backups)');
  console.error('  --interval    Poll interval in milliseconds (default: 500)\n');
  console.error('Note: Run as administrator if the game is installed under Program Files.');
  process.exit(1);
}

const sourceDir = path.dirname(sourceFile);
const filename  = path.basename(sourceFile);
const stagingFile = path.join(watchDir, filename);

const backupDir = getArg('--backup-dir') ?? path.join(sourceDir, 'gfx-backups');

// ---------------------------------------------------------------------------
// Startup checks
// ---------------------------------------------------------------------------
if (!fs.existsSync(watchDir)) {
  try {
    fs.mkdirSync(watchDir, { recursive: true });
    console.log(`[init] Created staging folder: ${watchDir}`);
  } catch (err) {
    console.error(`[error] Cannot create staging folder: ${err.message}`);
    process.exit(1);
  }
}

try {
  fs.mkdirSync(backupDir, { recursive: true });
} catch (err) {
  console.error(`[error] Cannot create backup folder: ${err.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Backup original (once per session)
// ---------------------------------------------------------------------------
let backedUp = false;

function ensureBackup() {
  if (backedUp) return true;
  if (!fs.existsSync(sourceFile)) {
    // Source doesn't exist yet — nothing to back up
    backedUp = true;
    return true;
  }
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    const backupPath = path.join(backupDir, `${base}_backup_${ts}${ext}`);
    fs.copyFileSync(sourceFile, backupPath);
    console.log(`[backup] Original saved to: ${backupPath}`);
    backedUp = true;
    return true;
  } catch (err) {
    console.error(`[error] Backup failed: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Watch loop
// ---------------------------------------------------------------------------
let lastMtime = 0;
let lastSize  = 0;

function checkAndCopy() {
  if (!fs.existsSync(stagingFile)) return;

  let stat;
  try {
    stat = fs.statSync(stagingFile);
  } catch {
    return;
  }

  // Only act when the file has actually changed
  if (stat.mtimeMs === lastMtime && stat.size === lastSize) return;

  // Wait until the file isn't being written (size stable for one more tick)
  if (stat.size !== lastSize) {
    lastSize = stat.size;
    return; // check again next interval
  }

  lastMtime = stat.mtimeMs;
  lastSize  = stat.size;

  if (!ensureBackup()) return;

  try {
    fs.copyFileSync(stagingFile, sourceFile);
    const now = new Date().toLocaleTimeString();
    const kb  = (stat.size / 1024).toFixed(1);
    console.log(`[copy] ${filename} (${kb} KB) → ${sourceFile}  [${now}]`);
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      console.error(`[error] Permission denied writing to: ${sourceFile}`);
      console.error(`        Try running this script as Administrator.`);
    } else {
      console.error(`[error] Copy failed: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('');
console.log('  GFX Live Edit Watcher');
console.log('  ─────────────────────────────────────────────────────────────');
console.log(`  Watching:   ${stagingFile}`);
console.log(`  Copying to: ${sourceFile}`);
console.log(`  Backups:    ${backupDir}`);
console.log(`  Interval:   ${interval} ms`);
console.log('  Press Ctrl+C to stop.');
console.log('');

setInterval(checkAndCopy, interval);

// Trap Ctrl+C for a clean exit message
process.on('SIGINT', () => {
  console.log('\n[watcher] Stopped.');
  process.exit(0);
});
