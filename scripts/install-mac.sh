#!/usr/bin/env bash
# 打包 WeChat Relay 为正式 macOS .app，安装到 /Applications 并启动。
#
# 为什么需要它：dev 模式下应用以 "Electron" 的临时身份运行，系统通知会被静默丢弃；
# 打包成带正式 bundle id(dev.cuttleyu.wechat-relay) 的 .app 后，草稿待审核 / 安全停止等通知才能正常弹出。
# 识别用的 wx-vision(Swift) 会一并编译并放进 .app 的 Resources/native。
#
# 用法：
#   bash scripts/install-mac.sh              # 构建 + 安装 + 启动
#   bash scripts/install-mac.sh --no-launch  # 只构建安装，不启动
#   npm run install:mac                      # 同上(见 package.json)
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="WeChat Relay"
DEST="/Applications/${APP_NAME}.app"
LAUNCH=1
for arg in "$@"; do
  [ "$arg" = "--no-launch" ] && LAUNCH=0
done

echo "==> 1/4 构建并打包 (typecheck + wx-vision + electron-vite build + electron-builder --mac)"
npm run build:mac

# electron-builder 按架构输出到 dist/mac-arm64 或 dist/mac
echo "==> 2/4 定位产物 .app"
BUILT_APP="$(find dist -maxdepth 2 -name "${APP_NAME}.app" -type d 2>/dev/null | head -1)"
if [ -z "${BUILT_APP}" ]; then
  echo "错误：dist/ 下未找到 ${APP_NAME}.app，构建可能失败" >&2
  exit 1
fi
if [ ! -x "${BUILT_APP}/Contents/Resources/native/wx-vision" ]; then
  echo "错误：${BUILT_APP} 中缺少 Resources/native/wx-vision" >&2
  exit 1
fi
echo "    产物：${BUILT_APP}"

echo "==> 3/4 安装到 ${DEST}"
# 若旧版本在运行，先退出，避免覆盖时文件占用
osascript -e "tell application \"${APP_NAME}\" to quit" 2>/dev/null || true
sleep 1
rm -rf "${DEST}"
cp -R "${BUILT_APP}" "${DEST}"
# 去除隔离属性，避免 Gatekeeper 拦截(本地 ad-hoc 签名场景)
xattr -dr com.apple.quarantine "${DEST}" 2>/dev/null || true

if [ "${LAUNCH}" = "1" ]; then
  echo "==> 4/4 启动 ${APP_NAME}"
  open "${DEST}"
else
  echo "==> 4/4 跳过启动 (--no-launch)"
fi

echo "完成。已安装到 ${DEST}"
echo "提示：识别与操作微信依赖 CodeBuddy Desktop 内置的 Cua Driver，首次使用需在 系统设置 → 隐私与安全性 中为 Cua Driver 打开「辅助功能」和「录屏与系统录音」。"
