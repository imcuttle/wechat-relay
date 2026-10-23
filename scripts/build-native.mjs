// Compiles native/*.swift (wx-vision, wx-audio) into native/bin/ when the source is newer than the binary.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
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
