/**
 * Configuration migration module
 * Handles migration from v1 → v2 → v3 config formats.
 *
 * Migrations run as an ordered, idempotent chain in `ensureLatestConfig`:
 * each step only runs when the stored `_configVersion` is below the version it
 * produces, and re-running the whole chain once the config is current performs
 * no writes.
 */

import type { CustomMode, EnhancementEffect, PerformanceTier } from '../types';
import { AVAILABLE_EFFECTS } from './effects-map';
import { DEFAULT_COLOR_GRADING } from './validation';

// v1 mode definitions (legacy format)
interface V1EnhancementMode {
    id: string;
    name: string;
    isBuiltIn: boolean;
    effects: EnhancementEffect[];
}

// Config version
const CURRENT_CONFIG_VERSION = 3;
const CONFIG_VERSION_2 = 2;

/**
 * Execute migration from v1 to v2
 */
async function migrateV1ToV2(): Promise<void> {
    console.log('[Migration] Starting v1 to v2 migration...');

    const syncData = await chrome.storage.sync.get([
        'enhancementModes',
        'selectedModeId',
        'targetResolutionSetting',
        'whitelistEnabled',
        'whitelist',
        'enableCrossOriginFix',
    ]);

    const oldModes = syncData.enhancementModes as V1EnhancementMode[] | undefined;

    // Extract user custom modes (preserve full effect chains)
    const customModes: CustomMode[] = [];
    if (oldModes) {
        for (const mode of oldModes) {
            if (!mode.isBuiltIn) {
                // Sync effect definitions, removing effects that no longer exist
                const syncedEffects = mode.effects
                    .map(e => AVAILABLE_EFFECTS.find(ae => ae.id === e.id))
                    .filter((e): e is EnhancementEffect => !!e);

                customModes.push({
                    id: mode.id,
                    name: mode.name,
                    isBuiltIn: false,
                    effects: syncedEffects,
                });
            }
        }
    }

    // Determine the selected mode ID
    let selectedModeId = syncData.selectedModeId || 'builtin-mode-a';

    // If the selected mode is an old built-in mode, map to the new ID
    const builtInModeMap: Record<string, string> = {
        'builtin-mode-a': 'builtin-mode-a',
        'builtin-mode-b': 'builtin-mode-b',
        'builtin-mode-c': 'builtin-mode-c',
        'builtin-mode-aa': 'builtin-mode-aa',
        'builtin-mode-bb': 'builtin-mode-bb',
        'builtin-mode-ca': 'builtin-mode-ca',
    };

    if (builtInModeMap[selectedModeId]) {
        selectedModeId = builtInModeMap[selectedModeId];
    }

    // Save migrated data. This step only produces a v2 config; the v2 → v3
    // backfill is applied afterwards by the migration chain.
    await chrome.storage.sync.set({
        customModes,
        selectedModeId,
        targetResolutionSetting: syncData.targetResolutionSetting || 'x2',
        whitelistEnabled: syncData.whitelistEnabled ?? false,
        whitelist: syncData.whitelist || [],
        enableCrossOriginFix: syncData.enableCrossOriginFix ?? false,
        _configVersion: CONFIG_VERSION_2,
    });

    // Clean up old data
    await chrome.storage.sync.remove('enhancementModes');

    // Set default local settings
    const localData = await chrome.storage.local.get(['performanceTier']);
    if (!localData.performanceTier) {
        await chrome.storage.local.set({
            performanceTier: 'balanced' as PerformanceTier,
            gpuBenchmarkResult: null,
            gpuAdapterInfo: null,
            hasCompletedOnboarding: false,
        });
    }

    console.log('[Migration] v1 to v2 migration completed');
    console.log(`[Migration] Migrated ${customModes.length} custom modes`);
}

/**
 * Execute migration from v2 to v3.
 *
 * v3 introduced `autoEnableOnWhitelist`, `enableHotkey` and `colorGrading`
 * (synced) plus `showDiagnostics` (local). Only fields that are absent are
 * backfilled with defaults; existing values are never overwritten.
 */
async function migrateV2ToV3(): Promise<void> {
    console.log('[Migration] Starting v2 to v3 migration...');

    const syncData = await chrome.storage.sync.get([
        'autoEnableOnWhitelist',
        'enableHotkey',
        'colorGrading',
    ]);

    const syncBackfill: Record<string, unknown> = {
        _configVersion: CURRENT_CONFIG_VERSION,
    };
    if (syncData.autoEnableOnWhitelist === undefined) {
        syncBackfill.autoEnableOnWhitelist = false;
    }
    if (syncData.enableHotkey === undefined) {
        syncBackfill.enableHotkey = true;
    }
    if (syncData.colorGrading === undefined) {
        syncBackfill.colorGrading = { ...DEFAULT_COLOR_GRADING };
    }

    await chrome.storage.sync.set(syncBackfill);

    const localData = await chrome.storage.local.get(['showDiagnostics']);
    if (localData.showDiagnostics === undefined) {
        await chrome.storage.local.set({ showDiagnostics: false });
    }

    console.log('[Migration] v2 to v3 migration completed');
}

/**
 * Initialize a fresh install directly on the latest config version.
 */
async function initializeDefaultConfig(): Promise<void> {
    await chrome.storage.sync.set({
        customModes: [],
        selectedModeId: 'builtin-mode-a',
        targetResolutionSetting: 'x2',
        whitelistEnabled: false,
        whitelist: [],
        enableCrossOriginFix: false,
        autoEnableOnWhitelist: false,
        enableHotkey: true,
        colorGrading: { ...DEFAULT_COLOR_GRADING },
        _configVersion: CURRENT_CONFIG_VERSION,
    });

    await chrome.storage.local.set({
        performanceTier: 'balanced' as PerformanceTier,
        gpuBenchmarkResult: null,
        gpuAdapterInfo: null,
        hasCompletedOnboarding: false,
        showDiagnostics: false,
    });

    console.log('[Migration] Initialized new config with defaults');
}

/**
 * Ensure the config is on the latest version by running the ordered migration
 * chain. Safe to call repeatedly: once the config is current this is a no-op.
 */
export async function ensureLatestConfig(): Promise<void> {
    const syncData = await chrome.storage.sync.get(['_configVersion', 'enhancementModes']);
    const storedVersion = typeof syncData._configVersion === 'number'
        ? syncData._configVersion
        : 0;

    // Fresh install: no version marker and no legacy data to migrate.
    if (storedVersion === 0 && !syncData.enhancementModes) {
        await initializeDefaultConfig();
        return;
    }

    let version = storedVersion;

    // v1 → v2. Legacy v1 data without enhancementModes is simply bumped to v2
    // and then handled by the v2 → v3 backfill below.
    if (version < 2) {
        if (syncData.enhancementModes) {
            await migrateV1ToV2();
        }
        version = 2;
    }

    // v2 → v3
    if (version < 3) {
        await migrateV2ToV3();
    }
}
