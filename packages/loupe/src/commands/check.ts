import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  describeResults,
  RULES,
  rulesOf,
  screenCheckSchema,
  type ScreenTree,
} from '../core/check'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { describeDisplay } from '../core/display'
import { type Selector } from '../core/element'
import { LoupeError } from '../core/errors'
import { checkAndroidUi } from '../drivers/android/check'
import { selectAndroidDevice } from '../drivers/android/devices'
import { type AndroidUi, readAndroidUi } from '../drivers/android/ui'
import { uiCommand } from './ui'

const centredField = (by: string) =>
  z
    .array(z.string().min(1))
    .optional()
    .describe(
      `For the centred rule: the element with this ${by} must be at the centre of its container, whatever sits beside it. Give it once for each element.`,
    )

type SavedUi = z.infer<typeof uiCommand.output>

function notSaved(file: string, why: string): LoupeError {
  return new LoupeError(
    'invalid_input',
    `${why} Save the other direction with: loupe ui --json > ${file}`,
  )
}

/** The output of `loupe ui --json` in a file, or only its `data`. */
async function readSavedUi(file: string): Promise<SavedUi> {
  let text: string
  try {
    text = await readFile(path.resolve(file), 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw notSaved(
      file,
      code === 'ENOENT'
        ? `There is no file ${file}.`
        : `loupe can't read ${file} (${code ?? String(error)}).`,
    )
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw notSaved(file, `${file} isn't JSON.`)
  }
  const data =
    typeof json === 'object' && json !== null && 'ok' in json && 'data' in json
      ? json.data
      : json
  const saved = uiCommand.output.safeParse(data)
  if (!saved.success) {
    throw notSaved(file, `${file} isn't the output of loupe ui.`)
  }
  return saved.data
}

/** The saved screen, when it is this screen in the other direction. */
function otherDirection(
  file: string,
  saved: SavedUi,
  ui: AndroidUi,
): ScreenTree {
  const here = ui.probe?.report
  if (
    saved.orientation !== ui.display.orientation ||
    saved.pixels.width !== ui.display.pixels.width ||
    saved.pixels.height !== ui.display.pixels.height
  ) {
    throw notSaved(
      file,
      `The saved screen is ${describeDisplay(saved)}, and this one is ${describeDisplay(ui.display)}. Turn the screen to match.`,
    )
  }
  if (saved.app && ui.app && saved.app !== ui.app) {
    throw notSaved(
      file,
      `The saved screen is of ${saved.app}, and this one is of ${ui.app}.`,
    )
  }
  if (saved.probe?.route && here?.route && saved.probe.route !== here.route) {
    throw notSaved(
      file,
      `The saved screen shows ${saved.probe.route}, and this one shows ${here.route}. Open the same screen in both directions.`,
    )
  }
  if (saved.probe && here && saved.probe.direction === here.direction) {
    throw notSaved(
      file,
      `Both screens are ${here.direction.toUpperCase()}. The mirrored rule compares LTR with RTL.`,
    )
  }
  return {
    display: saved,
    app: saved.app,
    nodes: saved.nodes,
    direction: saved.probe?.direction,
  }
}

export const checkCommand = defineCommand({
  name: 'check',
  summary:
    'Check the screen for layout defects: elements under an inset, cut at an edge, off centre, too small to touch, or not mirrored in the other direction',
  input: z.object({
    rules: z
      .string()
      .regex(/^[a-z-]+(,[a-z-]+)*$/, 'The rules are a comma list.')
      .optional()
      .describe(
        `The rules to run, as a comma list. Each one by default: ${RULES.join(', ')} (mirrored only with --mirror-of).`,
      ),
    centred: centredField('text (the whole text)'),
    centredLabel: centredField('accessibility label'),
    centredId: centredField('id'),
    mirrorOf: z
      .string()
      .min(1)
      .optional()
      .describe(
        'For the mirrored rule: a file with this screen in the other layout direction, from loupe ui --json. Each element must sit where that screen puts it, mirrored.',
      ),
    app: appField,
    device: deviceField,
  }),
  output: screenCheckSchema,
  run: async (input, context) => {
    const names =
      input.rules === undefined
        ? RULES.filter((rule) => rule !== 'mirrored' || input.mirrorOf)
        : rulesOf(input.rules)
    const centred: Selector[] = [
      ...(input.centred ?? []).map((value) => ({ by: 'text' as const, value })),
      ...(input.centredLabel ?? []).map((value) => ({
        by: 'label' as const,
        value,
      })),
      ...(input.centredId ?? []).map((value) => ({ by: 'id' as const, value })),
    ]
    if (centred.length > 0 && !names.includes('centred')) {
      throw new LoupeError(
        'invalid_input',
        'The centred elements need the centred rule. Add "centred" to the rules.',
      )
    }
    if (names.includes('mirrored') !== (input.mirrorOf !== undefined)) {
      throw new LoupeError(
        'invalid_input',
        input.mirrorOf
          ? 'The mirror-of file needs the mirrored rule. Add "mirrored" to the rules.'
          : 'The mirrored rule needs --mirror-of: a file with this screen in the other layout direction, from loupe ui --json.',
      )
    }
    const saved = input.mirrorOf ? await readSavedUi(input.mirrorOf) : undefined

    const target = await selectAndroidDevice(context, input.device)
    const ui = await readAndroidUi(target, input.app)
    const mirrorOf =
      saved && input.mirrorOf
        ? otherDirection(input.mirrorOf, saved, ui)
        : undefined
    const { check } = await checkAndroidUi(target, input.app, ui, names, {
      centred,
      mirrorOf,
    })
    return check
  },
  passed: (check) => check.passed,
  format: (check) =>
    [
      check.app
        ? `${describeDisplay(check)}, ${check.app}`
        : describeDisplay(check),
      ...describeResults(check.results),
      ...check.warnings.map((warning) => `Warning: ${warning}`),
    ].join('\n'),
})
