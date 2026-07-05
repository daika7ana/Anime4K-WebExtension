import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiagnosticsOverlay } from './diagnostics-overlay';

/**
 * Creates a video element inside a parent div with common layout properties,
 * and stubs browser APIs that jsdom does not provide.
 */
function createTestVideo(): HTMLVideoElement {
  const parent = document.createElement('div');
  parent.id = 'test-parent';
  document.body.appendChild(parent);

  const video = document.createElement('video');
  parent.appendChild(video);

  Object.defineProperty(video, 'offsetWidth', { value: 640, configurable: true });
  Object.defineProperty(video, 'offsetHeight', { value: 360, configurable: true });
  Object.defineProperty(video, 'offsetTop', { value: 0, configurable: true });
  Object.defineProperty(video, 'offsetLeft', { value: 0, configurable: true });
  Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
  Object.defineProperty(video, 'videoHeight', { value: 360, configurable: true });

  return video;
}

function cleanupDom(): void {
  document.body.innerHTML = '';
}

let currentTime = 0;

describe('DiagnosticsOverlay', () => {
  beforeEach(() => {
    currentTime = 0;
    vi.stubGlobal('performance', { now: () => currentTime });
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    cleanupDom();
  });

  describe('create()', () => {
    it('creates a host element as a sibling of the video', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      const host = video.parentElement?.querySelector('div');
      expect(host).toBeDefined();
      expect(host?.style.position).toBe('absolute');

      overlay.destroy();
    });

    it('returns a DiagnosticsOverlay instance', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');
      expect(overlay).toBeInstanceOf(DiagnosticsOverlay);
      overlay.destroy();
    });

    it('creates shadow DOM content with diagnostic metrics', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      const host = video.parentElement?.querySelector('div');
      expect(host?.shadowRoot).toBeDefined();
      const textContent = host?.shadowRoot?.textContent ?? '';
      expect(textContent).toContain('FPS');
      expect(textContent).toContain('Frame');
      expect(textContent).toContain('Avg');
      expect(textContent).toContain('Pipes');
      expect(textContent).toContain('GPU');
      expect(textContent).toContain('Test GPU');

      overlay.destroy();
    });

    it('starts hidden by default', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      const host = video.parentElement?.querySelector('div') as HTMLElement;
      expect(host.style.display).toBe('none');

      overlay.destroy();
    });
  });

  describe('show() / hide()', () => {
    it('show() makes overlay visible', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      overlay.show();
      const host = video.parentElement?.querySelector('div') as HTMLElement;
      expect(host.style.display).toBe('block');

      overlay.destroy();
    });

    it('hide() hides the overlay', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      overlay.show();
      overlay.hide();
      const host = video.parentElement?.querySelector('div') as HTMLElement;
      expect(host.style.display).toBe('none');

      overlay.destroy();
    });
  });

  describe('update()', () => {
    it('calculates FPS from wall-clock time between updates', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      // First call — no FPS yet (no previous timestamp to compute delta)
      overlay.update(0, 4);
      expect(overlay['fpsEl']?.textContent).toBe('0.00');

      // Advance time by 16.67ms (~60 FPS — 1000/16.67 ≈ 59.99)
      currentTime = 16.67;
      overlay.update(0, 4);
      expect(overlay['fpsEl']?.textContent).toBe('59.99');

      // Advance by another 16.67ms — avg stays at 16.67ms
      currentTime = 33.34;
      overlay.update(0, 4);
      expect(overlay['fpsEl']?.textContent).toBe('59.99');

      overlay.destroy();
    });

    it('displays frame time and average frame time from wall-clock deltas', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      // First call — no delta yet
      overlay.update(0, 3);

      // Advance by 10ms (100 FPS)
      currentTime = 10;
      overlay.update(0, 3);

      // Advance by another 20ms (now buffer: [10, 20], avg = 15ms)
      currentTime = 30;
      overlay.update(0, 3);

      const host = video.parentElement?.querySelector('div') as HTMLElement;
      const textContent = host.shadowRoot?.textContent ?? '';

      // Latest frame time (wall-clock delta)
      expect(textContent).toContain('20.0 ms');
      // Average frame time: (10 + 20) / 2 = 15ms
      expect(textContent).toContain('15.0 ms');

      overlay.destroy();
    });

    it('rolling buffer keeps max 60 entries', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      // First call (no delta recorded)
      overlay.update(0, 4);

      // Push 70 frames at 16.67ms intervals
      for (let i = 1; i <= 70; i++) {
        currentTime = i * 16.67;
        overlay.update(0, 4);
      }

      // Should only keep last 60 entries
      expect(overlay['frameTimes'].length).toBe(60);

      overlay.destroy();
    });

    it('handles zero delta gracefully', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      // First call — no delta
      overlay.update(0, 0);

      // Second call at same time (zero delta)
      overlay.update(0, 0);

      const host = video.parentElement?.querySelector('div') as HTMLElement;
      const textContent = host.shadowRoot?.textContent ?? '';

      expect(textContent).toContain('0.0 ms');
      expect(textContent).toContain('0');

      overlay.destroy();
    });

    it('resets buffer on abnormally large wall-clock delta', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      // Build up some frame times at 16.67ms intervals
      for (let i = 1; i <= 10; i++) {
        currentTime = i * (1000 / 60);
        overlay.update(0, 4);
      }
      expect(overlay['frameTimes'].length).toBeGreaterThan(0);

      // Large gap (e.g. tab was hidden) — should reset the buffer
      currentTime += 1000; // 1 second gap (>500ms threshold)
      overlay.update(0, 4);

      // Buffer should be empty after the reset
      expect(overlay['frameTimes'].length).toBe(0);
      expect(overlay['fpsEl']?.textContent).toBe('0.00');

      // Next normal frame should recover immediately
      currentTime += 1000 / 60;
      overlay.update(0, 4);
      expect(overlay['frameTimes'].length).toBe(1);
      expect(overlay['fpsEl']?.textContent).toBe('60.00');

      overlay.destroy();
    });
  });

  describe('destroy()', () => {
    it('removes host from DOM', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      overlay.destroy();

      const host = video.parentElement?.querySelector('div');
      expect(host).toBeNull();
    });

    it('disconnects ResizeObserver', () => {
      const video = createTestVideo();
      const disconnectSpy = vi.spyOn(ResizeObserver.prototype, 'disconnect');
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      overlay.destroy();

      expect(disconnectSpy).toHaveBeenCalled();
    });

    it('is idempotent — safe to call destroy twice', () => {
      const video = createTestVideo();
      const overlay = DiagnosticsOverlay.create(video, 'Test GPU');

      expect(() => {
        overlay.destroy();
        overlay.destroy();
      }).not.toThrow();
    });
  });
});
