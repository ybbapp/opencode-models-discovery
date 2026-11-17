# Model unavailable during plugin loading: investigation

Status: reproduced with `@ybbapp/opencode-models-discovery@2.1.3`. An initial-publication mitigation is implemented on this PR branch, but an isolated real-host test still reproduces a model-resolution failure before plugin setup settles. This is not a complete fix.

## Observed failure

A real OpenCode session using `sub2api/deepseek-v4-1-flash-261017` failed while starting a subsequent turn. The error originated in `SessionRunnerModel.select`, through `SessionContext.load` and `SessionRunner.drain`:

```text
SessionRunnerModel.ModelUnavailableError:
Model unavailable: sub2api/deepseek-v4-1-flash-261017
```

Selected server log events on November 17, 2026 (UTC):

| Time | Event |
|---|---|
| 08:59:24.541 | Loading the npm package's `2.1.3` server entrypoint |
| 08:59:24.660 | `model.updated` for the affected project location |
| 08:59:24.694 | Another `model.updated` for that location |
| 08:59:24.709 | Session model selection fails with `ModelUnavailableError` |
| 08:59:25.399 | A subsequent `model.updated` for that location |

A later model-directory query at the affected location returned 249 models, including the exact provider/model ID from the error. Events do not include model snapshots, so they cannot establish precisely when the target disappeared or reappeared. The loading event establishes that the new package was involved; it does not establish that its setup had finished when the session selected the model. The trigger for loading is not established by these selected events.

The stack identifies failure in local session model resolution. It does not show an upstream inference endpoint rejecting the model. Matching a models.dev metadata alias is a separate operation and cannot on its own make a model available in the host catalog.

## Why the successful concurrency test is insufficient

Before this failure, three terminal clients refreshed different project locations concurrently, then three clients refreshed the same location concurrently. Each issued five forced refreshes while two readers per client queried the model directory. All 30 refreshes and 246 reads succeeded; the target remained present and each snapshot contained 249 models.

Those clients exercised already initialized plugin instances. They did not reproduce plugin initialization, session selection during loading, configuration reload, or a provider failure. Directory reads also do not exercise the session runner's own model snapshot or readiness behavior. Therefore the successful checks do not contradict the real session failure.

## Code paths that need investigation

1. `setupV2` creates a new provider array and controller for each setup. `createProviderController` initializes its inventory with an empty `Map` (`src/v2/index.ts`, `src/v2/catalog.ts`). The previous-inventory fallback only accesses that controller's current inventory; it does not recover inventory from an earlier plugin instance.
2. `syncConfiguredProviders` registers provider and integration transforms before the initial `discoverInventory` call has completed. Registration also invokes `integration.reload`. A transform invoked with an empty inventory cannot inject discovered models. Whether the host publishes such a snapshot before setup settles requires host-level verification.
3. Cache reads, when enabled, happen inside asynchronous discovery after transform registration (`src/v2/discovery.ts`). A persistent cache is not synchronously restored before registration. A warm cache can shorten a window, but is not itself a readiness barrier.
4. `activeRefresh` serializes refresh calls within one setup instance. It does not coordinate initialization across plugin instances or gate the host session runner.
5. Configuration and credential events explicitly reload the provider registry before discovery. This differs from normal refresh, which defers the reload. It is another lifecycle path to test; the observed logs do not establish that this branch caused this incident.

The leading hypothesis is a lifecycle readiness race: session selection can observe a catalog without the discovered model while plugin initialization or replacement is still in progress. The current evidence does not distinguish a host readiness gap, a stale session snapshot, or a provider-catalog replacement issue. It also does not prove which operation triggered the loading window.

## Regression and fix acceptance plan

- Start with a successfully discovered model, then recreate the plugin context while a discovery response is deliberately delayed. Query the affected location and attempt harmless session model resolution before releasing that response.
- Cover the first initialization separately from reinitialization, with cache disabled, fresh cache, expired cache, and a failed provider response.
- Repeat with the same project location and different project locations, concurrent normal/forced refresh, and config/credential events. Record the location used by session resolution and catalog queries.
- Capture model snapshots or instrumentation at transform registration, inventory replacement, provider reload, setup completion, and session selection. `model.updated` alone is not sufficient evidence of target availability.
- Verify the host's contract for awaiting plugin setup before selecting a session model. A unit mock where `provider.reload` is a no-op cannot verify that contract.
- A fix must ensure either a valid previous snapshot remains usable or session resolution waits for the relevant initial catalog. Avoid retaining models across unrelated provider credentials or locations, and preserve intentional removal/filter semantics.

## Implementation and test results

The initial-publication change removes eager transform registration from setup and provider synchronization. `replaceInventory` installs the discovered, overridden snapshot before registering transforms and performing the provider reload. This prevents registration from publishing this controller's empty initial inventory while its first discovery request is pending. Subsequent refreshes continue to use the existing registered transforms and previous inventory.

A delayed-response unit regression failed against the previous code because provider transforms were registered before the discovery response arrived. With the change, no provider/integration transform or integration reload is issued by this setup while the response is pending; the first provider transform sees `stable-model`. The full build passes 355 tests across 43 test files, type checking, and compilation, with the existing 20 lint warnings.

### Remaining host readiness gap

An independent OpenCode service was launched with temporary XDG/config paths, this branch's compiled local plugin, a loopback mock provider, and discovery caching disabled. The mock `/v1/models` response was delayed by 1.5 seconds. No user provider credentials or production inference endpoint was used.

With the initial-publication change applied:

1. During the pending discovery response, the host's model-list API returned HTTP 200 with 13 built-in models, without `local/stable-model`.
2. The plugin's status RPC was already callable and reported zero discovered models.
3. A valid `POST /api/experimental/generate/text` specifying `{ "providerID": "local", "id": "stable-model" }` returned HTTP 404 with `ModelNotFoundError: Model not found: local/stable-model`.
4. After discovery completed, the catalog contained 14 models, including `stable-model`.

The standalone generation endpoint is a real host model-resolution probe, not the original session-runner path. It demonstrates that the host serves model-resolution requests before plugin setup finishes; it does not by itself prove the same readiness contract applies to every session hook. Deferring transform registration is insufficient to eliminate this window.

### Next fix steps

- Verify whether the session `prompt` hook executes before model selection, including restored inbox turns. If it does, assess a setup-readiness gate scoped to this plugin context; a hook registered after the host has already dispatched the turn cannot protect it.
- Inspect the host's session/model readiness contract and determine whether model resolution must await relevant plugin setup. An async provider transform is not supported by the current plugin SDK.
- Keep the first-publication regression, then add a host-level regression asserting a session request waits rather than fails while initial discovery is delayed. Include plugin reinitialization and restored sessions, not just standalone generation.
- Validate any readiness gate against initialization failure, disposal, credential changes, and discovery timeouts so requests cannot wait indefinitely or receive another account's inventory.

A passing initialized-instance refresh test, the new unit regression, or the initial-publication mitigation must not be reported as proof that the lifecycle issue is resolved. Keep this PR in draft until the remaining readiness gap has an accepted resolution.
