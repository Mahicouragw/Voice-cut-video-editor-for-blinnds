#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Generate missing Gradle wrapper, activity, styles and icons without overwriting source.
TEMP=$(mktemp -d)
trap 'rm -rf "$TEMP"' EXIT
flutter create --platforms=android --org=com.mahicouragw --project-name=voicecut_studio "$TEMP/scaffold"
cp -R flutter_app/android/. "$TEMP/overrides/"
cp -R "$TEMP/scaffold/android/." flutter_app/android/
cp -R "$TEMP/overrides/." flutter_app/android/
