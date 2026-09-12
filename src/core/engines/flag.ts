/**
 * Engine-registry rollout flag (temporary).
 *
 * Selects whether `buildEffectPipelines` dispatches effects through the engine
 * backend seam (`'registry'`) or the legacy per-className path (`'legacy'`).
 * The flag lives in `chrome.storage.local` so it can be flipped per device
 * without a rebuild; it defaults to `'legacy'` and normalizes anything unknown
 * back to `'legacy'`.
 *
 * TODO(C1a): Temporary rollout flag for the behavior-preserving migration.
 * Promote it to a build-time default (or delete it) once the registry path is
 * the only path and the legacy builder branch is removed.
 */

export type EngineRegistryMode = 'legacy' | 'registry';

const STORAGE_KEY = 'engineRegistryMode';
const DEFAULT_ENGINE_REGISTRY_MODE: EngineRegistryMode = 'legacy';
const VALID_ENGINE_REGISTRY_MODES: readonly EngineRegistryMode[] = ['legacy', 'registry'];

function normalizeEngineRegistryMode(value: unknown): EngineRegistryMode {
  return typeof value === 'string'
    && (VALID_ENGINE_REGISTRY_MODES as readonly string[]).includes(value)
    ? (value as EngineRegistryMode)
    : DEFAULT_ENGINE_REGISTRY_MODE;
}

/**
 * Read the engine-registry mode from `chrome.storage.local`.
 *
 * Feature-detects the storage API and never throws: any missing API, read
 * failure or unrecognized value resolves to `'legacy'`. Supports both the
 * callback and Promise forms of `chrome.storage.local.get`.
 */
export async function getEngineRegistryMode(): Promise<EngineRegistryMode> {
  try {
    const storageLocal = (globalThis as { chrome?: typeof chrome }).chrome?.storage?.local;
    if (!storageLocal || typeof storageLocal.get !== 'function') {
      return DEFAULT_ENGINE_REGISTRY_MODE;
    }

    const value = await new Promise<unknown>((resolve) => {
      let settled = false;
      const settle = (raw: unknown): void => {
        if (settled) return;
        settled = true;
        resolve(raw);
      };

      try {
        const maybePromise: unknown = storageLocal.get(
          STORAGE_KEY,
          (items) => settle((items as Record<string, unknown> | undefined)?.[STORAGE_KEY]),
        );
        // Promise form: some Chrome builds / test doubles resolve instead of
        // invoking the callback.
        if (
          maybePromise
          && typeof (maybePromise as { then?: unknown }).then === 'function'
        ) {
          Promise.resolve(maybePromise as PromiseLike<Record<string, unknown>>)
            .then((items) => settle(items?.[STORAGE_KEY]))
            .catch(() => settle(undefined));
        }
      } catch {
        settle(undefined);
      }
    });

    return normalizeEngineRegistryMode(value);
  } catch {
    return DEFAULT_ENGINE_REGISTRY_MODE;
  }
}
