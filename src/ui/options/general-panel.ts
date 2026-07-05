/**
 * General Settings panel for the options page.
 *
 * Handles cross-origin fix toggle, theme selection, tier select value sync,
 * color grading toggle + slider delegation, and the About section version number.
 */
import { saveSettings, getLocalSettings } from '@utils/settings';
import { themeManager } from '../theme-manager';
import { renderColorGradingSliders, setColorGradingSlidersEnabled } from './color-grading-panel';

import type { AppContext } from './modes-panel';

export function initGeneralPanel(
  ctx: AppContext,
  crossOriginFixToggle: HTMLInputElement,
  themeSelect: HTMLSelectElement,
  tierSelect: HTMLSelectElement,
  colorGradingToggle: HTMLInputElement,
  colorGradingSliders: HTMLElement,
  versionNumberSpan: HTMLSpanElement,
): { render(): void; renderGeneralSettings(): Promise<void> } {

  function render() {
    const state = ctx.getState();
    crossOriginFixToggle.checked = state.enableCrossOriginFix;
    themeSelect.value = themeManager.getTheme();
    tierSelect.value = ctx.getTier();

    if (versionNumberSpan) {
      const manifest = chrome.runtime.getManifest();
      versionNumberSpan.textContent = manifest.version;
    }

    renderColorGradingUI();
  }

  async function renderGeneralSettings() {
    // Minimal update for tier/benchmark changes — syncs tierSelect value only.
    // The full render (crossOriginFix, theme, about, colorGrading) is handled
    // by the initial render() call in DOMContentLoaded.
    const localSettings = await getLocalSettings();
    if (tierSelect) {
      tierSelect.value = localSettings.performanceTier;
    }
  }

  function renderColorGradingUI() {
    const state = ctx.getState();
    colorGradingToggle.checked = state.colorGrading.enabled;
    renderColorGradingSliders(
      state.colorGrading,
      colorGradingSliders,
      state.colorGrading.enabled,
      async (updated) => {
        state.colorGrading = updated;
        await saveSettings({ colorGrading: updated });
        ctx.notifyUpdate();
      },
    );
  }

  // --- Cross-Origin Fix Toggle ---
  crossOriginFixToggle.addEventListener('change', async (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    ctx.getState().enableCrossOriginFix = enabled;
    await saveSettings({ enableCrossOriginFix: enabled });
    ctx.notifyUpdate();
  });

  // --- Theme Select ---
  themeSelect.addEventListener('change', (e) => {
    const selectedTheme = (e.target as HTMLSelectElement).value as 'light' | 'dark' | 'auto';
    themeManager.setTheme(selectedTheme);
  });

  // --- Color Grading Toggle ---
  colorGradingToggle.addEventListener('change', async (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    ctx.getState().colorGrading.enabled = enabled;
    setColorGradingSlidersEnabled(colorGradingSliders, enabled);
    await saveSettings({ colorGrading: ctx.getState().colorGrading });
    ctx.notifyUpdate();
  });

  return { render, renderGeneralSettings };
}
