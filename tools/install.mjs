// Install dsh-restart-button into a DSH profile.
//
// Two changes, both reversible:
//   1. a directory junction at <profile>/node_modules/dsh-restart-button
//   2. one `- insert:` row in <profile>/cordis.patch.yml
//
// Written in Node rather than PowerShell on purpose. The patch layer is BOM-less
// UTF-8 and routinely carries CJK (a provider's displayName, a comment), and both
// Windows PowerShell 5.1 defaults get that wrong: `Get-Content` without
// `-Encoding` decodes it as the system ANSI codepage, and `Set-Content -Encoding
// utf8` there writes UTF-8 WITH a BOM. Doing it here means the file is read and
// written as exactly what it is.
//
//   node tools/install.mjs [--profile desktop] [--dsh-home D:\dsh-data]
//
// package.json is NOT modified and no package manager runs.

import { existsSync, mkdirSync, copyFileSync, readFileSync, readdirSync, writeFileSync, symlinkSync, readlinkSync, lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = 'dsh-restart-button'
const ENTRY_ID = 'restart-button'

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
const patchFile = join(profile, 'cordis.patch.yml')
const manifestFile = join(profile, 'package.json')
const linkPath = join(profile, 'node_modules', PLUGIN)

const say = (message) => { console.log(message) }
const fail = (message) => { console.error(`FAILED: ${message}`); process.exit(2) }

say('=== 1/3 preconditions ===')
say(`  package : ${packageDir}`)
say(`  dsh home: ${dshHome}`)
say(`  profile : ${profile}`)

if (!existsSync(join(packageDir, 'entry.js'))) fail(`no entry.js at ${packageDir}`)
if (!existsSync(join(packageDir, 'lib', 'client.js'))) {
  fail('lib/client.js is missing - run "node build-client.mjs" first.')
}
if (!existsSync(manifestFile)) {
  const profilesDir = join(dshHome, 'profiles')
  const found = existsSync(profilesDir)
    ? readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    : []
  fail(`no profile at ${profile}. Pass --profile <name>. Profiles present: ${found.join(', ') || '(none)'}`)
}
if (!existsSync(patchFile)) fail(`no cordis.patch.yml at ${patchFile}`)

const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
const bundles = manifest?.dsh?.profile?.bundles ?? []
if (bundles.includes(PLUGIN)) {
  say(`  ${PLUGIN} is already declared as a bundle layer; a patch row would mount it twice.`)
  say('  Nothing to do.')
  process.exit(0)
}

const reload = manifest?.dsh?.profile?.patchReload
if (reload !== undefined && !String(reload).startsWith('live')) {
  say(`  patchReload = ${String(reload)}: this profile does not hot-reload its patch layer,`)
  say('  so the row takes effect after the next DSH restart.')
}

say('=== 2/3 link the package into the profile ===')
mkdirSync(join(profile, 'node_modules'), { recursive: true })
let alreadyLinked = false
try {
  const info = lstatSync(linkPath)
  alreadyLinked = true
  const target = info.isSymbolicLink() ? readlinkSync(linkPath) : '(a real directory)'
  say(`  link already present -> ${String(target)}`)
} catch {
  alreadyLinked = false
}
if (!alreadyLinked) {
  symlinkSync(packageDir, linkPath, 'junction')
  say(`  linked ${linkPath} -> ${packageDir}`)
}

say('=== 3/3 add the plugin row to the patch layer ===')
// The row is counted rather than the name searched. Once the settings service has
// written anything for this entry it leaves a row of its own that carries the same
// name but mounts nothing; a name search would call that "already installed" and
// leave the plugin off the loader graph while reporting success.
const eol = '(?:\\r\\n|\\n|\\r)'
// The `m` flag is passed as an argument, NOT as an inline `(?m)` prefix: that
// prefix is a .NET/PCRE spelling and JavaScript rejects it as an invalid group.
const rowPattern = new RegExp(
  `^[ \\t]*-[ \\t]*insert:[ \\t]*${eol}`
  + `[ \\t]*-[ \\t]*id:[ \\t]*${ENTRY_ID}[ \\t]*${eol}`
  + `[ \\t]*name:[ \\t]*${PLUGIN}[ \\t]*`,
  'gm',
)

const raw = readFileSync(patchFile, 'utf8')
const matches = raw.match(rowPattern)
if (matches !== null && matches.length > 0) {
  say(`  an insert row is already there (${String(matches.length)} of them); leaving it alone`)
} else {
  const newline = raw.includes('\r\n') ? '\r\n' : '\n'
  const block = `- insert:${newline}    - id: ${ENTRY_ID}${newline}      name: ${PLUGIN}${newline}`
  const separator = raw.length > 0 && !raw.endsWith('\n') && !raw.endsWith('\r') ? newline : ''
  const backup = `${patchFile}.bak-${PLUGIN}-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(patchFile, backup)
  writeFileSync(patchFile, raw + separator + block, 'utf8')
  say(`  appended 3 lines (backup: ${backup})`)
}

say('')
say('Done. A profile that hot-reloads its patch layer picks this up within a few')
say('seconds; otherwise restart DSH once. Then refresh the page: the button appears')
say('beside Settings at the foot of the sidebar.')
