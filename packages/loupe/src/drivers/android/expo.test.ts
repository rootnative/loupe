import { describe, expect, it } from 'vitest'
import { byCommand, fakeContext } from '../../testing/fake-exec'
import { recorded, recordedText } from '../../testing/fixtures'
import { selectAndroidDevice } from './devices'
import { showInExpoGo } from './expo'

const ADB = 'adb -s emulator-5554'
const DISPLAYS = 'api-36/sheets/alert/back/before.dumpsys-window-displays.txt'
const EXPERIENCE =
  'host.exp.exponent/host.exp.exponent.experience.ExperienceActivity'
const LAUNCHER =
  'com.google.android.apps.nexuslauncher/com.google.android.apps.nexuslauncher.NexusLauncherActivity'

describe('showInExpoGo', () => {
  it('opens the link again while the launcher stays in front', async () => {
    const launcher = {
      stdout: recordedText(DISPLAYS).replace(EXPERIENCE, LAUNCHER),
    }
    const table = byCommand({
      'adb devices -l': recorded('api-36/host/adb-devices-l.txt'),
      [`${ADB} shell getprop`]: recorded('api-36/device/getprop.txt'),
      [`${ADB} shell dumpsys window displays`]: [
        launcher,
        launcher,
        recorded(DISPLAYS),
      ],
      [`${ADB} exec-out uiautomator dump /dev/tty`]: recorded(
        'api-36/expo/open/shown.ui-tty.txt',
      ),
    })
    const { context, calls } = fakeContext((call) =>
      call.args.includes('am')
        ? recorded('api-36/extra/am-start-https.txt')
        : table(call),
    )
    const target = await selectAndroidDevice(context)

    const shown = await showInExpoGo(target, {
      link: 'exp://127.0.0.1:8081/--/appstate',
      route: '/appstate',
      timeout: 10_000,
      openAgain: 0,
    })

    expect(shown).toMatchObject({ opens: 3, closed: [] })
    expect(shown.probe?.route).toBe('/appstate')
    expect(calls.filter((call) => call.args.includes('am'))).toHaveLength(3)
  })
})
