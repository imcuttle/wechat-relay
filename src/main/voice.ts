import { exec } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { VoiceConfig } from '@shared/types';
import { CACHE_DIR, expandEnv } from './config';
import { errText, logger } from './util';

const log = logger.scope('voice');
const VOICE_DIR = join(CACHE_DIR, 'voice');

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const untilde = (p: string) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/** Turns a chat reply into something worth saying aloud: no Markdown, links, emoji or [表情] stickers. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\[[^\]\n]{1,6}\]/g, ' ')
    .replace(/[*_`#>~]+/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s*\n+\s*/g, '，')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export interface Synth { file: string; ext: string; bytes: number }

async function http(url: string, init: RequestInit, timeoutMs: number): Promise<Buffer> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`TTS 服务返回 ${res.status}：${(await res.text().catch(() => '')).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

const join2 = (base: string, path: string) => `${base.replace(/\/+$/, '')}${path}`;

/** Synthesises `text` into an audio file under the cache dir. Throws when the service fails (caller falls back to text). */
export async function synthesize(cfg: VoiceConfig, text: string): Promise<Synth> {
  mkdirSync(VOICE_DIR, { recursive: true });
  const key = expandEnv(cfg.apiKey);
  const json = { 'Content-Type': 'application/json' };
  let audio: Buffer;
  let ext = 'mp3';
  switch (cfg.provider) {
    case 'openai':
      audio = await http(join2(cfg.baseUrl || 'https://api.openai.com/v1', '/audio/speech'), {
        method: 'POST', headers: { ...json, Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: cfg.model || 'tts-1', input: text, voice: cfg.voice || 'alloy', response_format: 'mp3', ...(cfg.speed ? { speed: cfg.speed } : {}) }),
      }, cfg.timeoutMs);
      break;
    case 'elevenlabs':
      if (!cfg.voice) throw new Error('ElevenLabs 需要配置 voice（voice_id）');
      audio = await http(`${(cfg.baseUrl || 'https://api.elevenlabs.io').replace(/\/+$/, '')}/v1/text-to-speech/${encodeURIComponent(cfg.voice)}?output_format=mp3_44100_128`, {
        method: 'POST', headers: { ...json, 'xi-api-key': key },
        body: JSON.stringify({ text, model_id: cfg.model || 'eleven_multilingual_v2' }),
      }, cfg.timeoutMs);
      break;
    case 'fish':
      audio = await http(join2(cfg.baseUrl || 'https://api.fish.audio', '/v1/tts'), {
        method: 'POST', headers: { ...json, Authorization: `Bearer ${key}`, model: cfg.model || 's1' },
        body: JSON.stringify({ text, format: 'mp3', ...(cfg.voice ? { reference_id: cfg.voice } : {}) }),
      }, cfg.timeoutMs);
      break;
    case 'gpt-sovits': {
      if (!cfg.refAudio) throw new Error('GPT-SoVITS 需要配置 refAudio（你自己的样音文件）');
      audio = await http(join2(cfg.baseUrl || 'http://127.0.0.1:9880', '/tts'), {
        method: 'POST', headers: json,
        body: JSON.stringify({
          text, text_lang: 'zh', ref_audio_path: untilde(cfg.refAudio), prompt_text: cfg.refText ?? '', prompt_lang: 'zh',
          media_type: 'wav', streaming_mode: false, text_split_method: 'cut5', speed_factor: cfg.speed ?? 1,
        }),
      }, cfg.timeoutMs);
      ext = 'wav';
      break;
    }
    case 'command': {
      if (!cfg.command) throw new Error('provider=command 需要配置 command');
      const out = join(VOICE_DIR, `cmd-${Date.now()}.mp3`);
      const cmd = cfg.command.replace(/\{\{text\}\}/g, () => shq(text)).replace(/\{\{out\}\}/g, () => shq(out));
      await new Promise<void>((resolve, reject) => exec(cmd, { timeout: cfg.timeoutMs }, (e, _o, se) => (e ? reject(new Error(`${errText(e)} ${se}`.trim())) : resolve())));
      audio = readFileSync(out);
      break;
    }
    default:
      throw new Error(`未知的 TTS provider：${String(cfg.provider)}`);
  }
  if (audio.length < 1000) throw new Error('TTS 返回的音频过短，可能服务出错');
  const file = join(VOICE_DIR, `tts-${Date.now()}.${ext}`);
  writeFileSync(file, audio);
  log.info(`合成完成 ${audio.length} 字节（${cfg.provider}）`);
  return { file, ext, bytes: audio.length };
}
