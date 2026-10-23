import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { VisionResult } from '@shared/types';
import { logger } from './util';

const log = logger.scope('vision');

export function visionBinary(appRoot: string, resourcesPath?: string): string {
  const candidates = [resourcesPath && join(resourcesPath, 'native', 'wx-vision'), join(appRoot, 'native', 'bin', 'wx-vision')].filter(Boolean) as string[];
  return candidates.find((c) => existsSync(c)) ?? candidates[candidates.length - 1];
}

export interface CropResult { ok: boolean; error?: string | null; width: number; height: number; bytes: number; std?: number }
export interface OcrResult { ok: boolean; text: string; width: number; height: number; std: number }
export interface ClipResult { ok: boolean; error?: string | null; restored?: boolean | null }
export interface WinInfo { id: number; layer: number; x: number; y: number; w: number; h: number; name?: string | null }
type Reply = { result?: VisionResult; crop?: CropResult; clip?: ClipResult; windows?: WinInfo[]; luma?: number[]; ocr?: OcrResult };

/** Long-lived native helper (Apple Vision OCR + WeChat layout analysis + image crops), JSON lines over stdio. */
export class Vision {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, (r: Reply) => void>();
  private nextId = 1;
  constructor(private bin: string) {}

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    if (!existsSync(this.bin)) throw new Error(`缺少 OCR 组件 ${this.bin}，请先运行 npm run build:native`);
    const p = spawn(this.bin, ['--serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: p.stdout }).on('line', (line) => {
      try {
        const msg = JSON.parse(line) as Reply & { id: number };
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      } catch { /* ignore */ }
    });
    p.stderr.on('data', (d) => log.warn(String(d).trim()));
    p.on('exit', (code) => {
      log.warn(`wx-vision exited (${code})`);
      this.proc = null;
      for (const r of this.pending.values()) r({ result: { ok: false, error: 'vision helper exited' } as VisionResult, crop: { ok: false, error: 'vision helper exited', width: 0, height: 0, bytes: 0 } });
      this.pending.clear();
    });
    this.proc = p;
    return p;
  }

  private request(body: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
    const p = this.ensure();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('vision timeout')); }, timeoutMs);
      this.pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
      p.stdin.write(JSON.stringify({ id, ...body }) + '\n');
    });
  }

  async parse(image: string, scale: number, timeoutMs = 15000): Promise<VisionResult> {
    return (await this.request({ image, scale }, timeoutMs)).result ?? ({ ok: false, error: 'no result' } as VisionResult);
  }

  /** Crops `box` out of a screenshot into a JPEG whose longest side is at most `maxDim`. */
  async crop(image: string, box: { x: number; y: number; w: number; h: number }, out: string, maxDim: number, quality = 0.85): Promise<CropResult> {
    const r = await this.request({ crop: { image, ...box, out, maxDim, quality } }, 10000);
    return r.crop ?? { ok: false, error: 'no result', width: 0, height: 0, bytes: 0 };
  }

  /**
   * Clipboard via NSPasteboard in the helper: `save` snapshots every item/type, `set` puts plain text (marked transient),
   * `restore` puts the snapshot back unless something else was copied after `set`.
   */
  async clipboard(op: 'save' | 'set' | 'restore', text?: string): Promise<ClipResult> {
    const r = await this.request({ clip: { op, text } }, 5000);
    const c = r.clip ?? { ok: false, error: 'no result' };
    if (!c.ok && op !== 'restore') throw new Error(`剪贴板操作失败（${op}）：${c.error}`);
    return c;
  }

  /** OCR of a whole image file (zoomed in), plus its size and luminance spread (std ≈ 0 → blank / black). */
  async ocr(image: string): Promise<OcrResult> {
    return (await this.request({ ocr: { image } }, 15000)).ocr ?? { ok: false, text: '', width: 0, height: 0, std: 0 };
  }

  /** On-screen windows of `pid` (CoreGraphics), including popups the driver's list_windows does not report. */
  async windows(pid: number): Promise<WinInfo[]> {
    return (await this.request({ windows: { pid } }, 5000)).windows ?? [];
  }

  /** Mean luminance of an 8px strip at (x, y) for every y in `ys` (screenshot pixels). */
  async luma(image: string, x: number, ys: number[]): Promise<number[]> {
    return (await this.request({ luma: { image, x, ys } }, 5000)).luma ?? [];
  }

  close(): void { this.proc?.kill(); this.proc = null; }
}
