// The deploys view, pure (docs/catalog.md): what every environment of a catalog system runs,
// from its ops repository (EnvImages, github.rs), set against the version label of the live
// workloads in the pane's context. One group per app, one row per environment. No store, no React.
import type { Catalog, CatalogComponent, CatalogSystem, EnvImage } from "../ipc/types";
import { componentOf, environments } from "./model";

/** Two tags name the same version: `v1.2.0` is `1.2.0`. */
export function sameVersion(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const bare = (s: string) => s.trim().replace(/^v(?=\d)/, "");
  return bare(a) === bare(b);
}

/** The environments of the images, in catalog order (test, stage, prod), then the rest by name. */
export function envOrder(catalog: Catalog | null, images: readonly EnvImage[]): string[] {
  const known = environments(catalog);
  const have = new Set(images.map((i) => i.env));
  const rest = [...have].filter((e) => !known.includes(e)).sort();
  return [...known.filter((e) => have.has(e)), ...rest];
}

/** The production environment: that of a protected catalog cluster, else one called `prod` or `production`. */
export function prodEnv(catalog: Catalog | null, envs: readonly string[]): string | undefined {
  const protectedEnv = catalog?.clusters.find((c) => c.protected && c.environment && envs.includes(c.environment))?.environment;
  return protectedEnv ?? envs.find((e) => e === "prod" || e === "production");
}

/**
 * The app repository behind an app: the component the image is named after (the last segment of
 * `image.name`, as a component or repository name), else the one behind its workload (componentOf).
 * GitOps components are never it.
 */
export function appComponent(system: CatalogSystem, imageName: string | undefined, workload: string): CatalogComponent | undefined {
  const apps = system.components.filter((c) => !c.gitops);
  const last = imageName?.split(":")[0].split("/").pop()?.toLowerCase();
  if (last) {
    const hit = apps.find((c) => c.name.toLowerCase() === last) ?? apps.find((c) => c.repo?.toLowerCase().split("/")[1] === last);
    if (hit) return hit;
  }
  const c = componentOf(system, workload);
  return c && !c.gitops ? c : undefined;
}

/** What `changes` and the compare page are opened for. */
export interface CompareTarget {
  repo: string;
  base: string;
  head: string;
  /** "prod 1.4.0 → test 1.5.0" */
  label: string;
}

export interface DeployRow {
  app: string;
  env: string;
  /** the file in the ops repository */
  path: string;
  tag?: string;
  imageName?: string;
  error?: string;
  /** the pane's context is this environment: `live` is read */
  here: boolean;
  /** the version label of the live workload; undefined = not known (not here, not synced, no label) */
  live?: string;
  /** here, synced, and no workload of that name in the namespace */
  missing: boolean;
  /** live and tag differ */
  drift: boolean;
  /** the newest environment's tag, when this row (production) is behind it */
  behind?: { env: string; tag: string };
  compare?: CompareTarget;
}

export interface DeployGroup {
  app: string;
  /** `<appPrefix><app>` */
  workload: string;
  component?: CatalogComponent;
  rows: DeployRow[];
}

export interface DeploysInput {
  catalog: Catalog | null;
  system: CatalogSystem;
  images: readonly EnvImage[];
  /** a workload is `<appPrefix><app>` */
  appPrefix?: string;
  /** the environment of the pane's context */
  paneEnv?: string;
  /** the live deployments of the namespace: name -> version label value (empty string: no label); null = not known */
  live: ReadonlyMap<string, string> | null;
}

/** One group per app (sorted), one row per environment (catalog order). */
export function deployGroups(input: DeploysInput): DeployGroup[] {
  const { catalog, system, images, appPrefix, paneEnv, live } = input;
  const order = envOrder(catalog, images);
  const prod = prodEnv(catalog, order);
  const byApp = new Map<string, EnvImage[]>();
  for (const i of images) byApp.set(i.app, [...(byApp.get(i.app) ?? []), i]);
  const out: DeployGroup[] = [];
  for (const app of [...byApp.keys()].sort()) {
    const list = [...byApp.get(app)!].sort((a, b) => order.indexOf(a.env) - order.indexOf(b.env));
    const workload = `${appPrefix ?? ""}${app}`;
    const component = appComponent(system, list.find((i) => i.name)?.name, workload);
    const prodTag = list.find((i) => i.env === prod)?.tag;
    // the newest: the first environment before production that has a tag (test)
    const newest = list.find((i) => i.env !== prod && i.tag);
    const rows = list.map((i): DeployRow => {
      const here = !!paneEnv && i.env === paneEnv;
      const value = here && live ? live.get(workload) : undefined;
      const liveVersion = value || undefined;
      const head = i.env === prod ? newest : i;
      const compare =
        component?.repo && prodTag && head?.tag && !sameVersion(prodTag, head.tag)
          ? { repo: component.repo, base: prodTag, head: head.tag, label: `${prod} ${prodTag} → ${head.env} ${head.tag}` }
          : undefined;
      return {
        app,
        env: i.env,
        path: i.path,
        tag: i.tag,
        imageName: i.name,
        error: i.error,
        here,
        live: liveVersion,
        missing: here && !!live && !live.has(workload),
        drift: !!liveVersion && !!i.tag && !sameVersion(liveVersion, i.tag),
        behind: i.env === prod && newest?.tag && i.tag && !sameVersion(newest.tag, i.tag) ? { env: newest.env, tag: newest.tag } : undefined,
        compare,
      };
    });
    out.push({ app, workload, component, rows });
  }
  return out;
}

/** The status cell of a row: what is live here, why there is no tag, or what production is behind. */
export function rowStatus(r: DeployRow, versionLabel: string | undefined): string {
  if (r.error) return r.error;
  if (r.here) {
    if (r.missing) return "not running here";
    if (r.drift) return `live ${r.live} ≠ ${r.tag}`;
    if (r.live) return "live";
    if (!versionLabel) return "live: no version label in the catalog";
  }
  if (r.behind) return `${r.behind.env} has ${r.behind.tag}`;
  return "";
}

/** The status glyph of a row. */
export function rowGlyph(r: DeployRow): "ok" | "warn" | "error" | undefined {
  if (r.error) return "error";
  if (r.drift || r.missing) return "warn";
  if (r.here && r.live) return "ok";
  return undefined;
}
