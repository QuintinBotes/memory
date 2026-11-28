/** What the review pane keeps (#104): the proposals `memory review --json` listed, trimmed to what it draws. */
export type MemoryProposal = {
  id: string;
  type: string;
  where: string;
  statement: string;
  evidence: string[];
  shadow: string;
};

declare module 'claude-code' {
  interface PluginState {
    memory: {
      proposals: Shaped<MemoryProposal[]>;
      /** Why the list could not be read, or '' when it was. */
      problem: string;
      /** The proposal a decision is running for, so a second press does nothing. */
      busy: string;
      /** How many items `memory review --json` listed as expiring soon (#142). */
      expiring: number;
    };
  }
}
