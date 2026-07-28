export const TUTORIAL_ANCHORS = {
  settings: 'settings',
  accountSignIn: 'account-sign-in',
  home: 'home',
  projectList: 'project-list',
  newProject: 'new-project',
  newScratchpad: 'new-scratchpad',
  newProjectFlow: 'new-project-flow',
  projectSource: 'project-source',
  projectIndependentAgents: 'project-independent-agents',
  projectWorktree: 'project-worktree',
  projectManager: 'project-manager',
  projectFinalize: 'project-finalize',
  projectView: 'project-view',
  projectManagerSetup: 'project-manager-setup',
} as const

export type TutorialAnchor = (typeof TUTORIAL_ANCHORS)[keyof typeof TUTORIAL_ANCHORS]
