import { describe, expect, it } from "vitest";
import {
  applyBudgetEvent,
  asIdleSeconds,
  asTokenCount,
  asWallClockMs,
  checkBudget,
  DEFAULT_BUDGET_CONFIG,
  decodeBudgetConfigFromEnv,
  initialBudgetState,
  retireScopeFor,
  type BudgetConfig,
} from "../src/orchestrator/budget.ts";
import { absurd, asAoSessionName } from "../src/types.ts";

const S = (name: string) => asAoSessionName(name);

function makeConfig(partial: Partial<BudgetConfig> = {}): BudgetConfig {
  return {
    sessionIdleSeconds: asIdleSeconds(60),
    rosterBudgetTokens: asTokenCount(1000),
    declaredMemberCount: 2,
    ...partial,
  };
}

describe("budget.decodeBudgetConfigFromEnv", () => {
  it("returns defaults when env is empty", () => {
    const res = decodeBudgetConfigFromEnv({}, 3);
    expect(res._tag).toBe("Ok");
    if (res._tag !== "Ok") return;
    expect(res.value.sessionIdleSeconds).toBe(
      DEFAULT_BUDGET_CONFIG.sessionIdleSeconds,
    );
    expect(res.value.rosterBudgetTokens).toBe(
      DEFAULT_BUDGET_CONFIG.rosterBudgetTokens,
    );
    expect(res.value.declaredMemberCount).toBe(3);
  });

  it("parses valid env overrides", () => {
    const res = decodeBudgetConfigFromEnv(
      {
        MOLTZAP_SESSION_IDLE_SECONDS: "120",
        MOLTZAP_ROSTER_BUDGET_TOKENS: "2000000",
      },
      4,
    );
    expect(res._tag).toBe("Ok");
    if (res._tag !== "Ok") return;
    expect(res.value.sessionIdleSeconds).toBe(120);
    expect(res.value.rosterBudgetTokens).toBe(2000000);
  });

  it("rejects invalid idle seconds (non-numeric)", () => {
    const res = decodeBudgetConfigFromEnv(
      { MOLTZAP_SESSION_IDLE_SECONDS: "abc" },
      2,
    );
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("InvalidIdleSeconds");
  });

  it("rejects invalid idle seconds (zero)", () => {
    const res = decodeBudgetConfigFromEnv(
      { MOLTZAP_SESSION_IDLE_SECONDS: "0" },
      2,
    );
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("InvalidIdleSeconds");
  });

  it("rejects invalid roster tokens (negative)", () => {
    const res = decodeBudgetConfigFromEnv(
      { MOLTZAP_ROSTER_BUDGET_TOKENS: "-5" },
      2,
    );
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("InvalidRosterTokens");
  });

  it("rejects invalid member count (zero)", () => {
    const res = decodeBudgetConfigFromEnv({}, 0);
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("InvalidMemberCount");
  });

  it("rejects invalid member count (non-integer)", () => {
    const res = decodeBudgetConfigFromEnv({}, 1.5);
    expect(res._tag).toBe("Err");
  });
});

describe("budget state machine", () => {
  it("fresh state at WithinBudget", () => {
    const cfg = makeConfig();
    const s = initialBudgetState(cfg, [S("a"), S("b")], asWallClockMs(1000));
    expect(checkBudget(s, asWallClockMs(1000))._tag).toBe("WithinBudget");
  });

  it("trips IdleTimeoutTripped after sessionIdleSeconds on a session with no peer events", () => {
    const cfg = makeConfig({ sessionIdleSeconds: asIdleSeconds(10) });
    const s0 = initialBudgetState(cfg, [S("a"), S("b")], asWallClockMs(0));
    const verdict = checkBudget(s0, asWallClockMs(10_000));
    expect(verdict._tag).toBe("IdleTimeoutTripped");
    if (verdict._tag !== "IdleTimeoutTripped") return;
    expect(verdict.idleForMs).toBe(10_000);
  });

  it("PeerMessageObserved resets idle clock for that session only", () => {
    const cfg = makeConfig({ sessionIdleSeconds: asIdleSeconds(10) });
    const s0 = initialBudgetState(cfg, [S("a"), S("b")], asWallClockMs(0));
    const s1 = applyBudgetEvent(s0, {
      _tag: "PeerMessageObserved",
      session: S("a"),
      atMs: asWallClockMs(9_000),
    });
    // At t=10_001ms, a is idle for 1001ms (not yet tripped), b is idle for 10001ms
    const verdict = checkBudget(s1, asWallClockMs(10_001));
    expect(verdict._tag).toBe("IdleTimeoutTripped");
    if (verdict._tag !== "IdleTimeoutTripped") return;
    expect(verdict.session).toBe(S("b"));
  });

  it("TokensConsumed accumulates per roster and trips RosterTokenBudgetTripped", () => {
    const cfg = makeConfig({ rosterBudgetTokens: asTokenCount(100) });
    let s = initialBudgetState(cfg, [S("a"), S("b")], asWallClockMs(0));
    s = applyBudgetEvent(s, {
      _tag: "TokensConsumed",
      session: S("a"),
      tokens: asTokenCount(60),
    });
    s = applyBudgetEvent(s, {
      _tag: "TokensConsumed",
      session: S("b"),
      tokens: asTokenCount(50),
    });
    const verdict = checkBudget(s, asWallClockMs(0));
    expect(verdict._tag).toBe("RosterTokenBudgetTripped");
    if (verdict._tag !== "RosterTokenBudgetTripped") return;
    expect(verdict.consumedTokens).toBe(110);
    expect(verdict.ceilingTokens).toBe(100);
  });

  it("MemberRetired freezes session — no further idle trips for it", () => {
    const cfg = makeConfig({ sessionIdleSeconds: asIdleSeconds(10) });
    let s = initialBudgetState(cfg, [S("a"), S("b")], asWallClockMs(0));
    s = applyBudgetEvent(s, {
      _tag: "MemberRetired",
      session: S("a"),
      atMs: asWallClockMs(5_000),
    });
    // Reset b to stay within budget.
    s = applyBudgetEvent(s, {
      _tag: "PeerMessageObserved",
      session: S("b"),
      atMs: asWallClockMs(10_000),
    });
    const verdict = checkBudget(s, asWallClockMs(11_000));
    expect(verdict._tag).toBe("WithinBudget");
  });

  it("Unknown session events are no-ops", () => {
    const cfg = makeConfig();
    const s = initialBudgetState(cfg, [S("a")], asWallClockMs(0));
    const s1 = applyBudgetEvent(s, {
      _tag: "TokensConsumed",
      session: S("ghost"),
      tokens: asTokenCount(9999),
    });
    expect(checkBudget(s1, asWallClockMs(0))._tag).toBe("WithinBudget");
  });

  it("applyBudgetEvent is exhaustive (compile-time via absurd in impl)", () => {
    // Sanity: every event tag produces a defined BudgetState.
    const cfg = makeConfig();
    let s = initialBudgetState(cfg, [S("a")], asWallClockMs(0));
    s = applyBudgetEvent(s, {
      _tag: "PeerMessageObserved",
      session: S("a"),
      atMs: asWallClockMs(1),
    });
    s = applyBudgetEvent(s, {
      _tag: "TokensConsumed",
      session: S("a"),
      tokens: asTokenCount(1),
    });
    s = applyBudgetEvent(s, {
      _tag: "MemberRetired",
      session: S("a"),
      atMs: asWallClockMs(2),
    });
    expect(s).toBeTruthy();
  });
});

describe("budget.retireScopeFor", () => {
  it("narrows WithinBudget to None", () => {
    expect(retireScopeFor({ _tag: "WithinBudget" })).toEqual({
      _tag: "None",
      session: null,
    });
  });

  it("narrows IdleTimeoutTripped to RetireMember", () => {
    expect(
      retireScopeFor({
        _tag: "IdleTimeoutTripped",
        session: S("a"),
        idleForMs: 1000,
      }),
    ).toEqual({ _tag: "RetireMember", session: S("a") });
  });

  it("narrows RosterTokenBudgetTripped to RetireRoster", () => {
    expect(
      retireScopeFor({
        _tag: "RosterTokenBudgetTripped",
        consumedTokens: asTokenCount(2000),
        ceilingTokens: asTokenCount(1000),
      }),
    ).toEqual({ _tag: "RetireRoster", session: null });
  });

  it("is exhaustive over the BudgetVerdict union", () => {
    // Compile-time exhaustiveness is enforced inside retireScopeFor via
    // absurd. This test documents the contract.
    const verdicts = [
      { _tag: "WithinBudget" as const },
      {
        _tag: "IdleTimeoutTripped" as const,
        session: S("x"),
        idleForMs: 0,
      },
      {
        _tag: "RosterTokenBudgetTripped" as const,
        consumedTokens: asTokenCount(1),
        ceilingTokens: asTokenCount(1),
      },
    ];
    for (const v of verdicts) {
      const r = retireScopeFor(v);
      expect(["None", "RetireMember", "RetireRoster"]).toContain(r._tag);
    }
    // Exercise absurd on the `never` branch of the switch — by construction,
    // we can't hit this without casting. The following is purely illustrative.
    void absurd;
  });
});
