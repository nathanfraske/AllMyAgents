import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const installer = fileURLToPath(new URL('./install-linux.sh', import.meta.url))
const linux = process.platform === 'linux'
const quote = value => `'${value.replaceAll("'", "'\\''")}'`

// All external writes, downloads and privilege transitions are mocks. No apt, sudo or service runs.
function run(args = [], scenario = 'valid') {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-installer-test-'))
  try {
    const bin = path.join(work, 'bin')
    fs.mkdirSync(bin)
    const log = path.join(work, 'calls.jsonl')
    const fake = path.join(work, 'fake.mjs')
    fs.writeFileSync(fake, `
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const [tool, ...args] = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify({tool, args, socket:process.env.MYOWNMESH_CONTROL_SOCKET})+'\\n');
if (tool === 'sudo') { const r=spawnSync(args[0],args.slice(1),{stdio:'inherit',env:process.env}); process.exit(r.status ?? 1); }
if (tool === 'uname') { console.log(args[0]==='-s'?'Linux':'x86_64'); process.exit(0); }
if (tool !== 'curl') process.exit(0);
const output=args[args.indexOf('-o')+1];
const scenario=process.env.TEST_SCENARIO;
const name='allmyagents-testbed_0.2.0_amd64.deb';
const base='https://github.com/nathanfraske/AllMyAgents/releases/download/v0.2.0/';
const bytes=Buffer.from('disposable package fixture');
if (output.endsWith('release.json')) {
  let assets=[{name,browser_download_url:base+name},{name:name+'.sha256',browser_download_url:base+name+'.sha256'}];
  if (scenario==='missing') assets=[];
  if (scenario==='ambiguous') assets.push(assets[0]);
  if (scenario==='foreign') assets[0].browser_download_url='https://example.invalid/package.deb';
  fs.writeFileSync(output,JSON.stringify({assets}));
} else if (output.endsWith('checksum')) {
  const digest=scenario==='corrupt'?'0'.repeat(64):crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(output,digest+'  '+name+'\\n');
} else fs.writeFileSync(output,bytes);
`)
    for (const tool of ['curl', 'apt-get', 'sudo', 'allmyagents-testbed', 'uname']) {
      fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fake)} ${quote(tool)} "$@"\n`, { mode: 0o755 })
    }
    const result = spawnSync('bash', [installer, ...args], { encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_CALLS: log, TEST_SCENARIO: scenario } })
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []
    return { ...result, calls }
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

test('package-only install verifies the checksum and never configures a service', { skip: !linux }, () => {
  const r = run(['--tag', 'v0.2.0'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /: OK/)
  assert.equal(r.calls.filter(c => c.tool === 'apt-get').length, 1)
  assert.equal(r.calls.filter(c => c.tool === 'allmyagents-testbed').length, 0)
  assert.ok(r.calls.some(c => c.args.includes('https://api.github.com/repos/nathanfraske/AllMyAgents/releases/tags/v0.2.0')))
})

for (const scenario of ['corrupt', 'missing', 'ambiguous', 'foreign']) {
  test(`${scenario} release fails before package or service changes`, { skip: !linux }, () => {
    const r = run([], scenario)
    assert.notEqual(r.status, 0)
    assert.equal(r.calls.filter(c => ['apt-get', 'allmyagents-testbed'].includes(c.tool)).length, 0)
  })
}

for (const profile of ['elevated-machine', 'linux-sudo-machine', 'full-machine']) {
  test(`explicit ${profile} is passed intact, including a socket path with spaces`,
    { skip: !linux || (profile === 'full-machine' && process.getuid?.() === 0) }, () => {
      const r = run(['--profile', profile, '--mesh-socket', '/tmp/my mesh.sock'])
      assert.equal(r.status, 0, r.stderr)
      const calls = r.calls.filter(c => c.tool === 'allmyagents-testbed')
      assert.equal(calls.length, 1)
      assert.deepEqual(calls[0].args, [profile === 'full-machine' ? 'install-user' : 'install-elevated', '--profile', profile])
      assert.equal(calls[0].socket, '/tmp/my mesh.sock')
    })
}

test('unknown privilege profile fails before any download or package change', { skip: !linux }, () => {
  const r = run(['--profile', 'anything'])
  assert.equal(r.status, 2)
  assert.equal(r.calls.filter(c => c.tool !== 'uname').length, 0)
})
