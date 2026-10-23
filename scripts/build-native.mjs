// Compiles native/wx-vision.swift into native/bin/wx-vision when the source is newer than the binary.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'native', 'wx-vision.swift');
const out = join(root, 'native', 'bin', 'wx-vision');

if (process.platform !== 'darwin') {
  console.log('[build-native] skipped (macOS only)');
  process.exit(0);
}
if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) {
  console.log('[build-native] up to date');
  process.exit(0);
}
mkdirSync(dirname(out), { recursive: true });
console.log('[build-native] swiftc wx-vision.swift');
execFileSync('swiftc', ['-O', src, '-o', out], { stdio: 'inherit' });
