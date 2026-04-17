/**
 * native.ts
 *
 * Thin wrapper around the C# ↔ JS bridge injected by the WPF/WebView2 host.
 * Every function returns a Promise and falls back gracefully when running in
 * a regular browser (for continued web-app development).
 *
 * The bridge works by:
 *   JS → C#  :  window.chrome.webview.postMessage(JSON.stringify({id, type, args}))
 *   C# → JS  :  window.__nativeBridge.resolve(id, result)
 *               window.__nativeBridge.reject(id, errorMsg)
 *
 * Usage:
 *   import { isNative, nativeOpenFile, nativeSaveFile, nativeLiveEditWrite } from './native';
 */

// ── Bridge plumbing ──────────────────────────────────────────────────────────

type PendingCall = { resolve: (v: any) => void; reject: (e: Error) => void };
const pending = new Map<string, PendingCall>();

/** True when running inside the WPF desktop shell. */
export const isNative: boolean =
  typeof window !== 'undefined' && !!(window as any).__isNativeApp;

// Install the response handler once.
if (typeof window !== 'undefined') {
  (window as any).__nativeBridge = {
    resolve(id: string, result: unknown) {
      pending.get(id)?.resolve(result);
      pending.delete(id);
    },
    reject(id: string, message: string) {
      pending.get(id)?.reject(new Error(message));
      pending.delete(id);
    },
    /** Called by C# whenever the live-edit status changes. */
    onLiveEditStatus(status: LiveEditStatus) {
      liveEditStatusListeners.forEach(fn => fn(status));
    },
  };
}

function call<T = unknown>(type: string, args?: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!isNative) {
      reject(new Error('Not running in native desktop app'));
      return;
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pending.set(id, { resolve, reject });
    (window as any).chrome.webview.postMessage(JSON.stringify({ id, type, args }));
  });
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface OpenFileResult {
  cancelled: boolean;
  name?: string;
  path?: string;
  dataBase64?: string;
}

export interface SaveFileResult {
  cancelled: boolean;
  path?: string;
}

export interface PickDirectoryResult {
  cancelled: boolean;
  path?: string;
}

export interface SetLiveSourceResult {
  cancelled: boolean;
  sourcePath?: string;
  backupDir?: string;
}

export interface LiveEditWriteResult {
  ok: boolean;
  message?: string;
}

export interface LiveEditStatus {
  Ok: boolean;
  Message: string | null;
  Error: string | null;
}

// ── File I/O ─────────────────────────────────────────────────────────────────

/**
 * Opens an OpenFileDialog and returns the chosen file's bytes as base64.
 * Returns `{cancelled: true}` if the user dismisses the dialog.
 */
export function nativeOpenFile(filter?: string): Promise<OpenFileResult> {
  return call('openFile', { filter: filter ?? 'GFX Files|*.gfx;*.GFX;*.swf|All Files|*.*' });
}

/**
 * Writes bytes (as base64) to `path`. If `path` is omitted a SaveFileDialog is shown.
 * Returns `{cancelled: true}` if the user dismisses the dialog.
 */
export function nativeSaveFile(
  path: string | null | undefined,
  dataBase64: string,
  suggestedName?: string,
): Promise<SaveFileResult> {
  return call('saveFile', { path, dataBase64, suggestedName });
}

/**
 * Shows a SaveFileDialog and returns the chosen path without writing anything.
 * Use when you want the user to pick a destination once and then re-use it.
 */
export function nativeSaveFileDialog(suggestedName?: string): Promise<SaveFileResult> {
  return call('saveFileDialog', { suggestedName });
}

/**
 * Shows a FolderBrowserDialog and returns the path.
 */
export function nativePickDirectory(): Promise<PickDirectoryResult> {
  return call('pickDirectory');
}

// ── Live edit ─────────────────────────────────────────────────────────────────

/**
 * Picks the game GFX file that will be overwritten on every live-export.
 * If `sourcePath` is provided the dialog is skipped.
 */
export function nativeSetLiveSource(
  sourcePath?: string,
  backupDir?: string,
): Promise<SetLiveSourceResult> {
  return call('setLiveSource', { sourcePath, backupDir });
}

/**
 * Writes compiled GFX bytes to the game file, creating a timestamped backup on
 * the first call. This replaces the staging-folder + watcher.mjs approach.
 */
export function nativeLiveEditWrite(
  dataBase64: string,
  sourcePath?: string,
  backupDir?: string,
): Promise<LiveEditWriteResult> {
  return call('liveEditWrite', { dataBase64, sourcePath, backupDir });
}

// ── Live-edit status listeners ─────────────────────────────────────────────

const liveEditStatusListeners = new Set<(s: LiveEditStatus) => void>();

export function onLiveEditStatus(fn: (s: LiveEditStatus) => void): () => void {
  liveEditStatusListeners.add(fn);
  return () => liveEditStatusListeners.delete(fn);
}

// ── Utility ──────────────────────────────────────────────────────────────────

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
