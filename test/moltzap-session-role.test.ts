import { describe, expect, it } from "vitest";
import {
  ALL_SESSION_ROLES,
  ALL_WORKER_ROLES,
  decodeSessionRole,
  isWorkerRole,
  type SessionRole,
} from "../src/moltzap/session-role.ts";
import { absurd } from "../src/types.ts";

describe("session-role", () => {
  it("decodes every known role", () => {
    for (const role of ALL_SESSION_ROLES) {
      const res = decodeSessionRole(role);
      expect(res).toEqual({ _tag: "Ok", value: role });
    }
  });

  it("rejects unknown roles with UnknownSessionRole tag", () => {
    const res = decodeSessionRole("captain");
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("UnknownSessionRole");
    expect(res.error.raw).toBe("captain");
  });

  it("rejects empty string", () => {
    const res = decodeSessionRole("");
    expect(res._tag).toBe("Err");
  });

  it("rejects non-string input defensively", () => {
    // Casting through unknown to simulate a caller that bypassed the
    // type system (e.g. JSON.parse returning a non-string).
    const res = decodeSessionRole(42 as unknown as string);
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("UnknownSessionRole");
  });

  it("isWorkerRole excludes orchestrator", () => {
    expect(isWorkerRole("orchestrator")).toBe(false);
    expect(isWorkerRole("architect")).toBe(true);
    expect(isWorkerRole("implementer")).toBe(true);
    expect(isWorkerRole("reviewer")).toBe(true);
  });

  it("ALL_WORKER_ROLES matches the Extract-derived union", () => {
    expect([...ALL_WORKER_ROLES].sort()).toEqual(
      ["architect", "implementer", "reviewer"].sort(),
    );
  });

  it("SessionRole switch compiles exhaustively", () => {
    const role: SessionRole = "reviewer";
    const label = ((): string => {
      switch (role) {
        case "orchestrator":
          return "O";
        case "architect":
          return "A";
        case "implementer":
          return "I";
        case "reviewer":
          return "R";
        default:
          return absurd(role);
      }
    })();
    expect(label).toBe("R");
  });
});
