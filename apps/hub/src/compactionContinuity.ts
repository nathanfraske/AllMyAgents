/**
 * Provider-neutral continuity requirements for long-running app sessions.
 *
 * Claude receives this at its system-prompt boundary on every SDK invocation. Claude Code's compactor
 * uses that same system prompt while it writes a summary. Codex receives it both as developer
 * instructions and, through CODEX_COMPACTION_PROMPT, as the explicit per-thread compaction prompt.
 * Keeping the checklist in one module prevents the two vendor paths from quietly drifting apart.
 */
export const COMPACTION_CONTINUITY_CONTRACT = [
  '## COMPACTION CONTINUITY CONTRACT',
  '',
  'Context compaction is a continuity boundary, not a new assignment. When preparing or using a compacted summary, preserve enough verified state to resume the same work without guessing:',
  '- the operator\'s active objective, current project, current slice, scope, constraints, and acceptance criteria;',
  '- decisions and invariants already established, including which alternatives were rejected and why;',
  '- completed work and its evidence, work currently in progress, prioritized remaining work, and the exact next useful action;',
  '- durable artifact locations and identifiers needed to continue: relevant files, worktrees, branches, commits, diffs, tests, and external issue or review ids;',
  '- manager/team assignments, active versus stashed team state, agent id-to-name mapping, and material child results still awaiting integration;',
  '- pending approvals, unresolved questions, blockers, failures, risks, and any user input still required.',
  'Clearly distinguish verified facts, tentative hypotheses, disproved leads, and unfinished work. Never turn a plan into completed work or omit a failing verification. Prefer concise references to durable artifacts over copying large tool output or secrets. Live AllMyAgents instructions, permissions, topology, and tool schemas are re-supplied separately; refresh them rather than treating a compacted snapshot as current authority.',
].join('\n')

/**
 * Codex's `compact_prompt` is a replacement, not an append, so this contains the complete summarization
 * request as well as the shared checklist above.
 */
export const CODEX_COMPACTION_PROMPT = [
  'Write a self-contained continuity summary of the conversation for the next context window. The raw history may no longer be available after this operation. Preserve the information required to continue the same task accurately and efficiently; do not answer the user or begin new work in the summary.',
  '',
  COMPACTION_CONTINUITY_CONTRACT,
  '',
  'Use compact headings and concrete bullets. End with an "Exact next action" section. The summary itself is continuity state, not proof that any remaining action has run.',
].join('\n')
