// What the package ships of the XCTest runner for the iOS simulator, shared
// by the checks of the runner and of the package. The paths are relative to
// the runner folder: `dist/ios-runner` in the package.

const PRODUCTS = 'Debug-iphonesimulator'
const HOST_APP = `${PRODUCTS}/LoupeHost.app`
const RUNNER_APP = `${PRODUCTS}/LoupeRunner-Runner.app`
const TEST_BUNDLE = `${RUNNER_APP}/PlugIns/LoupeRunner.xctest`

/** The folder of the runner in the package of loupe. */
export const RUNNER_DIR = 'dist/ios-runner'

/** The file that `xcodebuild test-without-building` takes. */
export const XCTESTRUN = 'LoupeRunner.xctestrun'

/** The programs of the runner. Each needs its executable bits and both slices. */
export const RUNNER_BINARIES = [
  `${HOST_APP}/LoupeHost`,
  `${RUNNER_APP}/LoupeRunner-Runner`,
  `${TEST_BUNDLE}/LoupeRunner`,
]

export const RUNNER_FILES = [
  XCTESTRUN,
  `${HOST_APP}/Info.plist`,
  `${RUNNER_APP}/Info.plist`,
  `${TEST_BUNDLE}/Info.plist`,
  ...RUNNER_BINARIES,
]

/**
 * A test framework of Xcode. Xcode copies them into the runner app when it
 * builds, and gives its own when it starts the runner, so the package ships
 * none: they are Apple's files, and 16 MB.
 */
export const XCODE_FRAMEWORK =
  /(^|\/)Frameworks\/|\.framework\/|(^|\/)libXCTestSwiftSupport\.dylib$/
