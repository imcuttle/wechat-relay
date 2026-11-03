// Compiles native/*.swift (wx-vision, wx-audio) into native/bin/ when the source is newer than the binary.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { arch } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform !== 'darwin') {
  console.log('[build-native] skipped (macOS only)');
  process.exit(0);
}
for (const name of ['wx-vision', 'wx-audio']) {
  const src = join(root, 'native', `${name}.swift`);
  const out = join(root, 'native', 'bin', name);
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) {
    console.log(`[build-native] ${name} up to date`);
    continue;
  }
  mkdirSync(dirname(out), { recursive: true });
  console.log(`[build-native] swiftc ${name}.swift`);
  execFileSync('swiftc', ['-O', src, '-o', out], { stdio: 'inherit' });
}

// Bundle the Cua Driver binary so WeChat Relay runs its own copy (embedded mode) instead of CodeBuddy's.
const driverSources = [
  '/Applications/CodeBuddy Desktop.app/Contents/Resources/native/cua-driver/vendor/CuaDriver.app/Contents/MacOS/cua-driver',
  '/Applications/CuaDriver.app/Contents/MacOS/cua-driver',
];
const driverOut = join(root, 'native', 'bin', 'cua-driver');
const driverSrc = driverSources.find((p) => existsSync(p));
if (driverSrc) {
  if (existsSync(driverOut) && statSync(driverOut).mtimeMs >= statSync(driverSrc).mtimeMs) {
    console.log('[build-native] cua-driver up to date');
  } else {
    mkdirSync(dirname(driverOut), { recursive: true });
    console.log(`[build-native] cua-driver <- ${driverSrc}`);
    try {
      // The upstream binary is universal; keep only this machine's slice.
      execFileSync('lipo', [driverSrc, '-thin', arch() === 'arm64' ? 'arm64' : 'x86_64', '-output', driverOut], { stdio: 'pipe' });
      // Thinning invalidates the upstream signature and arm64 macOS kills binaries with a broken one.
      execFileSync('codesign', ['--force', '--sign', '-', driverOut], { stdio: 'pipe' });
    } catch {
      copyFileSync(driverSrc, driverOut);
    }
  }
} else if (!existsSync(driverOut)) {
  console.warn('[build-native] 找不到 cua-driver：运行时将回退到 CodeBuddy Desktop 自带的驱动');
}
