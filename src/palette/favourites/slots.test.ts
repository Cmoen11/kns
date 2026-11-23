import { describe, expect, it } from "vitest";
import type { NsSlot, Slot } from "../../types";
import {
  findByName, moveSlot, nextFreeSlot, normalizeNsSlots, noteNamespace, nsSlotOf, occupant, parseSlot, togglePin, touchRecent, upsert,
} from "./slots";

const fav = (id: string, slot?: number) => (slot ? { id, name: id, slot: slot as Slot } : { id, name: id });
const slotsOf = (items: { id: string; slot?: Slot }[]) => Object.fromEntries(items.map((i) => [i.id, i.slot]));

describe("favourite slots", () => {
  it("parseSlot accepts 1..9 only", () => {
    expect(parseSlot("3")).toBe(3);
    expect(parseSlot(" 9 ")).toBe(9);
    expect(parseSlot("0")).toBeUndefined();
    expect(parseSlot("10")).toBeUndefined();
    expect(parseSlot("x")).toBeUndefined();
    expect(parseSlot(undefined)).toBeUndefined();
  });

  it("nextFreeSlot is the lowest free number, or undefined when full", () => {
    expect(nextFreeSlot([])).toBe(1);
    expect(nextFreeSlot([fav("a", 1), fav("b", 3), fav("c")])).toBe(2);
    expect(nextFreeSlot([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => fav(`f${n}`, n)))).toBeUndefined();
  });

  it("upsert onto an occupied slot leaves the old occupant in the list without a slot", () => {
    const out = upsert([fav("warnings", 3), fav("b", 1)], fav("new", 3));
    expect(slotsOf(out)).toEqual({ warnings: undefined, b: 1, new: 3 });
    expect("slot" in out[0]).toBe(false);
  });

  it("upsert replaces an item with the same id in place", () => {
    const out = upsert([fav("a", 1), fav("b", 2)], { ...fav("a", 2), name: "renamed" });
    expect(out.map((i) => i.id)).toEqual(["a", "b"]);
    expect(out[0].name).toBe("renamed");
    expect(slotsOf(out)).toEqual({ a: 2, b: undefined });
  });

  it("occupant finds who holds a slot", () => {
    const items = [fav("a", 1), fav("b", 2)];
    expect(occupant(items, 2)?.id).toBe("b");
    expect(occupant(items, 2, "b")).toBeUndefined();
    expect(occupant(items, undefined)).toBeUndefined();
  });

  it("moveSlot moves to a free neighbour and swaps with an occupied one", () => {
    const items = [fav("a", 1), fav("b", 2), fav("c", 5)];
    expect(slotsOf(moveSlot(items, "c", -1))).toEqual({ a: 1, b: 2, c: 4 });
    expect(slotsOf(moveSlot(items, "b", -1))).toEqual({ a: 2, b: 1, c: 5 });
    expect(slotsOf(moveSlot(items, "a", 1))).toEqual({ a: 2, b: 1, c: 5 });
  });

  it("moveSlot does not wrap and gives an unslotted item a free slot", () => {
    const items = [fav("a", 1), fav("z", 9), fav("n")];
    expect(moveSlot(items, "a", -1)).toBe(items);
    expect(moveSlot(items, "z", 1)).toBe(items);
    expect(slotsOf(moveSlot(items, "n", -1))).toEqual({ a: 1, z: 9, n: 2 });
    expect(slotsOf(moveSlot(items, "n", 1))).toEqual({ a: 1, z: 9, n: 8 });
    expect(moveSlot(items, "missing", 1)).toBe(items);
  });

  it("findByName prefers the exact case", () => {
    const items = [{ id: "1", name: "Web" }, { id: "2", name: "web" }];
    expect(findByName(items, "web")?.id).toBe("2");
    expect(findByName(items, "WEB")?.id).toBe("1");
    expect(findByName(items, "nope")).toBeUndefined();
  });
});

const names = (slots: NsSlot[]) => slots.map((s) => (s ? (s.pinned ? `${s.name}!` : s.name) : "-")).join(" ");
const full = (pinned: number[] = []): NsSlot[] => [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ name: `ns${n}`, pinned: pinned.includes(n) }));

describe("namespace slots (§8.1)", () => {
  it("normalizes to nine entries and drops duplicates", () => {
    const out = normalizeNsSlots([{ name: "a", pinned: true }, { name: "a", pinned: false }]);
    expect(out).toHaveLength(9);
    expect(names(out)).toBe("a! - - - - - - - -");
    expect(normalizeNsSlots(undefined).every((s) => s === null)).toBe(true);
  });

  it("a new namespace fills the lowest free slot and then stays", () => {
    let s = noteNamespace([], [], "web");
    s = noteNamespace(s, ["web"], "db");
    expect(names(s)).toBe("web db - - - - - - -");
    // used again: nothing moves
    expect(names(noteNamespace(s, ["db", "web"], "web"))).toBe("web db - - - - - - -");
    expect(nsSlotOf(s, "db")).toBe(2);
    expect(nsSlotOf(s, "nope")).toBe(0);
  });

  it("fills a hole left in the middle, lowest number first", () => {
    const s = normalizeNsSlots([{ name: "a", pinned: false }, null, { name: "c", pinned: false }]);
    expect(names(noteNamespace(s, [], "x"))).toBe("a x c - - - - - -");
  });

  it("all namespaces and the empty name never take a slot", () => {
    expect(names(noteNamespace([], [], "*"))).toBe("- - - - - - - - -");
    expect(names(noteNamespace([], [], ""))).toBe("- - - - - - - - -");
  });

  it("when full, replaces the least recently used unpinned slot in place; no other number moves", () => {
    // ns4 is the least recent of the unpinned ones; ns9 is older still but pinned
    const recent = ["ns1", "ns2", "ns3", "ns5", "ns6", "ns7", "ns8", "ns4", "ns9"];
    const out = noteNamespace(full([9]), recent, "new");
    expect(names(out)).toBe("ns1 ns2 ns3 new ns5 ns6 ns7 ns8 ns9!");
  });

  it("a slot that was never used counts as the oldest", () => {
    const out = noteNamespace(full(), ["ns1", "ns2", "ns3", "ns4", "ns5", "ns6", "ns8", "ns9"], "new");
    expect(names(out)).toBe("ns1 ns2 ns3 ns4 ns5 ns6 new ns8 ns9");
  });

  it("does nothing when every slot is pinned", () => {
    const all = full([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(noteNamespace(all, [], "new")).toEqual(all);
  });

  it("togglePin pins and unpins a slot, and gives an unslotted namespace a pinned slot", () => {
    let s = noteNamespace([], [], "web");
    s = togglePin(s, [], "web");
    expect(names(s)).toBe("web! - - - - - - - -");
    s = togglePin(s, [], "web");
    expect(names(s)).toBe("web - - - - - - - -");
    s = togglePin(s, [], "db");
    expect(names(s)).toBe("web db! - - - - - - -");
    expect(togglePin(s, [], "*")).toEqual(s);
  });

  it("touchRecent moves the name to the front without duplicates", () => {
    expect(touchRecent(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
    expect(touchRecent(["a", "b"], "x", 2)).toEqual(["x", "a"]);
  });
});
