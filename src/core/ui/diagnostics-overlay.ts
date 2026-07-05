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
  private frameTimes: number[] = [];
  private lastUpdateTime = 0;
  private hasFirstUpdate = false;
  private adapterInfo: string;
  private video: HTMLVideoElement;
  private resizeObserver: ResizeObserver | null = null;

  private static readonly MAX_FRAME_TIMES = 60;
  private static readonly MAX_REASONABLE_DELTA_MS = 500;

  private constructor(video: HTMLVideoElement, adapterInfo: string) {
    this.video = video;
    this.adapterInfo = adapterInfo;
  }

  public static create(video: HTMLVideoElement, adapterInfo: string): DiagnosticsOverlay {
    const overlay = new DiagnosticsOverlay(video, adapterInfo);
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
  }

  public update(frameTime: number, pipelineCount: number): void {
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
