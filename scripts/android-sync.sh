#!/usr/bin/env bash
# Recopie le dépôt (WSL) vers un dossier Windows pour construire l'application
# Android (`docs/ANDROID.md`) : Gradle et les liens symboliques de
# `tauri android build` ne marchent pas sur un chemin `\\wsl.localhost\…`.
#
#   scripts/android-sync.sh            # construit web/dist-app puis recopie
#   scripts/android-sync.sh --no-web   # recopie seulement
#   scripts/android-sync.sh --back     # rapatrie app-tauri/gen/android (après
#                                      # `cargo tauri android init` côté Windows)
#
# La destination : $GUIVAULT_ANDROID_DIR, sinon
# /mnt/c/Users/<utilisateur Windows>/guivault-android.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
win_user="$(powershell.exe -NoProfile -Command '$env:USERNAME' | tr -d '\r')"
dest="${GUIVAULT_ANDROID_DIR:-/mnt/c/Users/$win_user/guivault-android}"

# Ce que Gradle et Cargo produisent côté Windows : jamais écrasé ni rapatrié.
build_outputs=(
  --exclude 'app-tauri/gen/android/.gradle/'
  --exclude 'app-tauri/gen/android/build/'
  --exclude 'app-tauri/gen/android/app/build/'
  --exclude 'app-tauri/gen/android/buildSrc/build/'
  --exclude 'app-tauri/gen/android/buildSrc/.gradle/'
  --exclude 'app-tauri/gen/android/app/src/main/jniLibs/'
  --exclude 'app-tauri/gen/android/app/src/main/assets/'
  --exclude 'app-tauri/gen/android/local.properties'
  --exclude 'app-tauri/gen/android/.idea/'
)

if [[ "${1:-}" == "--back" ]]; then
  rsync -a "${build_outputs[@]}" "$dest/app-tauri/gen/android/" "$repo/app-tauri/gen/android/"
  echo "gen/android rapatrié dans $repo/app-tauri/gen/android"
  exit 0
fi

if [[ "${1:-}" != "--no-web" ]]; then
  (cd "$repo/web" && npm run build:app >/dev/null)
fi

mkdir -p "$dest"
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'target/' \
  --exclude 'node_modules/' \
  --exclude 'web/dist/' \
  --exclude 'web/dist-extension/' \
  --exclude 'web/app/e2e/.output/' \
  "${build_outputs[@]}" \
  "$repo/" "$dest/"
echo "recopié vers $dest"
