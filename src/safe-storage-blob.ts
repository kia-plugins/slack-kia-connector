import fs from 'node:fs';
import type { SafeStorageLike } from '@kiagent/connector-sdk';

// Vendored from the app's oauth-shared/safe-storage-blob, with the Electron
// `require('electron').safeStorage` default removed: a forked extension process
// has no Electron API, so safeStorage is ALWAYS injected via the host (ctx).

export function encodeJsonForStorage<T>(t: T, ss: SafeStorageLike): Buffer {
  if (!ss.isEncryptionAvailable())
    throw new Error('safeStorage encryption unavailable');
  return ss.encryptString(JSON.stringify(t));
}

export function decodeJsonFromStorage<T>(
  blob: Buffer,
  ss: SafeStorageLike,
): T {
  return JSON.parse(ss.decryptString(blob)) as T;
}

export function saveTokenBlob(filePath: string, blob: Buffer): void {
  fs.writeFileSync(filePath, blob, { mode: 0o600 });
}

export function loadTokenBlob(filePath: string): Buffer {
  return fs.readFileSync(filePath);
}
