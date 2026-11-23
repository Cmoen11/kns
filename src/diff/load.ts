// Fetches what each diff side shows (lazy, with the view). Revisions of one owner are fetched once
// per load, so `:diff prev` costs one list call.
import { backend, toObjRef } from "../foundation";
import type { Revision } from "../ipc/types";
import type { DiffSide, ObjectRef } from "../types";
import { APPLIED, isSecretGvr } from "./args";
import type { SideData } from "./model";

/** One salt per diff: Rust masks Secret values as salted digests, comparable only inside this diff. */
function diffSalt(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export async function loadSides(left: DiffSide, right: DiffSide, context: string): Promise<[SideData, SideData]> {
  const salt = diffSalt();
  // a Secret never comes to the webview with its values (§6.6 e): Rust masks them
  const fetch = (ref: ObjectRef) => (isSecretGvr(ref.gvr) ? backend.getJsonMasked(toObjRef(ref, context), salt) : backend.getJson(toObjRef(ref, context)));
  const revs = new Map<string, Promise<Revision[]>>();
  const revisionsOf = (owner: ObjectRef): Promise<Revision[]> => {
    const key = `${owner.gvr.group}/${owner.gvr.resource}/${owner.namespace ?? ""}/${owner.name}`;
    let p = revs.get(key);
    if (!p) revs.set(key, (p = backend.revisions(toObjRef(owner, context))));
    return p;
  };
  const one = async (s: DiffSide): Promise<SideData> => {
    if ("ref" in s) return { by: "object", ref: s.ref, obj: await fetch(s.ref) };
    const { owner, id } = s.revision;
    if (id === APPLIED) return { by: "applied", owner, live: await fetch(owner) };
    const rev = (await revisionsOf(owner)).find((r) => r.id === id);
    if (!rev) throw `Revision ${id} of ${owner.name} no longer exists`;
    return { by: "revision", owner, rev };
  };
  return Promise.all([one(left), one(right)]);
}
