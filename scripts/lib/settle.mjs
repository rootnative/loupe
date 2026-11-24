// Shared by the scripts that run on a booted emulator in CI: the smoke run
// and the Expo Go recorder.

import { setTimeout as sleep } from 'node:timers/promises'

/** The guest's CPU ticks from the first line of `/proc/stat`. */
function cpuTicks(shell) {
  const values = shell('cat', '/proc/stat')
    .split('\n')[0]
    .trim()
    .split(/\s+/)
    .slice(1, 9)
    .map(Number)
  const [, , , idle = 0, iowait = 0] = values
  return {
    idle: idle + iowait,
    total: values.reduce((sum, value) => sum + value, 0),
  }
}

/** The guest's `MemAvailable`, in MB. */
function memoryAvailable(shell) {
  const kb = /^MemAvailable:\s+(\d+) kB/m.exec(
    shell('cat', '/proc/meminfo'),
  )?.[1]
  return kb === undefined ? '?' : String(Math.round(Number(kb) / 1024))
}

// The guest is quiet when this share of its CPU is idle in a window.
const QUIET_IDLE = 0.7
const QUIET_WINDOW_MS = 2000

/**
 * Waits until 3 `input` calls in a row are fast and the guest's CPU is
 * quiet in the 3 windows after them, for up to 5 minutes. Right after boot
 * the emulator is busy for a while: in CI a drag of 300 ms once took 6 s,
 * and on API 36 Settings stopped responding at a load of 38, while `input`
 * was already fast. On API 30 each `input` call starts a Java process, so
 * fast there is under 1 s, and the window starts after the call.
 *
 * `shell(...args)` runs `adb shell` with the arguments and gives its
 * stdout.
 */
export async function settle(shell, apiLevel) {
  const limit = apiLevel === 30 ? 1000 : 100
  const start = Date.now()
  const seconds = () => Math.round((Date.now() - start) / 1000)
  console.log(`At the start: MemAvailable ${memoryAvailable(shell)} MB.`)
  let fast = 0
  let quiet = 0
  let idle = 0
  let inputMs = 0
  let reported = 0
  while ((fast < 3 || quiet < 3) && Date.now() - start < 300_000) {
    const before = performance.now()
    shell('input', 'keyevent', '0')
    inputMs = Math.round(performance.now() - before)
    fast = inputMs < limit ? fast + 1 : 0

    const from = cpuTicks(shell)
    await sleep(QUIET_WINDOW_MS)
    const to = cpuTicks(shell)
    idle = (to.idle - from.idle) / Math.max(1, to.total - from.total)
    quiet = idle >= QUIET_IDLE ? quiet + 1 : 0

    if (Date.now() - reported >= 30_000) {
      reported = Date.now()
      console.log(
        `Waiting for a quiet emulator, ${seconds()} s: input ${inputMs} ms, CPU idle ${Math.round(idle * 100)} %.`,
      )
    }
  }
  const state = `input ${inputMs} ms, CPU idle ${Math.round(idle * 100)} %, MemAvailable ${memoryAvailable(shell)} MB`
  console.log(
    fast >= 3 && quiet >= 3
      ? `The emulator settled in ${seconds()} s: ${state}.`
      : `The emulator was still busy after ${seconds()} s (${state}). The checks run anyway.`,
  )
}
