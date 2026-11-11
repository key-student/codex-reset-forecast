#!/bin/bash
set -euo pipefail
umask 077

if [[ "$(uname -s)" != Darwin || "$(id -u)" == 0 ]]; then
    echo "请在普通 macOS 用户账户中运行。" >&2
    exit 1
fi

label=io.github.key-student.codex-reset-forecast
domain="gui/$(id -u)"
job="$domain/$label"
root="$HOME/Library/Application Support/Codex Reset Forecast"
runtime="$root/runtime"
data="$root/data"
agents="$HOME/Library/LaunchAgents"
plist="$agents/$label.plist"
app=/Applications/ChatGPT.app

stop_job() {
    if /bin/launchctl print "$job" >/dev/null 2>&1; then
        /bin/launchctl bootout "$job"
    fi
}

case "${1:-}" in
    status)
        if /bin/launchctl print "$job" >/dev/null 2>&1; then
            echo "Codex Reset Forecast 启动助手已注册。"
        else
            echo "Codex Reset Forecast 启动助手未运行。"
        fi
        exit
        ;;
    uninstall)
        stop_job
        rm -f "$plist"
        rm -rf "$runtime"
        echo "已卸载启动助手。显示时段保存在 $data。"
        exit
        ;;
    install) ;;
    *) echo "用法：bash standalone/install.sh install|status|uninstall" >&2; exit 64 ;;
esac

node_bin=$(command -v node || true)
if [[ -z "$node_bin" ]] || ! "$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0]) < 22 ? 1 : 0)'; then
    echo "请让 Node.js 22 或更新版本出现在 PATH 中。" >&2
    exit 1
fi
node_bin=$("$node_bin" -p 'process.execPath')
if [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" != com.openai.codex ]]; then
    echo "找不到 /Applications/ChatGPT.app 中的 Codex。" >&2
    exit 1
fi

project=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$root" "$data" "$agents"
stage=$(mktemp -d "$root/.install.XXXXXX")
changing=0
runtime_moved=0
new_runtime=0
cleanup() {
    if [[ "$changing" == 1 ]]; then
        stop_job || true
        if [[ "$new_runtime" == 1 ]]; then mv "$runtime" "$stage/failed-runtime"; fi
        if [[ "$runtime_moved" == 1 ]]; then mv "$stage/old-runtime" "$runtime"; fi
        if [[ -f "$stage/old.plist" ]]; then
            cp "$stage/old.plist" "$plist"
            /bin/launchctl bootstrap "$domain" "$plist" || true
        else
            rm -f "$plist"
        fi
    fi
    rm -rf "$stage"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

mkdir -p "$stage/runtime/src" "$stage/runtime/standalone"
cp "$project/package.json" "$stage/runtime/"
cp "$project/src/"{node.js,renderer.js,preferences.js,style.css} "$stage/runtime/src/"
cp "$project/standalone/agent.js" "$stage/runtime/standalone/"
/usr/bin/swiftc -O -parse-as-library "$project/standalone/Launcher.swift" -o "$stage/runtime/launcher"

candidate="$stage/new.plist"
/usr/bin/plutil -create xml1 "$candidate"
/usr/bin/plutil -insert Label -string "$label" "$candidate"
/usr/bin/plutil -insert ProgramArguments -json '[]' "$candidate"
index=0
for argument in "$runtime/launcher" "$app" "$node_bin" "$runtime/standalone/agent.js" "$data"; do
    /usr/bin/plutil -insert "ProgramArguments.$index" -string "$argument" "$candidate"
    index=$((index + 1))
done
/usr/bin/plutil -insert RunAtLoad -bool YES "$candidate"
/usr/bin/plutil -insert KeepAlive -json '{"SuccessfulExit":false}' "$candidate"
/usr/bin/plutil -insert ProcessType -string Background "$candidate"
/usr/bin/plutil -insert StandardErrorPath -string "$root/launcher.log" "$candidate"
/usr/bin/plutil -lint "$candidate"

if [[ -f "$plist" ]]; then cp "$plist" "$stage/old.plist"; fi
stop_job
changing=1
if [[ -d "$runtime" ]]; then
    mv "$runtime" "$stage/old-runtime"
    runtime_moved=1
fi
mv "$stage/runtime" "$runtime"
new_runtime=1
mv "$candidate" "$plist"
/bin/launchctl bootstrap "$domain" "$plist"
changing=0

echo "安装完成。方便时退出 Codex，再从原来的 Dock 图标打开。"
