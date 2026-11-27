#!/usr/bin/env bash
# Builds the XCTest runner of packages/loupe/native/ios for the iOS
# simulator, with arm64 and x86_64 slices, and checks both. CI runs it; the
# "CI" and "iOS fixtures" workflows call it. DEVELOPER_DIR picks the Xcode.
# The built products are in <derived-data-dir>/Build/Products.
#
# With <package-dir>, it also writes there what the package of loupe ships:
# the two apps and the test bundle with no test framework of Xcode, and the
# `.xctestrun` file as LoupeRunner.xctestrun. Xcode copies its frameworks
# into the runner app (16 MB), and gives its own when it starts the runner,
# so the runner starts with none in it.
#
# XcodeGen makes the Xcode project from project.yml, so no generated project
# is in git. The script downloads it once per work folder, pinned by version
# and SHA-256. The zip holds a universal binary.
#
# Usage: scripts/build-ios-runner.sh <derived-data-dir> [<package-dir>]

set -euo pipefail

out=${1:?Usage: scripts/build-ios-runner.sh <derived-data-dir> [<package-dir>]}
package=${2:-}

XCODEGEN_VERSION=2.46.0
XCODEGEN_SHA256=4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806

root=$(cd "$(dirname "$0")/.." && pwd)
work=${RUNNER_TEMP:-${TMPDIR:-/tmp}}/loupe-ios-runner

if [ ! -x "$work/xcodegen/bin/xcodegen" ]; then
  mkdir -p "$work"
  curl -fsSL -o "$work/xcodegen.zip" \
    "https://github.com/yonaskolb/XcodeGen/releases/download/$XCODEGEN_VERSION/xcodegen.zip"
  echo "$XCODEGEN_SHA256  $work/xcodegen.zip" | shasum -a 256 -c -
  unzip -q -o "$work/xcodegen.zip" -d "$work"
fi

# XcodeGen writes the project only into a folder that exists.
rm -rf "$work/project"
mkdir -p "$work/project"
"$work/xcodegen/bin/xcodegen" generate \
  --spec "$root/packages/loupe/native/ios/project.yml" \
  --project "$work/project"

xcodebuild build-for-testing \
  -project "$work/project/LoupeRunner.xcodeproj" \
  -scheme LoupeRunner \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath "$out" \
  ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO

# A runner with one slice starts only on Macs of that CPU.
app=$out/Build/Products/Debug-iphonesimulator/LoupeRunner-Runner.app
for binary in "$app/LoupeRunner-Runner" "$app/PlugIns/LoupeRunner.xctest/LoupeRunner"; do
  archs=$(lipo -archs "$binary")
  echo "$binary: $archs"
  for arch in arm64 x86_64; do
    case " $archs " in
      *" $arch "*) ;;
      *)
        echo "$binary has no $arch slice." >&2
        exit 1
        ;;
    esac
  done
done

if [ -n "$package" ]; then
  products=$out/Build/Products
  rm -rf "$package"
  mkdir -p "$package/Debug-iphonesimulator"
  cp -R "$products/Debug-iphonesimulator/LoupeHost.app" \
    "$products/Debug-iphonesimulator/LoupeRunner-Runner.app" \
    "$package/Debug-iphonesimulator/"
  rm -rf "$package/Debug-iphonesimulator/LoupeRunner-Runner.app/Frameworks"
  # The name that Xcode gives has the version of its SDK in it.
  cp "$products"/*.xctestrun "$package/LoupeRunner.xctestrun"
  echo "The runner for the package is in $package."
fi
