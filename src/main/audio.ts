import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VoiceConfig } from '@shared/types';
import { DATA_DIR } from './config';
import { errText, logger } from './util';

const log = logger.scope('audio');
const RESTORE_FILE = join(DATA_DIR, 'voice-restore.json');

/** The reply cannot be sent as a voice message, and nothing was done in WeChat yet: fall back to text. */
export class VoiceUnavailable extends Error {}
/** The voice button did not start a recording (nothing to clean up); may be retried in the foreground. */
export class NotRecordingError extends VoiceUnavailable {}
/** Something went wrong once recording had started: do NOT fall back to text (a voice message may have gone out). */
export class VoiceFailed extends Error {}

export interface AudioDevice { id: number; uid: string; name: string; input: boolean; output: boolean; running: boolean }

/**
 * Wraps the `wx-audio` helper. The system default input is switched to the virtual device only inside
 * `withVirtualInput` and is always put back (also after a crash: the original device is persisted and restored at startup).
 */
export class AudioRig {
  constructor(private bin: string) {}

  private run<T extends { ok: boolean; error?: string }>(args: string[], timeoutMs = 15000): Promise<T> {
    if (!existsSync(this.bin)) return Promise.reject(new Error(`缺少音频组件 ${this.bin}，请先运行 npm run build:native`));
    return new Promise((resolve, reject) => execFile(this.bin, args, { timeout: timeoutMs }, (e, so) => {
      try {
        const r = JSON.parse(so || '{}') as T;
        if (r.ok) resolve(r); else reject(new Error(r.error ?? errText(e)));
      } catch { reject(new Error(errText(e))); }
    }));
  }

  async devices(): Promise<AudioDevice[]> { return (await this.run<{ ok: boolean; devices: AudioDevice[] }>(['devices'])).devices; }
  private getInput(): Promise<AudioDevice & { ok: boolean }> { return this.run(['get-input']); }
  private setInput(uid: string): Promise<{ ok: boolean }> { return this.run(['set-input', uid]); }
  async duration(file: string): Promise<number> { return (await this.run<{ ok: boolean; seconds: number }>(['duration', file])).seconds; }

  /** Restores the default input left switched by a crashed run. Call once at startup. */
  async recover(): Promise<void> {
    if (!existsSync(RESTORE_FILE)) return;
    try {
      const { uid } = JSON.parse(readFileSync(RESTORE_FILE, 'utf8')) as { uid: string };
      await this.setInput(uid);
      log.warn(`上次异常退出，已把默认输入设备恢复为 ${uid}`);
    } catch (e) { log.warn(`恢复默认输入设备失败：${errText(e)}`); }
    rmSync(RESTORE_FILE, { force: true });
  }

  /**
   * Checks everything that can be checked without touching WeChat: the virtual device exists, the real microphone is
   * not used by another app (call / meeting), the audio is short enough.
   */
  async preflight(cfg: VoiceConfig, file: string): Promise<{ virtual: AudioDevice; real: AudioDevice }> {
    const seconds = await this.duration(file);
    if (seconds > cfg.maxSeconds) throw new VoiceUnavailable(`语音 ${seconds.toFixed(0)} 秒，超过上限 ${cfg.maxSeconds} 秒`);
    const virtual = (await this.devices()).find((d) => d.input && d.output && d.name.toLowerCase().includes(cfg.virtualDevice.toLowerCase()));
    if (!virtual) throw new VoiceUnavailable(`没有找到虚拟声卡「${cfg.virtualDevice}」（需要安装 BlackHole 2ch 等）`);
    const real = await this.getInput();
    if (real.uid !== virtual.uid && real.running) throw new VoiceUnavailable(`麦克风「${real.name}」正被其他应用使用（通话 / 会议？），改发文字`);
    return { virtual, real };
  }

  async withVirtualInput<T>(virtual: AudioDevice, real: AudioDevice, fn: () => Promise<T>): Promise<T> {
    const switched = real.uid !== virtual.uid;
    if (switched) {
      writeFileSync(RESTORE_FILE, JSON.stringify({ uid: real.uid }));
      await this.setInput(virtual.uid);
    }
    try {
      return await fn();
    } finally {
      if (switched) {
        try {
          await this.setInput(real.uid);
          if ((await this.getInput()).uid !== real.uid) throw new Error('恢复后读取到的默认输入不一致');
          rmSync(RESTORE_FILE, { force: true });
        } catch (e) {
          log.error(`恢复默认输入设备「${real.name}」失败，请在 系统设置 → 声音 → 输入 中手动选回：${errText(e)}`);
        }
      }
    }
  }

  /** Plays a file on the virtual device only; the system default output is untouched. */
  play(file: string, device: AudioDevice): Promise<void> {
    return this.run(['play', file, device.uid], 120000).then(() => undefined);
  }
}
