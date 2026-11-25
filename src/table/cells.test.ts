// Settings: Hide namespace prefix. The name column shows `api` for `companyadmin-api` in `companyadmin`.
import { describe, expect, it } from "vitest";
import type { Row } from "../ipc/types";
import { columnText, stripNamespace, type CellContext } from "./cells";
import type { ColSpec } from "./columns";

describe("stripNamespace", () => {
  it("drops a namespace prefix followed by a dash", () => {
    expect(stripNamespace("companyadmin-user-api-internal-skyss-747", "companyadmin")).toBe("user-api-internal-skyss-747");
  });

  it("keeps names without the prefix, the bare prefix, and rows without a namespace", () => {
    expect(stripNamespace("ticket-webstore-api", "companyadmin")).toBe("ticket-webstore-api");
    expect(stripNamespace("companyadminx-api", "companyadmin")).toBe("companyadminx-api");
    expect(stripNamespace("companyadmin-", "companyadmin")).toBe("companyadmin-");
    expect(stripNamespace("companyadmin", "companyadmin")).toBe("companyadmin");
    expect(stripNamespace("companyadmin-api", undefined)).toBe("companyadmin-api");
  });
});

describe("columnText with the prefix hidden", () => {
  const row = { uid: "1", name: "companyadmin-api-7f9", namespace: "companyadmin", cells: ["companyadmin-api-7f9", "Running"] } as unknown as Row;
  const name = { role: "name", source: { by: "cell", index: 0 } } as unknown as ColSpec;
  const status = { role: "other", source: { by: "cell", index: 1 } } as unknown as ColSpec;
  const ctx = (stripNs: boolean): CellContext => ({ nowMs: 0, metrics: null, statusOf: () => null, stripNs });

  it("changes only the name column, and only while the setting is on", () => {
    expect(columnText(row, name, ctx(true))).toBe("api-7f9");
    expect(columnText(row, name, ctx(false))).toBe("companyadmin-api-7f9");
    expect(columnText({ ...row, cells: ["x", "companyadmin-x"] } as unknown as Row, status, ctx(true))).toBe("companyadmin-x");
  });
});
