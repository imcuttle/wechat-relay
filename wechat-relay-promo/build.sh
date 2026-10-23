#!/bin/sh
# WeChat Relay · 产品宣传片 — rebuild everything:  sh build.sh [--vo]   (--vo re-synthesises and re-checks the voice; needs a connection)
set -e
LIB=${LIB:-/Users/cuttleyu/lemo-opuscar}
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the Lemo-Opuscar library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
cd "$LIB"
if [ "$1" = "--vo" ]; then
  $PY core/tts/tts_zh.py "$HERE/lines.json" "$HERE/voices" --voice zh-CN-YunxiNeural
  $PY core/tts/asr_check.py "$HERE/lines.json" "$HERE/voices" --lang zh
fi
mkdir -p "$HERE/out"
node core/render/events.mjs "$HERE"
$PY "$HERE/sound.py"
node core/render/video.mjs "$HERE" --fps 30 --workers 6 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/wechat-relay-promo.mp4" 30 0
node "$HERE/tools/subs.mjs" && $PY core/render/srt.py "$HERE/out/subs.json" "$HERE/wechat-relay-promo.srt"
node core/render/still.mjs "$HERE" 32.6 --q nosubs=1 --prefix po_ --out "$HERE/out/stills" && cp "$HERE/out/stills/po_32.6.jpg" "$HERE/poster.jpg"
echo "built $HERE/wechat-relay-promo.mp4"
