import { nanoid } from "nanoid";
import { detectRiskFlags, maskSensitive } from "@local-terminal/security";
import type { CommandProposal, ProposeCommandResponse } from "@local-terminal/shared";
import type { ProposalState, TerminalAdapter } from "../types.js";
import { SessionStore } from "./sessionStore.js";

export class CommandService {
  private readonly proposals = new Map<string, ProposalState>();

  constructor(
    private readonly adapter: TerminalAdapter,
    private readonly store: SessionStore
  ) {}

  propose(sessionId: string, command: string): ProposeCommandResponse {
    const riskFlags = detectRiskFlags(command);
    const proposal: CommandProposal = {
      id: nanoid(),
      sessionId,
      command,
      riskFlags,
      explanation: riskFlags.length > 0
        ? "This command includes explicit delete semantics and needs careful review."
        : "Command looks non-destructive based on configured policy.",
      createdAt: Date.now()
    };

    this.proposals.set(proposal.id, { proposal, confirmed: false });
    this.store.setRiskFlags(sessionId, riskFlags);

    return {
      proposal,
      requiresConfirmation: true,
      preview: {
        command: maskSensitive(command),
        riskFlags,
        explanation: proposal.explanation
      }
    };
  }

  async confirm(proposalId: string): Promise<{ paneId: string; proposal: CommandProposal }> {
    const state = this.proposals.get(proposalId);
    if (!state) {
      throw new Error("proposal_not_found");
    }

    if (state.confirmed) {
      throw new Error("proposal_already_confirmed");
    }

    state.confirmed = true;
    const result = await this.adapter.sendCommandToActivePane(state.proposal.sessionId, state.proposal.command);
    this.store.recordCommand(state.proposal.sessionId, state.proposal.command);
    return { paneId: result.paneId, proposal: state.proposal };
  }
}
