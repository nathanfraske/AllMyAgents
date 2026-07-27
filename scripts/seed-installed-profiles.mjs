// Copy vendor SIGN-IN state from a source hub's profiles into the installed app's profiles.
//
//   node scripts/seed-installed-profiles.mjs            # show what would happen, change nothing
//   node scripts/seed-installed-profiles.mjs --apply    # do it
//   node scripts/seed-installed-profiles.mjs --apply --force   # overwrite creds already there
//
// WHY THIS EXISTS. The installed desktop app keeps its profiles in the OS app-data directory; a hub run
// from a checkout keeps them in `<repo>/profiles`. Those are different places on purpose — the bundle
// ships ZERO credentials, and `scripts/bundle-hub.mjs` has a firewall that fails the build if any
// credential-shaped file reaches the payload. Correct, and it means a fresh install starts signed into
// nothing.
//
// That is right for a real user and wrong for the operator testing their own release, who then has to
// re-authenticate every profile before they can test anything — enough friction that the clean-machine
// test quietly stops being run, which is the actual danger.
//
// WHAT IT DELIBERATELY DOES NOT COPY. Only the auth files. Not the journal, not chats, not project lists,
// not worktrees. The point is a CLEAN app that happens to be signed in: fresh database, fresh UI state,
// real accounts. Copying whole profile directories would drag `.claude.json` (project list, machine paths,
// prior session state) along and turn a clean test into a partial migration — at which point it no longer
// tells you what a new install does.
//
// WHY COPIES RATHER THAN A SHARED DIRECTORY. Pointing two hubs at one profile directory looks tidier and
// is worse: both vendors refresh OAuth tokens in place, so two live hubs can interleave a refresh and a
// read on the same file and sign each other out. Independent copies cannot race. The cost is that a copy
// goes stale when the source refreshes its token — so re-run this before a test session rather than once
// and forever.
//
// This is an operator tool and never ships: the bundle stages `apps/hub` and the node runtime, not
// `scripts/`. It also refuses to write anything without --apply.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APPLY = process.argv.includes('--apply')
const FORCE = process.argv.includes('--force')
const IDENTIFIER = 'direct.cec.allmyagents'

// The files that mean "signed in", per vendor. Anything not listed is state, not auth, and stays behind.
const AUTH_FILES = {
  claude: ['.credentials.json'],
  codex: ['auth.json'],
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Where the installed desktop app keeps its hub profiles, per platform. */
function installedProfilesDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, IDENTIFIER, 'hub', 'profiles')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', IDENTIFIER, 'hub', 'profiles')
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(base, IDENTIFIER, 'hub', 'profiles')
}

/** Which vendor a profile belongs to, from its directory name. */
function vendorOf(name) {
  if (name.startsWith('claude')) return 'claude'
  if (name.startsWith('codex')) return 'codex'
  return undefined
}

const src = path.join(repoRoot, 'profiles')
const dst = installedProfilesDir()

console.log(`source (this checkout) : ${src}`)
console.log(`target (installed app) : ${dst}`)
console.log('')

if (!fs.existsSync(src)) {
  console.error(`nothing to copy: ${src} does not exist`)
  process.exit(1)
}

const profiles = fs
  .readdirSync(src, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)

if (!profiles.length) {
  console.error(`nothing to copy: ${src} has no profile directories`)
  process.exit(1)
}

let planned = 0
let skipped = 0
const actions = []

for (const profile of profiles) {
  const vendor = vendorOf(profile)
  if (!vendor) {
    console.log(`  ${profile}: unrecognised vendor prefix — skipped`)
    continue
  }
  for (const file of AUTH_FILES[vendor]) {
    const from = path.join(src, profile, file)
    if (!fs.existsSync(from)) {
      console.log(`  ${profile}/${file}: not signed in here — nothing to copy`)
      continue
    }
    const to = path.join(dst, profile, file)
    const exists = fs.existsSync(to)
    if (exists && !FORCE) {
      console.log(`  ${profile}/${file}: already present in the installed app — left alone (--force to replace)`)
      skipped++
      continue
    }
    actions.push({ from, to, profile, file, replacing: exists })
    console.log(`  ${profile}/${file}: ${exists ? 'REPLACE' : 'copy'}`)
    planned++
  }
}

console.log('')
if (!planned) {
  console.log(`nothing to do (${skipped} already present).`)
  process.exit(0)
}

if (!APPLY) {
  console.log(`${planned} file(s) would be copied. Re-run with --apply to do it.`)
  process.exit(0)
}

for (const a of actions) {
  fs.mkdirSync(path.dirname(a.to), { recursive: true })
  fs.copyFileSync(a.from, a.to)
  // Credentials are readable by the owner only. copyFileSync does not carry POSIX mode across, and a
  // token that lands world-readable is a worse outcome than the re-auth this script exists to avoid.
  if (process.platform !== 'win32') fs.chmodSync(a.to, 0o600)
}

console.log(`copied ${actions.length} auth file(s).`)
console.log('')
console.log('The installed app now starts with an EMPTY database and your existing accounts.')
console.log('These are point-in-time copies: if a token refreshes in the source hub, re-run this.')
console.log('')
console.log('⚠ ONE ACCOUNT, TWO HUBS — read this before running both at once.')
console.log('  Both copies now hold the same OAuth refresh token. Vendors commonly ROTATE that token on')
console.log('  refresh: the first hub to refresh gets a new one, and the other copy is left holding a')
console.log('  token the provider has already retired. That hub is then signed out and needs re-auth.')
console.log('')
console.log('  It does not corrupt anything and nothing is lost — but if it happens to the hub running')
console.log('  your live fleet, it signs those agents out mid-work, which is a bad way to find out.')
console.log('')
console.log('  Safest: test the installed app while the source hub is idle, or point the installed app at')
console.log('  a spare profile instead of the ones your fleet is using.')
