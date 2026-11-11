import { version } from '../version'

export interface CliStreams {
  out: (text: string) => void
  err: (text: string) => void
}

const defaultStreams: CliStreams = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
}

const USAGE = `Usage: loupe <command> [options]

Options:
  -v, --version  Print the version
  -h, --help     Print this help`

export const EXIT_OK = 0
export const EXIT_USAGE = 2

export async function run(
  argv: readonly string[],
  streams: CliStreams = defaultStreams,
): Promise<number> {
  const [first] = argv

  if (first === '--version' || first === '-v') {
    streams.out(version)
    return EXIT_OK
  }

  if (first === undefined || first === '--help' || first === '-h') {
    streams.out(USAGE)
    return EXIT_OK
  }

  streams.err(`loupe: "${first}" is not a command.\n\n${USAGE}`)
  return EXIT_USAGE
}
