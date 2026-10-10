// Remove dsh-restart-button from a DSH profile.
//
// Reverses tools/install.mjs: drops the junction and the insert row, and leaves
// every other byte of the patch layer as it was - the file is BOM-less UTF-8 with
// CJK in it, so it is read and written as text here rather than through
// PowerShell, whose 5.1 defaults mangle exactly that shape.
//
//   node tools/uninstall.mjs [--profile desktop] [--dsh-home D:\dsh-data]

import { existsSync, copyFileSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = 'dsh-restart-button'
const ENTRY_ID = 'restart-button'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue
    out[argv[index].slice(2)] = argv[index + 1]
    index += 1
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const dshHome = args['dsh-home'] ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const profileName = args.profile ?? 'desktop'

const profile = join(dshHome, 'profiles', profileName)
const patchFile = join(profile, 'cordis.patch.yml')
const linkPath = join(profile, 'node_modules', PLUGIN)

const say = (message) => { console.log(message) }
const fail = (message) => { console.error(`FAILED: ${message}`); process.exit(2) }

say(`profile : ${profile}`)
if (!existsSync(patchFile)) fail(`no cordis.patch.yml at ${patchFile}`)

// The link first: with it gone the row names a package that cannot resolve, so a
// half-finished uninstall is at least visibly incomplete rather than silently
// mounting a stale copy.
if (existsSync(linkPath)) {
  let isLink = false
  try {
    isLink = lstatSync(linkPath).isSymbolicLink()
  } catch {
    isLink = false
  }
  if (isLink) {
    rmSync(linkPath, { recursive: false, force: true })
    say(`  removed link ${linkPath}`)
  } else {
    say(`  ${linkPath} is a real directory, not the junction this tool creates; leaving it alone`)
  }
} else {
  say('  no link to remove')
}

const raw = readFileSync(patchFile, 'utf8')
// Anchored to the exact three-line block the installer writes. `[ \t]` rather
// than `\s` so a pattern cannot run past a newline and swallow a neighbouring
// row, and a fresh regex per use because a /g regex carries `lastIndex` between
// calls - `test` followed by `replace` on the SAME object is the kind of shared
// state that works until the first line it silently skips.
const eol = '(?:\\r\\n|\\n|\\r)'
const blockSource = `^[ \\t]*-[ \\t]*insert:[ \\t]*${eol}`
  + `[ \\t]*-[ \\t]*id:[ \\t]*${ENTRY_ID}[ \\t]*${eol}`
  + `[ \\t]*name:[ \\t]*${PLUGIN}[ \\t]*${eol}?`

if (!new RegExp(blockSource, 'm').test(raw)) {
  say('  no insert row to remove (already gone, or never added by this tool)')
} else {
  const backup = `${patchFile}.bak-${PLUGIN}-uninstall-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(patchFile, backup)
  // Every match is removed: the installer only ever writes one, so a duplicate
  // would be a defect worth clearing rather than preserving.
  const next = raw.replace(new RegExp(blockSource, 'gm'), '')
  writeFileSync(patchFile, next, 'utf8')
  say(`  removed the insert row (backup: ${backup})`)
}

say('')
say('Done. Restart DSH (or wait for the patch layer to reload) for the row to')
say('disappear from the loader graph.')
say(`The helper directory ${join(dshHome, 'restart-helper')} is left in place: it holds`)
say('the relaunch log, which is the only record of a restart that misbehaved.')
