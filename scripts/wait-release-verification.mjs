import { pathToFileURL } from 'node:url'

export const REQUIRED_DURABILITY_WORKFLOWS = [
  'macos-p0-verification.yml',
  'windows-p0-verification.yml',
]

export function assessVerificationRuns(runs, required = REQUIRED_DURABILITY_WORKFLOWS) {
  const pending = []
  for (const workflow of required) {
    const run = runs[workflow]
    if (!run || run.status !== 'completed') {
      pending.push(workflow)
      continue
    }
    if (run.conclusion !== 'success') {
      throw new Error(
        `${workflow} run ${run.id ?? '(unknown)'} concluded ${run.conclusion ?? 'without a conclusion'}; release publishing is blocked`,
      )
    }
  }
  return { ready: pending.length === 0, pending }
}

async function githubRequest(path, { method = 'GET', body, token, apiUrl }) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`GitHub API ${method} ${path} returned ${response.status}: ${detail}`)
  }
  if (response.status === 204) return undefined
  return response.json()
}

export async function dispatchAndWait({
  repository,
  ref,
  sha,
  token,
  apiUrl = 'https://api.github.com',
  workflows = REQUIRED_DURABILITY_WORKFLOWS,
  timeoutMs = 50 * 60 * 1000,
  pollMs = 15_000,
}) {
  const encodedRepo = repository.split('/').map(encodeURIComponent).join('/')
  const startedAt = Date.now() - 5_000

  for (const workflow of workflows) {
    await githubRequest(
      `/repos/${encodedRepo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
      { method: 'POST', body: { ref }, token, apiUrl },
    )
    process.stdout.write(`dispatched ${workflow} at ${ref}\n`)
  }

  const deadline = Date.now() + timeoutMs
  const lastStatus = new Map()
  while (Date.now() < deadline) {
    const matching = {}
    for (const workflow of workflows) {
      const data = await githubRequest(
        `/repos/${encodedRepo}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&head_sha=${encodeURIComponent(sha)}&per_page=20`,
        { token, apiUrl },
      )
      const run = (data.workflow_runs ?? [])
        .filter((candidate) => Date.parse(candidate.created_at) >= startedAt)
        .sort((a, b) => Number(b.id) - Number(a.id))[0]
      if (run) {
        matching[workflow] = run
        const status = `${run.status}/${run.conclusion ?? '-'}`
        if (lastStatus.get(workflow) !== status) {
          process.stdout.write(`${workflow} run ${run.id}: ${status} ${run.html_url ?? ''}\n`)
          lastStatus.set(workflow, status)
        }
      }
    }

    const assessment = assessVerificationRuns(matching, workflows)
    if (assessment.ready) {
      process.stdout.write('macOS and Windows launch-and-repair verification passed\n')
      return matching
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }

  throw new Error(
    `timed out waiting for required launch-and-repair workflows after ${Math.round(timeoutMs / 60_000)} minutes`,
  )
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY
  const ref = process.env.GITHUB_REF_NAME
  const sha = process.env.GITHUB_SHA
  const token = process.env.GITHUB_TOKEN
  if (!repository || !ref || !sha || !token) {
    throw new Error(
      'GITHUB_REPOSITORY, GITHUB_REF_NAME, GITHUB_SHA, and GITHUB_TOKEN are required',
    )
  }
  await dispatchAndWait({ repository, ref, sha, token })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error title=Release durability gate::${error.message}`)
    process.exitCode = 1
  })
}
