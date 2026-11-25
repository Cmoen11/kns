# Organisation catalog

kns can read an optional catalog of your organisation: which teams own which systems, the namespace a system has, the repositories behind its workloads and which kube context is which environment. kns knows no organisation; the catalog is a file you export from wherever that knowledge lives (a Backstage instance, an internal repository of team and system definitions, a hand-written file).

Without a catalog nothing changes.

## What it gives you

- **Team members on shared clusters.** A user whose RBAC grants a few namespaces cannot list namespaces or anything across all of them. With a catalog:
  - the namespace picker, the context sidebar and `:ns` completion offer the team's namespaces (and the ones you used), not an empty list;
  - an "all namespaces" table shows one table over the team's namespaces (one watch per namespace, at most 40, merged in Rust);
  - namespace health (badges, `:faults`) watches the team's namespaces instead of turning "unknown".
  Without a catalog the same fallbacks use the namespaces you used in that context.
- **Namespace rows say what they are.** The system's title and the owning team, a `TEAM` label on your team's namespaces, and a search that finds a namespace by system or team name.
- **System section in the context sidebar** for the focused namespace: description, owning team with its links (chat channel, wiki), the system's repositories (Enter or `o` opens them), the Secrets the namespace is expected to have.
- **Environments.** `:env prod` moves the focused pane to the context that is `prod` in the catalog, same view and namespace; it refuses when the system does not run there. A context the catalog calls production is protected once (Settings can turn that off; kns does not turn it on again).

## Commands and settings

| | |
|---|---|
| `:catalog` / `:catalog choose` | choose the catalog file (a native dialog) |
| `:catalog reload` | read it again (after you exported a new one) |
| `:catalog forget` | forget the file (the file is left alone) |
| `:catalog me <email or user name>` | who you are; your teams come from the catalog |
| `:catalog show` | what is loaded |
| `:team <team,...>` / `:team -` | scope to other teams / back to your own |
| `:env <env>` | the focused pane in another environment |

Settings > Catalog shows the file, you, the team scope and its errors.

## The file

A multi-document YAML (or JSON) stream of [Backstage](https://backstage.io/docs/features/software-catalog/descriptor-format) entities, `apiVersion: backstage.io/v1alpha1`. kns reads five kinds and ignores the rest; names in `owner`, `system`, `members` and `memberOf` may be entity refs (`group:default/shop`) or bare names.

```yaml
apiVersion: backstage.io/v1alpha1
kind: Group
metadata:
  name: webshop
  title: Webshop
  links: [{ url: https://chat.example.com/team-webshop, title: "#team-webshop" }]
spec: { type: team, children: [], members: [ada] }
---
apiVersion: backstage.io/v1alpha1
kind: User
metadata: { name: ada }
spec: { profile: { email: ada@example.com }, memberOf: [webshop] }
---
apiVersion: backstage.io/v1alpha1
kind: System
metadata:
  name: shop
  title: Shop
  description: The shop front and its order API
  annotations:
    kns.dev/namespace: shop               # its namespace (in every environment)
    kns.dev/environments: test,prod       # where it runs; absent = everywhere
    kns.dev/expected-secrets: kafka-credentials
spec: { owner: group:webshop }
---
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: shop-orders
  annotations:
    github.com/project-slug: example/shop-orders
    kns.dev/workloads: shop-orders        # workload names it deploys
spec: { type: service, lifecycle: production, owner: group:webshop, system: shop }
---
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: shop-ops
  annotations:
    github.com/project-slug: example/shop-ops
    kns.dev/gitops: argocd                # an ops (GitOps) repository
    kns.dev/gitops-image-file: "{app}/eks-{env}/image.yaml"
    kns.dev/gitops-app-prefix: shop-
spec: { type: gitops, lifecycle: production, owner: group:webshop, system: shop }
---
apiVersion: backstage.io/v1alpha1
kind: Resource
metadata:
  name: eks-prod
  annotations:
    kns.dev/environment: prod
    kns.dev/context-match: eks-prod       # in a context's name or cluster (as a whole word)
    kns.dev/protected: "true"
    kns.dev/team-label: tags.datadoghq.com/team
    kns.dev/system-label: tags.datadoghq.com/system
spec: { type: kubernetes-cluster, owner: group:platform }
```

A component behind a workload is the one that lists it in `kns.dev/workloads`, else the one whose name is the workload's name or its longest dash-prefix.

## Security

- The window never sends a path. Rust opens the file dialog, reads the file and keeps its path in `<config>/catalog-source.path`, which `save_state` cannot write.
- Errors name the file and the line, never its contents.
- Only `http(s)` links are kept, and Rust opens only links that are in the loaded catalog (and the GitHub page of its repositories).
- The catalog may list colleagues' email addresses. It stays on your machine; kns sends it nowhere.
