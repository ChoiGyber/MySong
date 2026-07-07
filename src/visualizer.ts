// Canvas waveform visualizer.
//
// It runs in "simulated" mode: bars animate while audio is playing and settle to
// a low idle line when paused. This keeps the visualizer working uniformly for
// both local files and remote (YouTube) streams — a real Web Audio AnalyserNode
// can't tap cross-origin streams without muting them, so we don't route through it.

export const BAR_COUNT = 60;

export class Visualizer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private heights: number[] = new Array(BAR_COUNT).fill(0.04);
  private targets: number[] = new Array(BAR_COUNT).fill(0.04);
  private playing = false;
  private volume = 0.8;
  private t = 0;
  private raf = 0;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.resize();
    this.loop();
  }

  setPlaying(p: boolean) {
    this.playing = p;
  }

  private spectrumFn: (() => number[] | null) | null = null;
  /** Provide a real analyser feed; when it returns null the simulation runs. */
  setSpectrumSource(fn: () => number[] | null) {
    this.spectrumFn = fn;
  }

  setVolume(v: number) {
    this.volume = v;
  }

  private resize() {
    this.dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.max(1, Math.floor(w * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(h * this.dpr));
  }

  private nextTargets() {
    // 60-band pseudo-spectrum in three zones:
    //   left  (0.00–0.33)  low  — tall bars, slow swells, strong beat pulse
    //   mid   (0.33–0.66)  mid  — medium height and motion, light pulse
    //   right (0.66–1.00)  high — short bars, fast sparkly flicker
    const beat = 0.55 + 0.45 * Math.max(0, Math.sin(this.t * 2.2)) ** 2;
    for (let i = 0; i < BAR_COUNT; i++) {
      if (!this.playing) {
        this.targets[i] = 0.05;
        continue;
      }
      const x = i / (BAR_COUNT - 1); // 0 = low … 1 = high
      // Zone weights: smooth crossfade between low / mid / high characters.
      const low = Math.max(0, 1 - x * 3); // 1 → 0 across the left third
      const high = Math.max(0, (x - 2 / 3) * 3); // 0 → 1 across the right third
      const mid = 1 - low - high;

      const envelope = low * 1.0 + mid * 0.72 + high * 0.45; // energy per zone
      const speed = low * 1.4 + mid * 3.2 + high * 7.0; // oscillation speed per zone
      const a = Math.sin(this.t * speed + i * 0.7);
      const b = Math.sin(this.t * speed * 1.9 + i * 0.31 + 1.3);
      const sparkle = high * 0.3 * Math.sin(this.t * 11 + i * 2.1); // extra treble shimmer
      let v = 0.5 + 0.5 * (a * 0.55 + b * 0.45 + sparkle);
      v = Math.max(0, v);
      v = v * v; // punchier peaks
      const pulse = 0.7 + 0.3 * beat * (low + mid * 0.35); // beat hits lows hardest
      this.targets[i] = Math.max(
        0.06,
        v * envelope * pulse * (0.45 + 0.55 * this.volume)
      );
    }
  }

  private loop = () => {
    this.t += 0.045;
    const real = this.playing ? this.spectrumFn?.() ?? null : null;
    if (real) {
      for (let i = 0; i < BAR_COUNT; i++) {
        // Mild curve lift so quiet high-frequency content stays visible.
        this.targets[i] = Math.max(0.04, Math.pow(real[i] ?? 0, 0.8));
      }
    } else {
      this.nextTargets();
    }

    const { ctx, canvas, dpr } = this;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const gap = 2 * dpr;
    const bw = (W - gap * (BAR_COUNT - 1)) / BAR_COUNT;
    const baseline = H - 2 * dpr;

    for (let i = 0; i < BAR_COUNT; i++) {
      // Ease current height toward target.
      this.heights[i] += (this.targets[i] - this.heights[i]) * 0.22;
      const bh = Math.max(2 * dpr, this.heights[i] * (H - 4 * dpr));
      const x = i * (bw + gap);
      const y = baseline - bh;

      // Louder bar → deeper, more saturated color (pale yellow → rich orange).
      const inten = Math.min(1, this.heights[i] * 1.35);
      const hue = 52 - 24 * inten;
      const light = 74 - 22 * inten;
      const alpha = 0.35 + 0.65 * inten;
      ctx.fillStyle = `hsla(${hue}, 100%, ${light}%, ${alpha})`;
      this.roundRect(ctx, x, y, bw, bh, Math.min(bw / 2, 2.5 * dpr));
      ctx.fill();
    }

    this.raf = requestAnimationFrame(this.loop);
  };

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
  ) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
  }
}
