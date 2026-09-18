import { useState } from "react";
import {
  type CuaFixtureRequest,
  type CuaFixtureState,
} from "../lib/hermesApi";
import type { ActivityEntry } from "./types";
import { StatusBadge } from "./StatusBadge";

type Props = {
  onActivity: (entry: Omit<ActivityEntry, "id" | "at">) => void;
  fixtureId: string | null;
  observedState: CuaFixtureState | null;
  running: boolean;
  error: string | null;
  onRun: (request: CuaFixtureRequest) => void;
};

export function CuaFixtureLab({ onActivity, fixtureId, observedState, running, error, onRun }: Props) {
  const [text, setText] = useState("fixture text");

  const expected = observedState
    ? { counter: observedState.counter, revision: observedState.revision, echo_sha256: observedState.echo_sha256 }
    : undefined;
  const bound = fixtureId !== null;

  function run(request: CuaFixtureRequest) {
    onActivity({ title: "CUA fixture requested", detail: `${request.operation} ${request.target}`, tag: "designed" });
    onRun(request);
  }

  return (
    <section className="dz-cua-lab" aria-labelledby="cua-lab-title">
      <StatusBadge status="DESIGNED / APPROVAL-BASED" />
      <h2 id="cua-lab-title">Bounded CUA Fixture Lab</h2>
      <p>
        Developer fixture only. Hermes owns targeting, approval, execution, verification, and receipts.
        General desktop control is not available.
      </p>
      <p className="dz-placeholder-note">
        Action proposals, decisions, execution status, and the human-readable receipt appear in Review.
      </p>
      <div className="dz-cua-controls" aria-label="Fixture actions">
        <button type="button" disabled={running} onClick={() => run({ operation: "OBSERVE", target: "FIXTURE_WINDOW" })}>
          Observe
        </button>
        <button type="button" disabled={!bound || running} onClick={() => run({ fixture_id: fixtureId!, operation: "FOCUS_TARGET", target: "FIXTURE_WINDOW" })}>
          Focus
        </button>
        <button type="button" disabled={!bound || running} onClick={() => run({ fixture_id: fixtureId!, operation: "CLICK_TARGET", target: "INCREMENT_BUTTON" })}>
          Increment
        </button>
        <label>
          Safe fixture text
          <input value={text} maxLength={64} onChange={(event) => setText(event.target.value)} />
        </label>
        <button type="button" disabled={!bound || running || !text} onClick={() => run({ fixture_id: fixtureId!, operation: "TYPE_IN_APPROVED_FIXTURE", target: "TEXT_INPUT", input: text })}>
          Type
        </button>
        <button type="button" disabled={!bound || running || !expected} onClick={() => run({ fixture_id: fixtureId!, operation: "WAIT_FOR_STATE", target: "STATE_SUMMARY", expected })}>
          Wait
        </button>
        <button type="button" disabled={!bound || running || !expected} onClick={() => run({ fixture_id: fixtureId!, operation: "VERIFY_STATE", target: "STATE_SUMMARY", expected })}>
          Verify
        </button>
      </div>

      {running && <p className="dz-placeholder-note" role="status">Waiting for Hermes…</p>}
      {observedState && <pre className="dz-cua-state">{JSON.stringify(observedState, null, 2)}</pre>}
      {error && <p className="dz-placeholder-note" role="alert">{error}</p>}
      <p className="dz-placeholder-note">
        Evidence is held only in this component state. It is not added to chat, SessionDB, memory, skills, or project context.
      </p>
    </section>
  );
}
