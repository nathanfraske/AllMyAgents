import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSandboxAppNetwork } from './sandbox.mjs'

test('Windows sandbox app binds the exact IPv4 loopback address it advertises', () => {
  const network = buildSandboxAppNetwork(5274)

  assert.equal(network.bindHost, '127.0.0.1')
  assert.equal(network.advertisedUrl, 'http://127.0.0.1:5274')
  assert.deepEqual(network.viteArgs, ['--host', '127.0.0.1', '--port', '5274', '--strictPort'])
})

test('IPv4 and IPv6 advertised URLs identify the exact Vite bind host', () => {
  for (const [bindHost, advertisedUrl] of [
    ['127.0.0.1', 'http://127.0.0.1:5274'],
    ['::1', 'http://[::1]:5274'],
  ]) {
    const network = buildSandboxAppNetwork(5274, bindHost)
    const hostIndex = network.viteArgs.indexOf('--host')

    assert.notEqual(hostIndex, -1)
    assert.equal(network.viteArgs[hostIndex + 1], bindHost)
    assert.equal(network.bindHost, bindHost)
    assert.equal(network.advertisedUrl, advertisedUrl)
  }
})
