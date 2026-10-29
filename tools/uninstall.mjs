// Remove dsh-fk-restart-button from a DSH profile.
//
// The mirror of tools/install.mjs: installation is `dsh plugin add`, so removal is
// `dsh plugin remove`, which drops the dependency AND removes the package from the
// bundles the profile selects. Editing those two records by hand is possible and is
// exactly the kind of half-measure that produced the invisible-plugin bug this pair
// of scripts was rewritten for.
//
// Nothing is removed from `cordis.patch.yml`: install never writes there.
//
//   node tools/uninstall.mjs [--profile desktop] [--dsh-home <DSH_HOME>]

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

/** Resolve the `dsh` launcher without relying on PATH; see tools/install.mjs. */
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

say(`profile : ${profile}`)
if (!existsSync(manifestFile)) fail(`no profile at ${profile}. Pass --profile <name>.`)

const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
if (manifest?.dependencies?.[PLUGIN] === undefined) {
  say(`  ${PLUGIN} is not a dependency of this profile; nothing to remove`)
  process.exit(0)
}

const launcher = resolveLauncher()
if (launcher === null) {
  say('Could not locate the `dsh` launcher. Set DSH_LAUNCHER, or run:')
  say('')
  say(`  dsh plugin --profile ${profileName} remove ${PLUGIN}`)
  process.exit(2)
}

say(`launcher: ${launcher}`)
say('=== running: dsh plugin remove ===')

let output = ''
try {
  output = execFileSync(launcher, ['plugin', '--profile', profileName, 'remove', PLUGIN], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 600000,
  })
} catch (error) {
  console.error(String(error.stdout ?? ''))
  console.error(String(error.stderr ?? ''))
  fail(`dsh plugin remove failed: ${String(error.message)}`)
}

for (const line of output.split(/\r?\n/)) {
  if (line.trim() === '') continue
  say(`  ${line}`)
}

say('')
say('=== verifying the result ===')
const after = JSON.parse(readFileSync(manifestFile, 'utf8'))
const stillDependency = after?.dependencies?.[PLUGIN] !== undefined
const stillSelected = (after?.dsh?.profile?.bundles ?? []).includes(PLUGIN)

say(`  dependency removed : ${stillDependency ? 'NO' : 'yes'}`)
say(`  bundle deselected  : ${stillSelected ? 'NO' : 'yes'}`)

if (stillDependency || stillSelected) fail('removal is incomplete')

say('')
say('Done. Restart DSH for the bundle layer to unmount.')
