// Verify that this package will compose as a client bundle.
//
// The registry serves browser bundles from a map keyed by an exact
// `/plugins/??<id>/client.js&rev=<rev>` string, so a hand-made HTTP request 404s
// whether or not the package registered - a 404 proves nothing. What actually
// decides whether the button can appear is a short chain of resolutions, and
// every link in it can be checked offline:
//
//   1. `dsh-fk-restart-button/package.json` must RESOLVE from the profile, which
//      needs the package's own "./package.json" export to exist.
//   2. the manifest must declare `dsh.client.platform === "web"`, and
//      `exports["./client"]` must name a file that is really there.
//   3. that file must be the loader wrapper the shell expects, and evaluating it
//      must yield an `apply` function.
//
//   node verify/verify-install.mjs [--profile-dir <DSH_HOME>\profiles\desktop]

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, '..')
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const packageName = manifest.name

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
const profileDir = args['profile-dir'] ?? join(dshHome, 'profiles', args.profile ?? 'desktop')

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined ? '' : `  (${detail})`}`)
  if (!ok) failures += 1
}

console.log(`package : ${packageName}`)
console.log(`profile : ${profileDir}`)
console.log('')

// 1. Manifest resolution, exactly as the scanner does it.
const require = createRequire(join(profileDir, 'package.json'))
let resolvedManifest
try {
  resolvedManifest = require.resolve(`${packageName}/package.json`)
  check('package.json resolves from the profile', true, resolvedManifest)
} catch (error) {
  check('package.json resolves from the profile', false, String(error.message))
}

// 2. The declaration the scanner reads.
const declaration = manifest.dsh?.client
check('manifest declares dsh.client', declaration !== undefined && typeof declaration === 'object')
check('dsh.client.platform is "web"', declaration?.platform === 'web', String(declaration?.platform))

const clientRel = manifest.exports?.['./client']?.default ?? manifest.exports?.['./client']
check('manifest exports "./client"', typeof clientRel === 'string', String(clientRel))

const clientPath = typeof clientRel === 'string' ? join(packageDir, clientRel) : null
check('the bundle file exists', clientPath !== null && existsSync(clientPath), String(clientPath))

// 3. The bundle must be the loader wrapper, and must yield an apply function.
if (clientPath !== null && existsSync(clientPath)) {
  const source = readFileSync(clientPath, 'utf8')
  check('bundle calls window.__ModuleLoader__.load', source.includes('__ModuleLoader__.load('))
  check('bundle returns module.exports', source.includes('return module.exports;'))

  // Evaluate the wrapper against a stub loader, the way the shell would.
  let captured = null
  const previous = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load: (entry) => { captured = entry },
    },
  }
  try {
    // The bundle only calls `load` at evaluation time; the factory is invoked
    // afterwards, which is what lets `require` be supplied by the shell.
    await import(`file://${clientPath.replace(/\\/g, '/')}?v=${String(Date.now())}`)
  } catch (error) {
    check('bundle evaluates', false, String(error.message))
  } finally {
    globalThis.window = previous
  }

  check('bundle registered an entry', captured !== null)
  check('entry id is the package name', captured?.id === packageName, String(captured?.id))

  if (captured !== null && typeof captured.factory === 'function') {
    let face = null
    try {
      // No `react` is supplied: the half is required to survive that and still
      // register, because an action that silently never appears is the failure
      // this suite exists to catch before a user sees it.
      face = captured.factory((specifier) => {
        throw new Error(`unexpected require(${specifier})`)
      })
    } catch (error) {
      check('factory runs without react', false, String(error.message))
    }
    check('factory exports apply', typeof face?.apply === 'function')
  }
}

console.log('')
if (failures === 0) {
  console.log('all checks passed')
} else {
  console.log(`${String(failures)} check(s) failed`)
  process.exitCode = 1
}
