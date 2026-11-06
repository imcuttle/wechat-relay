import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { powerMonitor, powerSaveBlocker } from 'electron';
import type { PowerStatus } from '@shared/types';
import { logger } from './util';

const log = logger.scope('power');
/** Safety net next to the system's lock / unlock notifications (they can be missed, e.g. when the app starts on a locked screen). */
const POLL_MS = 15_000;

/**
 * Screen lock + keep-awake of this Mac.
 *
 * A locked screen hides every other app from accessibility and screenshots, so the monitors can only wait for the
 * unlock. Keep-awake holds a "prevent display sleep" assertion: the display stays on, so neither the idle sleep nor the
 * screen saver / "require password after display off" lock ever kicks in. It does not stop a manual lock (⌃⌘Q), closing
 * the lid or choosing Sleep from the menu.
 *
 * Events: 'locked' (boolean), 'resume' (the Mac woke up), 'change' (PowerStatus).
 */
class Power extends EventEmitter {
  private blocker: number | null = null;
  private poll: NodeJS.Timeout | null = null;
  private state: PowerStatus = { keepAwake: false, locked: false, asleep: false };

  get status(): PowerStatus { return { ...this.state }; }
  get locked(): boolean { return this.state.locked; }

  init(): void {
    powerMonitor.on('lock-screen', () => this.setLocked(true));
    powerMonitor.on('unlock-screen', () => this.setLocked(false));
    powerMonitor.on('suspend', () => { this.patch({ asleep: true }); log.info('电脑进入睡眠，监听暂停'); });
    powerMonitor.on('resume', () => {
      this.patch({ asleep: false });
      log.info('电脑已唤醒');
      this.emit('resume');
      void this.refreshLocked();
    });
    void this.refreshLocked();
    this.poll = setInterval(() => void this.refreshLocked(), POLL_MS);
    this.poll.unref();
  }

  dispose(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.release();
  }

  /** Ask macOS whether the screen is locked right now (the session dictionary only has the key while it is). */
  refreshLocked(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('/usr/sbin/ioreg', ['-n', 'Root', '-d1', '-a'], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
        if (!err) this.setLocked(/<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(out));
        resolve(this.state.locked);
      });
    });
  }

  setKeepAwake(on: boolean): void {
    if (on === this.state.keepAwake) return;
    if (on) {
      this.blocker = powerSaveBlocker.start('prevent-display-sleep');
      log.info('已开启不休眠 / 不锁屏：屏幕保持常亮，不会因空闲休眠或自动锁屏');
    } else {
      this.release();
      log.info('已关闭不休眠 / 不锁屏');
    }
    this.patch({ keepAwake: on });
  }

  private release(): void {
    if (this.blocker !== null && powerSaveBlocker.isStarted(this.blocker)) powerSaveBlocker.stop(this.blocker);
    this.blocker = null;
  }

  private setLocked(locked: boolean): void {
    if (locked === this.state.locked) return;
    this.patch({ locked });
    log.info(locked ? '屏幕已锁定' : '屏幕已解锁');
    this.emit('locked', locked);
  }

  private patch(p: Partial<PowerStatus>): void {
    this.state = { ...this.state, ...p };
    this.emit('change', this.status);
  }
}

export const power = new Power();
