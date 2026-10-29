// Install dsh-fk-restart-button into a DSH profile, the way DSH expects a plugin
// to be installed.
//
// WHY THIS IS NOT A JUNCTION PLUS A PATCH ROW ANY MORE
//
// The first version of this script created a directory junction at
// `<profile>/node_modules/<name>` and appended an `- insert:` row to the profile's
// `cordis.patch.yml`. The plugin then worked perfectly - the route answered, the
// button appeared - and was invisible in the Plugins page, which is the symptom
// this was rewritten to fix.
//
// The reason is in the plugin manager's own documentation: it manages BUNDLES, and
// "a dependency without a bundle patch is refused before it installs; one the
// profile already holds is left off the page unless the profile SELECTS it". A
// bundle is selected by appearing in the profile's `dsh.profile.bundles`, which
// only `dsh plugin add` writes. A junction plus a patch row produces a plugin that
// runs but is in nobody's dependency record and selected by nothing.
//
// Appending the row by hand is also what the sibling plugins warn against in their
// own patch layers: it bypasses bundle load ordering. (They say so because they
// were bitten by it - `dsh-fk-search-tier`'s comment describes providers waiting on
// each other.)
//
// So this script does what `dsh plugin add <spec>` does, by delegating to it:
//
//   1. `dsh plugin --profile <name> add link:<absolute path>`
//        - records the dependency AND selects the bundle
//   2. validates the result, because a command that "succeeded" and a plugin that
//      will be listed are not the same claim
//
// It intentionally does NOT edit `cordis.patch.yml`: the package's own
// `cordis.patch.yml` is loaded as the bundle layer, and copying it into the profile
// would mount the same row twice.
//
//   node tools/install.mjs [--profile desktop] [--dsh-home <DSH_HOME>]

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = 'dsh-fk-restart-button'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Read `--name value` pairs. */
function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    out[token.slice(2)] = argv[index + 1]
    index += 1
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const dshHome = args['dsh-home'] ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const profileName = args.profile ?? 'desktop'

const profile = join(dshHome, 'profiles', profileName)
const manifestFile = join(profile, 'package.json')

const say = (message) => { console.log(message) }
const fail = (message) => { console.error(`FAILED: ${message}`); process.exit(2) }

/**
 * Where the `dsh` CLI lives.
 *
 * `dsh` is not on PATH on the machine this was written for (its PATH has a mangled
 * System32 entry), so the launcher is resolved from a few known locations rather
 * than invoked by bare name.
 * @returns the launcher path, or null.
 */
function resolveLauncher() {
  const candidates = [
    process.env.DSH_LAUNCHER,
    join(dirname(process.execPath), '..', '..', '..', 'runtime', 'cli', 'bin', 'dsh.cmd'),
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '')

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

say(`plugin  : ${PLUGIN}`)
say(`from    : ${packageDir}`)
say(`profile : ${profile}`)
say('')

if (!existsSync(join(packageDir, 'entry.js'))) fail(`no entry.js at ${packageDir}`)
if (!existsSync(manifestFile)) fail(`no profile at ${profile}. Pass --profile <name>.`)

const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
const launcher = resolveLauncher()

if (launcher === null) {
  say('Could not locate the `dsh` launcher. Set DSH_LAUNCHER to its path, then')
  say('either re-run this script or run the command it would have run:')
  say('')
  say(`  dsh plugin --profile ${profileName} add "link:${packageDir.replace(/\\/g, '/')}"`)
  say('')
  say('That one command is the whole installation. Do NOT add an insert row to the')
  say("profile's cordis.patch.yml - the package's own patch file is the bundle layer,")
  say('and duplicating it would mount the row twice.')
  process.exit(2)
}

say(`launcher: ${launcher}`)
say('=== running: dsh plugin add ===')

// `link:` with forward slashes: it is the form pnpm records and the form the
// sibling plugins already use in this profile.
const spec = `link:${packageDir.replace(/\\/g, '/')}`

let output = ''
try {
  output = execFileSync(launcher, ['plugin', '--profile', profileName, 'add', spec], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 600000,
  })
} catch (error) {
  console.error(String(error.stdout ?? ''))
  console.error(String(error.stderr ?? ''))
  fail(`dsh plugin add failed: ${String(error.message)}`)
}

for (const line of output.split(/\r?\n/)) {
  if (line.trim() === '') continue
  say(`  ${line}`)
}

say('')
say('=== verifying the result ===')

// Both conditions are required for the plugin to be listed, so both are asserted
// rather than inferred from the command's exit code. A successful `pnpm add` that
// somehow did not select the bundle would leave the original symptom in place.
const after = JSON.parse(readFileSync(manifestFile, 'utf8'))
const dependency = after?.dependencies?.[PLUGIN]
const bundles = after?.dsh?.profile?.bundles ?? []
const selected = bundles.includes(PLUGIN)

say(`  dependency recorded : ${dependency === undefined ? 'NO' : `yes (${String(dependency)})`}`)
say(`  bundle selected     : ${selected ? 'yes' : 'NO'}`)

if (dependency === undefined || !selected) {
  say('')
  say('The plugin would run but not be listed in the Plugins page, because the')
  say('manager only lists bundles the profile SELECTS.')
  fail('installation is incomplete')
}

const linkPath = join(profile, 'node_modules', PLUGIN)
say(`  link in node_modules: ${existsSync(linkPath) ? 'yes' : 'NO'}`)

say('')
say('Done. Restart DSH so the bundle layer mounts, then look for it in the')
say('Plugins page - the same place the other dsh-fk-* plugins appear.')
