import type { SafeStorageLike } from '@alpha-cent/connector-sdk';
import {
  decodeJsonFromStorage,
  encodeJsonForStorage,
} from './safe-storage-blob';
import type { SlackToken } from './types';

// A forked extension process has no Electron API, so safeStorage is ALWAYS
// injected via the host (ctx) — there is no electron default here (unlike the
// in-tree builtin, which defaulted to require('electron').safeStorage).

export function encodeSlackTokenForStorage(
  t: SlackToken,
  ss: SafeStorageLike,
): Buffer {
  return encodeJsonForStorage(t, ss);
}

export function decodeSlackTokenFromStorage(
  blob: Buffer,
  ss: SafeStorageLike,
): SlackToken {
  return decodeJsonFromStorage<SlackToken>(blob, ss);
}
