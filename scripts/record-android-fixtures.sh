#!/usr/bin/env bash
# Records the raw adb output that the Android driver parses, so each parser
# gets test fixtures for each API level. It also times the touch input, and
# checks that a tap lands where the `ui` dump puts the element, through
# `input` and through the emulator console. The "Android fixtures" workflow
# runs it in CI.
#
# Run it on one booted emulator with a clean system image. Don't run it on a
# phone: the dumps and the screenshots would hold personal data. It changes
# the rotation, the cutout overlay and the pointer location of the emulator,
# and touches Settings. At the end it puts these settings back.
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
  restore_setting pointer_location "$saved_pointer_location"
}

# rotate <rotation> <dir>: 0 is the natural orientation, 1 and 3 are the two
# landscapes. Android 11 has no `wm user-rotation`, so there the script turns
# auto-rotate off and writes the user rotation, each time: on Android 11,
# auto-rotate was on again after one write at the start.
rotate() {
  capture "$2/user-rotation-lock.txt" "$adb" shell wm user-rotation lock "$1"
  if [ -f "$out/$2/user-rotation-lock.txt.exit" ]; then
    "$adb" shell settings put system accelerometer_rotation 0
    "$adb" shell settings put system user_rotation "$1"
  fi
  sleep 3
}

# display <dir>: the display, the insets, and the rotation as they are now.
display() {
  capture "$1/wm-size.txt" "$adb" shell wm size
  capture "$1/wm-density.txt" "$adb" shell wm density
  capture "$1/wm-user-rotation.txt" "$adb" shell wm user-rotation
  capture "$1/settings-user-rotation.txt" "$adb" shell settings get system user_rotation
  capture "$1/settings-accelerometer-rotation.txt" "$adb" shell settings get system accelerometer_rotation
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

settings() {
  "$adb" shell am start -W -a android.settings.SETTINGS >/dev/null
  sleep 3
}

# timed <file> <command>: runs the command 5 times in one shell on the
# device, with a time stamp before each run and one after the last. A stamp
# is $EPOCHREALTIME (mksh) and `date +%s%N`, in case one of them is missing.
timed() {
  local stamp='echo "stamp ${EPOCHREALTIME:-} $(date +%s%N)"'
  capture "$1" "$adb" shell "for i in 1 2 3 4 5; do $stamp; $2; done; $stamp"
}

# host_timed <file> <command> [args...]: the same, on the host, in ns.
host_timed() {
  local name=$1
  local file=$out/$name
  shift
  mkdir -p "$(dirname "$file")"
  for _ in 1 2 3 4 5; do
    date +%s%N
    "$@" >/dev/null 2>&1
  done >"$file"
  date +%s%N >>"$file"
  echo "$name: timed"
}

# centre_of <ui-file> <text>: "x y", the centre in px of the first node with
# that text (XML-escaped) in a uiautomator dump. Empty when it isn't there.
centre_of() {
  local bounds left top right bottom
  bounds=$(grep -o "text=\"$2\"[^>]*bounds=\"[^\"]*\"" "$1" | head -1 |
    grep -o 'bounds="[^"]*"' | sed 's/[^0-9]/ /g')
  [ -n "$bounds" ] || return 0
  read -r left top right bottom <<<"$bounds"
  echo "$(((left + right) / 2)) $(((top + bottom) / 2))"
}

if ! is_emulator; then
  echo "No emulator found. This script runs on one emulator only. With more than one device, set ANDROID_SERIAL." >&2
  exit 1
fi

saved_rotation=$(setting user_rotation)
saved_auto_rotation=$(setting accelerometer_rotation)
saved_pointer_location=$(setting pointer_location)
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
capture device/accelerometer-rotation-at-start.txt "$adb" shell settings get system accelerometer_rotation

# Only this script turns the screen from here on.
"$adb" shell settings put system accelerometer_rotation 0

for cutout in none "${cutouts[@]}"; do
  if [ "$cutout" != none ]; then
    capture "$cutout/overlay-enable.txt" "$adb" shell cmd overlay enable "$overlay_prefix.$cutout"
    sleep 3
  fi

  for rotation in 0 1 3; do
    dir=$cutout/rotation-$rotation

    # An app that can turn is in front when the screen turns, as with the
    # app under test.
    capture "$dir/am-start-settings.txt" "$adb" shell am start -W -a android.settings.SETTINGS
    rotate "$rotation" "$dir"
    display "$dir/settings"
    screen "$dir/settings"

    # The launcher holds portrait, so the display turns back here.
    home
    display "$dir/home"
    screen "$dir/home"
  done

  if [ "$cutout" != none ]; then
    capture "$cutout/overlay-disable.txt" "$adb" shell cmd overlay disable "$overlay_prefix.$cutout"
    sleep 3
  fi
done

# One-off cases, in the natural orientation with no cutout. Settings is in
# front for the rotate: Android 14 and later put back a rotation that was
# written while the launcher was in front.
settings
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

# Touch input. A double-tap needs 40 to 300 ms between the taps, and a drag
# needs events with no gap, so the cost of one call decides the method.
capture touch/input-help.txt "$adb" shell input
capture touch/getevent-lp.txt "$adb" shell getevent -lp

# A tap in landscape must land where the `ui` dump puts the element: a tap
# on "Network & internet" opens the network page.
settings
rotate 1 touch/landscape
capture touch/landscape/before/dumpsys-window-displays.txt "$adb" shell dumpsys window displays
capture touch/landscape/before.ui-tty.txt "$adb" exec-out uiautomator dump /dev/tty
target=$(centre_of "$out/touch/landscape/before.ui-tty.txt" 'Network &amp; internet')
echo "$target" >"$out/touch/landscape/tap-target.txt"
if [ -n "$target" ]; then
  read -r x y <<<"$target"
  capture touch/landscape/input-tap.txt "$adb" shell input tap "$x" "$y"
  sleep 3
  capture touch/landscape/after/dumpsys-window-displays.txt "$adb" shell dumpsys window displays
  screen touch/landscape/after
  "$adb" shell input keyevent KEYCODE_BACK
  sleep 2
fi
rotate 0 touch/portrait

# The time of one call, with Settings in front. The taps hit the status bar.
timed touch/time-input-tap.txt 'input tap 5 5'
timed touch/time-motionevent.txt 'input motionevent DOWN 5 5; input motionevent UP 5 5'
capture touch/input-tap-fraction.txt "$adb" shell input tap 5.5 5.5
host_timed touch/time-host-adb-shell.txt "$adb" shell true
host_timed touch/time-host-emu-event.txt "$adb" emu event send EV_SYN:0:0

# Touches through the emulator console. The console takes raw touchscreen
# units, 0 to 32767 across the natural size, and Android turns them by the
# rotation. They run last: a touch that stays down can't spoil the other
# recordings.
read -r width height <<<"$("$adb" shell wm size | grep -o '[0-9]*x[0-9]*' | head -1 | tr x ' ')"

# raw_of <rotation> <x> <y>: "x y" in console units, for a point in px of
# the current orientation. It turns the point back to the natural
# orientation, the reverse of the touch mapper in the Android source.
raw_of() {
  local x y raw_x raw_y
  case $1 in
    1) x=$((width - $3)) y=$2 ;;
    2) x=$((width - $2)) y=$((height - $3)) ;;
    3) x=$3 y=$((height - $2)) ;;
    *) x=$2 y=$3 ;;
  esac
  raw_x=$((x * 32768 / width))
  raw_y=$((y * 32768 / height))
  echo "$((raw_x > 32767 ? 32767 : raw_x)) $((raw_y > 32767 ? 32767 : raw_y))"
}

# console_tap <dir> <raw-x> <raw-y>: one finger down, and up again.
console_tap() {
  capture "$1/event-down.txt" "$adb" emu event send \
    EV_ABS:ABS_MT_SLOT:0 EV_ABS:ABS_MT_TRACKING_ID:1 \
    "EV_ABS:ABS_MT_POSITION_X:$2" "EV_ABS:ABS_MT_POSITION_Y:$3" \
    EV_ABS:ABS_MT_PRESSURE:50 EV_KEY:BTN_TOUCH:1 EV_SYN:0:0
  capture "$1/event-up.txt" "$adb" emu event send \
    EV_ABS:ABS_MT_TRACKING_ID:-1 EV_KEY:BTN_TOUCH:0 EV_SYN:0:0
}

if [ -n "${width:-}" ] && [ -n "${height:-}" ]; then
  # The tap of round 3: portrait, on "Network & internet".
  capture touch/console/before/dumpsys-window-displays.txt "$adb" shell dumpsys window displays
  capture touch/console/before.ui-tty.txt "$adb" exec-out uiautomator dump /dev/tty
  target=$(centre_of "$out/touch/console/before.ui-tty.txt" 'Network &amp; internet')
  echo "$target in ${width}x$height" >"$out/touch/console/tap-target.txt"
  if [ -n "$target" ]; then
    read -r x y <<<"$target"
    read -r raw_x raw_y <<<"$(raw_of 0 "$x" "$y")"
    console_tap touch/console "$raw_x" "$raw_y"
    sleep 3
    capture touch/console/after/dumpsys-window-displays.txt "$adb" shell dumpsys window displays
    screen touch/console/after
    "$adb" shell input keyevent KEYCODE_BACK
    sleep 2
  fi

  # The console's answer to an event that it doesn't know, and adb's answer
  # when the emulator is gone.
  capture touch/console/event-unknown.txt "$adb" emu event send EV_ABS:ABS_LOUPE:1
  capture touch/console/no-emulator.txt "$adb" -s emulator-5998 emu event send EV_SYN:0:0

  # The same row in both landscapes, tapped in the middle of the screen
  # width. The row spans the width, and from the middle a point that Android
  # doesn't turn lands off the screen, and one turned the wrong way lands on
  # another row.
  for rotation in 1 3; do
    dir=touch/console/rotation-$rotation
    settings
    rotate "$rotation" "$dir"
    capture "$dir/before/dumpsys-window-displays.txt" "$adb" shell dumpsys window displays
    capture "$dir/before.ui-tty.txt" "$adb" exec-out uiautomator dump /dev/tty
    target=$(centre_of "$out/$dir/before.ui-tty.txt" 'Network &amp; internet')
    if [ -n "$target" ]; then
      read -r _ y <<<"$target"
      x=$((height / 2))
      read -r raw_x raw_y <<<"$(raw_of "$rotation" "$x" "$y")"
      echo "$x $y in ${height}x$width, raw $raw_x $raw_y" >"$out/$dir/tap-target.txt"
      console_tap "$dir" "$raw_x" "$raw_y"
      sleep 3
      capture "$dir/after/dumpsys-window-displays.txt" "$adb" shell dumpsys window displays
      screen "$dir/after"
      "$adb" shell input keyevent KEYCODE_BACK
      sleep 2
    fi
  done

  # A two-finger pinch in 3 rotations, with Android's pointer location on:
  # the screenshot after it shows the trail of each finger, and `dumpsys
  # input` while both fingers are down shows the points that Android got.
  # The fingers move apart on a slant, so the list scrolls and no row gets a
  # tap. Each step is one console send with both fingers.
  capture touch/pinch/pointer-location-on.txt "$adb" shell settings put system pointer_location 1
  for rotation in 0 1 3; do
    dir=touch/pinch/rotation-$rotation
    mkdir -p "$out/$dir"
    settings
    rotate "$rotation" "$dir"
    capture "$dir/before/dumpsys-window-displays.txt" "$adb" shell dumpsys window displays
    if [ $((rotation % 2)) -eq 1 ]; then
      centre_x=$((height / 2)) centre_y=$((width / 2))
    else
      centre_x=$((width / 2)) centre_y=$((height / 2))
    fi
    for step in 0 1 2 3 4 5 6 7 8 9 10; do
      spread=$((150 + step * 30))
      first_x=$((centre_x - spread)) first_y=$((centre_y - spread / 2))
      second_x=$((centre_x + spread)) second_y=$((centre_y + spread / 2))
      read -r ax ay <<<"$(raw_of "$rotation" "$first_x" "$first_y")"
      read -r bx by <<<"$(raw_of "$rotation" "$second_x" "$second_y")"
      echo "$step: $first_x $first_y, $second_x $second_y; raw $ax $ay, $bx $by" >>"$out/$dir/points.txt"
      if [ "$step" -eq 0 ]; then
        events=(
          EV_ABS:ABS_MT_SLOT:0 EV_ABS:ABS_MT_TRACKING_ID:1
          "EV_ABS:ABS_MT_POSITION_X:$ax" "EV_ABS:ABS_MT_POSITION_Y:$ay" EV_ABS:ABS_MT_PRESSURE:50
          EV_ABS:ABS_MT_SLOT:1 EV_ABS:ABS_MT_TRACKING_ID:2
          "EV_ABS:ABS_MT_POSITION_X:$bx" "EV_ABS:ABS_MT_POSITION_Y:$by" EV_ABS:ABS_MT_PRESSURE:50
          EV_KEY:BTN_TOUCH:1 EV_SYN:0:0
        )
      else
        events=(
          EV_ABS:ABS_MT_SLOT:0 "EV_ABS:ABS_MT_POSITION_X:$ax" "EV_ABS:ABS_MT_POSITION_Y:$ay"
          EV_ABS:ABS_MT_SLOT:1 "EV_ABS:ABS_MT_POSITION_X:$bx" "EV_ABS:ABS_MT_POSITION_Y:$by"
          EV_SYN:0:0
        )
      fi
      date +%s%N >>"$out/$dir/stamps.txt"
      "$adb" emu event send "${events[@]}" >>"$out/$dir/events.txt" 2>&1
      sleep 0.03
    done
    date +%s%N >>"$out/$dir/stamps.txt"
    capture "$dir/down/dumpsys-input.txt" "$adb" shell dumpsys input
    capture "$dir/event-up.txt" "$adb" emu event send \
      EV_ABS:ABS_MT_SLOT:0 EV_ABS:ABS_MT_TRACKING_ID:-1 \
      EV_ABS:ABS_MT_SLOT:1 EV_ABS:ABS_MT_TRACKING_ID:-1 \
      EV_KEY:BTN_TOUCH:0 EV_SYN:0:0
    sleep 1
    capture "$dir/after/dumpsys-window-displays.txt" "$adb" shell dumpsys window displays
    capture "$dir/after.png" "$adb" exec-out screencap -p
    "$adb" shell input keyevent KEYCODE_BACK
    sleep 2
  done
fi
home

failed=$(find "$out" -name '*.exit' | wc -l | tr -d ' ')
echo "Done. $failed commands failed; each one has a .exit file next to its output."
