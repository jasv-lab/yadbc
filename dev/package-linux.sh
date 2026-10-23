#!/usr/bin/env bash
# Builds the Linux release into dist/release (CI runs it on a v* tag; it also runs on Windows in git-bash):
#   yadbc.AppImage   one file to download, chmod +x and run; it updates itself like the Windows install.
# Self-contained .NET. The system provides the web view and the keyring:
#   sudo apt install libwebkit2gtk-4.1-0 libnotify4 libsecret-tools   (Debian / Ubuntu names)
set -euo pipefail
version=${1:-0.1.0}
root=$(cd "$(dirname "$0")/.." && pwd)
dist=$root/dist

cd "$root/web"
[ -d node_modules ] || npm ci
npx ng build

rm -rf "$dist"
dotnet publish "$root/src/Yadbc.Host" -c Release -r linux-x64 --self-contained -p:Version="$version" -o "$dist/publish"

cd "$root"
dotnet tool restore
# [linux]: packs for Linux from any OS (a Windows machine included).
dotnet vpk "[linux]" pack --packId yadbc --packVersion "$version" --runtime linux-x64 --packTitle yadbc \
  --packAuthors 'Jan Svimbersky' --packDir "$dist/publish" --mainExe Yadbc.Host --icon src/Yadbc.Host/yadbc.png \
  --outputDir "$dist/release"
ls -la "$dist/release"
