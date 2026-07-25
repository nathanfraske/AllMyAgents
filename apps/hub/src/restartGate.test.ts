import { describe, expect, it } from 'vitest'
import { decideRestartGate } from './restartGate.js'
import type { DangerFlags } from './types.js'

const SAFE: DangerFlags = { busCanUseRiskyTools: false, autoApprovePractices: false, autoApproveRestart: false }

describe('decideRestartGate (the restart gate + Danger Zone overrides)', () => {
  it('defaults to operator approval when nothing is enabled', () => {
    expect(decideRestartGate({ isBusTurn: false, danger: SAFE })).toEqual({ action: 'approve' })
  })

  it('bus turns are hard-denied by default — a teammate message can never restart the hub', () => {
    expect(decideRestartGate({ isBusTurn: true, danger: SAFE })).toEqual({ action: 'deny-bus' })
  })

  it('busCanUseRiskyTools lets a bus turn through, then the normal gate applies (approve by default)', () => {
    const danger: DangerFlags = { busCanUseRiskyTools: true, autoApprovePractices: false, autoApproveRestart: false }
    expect(decideRestartGate({ isBusTurn: true, danger })).toEqual({ action: 'approve' })
  })

  it('busCanUseRiskyTools + autoApproveRestart lets a bus turn restart with no prompt', () => {
    const danger: DangerFlags = { busCanUseRiskyTools: true, autoApprovePractices: false, autoApproveRestart: true }
    expect(decideRestartGate({ isBusTurn: true, danger })).toEqual({ action: 'allow' })
  })

  it('autoApproveRestart skips the operator prompt on a non-bus turn', () => {
    const danger: DangerFlags = { busCanUseRiskyTools: false, autoApprovePractices: false, autoApproveRestart: true }
    expect(decideRestartGate({ isBusTurn: false, danger })).toEqual({ action: 'allow' })
  })

  it('the bus hard-deny still wins over autoApproveRestart (bus safety is independent)', () => {
    const danger: DangerFlags = { busCanUseRiskyTools: false, autoApprovePractices: false, autoApproveRestart: true }
    expect(decideRestartGate({ isBusTurn: true, danger })).toEqual({ action: 'deny-bus' })
  })
})
