#!/usr/bin/env bash
# Builds Home Deck Notify without Gradle: aapt2 -> javac -> d8 -> zipalign -> apksigner.
# Needs a JDK 17 and the Android SDK (build-tools 36.0.0, platform android-36).
#   ANDROID_SDK  defaults to %LOCALAPPDATA%/Android/Sdk
#   KEYSTORE     signing key, kept outside the repo (made on first build)
# Output: build/home-deck-notify.apk
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_SDK:-$LOCALAPPDATA/Android/Sdk}"
BT="$SDK/build-tools/36.0.0"
JAR="$SDK/platforms/android-36/android.jar"
KEYSTORE="${KEYSTORE:-$LOCALAPPDATA/home-deck/notify-release.jks}"
EXE=""; [ -f "$BT/aapt2.exe" ] && EXE=".exe"
BAT=""; [ -f "$BT/d8.bat" ] && BAT=".bat"

rm -rf build && mkdir -p build/res build/gen build/classes build/dex

"$BT/aapt2$EXE" compile --dir res -o build/res/res.zip
"$BT/aapt2$EXE" link -I "$JAR" --manifest AndroidManifest.xml --min-sdk-version 26 --target-sdk-version 36 \
  --java build/gen -o build/base.apk build/res/res.zip

find src build/gen -name '*.java' > build/sources.txt
javac -encoding UTF-8 --release 17 -Xlint:-options -classpath "$JAR" -d build/classes @build/sources.txt 2>&1 \
  | grep -v "^Note:" || true
[ -n "$(find build/classes -name '*.class' -print -quit)" ] || { echo "javac failed"; exit 1; }

"$BT/d8$BAT" --release --min-api 26 --lib "$JAR" --output build/dex $(find build/classes -name '*.class')

cp build/base.apk build/unsigned.apk
(cd build/dex && jar uf ../unsigned.apk classes.dex)
"$BT/zipalign$EXE" -f -p 4 build/unsigned.apk build/aligned.apk

if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -keystore "$KEYSTORE" -alias notify -keyalg RSA -keysize 2048 -validity 36500 \
    -storepass homedeck -keypass homedeck -dname "CN=Home Deck Notify" >/dev/null 2>&1
fi
"$BT/apksigner$BAT" sign --ks "$KEYSTORE" --ks-key-alias notify --ks-pass pass:homedeck --key-pass pass:homedeck \
  --out build/home-deck-notify.apk build/aligned.apk
"$BT/apksigner$BAT" verify build/home-deck-notify.apk
ls -l build/home-deck-notify.apk
