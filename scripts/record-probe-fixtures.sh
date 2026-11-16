#!/usr/bin/env bash
# Records how the loupe probe shows in the Android dumps. The probe app
# (apps/probe-app) runs in Expo Go, and in each rotation, with and without a
# cutout, the script keeps the uiautomator dump, the display dump and the
# screen. It also times how long the probe takes to follow a rotate. The
# "Probe fixtures" workflow runs it in CI.
#
# Run it from the root of the repository, after `pnpm install` and the build,
# on one booted emulator with a clean system image. Don't run it on a phone:
# the dumps and the screenshots would hold personal data. It downloads Expo
# Go for the SDK of the app, installs it, and starts Metro. It changes the
# rotation, the cutout overlay and the dark mode of the emulator, and puts
# them back at the end.
#
# Usage: scripts/record-probe-fixtures.sh <out-dir>
# With more than one device, set ANDROID_SERIAL to the emulator first.

# No -e: a command that fails doesn't stop the run, and that failure is a
# fixture too.
set -uo pipefail

out=${1:?Usage: scripts/record-probe-fixtures.sh <out-dir>}

sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
adb=${sdk:+$sdk/platform-tools/}adb

app_dir=apps/probe-app
port=8081
expo_go=host.exp.exponent
cutouts=(hole corner)
overlay_prefix=com.android.internal.display.cutout.emulation

# capture <file> <command> [args...]
# Saves stdout to <file>, stderr to <file>.stderr when it isn't empty, and the
# exit code to <file>.exit when it isn't 0.
capture() {
  local name=$1
  local file=$out/$name
  shift
  mkdir -p "$(dirname "$file")"
  local status=0
  "$@" >"$file" 2>"$file.stderr" || status=$?
  [ -s "$file.stderr" ] || rm -f "$file.stderr"
  [ "$status" -eq 0 ] || echo "$status" >"$file.exit"
  echo "$name: exit $status"
}

setting() {
  "$adb" shell settings get system "$1" 2>/dev/null | tr -d '\r'
}

prop() {
  "$adb" shell getprop "$1" 2>/dev/null | tr -d '\r'
}

is_emulator() {
  [ "$(prop ro.boot.qemu)" = 1 ] ||
    [ "$(prop ro.kernel.qemu)" = 1 ] ||
    [ "$(prop ro.hardware)" = ranchu ]
}

now_ms() {
  echo $(($(date +%s%N) / 1000000))
}

# Puts a setting back. "null" means that it had no value.
restore_setting() {
  if [ -z "$2" ] || [ "$2" = null ]; then
    "$adb" shell settings delete system "$1" >/dev/null 2>&1
  else
    "$adb" shell settings put system "$1" "$2" >/dev/null 2>&1
  fi
}

restore() {
  [ -z "${metro_pid:-}" ] || kill "$metro_pid" 2>/dev/null
  "$adb" reverse --remove "tcp:$port" >/dev/null 2>&1
  [ -z "$saved_night" ] || "$adb" shell cmd uimode night "$saved_night" >/dev/null 2>&1
  for cutout in "${cutouts[@]}"; do
    "$adb" shell cmd overlay disable "$overlay_prefix.$cutout" >/dev/null 2>&1
  done
  restore_setting user_rotation "$saved_rotation"
  restore_setting accelerometer_rotation "$saved_auto_rotation"
}

# rotate <rotation> <dir>: as in record-android-fixtures.sh, but with no wait
# after it. The probe wait times the turn.
rotate() {
  capture "$2/user-rotation-lock.txt" "$adb" shell wm user-rotation lock "$1"
  if [ -f "$out/$2/user-rotation-lock.txt.exit" ]; then
    "$adb" shell settings put system accelerometer_rotation 0
    "$adb" shell settings put system user_rotation "$1"
  fi
}

# display <dir>: the display, the insets, and the frames of the windows. The
# frame of the Expo Go window shows a letterbox.
display() {
  capture "$1/wm-size.txt" "$adb" shell wm size
  capture "$1/wm-density.txt" "$adb" shell wm density
  capture "$1/dumpsys-window-displays.txt" "$adb" shell dumpsys window displays
  capture "$1/dumpsys-window-windows.txt" "$adb" shell dumpsys window windows
}

# screen <name>: a screenshot and the uiautomator dump, as loupe takes it.
screen() {
  capture "$1.png" "$adb" exec-out screencap -p
  capture "$1.ui-tty.txt" "$adb" exec-out uiautomator dump /dev/tty
}

# centre_of <ui-file> <attribute> <value>: "x y", the centre in px of the
# first node with that value (XML-escaped) in a uiautomator dump. Empty when
# it isn't there.
centre_of() {
  local bounds left top right bottom
  bounds=$(grep -o " $2=\"$3\"[^>]*bounds=\"[^\"]*\"" "$1" | head -1 |
    grep -o 'bounds="[^"]*"' | sed 's/[^0-9]/ /g')
  [ -n "$bounds" ] || return 0
  read -r left top right bottom <<<"$bounds"
  echo "$(((left + right) / 2)) $(((top + bottom) / 2))"
}

# probe_of <ui-file>: the probe report as JSON, from the content-desc that
# starts with "loupe:". Empty when the dump has no probe. A value with a
# double quote comes in single quotes (API 33–36), so both forms count.
probe_of() {
  grep -o -e "content-desc='loupe:[^']*'" -e 'content-desc="loupe:[^"]*"' "$1" 2>/dev/null |
    head -1 |
    sed -e 's/^content-desc=.loupe://' -e 's/.$//' \
      -e 's/&quot;/"/g' -e "s/&apos;/'/g" -e 's/&amp;/\&/g'
}

# shape_of <report>: "portrait" or "landscape", from the window in the report.
shape_of() {
  sed -n 's/.*"window":{"width":\([0-9.]*\),"height":\([0-9.]*\)}.*/\1 \2/p' <<<"$1" |
    awk '{ print ($1 > $2) ? "landscape" : "portrait" }'
}

# matches <report> <want>: "any", a shape, or a colour scheme.
matches() {
  case $2 in
    any) return 0 ;;
    light | dark) [[ $1 == *"\"colorScheme\":\"$2\""* ]] ;;
    *) [ "$(shape_of "$1")" = "$2" ] ;;
  esac
}

# wait_probe <dir> <want> <limit-s> [start-ms]
# Dumps the screen again and again until the probe shows and matches <want>,
# for up to <limit-s> seconds from [start-ms] (now by default). On the first
# open, Expo Go shows its developer menu: a sheet with a "Continue" button,
# then the menu with a "Close" button. The dump of either one has none of
# the app, so the script taps each button, and keeps the screens.
# <dir>/probe-wait.txt gets one line per dump: the time since the start, the
# window in front, and the probe in the dump. The last dump stays as
# <dir>/last.ui-tty.txt.
wait_probe() {
  local dir=$1 want=$2 limit_ms=$(($3 * 1000)) start=${4:-$(now_ms)}
  local log=$out/$1/probe-wait.txt file=$out/$1/last.ui-tty.txt
  local report focus sheet target x y
  mkdir -p "$out/$dir"
  : >"$log"
  while :; do
    "$adb" exec-out uiautomator dump /dev/tty >"$file" 2>/dev/null
    report=$(probe_of "$file")
    focus=$("$adb" shell dumpsys window displays 2>/dev/null |
      grep -m1 -o 'mCurrentFocus=[^}]*' | tr -d '\r')
    echo "$(($(now_ms) - start)) ms, ${focus:-no focus}, probe: ${report:-none}" >>"$log"

    sheet=
    target=
    if grep -q 'text="Continue"' "$file"; then
      sheet=onboarding
      target=$(centre_of "$file" text Continue)
    elif grep -q 'text="Go home"' "$file"; then
      sheet=dev-menu
      target=$(centre_of "$file" content-desc Close)
    fi

    if [ -n "$target" ]; then
      cp "$file" "$out/$dir/$sheet.ui-tty.txt"
      capture "$dir/$sheet.png" "$adb" exec-out screencap -p
      read -r x y <<<"$target"
      "$adb" shell input tap "$x" "$y"
      echo "tapped the button of the $sheet at $x, $y" >>"$log"
    elif [ -n "$report" ] && matches "$report" "$want"; then
      echo "found $want" >>"$log"
      echo "$dir: probe after $(($(now_ms) - start)) ms"
      return 0
    fi

    if [ $(($(now_ms) - start)) -ge "$limit_ms" ]; then
      echo "timeout" >>"$log"
      capture "$dir/timeout.png" "$adb" exec-out screencap -p
      echo "$dir: no probe ($want) after $3 s" >&2
      return 1
    fi
    sleep 0.5
  done
}

if ! is_emulator; then
  echo "No emulator found. This script runs on one emulator only. With more than one device, set ANDROID_SERIAL." >&2
  exit 1
fi

saved_rotation=$(setting user_rotation)
saved_auto_rotation=$(setting accelerometer_rotation)
saved_night=$("$adb" shell cmd uimode night 2>/dev/null |
  sed -n 's/^Night mode: //p' | tr -d '\r')
trap restore EXIT

mkdir -p "$out"

capture host/adb-version.txt "$adb" version
capture host/adb-devices-l.txt "$adb" devices -l
capture host/emu-avd-name.txt "$adb" emu avd name
capture host/node-version.txt node --version
capture device/getprop.txt "$adb" shell getprop
capture device/uimode-night-at-start.txt "$adb" shell cmd uimode night

# Expo Go for the SDK of the app, from the list that the Expo CLI reads too.
sdk_version=$(cd "$app_dir" && node -p "require('expo/package.json').version.split('.')[0] + '.0.0'")
capture expo-go/version-entry.json node -e "
  fetch('https://api.expo.dev/v2/versions/latest')
    .then((response) => response.json())
    .then(({ data }) => {
      const { relatedPackages, ...entry } = data.sdkVersions[process.argv[1]]
      console.log(JSON.stringify(entry, null, 2))
    })" "$sdk_version"
apk_url=$(node -e "
  const entry = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))
  console.log(entry.androidClientUrl)" "$out/expo-go/version-entry.json")
apk=$(mktemp -d)/expo-go.apk
capture expo-go/download.txt curl -sSfL -o "$apk" \
  -w '%{http_code}, %{size_download} bytes in %{time_total} s\n' "$apk_url"
# -g grants the runtime permissions, so no permission dialog covers the app.
capture expo-go/install.txt "$adb" install -r -g "$apk"
capture expo-go/dumpsys-package.txt "$adb" shell dumpsys package "$expo_go"
if [ -f "$out/expo-go/install.txt.exit" ]; then
  echo "Expo Go didn't install." >&2
  exit 1
fi

# Metro for the probe app. --localhost and `adb reverse` keep it off the
# network.
mkdir -p "$out/metro"
cli=$(cd "$app_dir" && node -p "require.resolve('expo/bin/cli')")
(cd "$app_dir" && CI=1 EXPO_NO_TELEMETRY=1 exec node "$cli" start --localhost --port "$port") \
  >"$out/metro/expo-start.log" 2>&1 &
metro_pid=$!
start=$(now_ms)
until curl -sf "http://127.0.0.1:$port/status" 2>/dev/null | grep -q packager-status:running; do
  if [ $(($(now_ms) - start)) -ge 180000 ] || ! kill -0 "$metro_pid" 2>/dev/null; then
    echo "Metro didn't start." >&2
    exit 1
  fi
  sleep 1
done
echo "$(($(now_ms) - start)) ms" >"$out/metro/ready.txt"

# A cold bundle can take longer than Expo Go waits, so the script fetches
# the bundle of the manifest first.
capture metro/manifest.json curl -sS -H 'expo-platform: android' \
  -H 'accept: application/expo+json,application/json' "http://127.0.0.1:$port"
bundle_url=$(node -e "
  try {
    const manifest = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))
    console.log(manifest.launchAsset.url)
  } catch {}" "$out/metro/manifest.json")
if [ -n "$bundle_url" ]; then
  capture metro/warm.txt curl -sS -o /dev/null --max-time 600 \
    -w '%{http_code}, %{size_download} bytes in %{time_total} s\n' "$bundle_url"
fi

# Only this script turns the screen from here on.
"$adb" shell settings put system accelerometer_rotation 0
rotate 0 open
capture open/reverse.txt "$adb" reverse "tcp:$port" "tcp:$port"
capture open/am-start.txt "$adb" shell am start -W -a android.intent.action.VIEW \
  -d "exp://127.0.0.1:$port" "$expo_go"
wait_probe open any 300 || exit 1
screen open/app
# A sheet can show a moment after the app.
sleep 5
wait_probe open/again any 60

for cutout in none "${cutouts[@]}"; do
  if [ "$cutout" != none ]; then
    capture "$cutout/overlay-enable.txt" "$adb" shell cmd overlay enable "$overlay_prefix.$cutout"
    sleep 3
    wait_probe "$cutout/overlay" any 60
  fi

  for rotation in 0 1 3; do
    dir=$cutout/rotation-$rotation
    shape=portrait
    [ "$rotation" = 0 ] || shape=landscape

    turned=$(now_ms)
    rotate "$rotation" "$dir"
    # Right after the turn, the probe can still show the old window.
    capture "$dir/first.ui-tty.txt" "$adb" exec-out uiautomator dump /dev/tty
    wait_probe "$dir" "$shape" 30 "$turned"
    sleep 1
    display "$dir"
    screen "$dir/app"
  done

  if [ "$cutout" != none ]; then
    capture "$cutout/overlay-disable.txt" "$adb" shell cmd overlay disable "$overlay_prefix.$cutout"
    sleep 3
    wait_probe "$cutout/overlay-off" any 60
  fi
done

# Dark mode, in portrait with no cutout: the colour scheme must follow.
rotate 0 night
wait_probe night/portrait portrait 30
capture night/uimode-yes.txt "$adb" shell cmd uimode night yes
wait_probe night dark 30
screen night/app
capture night/uimode-no.txt "$adb" shell cmd uimode night no
wait_probe night/light light 30

# A compressed dump leaves out the views that aren't important for
# accessibility. The probe is one, so it must be missing here.
capture extra/ui-compressed.txt "$adb" exec-out uiautomator dump --compressed /dev/tty
