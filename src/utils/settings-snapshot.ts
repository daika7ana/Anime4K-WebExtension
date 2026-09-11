/**
 * Revisioned settings snapshot store.
 *
 * Holds the last merged `Anime4KWebExtSettings` value produced by `getSettings`
 * together with a monotonically increasing `revision`. Consumers can subscribe
 * to be notified when the snapshot is invalidated (a relevant `chrome.storage`
 * area changed) or republished (a fresh merged value was produced).
 *
 * The store is deliberately decoupled from `settings.ts`: it knows nothing about
 * how the value is built, it only stores the latest value and tracks staleness.
 * `settings.ts` pushes values in via `setSnapshot` and asks `isStale` whether the
 * cached snapshot can still be trusted.
 */

import type { Anime4KWebExtSettings } from '../types';

/** A point-in-time merged settings value with its revision number. */
export interface SettingsSnapshot {
  /** Monotonically increasing revision; strictly greater after each publish. */
  readonly revision: number;
  /** The merged settings value at this revision. */
  readonly value: Anime4KWebExtSettings;
}

/** Listener notified on invalidate/publish. Receives the current (possibly stale) snapshot. */
export type SettingsSnapshotListener = (snapshot: SettingsSnapshot | null) => void;

let snapshot: SettingsSnapshot | null = null;
let revisionCounter = 0;
let stale = false;

const listeners = new Set<SettingsSnapshotListener>();

type StorageChangedListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

let storageChangedListener: StorageChangedListener | null = null;
let storageListenerAttached = false;

function notify(): void {
  for (const listener of listeners) {
    listener(snapshot);
  }
}

/**
 * Attach the `chrome.storage.onChanged` listener that invalidates the snapshot
 * when the `'sync'` or `'local'` areas change.
 *
 * Feature-detected and wrapped in a try/catch so importing/using this module
 * never throws in environments where the extension APIs are unavailable
 * (unit tests, plain pages, Firefox variants without the API, ...).
 */
function ensureStorageListener(): void {
  if (storageListenerAttached) return;
  storageListenerAttached = true;

  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged?.addListener) {
    return;
  }

  try {
    storageChangedListener = (_changes, areaName) => {
      if (areaName === 'sync' || areaName === 'local') {
        invalidate();
      }
    };
    chrome.storage.onChanged.addListener(storageChangedListener);
  } catch {
    storageChangedListener = null;
  }
}

/**
 * Subscribe to snapshot lifecycle events. The listener is invoked with the
 * current snapshot (or `null` before the first publish) whenever the snapshot is
 * invalidated or republished.
 *
 * @returns an unsubscribe function that removes the listener.
 */
export function subscribe(listener: SettingsSnapshotListener): () => void {
  ensureStorageListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Mark the current snapshot as stale and notify subscribers. Does not change the
 * stored value or its revision; the revision advances on the next `setSnapshot`
 * (i.e. the next settings read). Calling this repeatedly while already stale is a
 * no-op so that multiple storage listeners cannot double-notify.
 */
export function invalidate(): void {
  if (stale) return;
  stale = true;
  notify();
}

/** Whether the snapshot has been invalidated since it was last published. */
export function isStale(): boolean {
  return stale;
}

/**
 * Publish a freshly merged settings value. Bumps the revision, clears the stale
 * flag, and notifies subscribers.
 *
 * @returns the newly published snapshot.
 */
export function setSnapshot(value: Anime4KWebExtSettings): SettingsSnapshot {
  ensureStorageListener();
  revisionCounter += 1;
  snapshot = { revision: revisionCounter, value };
  stale = false;
  notify();
  return snapshot;
}

/**
 * Read the current snapshot (or `null` if nothing has been published yet).
 * This is a pure read: it never mutates state or bumps the revision.
 */
export function getSnapshot(): SettingsSnapshot | null {
  return snapshot;
}

/**
 * Tear down the store: remove the storage listener, drop all subscribers, and
 * clear the stored snapshot. The revision counter is intentionally retained so
 * revisions remain monotonic if the store is reused after disposal.
 */
export function dispose(): void {
  if (storageChangedListener) {
    try {
      chrome?.storage?.onChanged?.removeListener?.(storageChangedListener);
    } catch {
      // Ignore teardown failures; the listener reference is discarded below.
    }
  }
  storageChangedListener = null;
  storageListenerAttached = false;
  listeners.clear();
  snapshot = null;
  stale = false;
}
