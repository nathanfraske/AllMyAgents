import { randomBytes } from 'node:crypto'

/** One credential per supervisor lifetime, independent of device and worker-channel credentials. */
export function createAgentToolSecret(): string {
  return randomBytes(32).toString('hex')
}

/** Capture before any vendor/helper launch, then remove it from the inherited environment. */
export function takeAgentToolSecret(supervised: boolean, env: NodeJS.ProcessEnv = process.env): string {
  const inherited = env.HUB_AGENT_TOOL_SECRET
  delete env.HUB_AGENT_TOOL_SECRET
  if (supervised && inherited !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(inherited)) throw new Error('Invalid supervisor agent-tool credential')
    return inherited
  }
  // Standalone hubs and rolling upgrades under an older supervisor retain isolated credentials.
  // The first upgrade to supervisor-owned authentication requires a full app restart.
  return createAgentToolSecret()
}
