import { randomUUID } from 'node:crypto';
import { memoryRef } from '@shared/ai-memory';
import {
  MCP_MAX_OPEN_PROPOSALS,
  MCP_PROPOSAL_EXPIRY_MS,
  MCP_PROPOSAL_KEEP_MS,
  type McpAccess,
  accessAtLeast,
} from '@shared/mcp';
import type { AiActionResult } from '@shared/protocol';
import type { StartExternal } from '../ai';

/**
 * Proposals an AI tool made through MCP (`propose_change`, `remember`): each
 * has an id, waits for the user in Plasma, and keeps its outcome for an hour so
 * `check_proposal` can answer after the client's own call timed out.
 *
 * The rule this file exists for: once the user approved a proposal, nothing
 * (a client timeout, a dropped connection, the server being turned off) may
 * report "nothing changed" or cut the run short. Only an undecided proposal can
 * expire or be withdrawn. The real outcome is recorded when the run finishes.
 */

export type ProposalStatus = 'waiting_for_approval' | 'applied' | 'declined' | 'failed' | 'expired';
export type ProposalKind = 'change' | 'remember';

export interface ProposalView {
  proposal_id: string;
  status: ProposalStatus;
  message: string;
  rows_affected?: number;
}

interface Proposal {
  id: string;
  kind: ProposalKind;
  connectionId: string;
  status: ProposalStatus;
  message: string;
  rowsAffected?: number;
  settledAt?: number;
  /** Why an undecided proposal was taken back, if it was. */
  withdrawn?: { reason: string; expired: boolean };
  action: Extract<StartExternal, { ok: true }>['action'];
  timer?: ReturnType<typeof setTimeout>;
  waiters: Set<() => void>;
}

export interface ProposalDeps {
  start(input: {
    kind: ProposalKind;
    client: string;
    connectionId: string;
    connectionName: string;
    args: Record<string, unknown>;
  }): StartExternal;
  /** Error text with host, user, paths and secrets removed. */
  scrub(connectionId: string, text: string): string;
  now?: () => number;
  expiryMs?: number;
  keepMs?: number;
}

export const EXPIRED_REASON = 'Withdrawn: the request expired.';
export const WAITING_MESSAGE =
  'Waiting for the user to approve in Plasma. Call check_proposal with this id.';

const firstLine = (text: string): string => (text.split('\n')[0] ?? '').slice(0, 400);

export class ProposalStore {
  private readonly items = new Map<string, Proposal>();
  private readonly now: () => number;

  constructor(private readonly deps: ProposalDeps) {
    this.now = deps.now ?? Date.now;
  }

  private view(p: Proposal): ProposalView {
    return {
      proposal_id: p.id,
      status: p.status,
      message: p.status === 'waiting_for_approval' ? WAITING_MESSAGE : p.message,
      ...(p.rowsAffected !== undefined ? { rows_affected: p.rowsAffected } : {}),
    };
  }

  private open(): Proposal[] {
    return [...this.items.values()].filter((p) => p.status === 'waiting_for_approval');
  }

  private sweep(): void {
    const keep = this.deps.keepMs ?? MCP_PROPOSAL_KEEP_MS;
    for (const [id, p] of this.items) {
      if (p.settledAt !== undefined && this.now() - p.settledAt > keep) this.items.delete(id);
    }
  }

  /** Put a proposal in front of the user. */
  create(input: {
    kind: ProposalKind;
    client: string;
    connectionId: string;
    connectionName: string;
    args: Record<string, unknown>;
  }): { ok: true; id: string } | { ok: false; note: string } {
    this.sweep();
    if (this.open().length >= MCP_MAX_OPEN_PROPOSALS) {
      return {
        ok: false,
        note: 'Too many proposals are waiting for the user in Plasma. Try again after they answer.',
      };
    }
    const started = this.deps.start(input);
    if (!started.ok) return started;
    const p: Proposal = {
      id: randomUUID(),
      kind: input.kind,
      connectionId: input.connectionId,
      status: 'waiting_for_approval',
      message: '',
      action: started.action,
      waiters: new Set(),
    };
    this.items.set(p.id, p);
    void started.action.result.then((res) => this.settle(p, res));
    // Only an undecided proposal can expire.
    p.timer = setTimeout(() => {
      if (p.status !== 'waiting_for_approval' || p.action.approved()) return;
      if (p.action.withdraw(EXPIRED_REASON))
        p.withdrawn = { reason: EXPIRED_REASON, expired: true };
    }, this.deps.expiryMs ?? MCP_PROPOSAL_EXPIRY_MS);
    p.timer.unref?.();
    return { ok: true, id: p.id };
  }

  private settle(p: Proposal, res: AiActionResult): void {
    if (p.timer) clearTimeout(p.timer);
    const approved = p.action.approved();
    switch (res.outcome) {
      case 'applied':
        p.status = 'applied';
        if (p.kind === 'remember') {
          p.message = res.memoryId ? `Remembered as ${memoryRef(res.memoryId)}.` : 'Remembered.';
        } else {
          const m = /(\d+)\s+rows?\b/.exec(res.note ?? '');
          const rows = m?.[1] ? Number(m[1]) : res.data?.rowCount;
          if (rows !== undefined) p.rowsAffected = rows;
          p.message = (res.note ?? 'Applied.').slice(0, 300);
        }
        break;
      case 'rejected':
        p.status = 'declined';
        p.message = res.note
          ? `The user declined: ${res.note.slice(0, 300)}`
          : 'The user declined. Nothing was changed.';
        break;
      case 'failed':
        p.status = 'failed';
        p.message = this.deps.scrub(
          p.connectionId,
          firstLine(res.dbError ?? res.note ?? 'It failed.'),
        );
        break;
      default:
        // cancelled
        if (approved) {
          p.status = 'failed';
          p.message =
            'It was approved but stopped before it finished. It may have run: check the data before trying again.';
        } else if (p.withdrawn?.expired) {
          p.status = 'expired';
          p.message = `${EXPIRED_REASON} Nothing was changed.`;
        } else if (p.withdrawn) {
          p.status = 'declined';
          p.message = `${p.withdrawn.reason} Nothing was changed.`;
        } else {
          p.status = 'declined';
          p.message = 'Cancelled in Plasma. Nothing was changed.';
        }
    }
    p.settledAt = this.now();
    for (const w of [...p.waiters]) w();
    p.waiters.clear();
  }

  /** The proposal's state, or null when the id is unknown (or older than an hour). */
  get(id: string): ProposalView | null {
    this.sweep();
    const p = this.items.get(id);
    return p ? this.view(p) : null;
  }

  /**
   * Wait up to `ms` for a decision. Returns the state at that point: still
   * `waiting_for_approval` when the time is up, or when `signal` fires (the
   * client went away). Waiting never changes the proposal.
   */
  async wait(id: string, ms: number, signal?: AbortSignal): Promise<ProposalView | null> {
    const p = this.items.get(id);
    if (!p) return null;
    if (p.status === 'waiting_for_approval') {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          p.waiters.delete(done);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const t = setTimeout(done, ms);
        p.waiters.add(done);
        if (signal?.aborted) done();
        else signal?.addEventListener('abort', done, { once: true });
      });
    }
    return this.view(p);
  }

  /** Take back every undecided proposal for which `keep` says no (access lowered, connection deleted...). */
  recheck(keep: (connectionId: string, kind: ProposalKind) => string | null): void {
    for (const p of this.open()) {
      const reason = keep(p.connectionId, p.kind);
      if (reason && !p.action.approved() && p.action.withdraw(reason)) {
        p.withdrawn = { reason, expired: false };
      }
    }
  }

  withdrawUndecided(reason: string): void {
    this.recheck(() => reason);
  }
}

/** Access a proposal of `kind` needs. */
export const accessFor = (kind: ProposalKind): McpAccess =>
  kind === 'change' ? 'propose' : 'read';
export const accessAllows = (have: McpAccess, kind: ProposalKind): boolean =>
  accessAtLeast(have, accessFor(kind));
