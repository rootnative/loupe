#!/usr/bin/env bash
# Records the raw adb output that the Android driver parses, so each parser
# gets test fixtures for each API level. The "Android fixtures" workflow runs
# it in CI.
#
# Run it on one booted emulator with a clean system image. Don't run it on a
# phone: the dumps and the screenshots would hold personal data. It changes
# the rotation and the cutout overlay of the emulator. At the end it sets the
# rotation back and turns the cutout overlays off.
#
# Usage: scripts/record-android-fixtures.sh <out-dir>
# With more than one device, set ANDROID_SERIAL to the emulator first.

# No -e: a command that fails doesn't stop the run. Some commands don't exist
# on older API levels, and that failure is a fixture too.
set -uo pipefail

out=${1:?Usage: scripts/record-android-fixtures.sh <out-dir>}

sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
if [ -n "$sdk" ]; then
  adb=$sdk/platform-tools/adb
  emulator=$sdk/emulator/emulator
else
  adb=adb
  emulator=emulator
fi

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

# Puts a setting back. "null" means that it had no value.
restore_setting() {
  if [ -z "$2" ] || [ "$2" = null ]; then
    "$adb" shell settings delete system "$1" >/dev/null 2>&1
  else
    "$adb" shell settings put system "$1" "$2" >/dev/null 2>&1
  fi
}

restore() {
  for cutout in "${cutouts[@]}"; do
    "$adb" shell cmd overlay disable "$overlay_prefix.$cutout" >/dev/null 2>&1
  done
  restore_setting user_rotation "$saved_rotation"
  restore_setting accelerometer_rotation "$saved_auto_rotation"
}

# rotate <rotation> <dir>: 0 is the natural orientation, 1 and 3 are the two
# landscapes. `wm user-rotation` doesn't exist on every API level, so the
# setting is written too.
rotate() {
  capture "$2/user-rotation-lock.txt" "$adb" shell wm user-rotation lock "$1"
  "$adb" shell settings put system user_rotation "$1"
  sleep 3
}

# display <dir>: the display, the insets, and the rotation as they are now.
display() {
  capture "$1/wm-size.txt" "$adb" shell wm size
  capture "$1/wm-density.txt" "$adb" shell wm density
  capture "$1/wm-user-rotation.txt" "$adb" shell wm user-rotation
  capture "$1/settings-user-rotation.txt" "$adb" shell settings get system user_rotation
  capture "$1/dumpsys-window-displays.txt" "$adb" shell dumpsys window displays
  capture "$1/dumpsys-window.txt" "$adb" shell dumpsys window
  capture "$1/dumpsys-display.txt" "$adb" shell dumpsys display
  capture "$1/dumpsys-input.txt" "$adb" shell dumpsys input
}

# screen <name>: a screenshot, and the uiautomator dump in two forms: through
# a file, and straight to stdout.
screen() {
  capture "$1.png" "$adb" exec-out screencap -p
  capture "$1.uiautomator.txt" "$adb" shell uiautomator dump /data/local/tmp/loupe-ui.xml
  capture "$1.ui.xml" "$adb" shell cat /data/local/tmp/loupe-ui.xml
  capture "$1.ui-tty.txt" "$adb" exec-out uiautomator dump /dev/tty
}

home() {
  "$adb" shell input keyevent KEYCODE_HOME
  sleep 2
}

if ! is_emulator; then
  echo "No emulator found. This script runs on one emulator only. With more than one device, set ANDROID_SERIAL." >&2
  exit 1
fi

saved_rotation=$(setting user_rotation)
saved_auto_rotation=$(setting accelerometer_rotation)
trap restore EXIT

mkdir -p "$out"

capture host/adb-version.txt "$adb" version
capture host/adb-devices.txt "$adb" devices
capture host/adb-devices-l.txt "$adb" devices -l
capture host/emulator-list-avds.txt "$emulator" -list-avds
capture host/emu-avd-name.txt "$adb" emu avd name
capture host/emu-help.txt "$adb" emu help
capture host/emu-event-types.txt "$adb" emu event types
capture host/emu-event-codes-abs.txt "$adb" emu event codes EV_ABS
capture host/device-not-found.txt "$adb" -s emulator-5998 shell true

capture device/getprop.txt "$adb" shell getprop
capture device/overlays.txt "$adb" shell cmd overlay list
capture device/wm-help.txt "$adb" shell wm help
capture device/uiautomator-help.txt "$adb" shell uiautomator help

# Only this script turns the screen from here on.
"$adb" shell settings put system accelerometer_rotation 0

for cutout in none "${cutouts[@]}"; do
  if [ "$cutout" != none ]; then
    capture "$cutout/overlay-enable.txt" "$adb" shell cmd overlay enable "$overlay_prefix.$cutout"
    sleep 3
  fi

  for rotation in 0 1 3; do
    dir=$cutout/rotation-$rotation
    rotate "$rotation" "$dir"
    home
    display "$dir"
    screen "$dir/home"

    capture "$dir/am-start-settings.txt" "$adb" shell am start -W -a android.settings.SETTINGS
    sleep 3
    screen "$dir/settings"
  done

  if [ "$cutout" != none ]; then
    capture "$cutout/overlay-disable.txt" "$adb" shell cmd overlay disable "$overlay_prefix.$cutout"
    sleep 3
  fi
done

# One-off cases, in the natural orientation with no cutout.
rotate 0 extra
home
capture extra/ui-compressed.txt "$adb" exec-out uiautomator dump --compressed /dev/tty

# A system sheet over an app: the dump must show it.
capture extra/am-start-settings.txt "$adb" shell am start -W -a android.settings.SETTINGS
sleep 3
capture extra/statusbar-expand.txt "$adb" shell cmd statusbar expand-notifications
sleep 2
screen extra/shade
"$adb" shell cmd statusbar collapse
capture extra/am-start-share.txt "$adb" shell am start -W -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT loupe
sleep 3
screen extra/share
capture extra/dumpsys-activity-activities.txt "$adb" shell dumpsys activity activities
"$adb" shell input keyevent KEYCODE_BACK
home

# Deep links: one that no app handles, and one for the browser.
capture extra/am-start-no-handler.txt "$adb" shell am start -W -a android.intent.action.VIEW -d loupe-fixture://nothing
capture extra/am-start-https.txt "$adb" shell am start -W -a android.intent.action.VIEW -d https://example.com
sleep 5
screen extra/https
home

failed=$(find "$out" -name '*.exit' | wc -l | tr -d ' ')
echo "Done. $failed commands failed; each one has a .exit file next to its output."
