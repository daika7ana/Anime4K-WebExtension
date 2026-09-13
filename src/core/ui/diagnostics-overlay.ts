import type { ProfilerSnapshot } from '@core/gpu/gpu-timestamp-profiler';
import { t } from '@utils/i18n';

/** Format a millisecond value for the HUD, using an em dash when unavailable. */
function formatTimingMs(value: number | null | undefined): string {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return '\u2014';
  }
  return value.toFixed(2);
}

/** Read-only configuration values shown by the diagnostics HUD. */
export interface DiagnosticsInfo {
  /** Built-in preset name, or 'Custom' for a custom mode. */
  mode: string;
  /** Raw performance tier value, e.g. 'balanced'. */
  performanceTier: string;
  /** Input (source) video resolution, e.g. '1920×1080'. */
  inputResolution: string;
  /** Computed output target resolution, e.g. '3840×2160'. */
  targetResolution: string;
}

/**
 * Diagnostics overlay showing live performance metrics during video enhancement.
 * Attaches to the same video element as the enhance button, positioned top-right.
 * Uses shadow DOM for style isolation.
 */
export class DiagnosticsOverlay {
  private host: HTMLDivElement | null = null;
  private shadowRoot: ShadowRoot | null = null;
  private fpsEl: HTMLElement | null = null;
  private frameTimeEl: HTMLElement | null = null;
  private avgFrameTimeEl: HTMLElement | null = null;
  private pipelineCountEl: HTMLElement | null = null;
  private adapterInfoEl: HTMLElement | null = null;
  private modeEl: HTMLElement | null = null;
  private tierEl: HTMLElement | null = null;
  private inputResolutionEl: HTMLElement | null = null;
  private targetResolutionEl: HTMLElement | null = null;
  private timingSectionEl: HTMLElement | null = null;
  private timingTitleEl: HTMLElement | null = null;
  private timingStatusEl: HTMLElement | null = null;
  private timingGridEl: HTMLElement | null = null;
  private timingFramesEl: HTMLElement | null = null;
  private timingVisible = false;
  private lastTimingRenderTime = Number.NEGATIVE_INFINITY;
  private frameTimes: number[] = [];
  private lastUpdateTime = 0;
  private hasFirstUpdate = false;
  private adapterInfo: string;
  private info: DiagnosticsInfo | null = null;
  private video: HTMLVideoElement;
  private resizeObserver: ResizeObserver | null = null;

  private static readonly MAX_FRAME_TIMES = 60;
  private static readonly MAX_REASONABLE_DELTA_MS = 500;
  private static readonly TIMING_THROTTLE_MS = 250;

  private constructor(
    video: HTMLVideoElement,
    adapterInfo: string,
    info: DiagnosticsInfo | null = null,
  ) {
    this.video = video;
    this.adapterInfo = adapterInfo;
    this.info = info;
  }

  public static create(
    video: HTMLVideoElement,
    adapterInfo: string,
    info?: DiagnosticsInfo,
  ): DiagnosticsOverlay {
    const overlay = new DiagnosticsOverlay(video, adapterInfo, info ?? null);
    overlay.initialize();
    return overlay;
  }

  private initialize(): void {
    this.host = document.createElement('div');
    this.host.style.position = 'absolute';
    this.host.style.pointerEvents = 'none';
    this.host.style.zIndex = '2147483645';

    this.video.parentElement?.insertBefore(this.host, this.video);

    this.shadowRoot = this.host.attachShadow({ mode: 'open' });

    // Create styles
    const style = document.createElement('style');
    style.textContent = `
      .diagnostics {
        position: absolute;
        top: 10px;
        right: 10px;
        background: rgba(0, 0, 0, 0.6);
        color: #fff;
        font-family: monospace;
        font-size: 14px;
        line-height: 1.6;
        padding: 10px;
        border-radius: 4px;
        white-space: nowrap;
        user-select: none;
        pointer-events: none;
      }
      .metric {
        display: flex;
        justify-content: space-between;
        gap: 16px;
      }
      .metric-label {
        opacity: 0.7;
      }
      .metric-value {
        font-weight: bold;
        text-align: right;
      }
      .timing-section {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid rgba(255, 255, 255, 0.18);
      }
      .timing-title {
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        opacity: 0.55;
        margin-bottom: 4px;
      }
      .timing-status {
        opacity: 0.7;
        font-style: italic;
      }
      .timing-grid {
        display: grid;
        grid-template-columns: max-content repeat(5, minmax(46px, max-content));
        column-gap: 12px;
        row-gap: 2px;
        align-items: baseline;
      }
      .timing-cell {
        text-align: right;
      }
      .timing-pass {
        text-align: left;
        max-width: 140px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .timing-head {
        font-size: 11px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        opacity: 0.55;
      }
      .timing-total {
        opacity: 0.85;
      }
      .timing-frames {
        margin-top: 4px;
        font-size: 11px;
        opacity: 0.6;
      }
    `;
    this.shadowRoot.appendChild(style);

    // Create container
    const container = document.createElement('div');
    container.className = 'diagnostics';

    // FPS row
    const fpsRow = document.createElement('div');
    fpsRow.className = 'metric';
    const fpsLabel = document.createElement('span');
    fpsLabel.className = 'metric-label';
    fpsLabel.textContent = 'FPS';
    const fpsValue = document.createElement('span');
    fpsValue.className = 'metric-value';
    fpsValue.textContent = '--';
    this.fpsEl = fpsValue;
    fpsRow.appendChild(fpsLabel);
    fpsRow.appendChild(fpsValue);
    container.appendChild(fpsRow);

    // Frame time row (current)
    const ftRow = document.createElement('div');
    ftRow.className = 'metric';
    const ftLabel = document.createElement('span');
    ftLabel.className = 'metric-label';
    ftLabel.textContent = 'Frame';
    const ftValue = document.createElement('span');
    ftValue.className = 'metric-value';
    ftValue.textContent = '-- ms';
    this.frameTimeEl = ftValue;
    ftRow.appendChild(ftLabel);
    ftRow.appendChild(ftValue);
    container.appendChild(ftRow);

    // Avg frame time row
    const avgRow = document.createElement('div');
    avgRow.className = 'metric';
    const avgLabel = document.createElement('span');
    avgLabel.className = 'metric-label';
    avgLabel.textContent = 'Avg';
    const avgValue = document.createElement('span');
    avgValue.className = 'metric-value';
    avgValue.textContent = '-- ms';
    this.avgFrameTimeEl = avgValue;
    avgRow.appendChild(avgLabel);
    avgRow.appendChild(avgValue);
    container.appendChild(avgRow);

    // Pipeline count row
    const plcRow = document.createElement('div');
    plcRow.className = 'metric';
    const plcLabel = document.createElement('span');
    plcLabel.className = 'metric-label';
    plcLabel.textContent = 'Pipes';
    const plcValue = document.createElement('span');
    plcValue.className = 'metric-value';
    plcValue.textContent = '--';
    this.pipelineCountEl = plcValue;
    plcRow.appendChild(plcLabel);
    plcRow.appendChild(plcValue);
    container.appendChild(plcRow);

    // Adapter info row
    const adpRow = document.createElement('div');
    adpRow.className = 'metric';
    const adpLabel = document.createElement('span');
    adpLabel.className = 'metric-label';
    adpLabel.textContent = 'GPU';
    const adpValue = document.createElement('span');
    adpValue.className = 'metric-value';
    adpValue.textContent = this.adapterInfo;
    adpValue.style.maxWidth = '180px';
    adpValue.style.overflow = 'hidden';
    adpValue.style.textOverflow = 'ellipsis';
    this.adapterInfoEl = adpValue;
    adpRow.appendChild(adpLabel);
    adpRow.appendChild(adpValue);
    container.appendChild(adpRow);

    // Mode row (built-in preset name or "Custom")
    const modeRow = document.createElement('div');
    modeRow.className = 'metric';
    const modeLabel = document.createElement('span');
    modeLabel.className = 'metric-label';
    modeLabel.textContent = t('diagnosticsMode', 'Mode');
    const modeValue = document.createElement('span');
    modeValue.className = 'metric-value';
    modeValue.textContent = this.info?.mode ?? '--';
    this.modeEl = modeValue;
    modeRow.appendChild(modeLabel);
    modeRow.appendChild(modeValue);
    container.appendChild(modeRow);

    // Performance tier row (raw value)
    const tierRow = document.createElement('div');
    tierRow.className = 'metric';
    const tierLabel = document.createElement('span');
    tierLabel.className = 'metric-label';
    tierLabel.textContent = t('diagnosticsTier', 'Tier');
    const tierValue = document.createElement('span');
    tierValue.className = 'metric-value';
    tierValue.textContent = this.info?.performanceTier ?? '--';
    this.tierEl = tierValue;
    tierRow.appendChild(tierLabel);
    tierRow.appendChild(tierValue);
    container.appendChild(tierRow);

    // Input (source) resolution row
    const inputRow = document.createElement('div');
    inputRow.className = 'metric';
    const inputLabel = document.createElement('span');
    inputLabel.className = 'metric-label';
    inputLabel.textContent = t('diagnosticsInputResolution', 'Input');
    const inputValue = document.createElement('span');
    inputValue.className = 'metric-value';
    inputValue.textContent = this.info?.inputResolution ?? '--';
    this.inputResolutionEl = inputValue;
    inputRow.appendChild(inputLabel);
    inputRow.appendChild(inputValue);
    container.appendChild(inputRow);

    // Target (output) resolution row
    const targetRow = document.createElement('div');
    targetRow.className = 'metric';
    const targetLabel = document.createElement('span');
    targetLabel.className = 'metric-label';
    targetLabel.textContent = t('diagnosticsTargetResolution', 'Target');
    const targetValue = document.createElement('span');
    targetValue.className = 'metric-value';
    targetValue.textContent = this.info?.targetResolution ?? '--';
    this.targetResolutionEl = targetValue;
    targetRow.appendChild(targetLabel);
    targetRow.appendChild(targetValue);
    container.appendChild(targetRow);

    // GPU/CPU per-effect timing section (populated from a profiler snapshot)
    const timingSection = document.createElement('div');
    timingSection.className = 'timing-section';
    timingSection.style.display = 'none';

    const timingTitle = document.createElement('div');
    timingTitle.className = 'timing-title';
    timingTitle.textContent = t('diagnosticsGpuTimings', 'GPU Timings');
    timingSection.appendChild(timingTitle);
    this.timingTitleEl = timingTitle;

    const timingStatus = document.createElement('div');
    timingStatus.className = 'timing-status';
    timingStatus.style.display = 'none';
    timingSection.appendChild(timingStatus);
    this.timingStatusEl = timingStatus;

    const timingGrid = document.createElement('div');
    timingGrid.className = 'timing-grid';
    timingGrid.style.display = 'none';
    timingSection.appendChild(timingGrid);
    this.timingGridEl = timingGrid;

    const timingFrames = document.createElement('div');
    timingFrames.className = 'timing-frames';
    timingFrames.style.display = 'none';
    timingSection.appendChild(timingFrames);
    this.timingFramesEl = timingFrames;

    this.timingSectionEl = timingSection;
    container.appendChild(timingSection);

    this.shadowRoot.appendChild(container);

    // Start hidden
    this.host.style.display = 'none';

    // Observe video resizes
    this.resizeObserver = new ResizeObserver(() => this.updatePosition());
    this.resizeObserver.observe(this.video);
    this.updatePosition();
  }

  public show(): void {
    if (this.host) {
      this.host.style.display = 'block';
    }
  }

  public hide(): void {
    if (this.host) {
      this.host.style.display = 'none';
    }
  }

  public destroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.host) {
      this.host.remove();
      this.host = null;
      this.shadowRoot = null;
    }
    this.timingSectionEl = null;
    this.timingTitleEl = null;
    this.timingStatusEl = null;
    this.timingGridEl = null;
    this.timingFramesEl = null;
    this.modeEl = null;
    this.tierEl = null;
    this.inputResolutionEl = null;
    this.targetResolutionEl = null;
    this.timingVisible = false;
    this.lastTimingRenderTime = Number.NEGATIVE_INFINITY;
  }

  /**
   * Update one or more read-only configuration rows. Safe to call after
   * {@link destroy}: missing elements are simply skipped.
   */
  public setInfo(info: Partial<DiagnosticsInfo>): void {
    const base = this.info
      ?? { mode: '', performanceTier: '', inputResolution: '', targetResolution: '' };
    this.info = { ...base, ...info };

    if (info.mode !== undefined && this.modeEl) {
      this.modeEl.textContent = info.mode;
    }
    if (info.performanceTier !== undefined && this.tierEl) {
      this.tierEl.textContent = info.performanceTier;
    }
    if (info.inputResolution !== undefined && this.inputResolutionEl) {
      this.inputResolutionEl.textContent = info.inputResolution;
    }
    if (info.targetResolution !== undefined && this.targetResolutionEl) {
      this.targetResolutionEl.textContent = info.targetResolution;
    }
  }

  /**
   * Record one frame's metrics.
   *
   * `snapshot` is optional so existing two-argument callers keep working; when
   * omitted (or `null`) the GPU/CPU timing section stays hidden.
   */
  public update(
    frameTime: number,
    pipelineCount: number,
    snapshot?: ProfilerSnapshot | null,
  ): void {
    const now = performance.now();

    // Use wall-clock time between consecutive update() calls for FPS calculation.
    // The frameTime parameter (CPU processing time) is not used for display
    // because it doesn't reflect the actual frame rate (which is determined by
    // requestVideoFrameCallback, typically 24/30/60 fps).
    if (this.hasFirstUpdate) {
      const wallDelta = now - this.lastUpdateTime;
      // Reset the rolling buffer if a single delta is abnormally large (e.g. tab
      // was hidden, page was backgrounded, or initialization gap). This prevents
      // one bad delta from polluting the rolling average for up to 60 frames.
      if (wallDelta > DiagnosticsOverlay.MAX_REASONABLE_DELTA_MS) {
        this.frameTimes = [];
      } else {
        this.frameTimes.push(wallDelta);
        if (this.frameTimes.length > DiagnosticsOverlay.MAX_FRAME_TIMES) {
          this.frameTimes = this.frameTimes.slice(-DiagnosticsOverlay.MAX_FRAME_TIMES);
        }
      }
    }
    this.lastUpdateTime = now;
    this.hasFirstUpdate = true;

    const avgFrameTime = this.frameTimes.length > 0
      ? this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length
      : 0;
    const fps = avgFrameTime > 0 ? (1000 / avgFrameTime) : 0;
    const currentFrameTime = this.frameTimes.length > 0
      ? this.frameTimes[this.frameTimes.length - 1]
      : 0;

    if (this.fpsEl) {
      this.fpsEl.textContent = fps.toFixed(2);
    }
    if (this.frameTimeEl) {
      this.frameTimeEl.textContent = `${currentFrameTime.toFixed(1)} ms`;
    }
    if (this.avgFrameTimeEl) {
      this.avgFrameTimeEl.textContent = `${avgFrameTime.toFixed(1)} ms`;
    }
    if (this.pipelineCountEl) {
      this.pipelineCountEl.textContent = String(pipelineCount);
    }

    this.updateTimingSection(snapshot, now);
  }

  /**
   * Show/hide and (throttled) rebuild the timing section from the latest
   * snapshot. Visibility changes are applied immediately; the pass table is
   * only rebuilt every {@link DiagnosticsOverlay.TIMING_THROTTLE_MS} so the HUD
   * is not thrashed on every frame.
   */
  private updateTimingSection(snapshot: ProfilerSnapshot | null | undefined, now: number): void {
    const section = this.timingSectionEl;
    if (!section) return;

    const shouldShow = snapshot != null
      && (snapshot.status !== 'active' || snapshot.passes.length > 0);
    if (!shouldShow) {
      if (this.timingVisible) {
        section.style.display = 'none';
        this.timingVisible = false;
        this.clearTimingSection();
      }
      return;
    }

    const becameVisible = !this.timingVisible;
    section.style.display = 'block';
    this.timingVisible = true;

    // A non-active status is a single, cheap line and must replace any rows
    // immediately so a degraded/destroyed profiler never leaves stale data.
    if (snapshot.status !== 'active' || becameVisible) {
      this.lastTimingRenderTime = now;
      this.renderTimingSection(snapshot);
      return;
    }

    if (now - this.lastTimingRenderTime < DiagnosticsOverlay.TIMING_THROTTLE_MS) {
      return;
    }
    this.lastTimingRenderTime = now;
    this.renderTimingSection(snapshot);
  }

  private renderTimingSection(snapshot: ProfilerSnapshot): void {
    const title = this.timingTitleEl;
    const status = this.timingStatusEl;
    const grid = this.timingGridEl;
    const frames = this.timingFramesEl;
    if (!title || !status || !grid || !frames) return;

    grid.replaceChildren();
    frames.textContent = '';

    if (snapshot.status !== 'active') {
      title.style.display = 'none';
      grid.style.display = 'none';
      frames.style.display = 'none';
      status.textContent = t('diagnosticsGpuTimingsUnavailable', 'GPU timings unavailable');
      status.style.display = 'block';
      return;
    }

    title.style.display = 'block';
    status.style.display = 'none';
    status.textContent = '';
    grid.style.display = 'grid';
    frames.style.display = 'block';

    grid.appendChild(this.createTimingCell(t('diagnosticsTimingPass', 'Pass'), 'timing-pass timing-head'));
    grid.appendChild(this.createTimingCell(t('diagnosticsTimingCpuP50', 'CPU p50'), 'timing-cell timing-head'));
    grid.appendChild(this.createTimingCell(t('diagnosticsTimingCpuP95', 'CPU p95'), 'timing-cell timing-head'));
    grid.appendChild(this.createTimingCell(t('diagnosticsTimingGpuP50', 'GPU p50'), 'timing-cell timing-head'));
    grid.appendChild(this.createTimingCell(t('diagnosticsTimingGpuP95', 'GPU p95'), 'timing-cell timing-head'));
    grid.appendChild(this.createTimingCell(t('diagnosticsTimingGpuP99', 'GPU p99'), 'timing-cell timing-head'));

    for (const pass of snapshot.passes) {
      grid.appendChild(this.createTimingCell(pass.label, 'timing-pass'));
      grid.appendChild(this.createTimingCell(formatTimingMs(pass.cpuP50), 'timing-cell'));
      grid.appendChild(this.createTimingCell(formatTimingMs(pass.cpuP95), 'timing-cell'));
      grid.appendChild(this.createTimingCell(formatTimingMs(pass.gpuP50), 'timing-cell'));
      grid.appendChild(this.createTimingCell(formatTimingMs(pass.gpuP95), 'timing-cell'));
      grid.appendChild(this.createTimingCell(formatTimingMs(pass.gpuP99), 'timing-cell'));
    }

    // Total GPU row aligns under the GPU columns; total has no p99.
    grid.appendChild(this.createTimingCell(t('diagnosticsTimingTotal', 'Total GPU'), 'timing-pass timing-total'));
    grid.appendChild(this.createTimingCell('', 'timing-cell'));
    grid.appendChild(this.createTimingCell('', 'timing-cell'));
    grid.appendChild(this.createTimingCell(formatTimingMs(snapshot.totalGpuP50), 'timing-cell timing-total'));
    grid.appendChild(this.createTimingCell(formatTimingMs(snapshot.totalGpuP95), 'timing-cell timing-total'));
    grid.appendChild(this.createTimingCell('', 'timing-cell'));

    frames.textContent = `${t('diagnosticsFramesSampled', 'Frames sampled')}: ${snapshot.framesSampled}`;
  }

  private createTimingCell(text: string, className: string): HTMLElement {
    const cell = document.createElement('span');
    cell.className = className;
    cell.textContent = text;
    return cell;
  }

  private clearTimingSection(): void {
    this.timingGridEl?.replaceChildren();
    if (this.timingStatusEl) this.timingStatusEl.textContent = '';
    if (this.timingFramesEl) this.timingFramesEl.textContent = '';
  }

  private updatePosition(): void {
    if (!this.host) return;

    const rect = this.video.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      this.host.style.display = 'none';
      return;
    }

    const parentRect = this.video.parentElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
    this.host.style.left = `${rect.left - parentRect.left}px`;
    this.host.style.top = `${rect.top - parentRect.top}px`;
    this.host.style.width = `${rect.width}px`;
    this.host.style.height = `${rect.height}px`;
  }
}
