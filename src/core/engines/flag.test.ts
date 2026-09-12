/**
 * Tests for the temporary engine-registry rollout flag.
 *
 * The flag reads `chrome.storage.local.engineRegistryMode`, defaults to
 * `'legacy'`, normalizes unknown values, and must never throw when the storage
 * API is missing or failing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getEngineRegistryMode } from './flag';

type StorageGet = typeof chrome.storage.local.get;

const originalGet = chrome.storage.local.get;

function setGet(impl: (keys: unknown, callback?: (items: Record<string, unknown>) => void) => unknown): void {
  chrome.storage.local.get = impl as unknown as StorageGet;
}

afterEach(() => {
  chrome.storage.local.get = originalGet;
});

describe('getEngineRegistryMode', () => {
  it("defaults to 'legacy' when storage holds no value", async () => {
    setGet((_keys, callback) => callback?.({}));
    await expect(getEngineRegistryMode()).resolves.toBe('legacy');
  });

  it("reads 'registry' from storage", async () => {
    setGet((_keys, callback) => callback?.({ engineRegistryMode: 'registry' }));
    await expect(getEngineRegistryMode()).resolves.toBe('registry');
  });

  it("normalizes an unknown stored value to 'legacy'", async () => {
    setGet((_keys, callback) => callback?.({ engineRegistryMode: 'turbo' }));
    await expect(getEngineRegistryMode()).resolves.toBe('legacy');
  });

  it("normalizes a non-string stored value to 'legacy'", async () => {
    setGet((_keys, callback) => callback?.({ engineRegistryMode: 1 }));
    await expect(getEngineRegistryMode()).resolves.toBe('legacy');
  });

  it('supports the Promise form of chrome.storage.local.get', async () => {
    setGet(() => Promise.resolve({ engineRegistryMode: 'registry' }));
    await expect(getEngineRegistryMode()).resolves.toBe('registry');
  });

  it("returns 'legacy' without throwing when chrome.storage is unavailable", async () => {
    const chromeRef = (globalThis as { chrome?: typeof chrome }).chrome;
    const storageRef = chromeRef!.storage;

    (chromeRef as unknown as { storage: unknown }).storage = undefined;
    try {
      await expect(getEngineRegistryMode()).resolves.toBe('legacy');
    } finally {
      (chromeRef as unknown as { storage: typeof chrome.storage }).storage = storageRef;
    }
  });

  it("returns 'legacy' without throwing when the storage read throws", async () => {
    setGet(() => {
      throw new Error('storage exploded');
    });
    await expect(getEngineRegistryMode()).resolves.toBe('legacy');
  });

  it("returns 'legacy' without throwing when globalThis.chrome is absent", async () => {
    const originalChrome = (globalThis as { chrome?: typeof chrome }).chrome;
    try {
      (globalThis as { chrome?: typeof chrome }).chrome = undefined;
      await expect(getEngineRegistryMode()).resolves.toBe('legacy');
    } finally {
      (globalThis as { chrome?: typeof chrome }).chrome = originalChrome;
    }
  });
});
