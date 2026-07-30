// tier-controls.ts — Performance tier button UI and state
import type { PerformanceTier } from '@/types';

export function initTierControls(opts: {
  tierButtons: NodeListOf<HTMLButtonElement>;
  getTier: () => PerformanceTier;
  setTier: (tier: PerformanceTier) => void;
  onTierChanged: () => void;
}): {
  updateActiveTier: (tier: PerformanceTier) => void;
  setDisabled: (disabled: boolean) => void;
} {
  const { tierButtons, getTier, setTier, onTierChanged } = opts;

  function updateActiveTier(tier: PerformanceTier): void {
    tierButtons.forEach(btn => {
      const btnTier = btn.getAttribute('data-tier') as PerformanceTier;
      btn.classList.toggle('active', btnTier === tier);
    });
  }

  function setDisabled(disabled: boolean): void {
    tierButtons.forEach(btn => {
      btn.disabled = disabled;
      btn.classList.toggle('disabled', disabled);
    });
  }

  // Tier button click handler (only updates UI state, saving happens on save button click)
  tierButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tier = btn.getAttribute('data-tier') as PerformanceTier;
      if (tier && tier !== getTier()) {
        setTier(tier);
        updateActiveTier(tier);
        onTierChanged();
        console.log('Performance tier selected:', tier);
      }
    });
  });

  return { updateActiveTier, setDisabled };
}
