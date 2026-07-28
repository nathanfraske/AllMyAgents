import { execFileSync, spawn, type ChildProcess } from 'node:child_process'

const WINDOWS_INTEROP_PATH = /^\/mnt\/[a-z](?:\/|$)/i

/**
 * Resolve a command through the distro's own shell and reject Windows-interoperability shims. A
 * `/mnt/c/.../codex` result is still a Windows-side agent and would put the hot path back across UNC.
 */
export function nativeWslExecutable(distro: string, command: string): string {
  let executable = ''
  try {
    executable = execFileSync(
      'wsl.exe',
      [
        '--distribution',
        distro,
        '--exec',
        'sh',
        '-lc',
        'command -v -- "$1"',
        'allmyagents-resolve',
        command,
      ],
      { encoding: 'utf8', windowsHide: true },
    ).trim()
  } catch {
    // The actionable error below deliberately hides wsl.exe's raw encoding/platform noise.
  }
  if (!executable || WINDOWS_INTEROP_PATH.test(executable)) {
    throw new Error(
      `${command} is not installed natively in the ${distro} WSL distro. ` +
        `Install and sign in to ${command} inside ${distro}; Windows shims under /mnt cannot provide native WSL execution.`,
    )
  }
  return executable
}

export interface WslSpawnSpec {
  program: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/**
 * Build a WSL launch without putting credentials on the command line. WSLENV carries only the variables
 * the vendor process needs; their values stay in the child environment and do not appear in argv.
 */
export function buildWslSpawnSpec(
  distro: string,
  cwd: string,
  executable: string,
  args: readonly string[],
  vendorEnv: NodeJS.ProcessEnv,
): WslSpawnSpec {
  const names = Object.keys(vendorEnv).filter(
    (name) =>
      /^(?:AMA_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|SSL_CERT_FILE$|NODE_EXTRA_CA_CERTS$)/i.test(
        name,
      ) && name !== 'PATH',
  )
  const inherited = (process.env.WSLENV ?? '')
    .split(':')
    .map((name) => name.trim())
    .filter(Boolean)
  const wslenv = [...new Set([...inherited, ...names])].join(':')
  return {
    program: 'wsl.exe',
    args: [
      '--distribution',
      distro,
      '--cd',
      cwd,
      '--exec',
      executable,
      ...args,
    ],
    env: {
      ...process.env,
      ...vendorEnv,
      ...(wslenv ? { WSLENV: wslenv } : {}),
    },
  }
}

export function spawnInWsl(
  distro: string,
  cwd: string,
  executable: string,
  args: readonly string[],
  vendorEnv: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): ChildProcess {
  const spec = buildWslSpawnSpec(distro, cwd, executable, args, vendorEnv)
  return spawn(spec.program, spec.args, {
    env: spec.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(signal ? { signal } : {}),
  })
}
