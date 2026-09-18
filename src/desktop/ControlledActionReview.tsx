import type { ControlledActionState } from "./controlledActions";
import { StatusBadge } from "./StatusBadge";

type Props = {
  state: ControlledActionState;
  deciding: boolean;
  onApproveOnce: () => void;
  onDeny: () => void;
};

const PHASE_LABEL: Readonly<Record<ControlledActionState["phase"], string>> = {
  UNAVAILABLE: "Unavailable",
  READY: "Ready for a bounded proposal",
  PROPOSED: "Proposal received",
  AWAITING_APPROVAL: "Awaiting your decision",
  APPROVED: "Approved once — Hermes is enforcing the binding",
  EXECUTING: "Hermes is executing the bounded action",
  VERIFIED: "Verified by Hermes",
  DENIED: "Denied — nothing executed",
  FAILED: "Failed or unverified",
};

function humanTarget(value: string | undefined): string {
  return value ? value.toLowerCase().replace(/_/g, " ") : "Exact target unavailable";
}

/**
 * The permission class Hermes attaches to this action, in the contract §15
 * human phrasing rather than the raw tier enum. The narrower "once only"
 * scope is asserted only once Hermes has actually sent the bounded envelope
 * and it passed validation; before that Yuzuki has not been told it and says
 * so instead of promising it.
 */
function permissionClassOf(state: ControlledActionState): { tier: string; scope: string } | null {
  if (!state.proposal) return null;
  return {
    tier: "Write to your device — one isolated fixture target",
    scope: state.approval
      ? "This decision applies once, to this action. Session-wide and permanent approval are not offered."
      : "Hermes states the decision scope when it requests your decision.",
  };
}

export function ControlledActionReview({ state, deciding, onApproveOnce, onDeny }: Props) {
  const proposal = state.proposal;
  const approval = state.approval;
  const receipt = state.receipt;
  const permissionClass = permissionClassOf(state);
  const unavailable = state.phase === "UNAVAILABLE";
  const awaiting = state.phase === "AWAITING_APPROVAL";

  return (
    <section className="dz-controlled-action" aria-labelledby="controlled-action-title" data-action-phase={state.phase}>
      <div className="dz-controlled-action-heading">
        <div>
          <p className="dz-controlled-action-kicker">Controlled Actions · Limited preview</p>
          <h2 id="controlled-action-title">Review before anything happens</h2>
        </div>
        <StatusBadge status={state.example ? "EXAMPLE DATA" : unavailable ? "NOT IMPLEMENTED IN THIS PROTOTYPE" : "FOUNDATION"} />
      </div>

      {state.example && (
        <p className="dz-controlled-action-example" role="note">
          Example evidence for interface QA only. No request was sent and no action occurred.
        </p>
      )}

      {unavailable ? (
        <div className="dz-controlled-action-unavailable" role="status">
          <p>No normal user action is connected to bounded computer control in this build.</p>
          <p>
            The implemented CUA path is an isolated developer fixture only. General desktop control, shell,
            accounts, credentials, and session-wide permission are unavailable.
          </p>
        </div>
      ) : (
        <>
          <p className="dz-controlled-action-status" role="status" aria-live="polite">
            <span aria-hidden className="dz-controlled-action-status-dot" />
            {PHASE_LABEL[state.phase]}
          </p>

          {proposal && (
            <dl className="dz-controlled-action-fields">
              <div>
                <dt>What</dt>
                <dd>{String(proposal.expected_effect ?? approval?.description ?? proposal.operation)}</dd>
              </div>
              <div>
                <dt>Why</dt>
                <dd>Hermes requires one fresh decision before input can reach this exact bounded target.</dd>
              </div>
              <div>
                <dt>Target</dt>
                <dd>
                  {proposal.fixed_title} · {humanTarget(proposal.target)}
                </dd>
              </div>
              {permissionClass && (
                <div>
                  <dt>Permission class</dt>
                  <dd>
                    {permissionClass.tier}
                    <span className="dz-controlled-action-scope">{permissionClass.scope}</span>
                  </dd>
                </div>
              )}
              <div>
                <dt>Current status</dt>
                <dd>{PHASE_LABEL[state.phase]}</dd>
              </div>
            </dl>
          )}

          {awaiting && (
            <div className="dz-controlled-action-decision" role="group" aria-label="Controlled action decision">
              <p>
                This decision applies once, to this proposal only. A changed target or replay requires a new request.
              </p>
              <div>
                <button type="button" disabled={deciding || state.example} onClick={onApproveOnce}>
                  {deciding ? "Sending decision…" : "Approve once"}
                </button>
                <button type="button" disabled={deciding || state.example} onClick={onDeny}>
                  Deny
                </button>
              </div>
            </div>
          )}

          {state.message && (
            <p className={`dz-controlled-action-message${state.phase === "FAILED" ? " is-error" : ""}`} role={state.phase === "FAILED" ? "alert" : "status"}>
              {state.message}
            </p>
          )}

          {receipt && (
            <div className="dz-controlled-action-receipt" aria-label="Hermes verification receipt">
              <div className="dz-controlled-action-receipt-heading">
                <div>
                  <p className="dz-controlled-action-kicker">Hermes receipt</p>
                  <h3>{receipt.result === "SUCCEEDED" && receipt.verification.outcome === "VERIFIED" ? "Action verified" : "Action not verified"}</h3>
                </div>
                <span>{receipt.verification.outcome.replace(/_/g, " ")}</span>
              </div>
              <dl>
                <div><dt>Outcome</dt><dd>{receipt.side_effect_summary}</dd></div>
                <div><dt>Verified by</dt><dd>Hermes bounded driver · {receipt.verification.predicate}</dd></div>
                <div><dt>Resolved target</dt><dd>{receipt.resolved_target.fixed_title} · {humanTarget(receipt.resolved_target.semantic_target)}</dd></div>
                <div><dt>Duration</dt><dd>{receipt.timestamps.duration_ms.toLocaleString()} ms</dd></div>
              </dl>
            </div>
          )}
        </>
      )}

      <ol className="dz-controlled-action-lifecycle" aria-label="Controlled action lifecycle">
        <li>User request</li>
        <li>Hermes proposal</li>
        <li>Approve once or deny</li>
        <li>Hermes enforcement</li>
        <li>Bounded execution</li>
        <li>Verification</li>
        <li>Receipt</li>
      </ol>

      <p className="dz-placeholder-note">
        Yuzuki presents the request and evidence. Hermes remains the authority, executor, and verification owner.
      </p>
    </section>
  );
}
