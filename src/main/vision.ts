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

/** Long-lived native helper (Apple Vision OCR + WeChat layout analysis), JSON lines over stdio. */
export class Vision {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, (r: VisionResult) => void>();
  private nextId = 1;
  constructor(private bin: string) {}

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    if (!existsSync(this.bin)) throw new Error(`缺少 OCR 组件 ${this.bin}，请先运行 npm run build:native`);
    const p = spawn(this.bin, ['--serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: p.stdout }).on('line', (line) => {
      try {
        const msg = JSON.parse(line) as { id: number; result: VisionResult };
        this.pending.get(msg.id)?.(msg.result);
        this.pending.delete(msg.id);
      } catch { /* ignore */ }
    });
    p.stderr.on('data', (d) => log.warn(String(d).trim()));
    p.on('exit', (code) => {
      log.warn(`wx-vision exited (${code})`);
      this.proc = null;
      for (const r of this.pending.values()) r({ ok: false, error: 'vision helper exited' } as VisionResult);
      this.pending.clear();
    });
    this.proc = p;
    return p;
  }

  parse(image: string, scale: number, timeoutMs = 15000): Promise<VisionResult> {
    const p = this.ensure();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('vision timeout')); }, timeoutMs);
      this.pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
      p.stdin.write(JSON.stringify({ id, image, scale }) + '\n');
    });
  }

  close(): void { this.proc?.kill(); this.proc = null; }
}
