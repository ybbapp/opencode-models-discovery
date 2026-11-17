# Model unavailable during plugin loading: investigation

Status: reproduced with `@ybbapp/opencode-models-discovery@2.1.3`. A last-successful-inventory snapshot is implemented on this PR branch, but an isolated real-host test still reproduces a model-resolution failure before provider configuration and plugin setup settle. This is not a complete fix.

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

## Current implementation: retain and restore successful inventory

The earlier deferred-registration approach is superseded. Transforms are registered with a locally restored successful snapshot before the network request starts; there is no discovery-readiness gate or sleep added to user requests.

- Store baseline discovered models separately from overrides. Restore and reapply current overrides on setup before exposing discovery RPC/tools.
- Scope the snapshot by project directory, provider ID/package/settings, and the resolved credential, using a SHA-256 storage key. Raw credentials are not stored in snapshot keys or values. A changed endpoint/filter/account does not reuse the old snapshot.
- Keep the snapshot independently from the optional TTL request cache. Disabling request caching or issuing a force refresh does not discard the fallback.
- Replace baseline inventory and the persisted snapshot only after a successful, valid response. An HTTP error, timeout, malformed payload, or invalid model entry retains the prior models. A valid empty list is a successful replacement.
- A snapshot write failure leaves the prior persisted value intact; the successful response remains available in memory. Explicit provider removal or credential/configuration changes may remove an old inventory independently of network success.
- The existing raw-response cache now also validates a credential hash, preventing another account's cached response from overwriting the correctly scoped fallback.

## Validation

`npm run build` passes 363 tests in 44 files, type checking, and compilation, with 20 pre-existing lint warnings. New tests cover restoring after a module-memory reset, early transform registration with a restored inventory while a request is pending, failed refresh without a catalog replacement, malformed responses, successful empty responses, identity isolation, corrupted snapshots, and a failed snapshot write.

### Remaining real-host failure

Run the manual reproduction after compiling:

```sh
npm run compile
node scripts/reproduce-v2-reload.mjs
```

It starts an independent OpenCode service with temporary XDG/config directories, the local compiled plugin, and a loopback provider. No user credentials or real inference endpoint are used. Discovery is delayed by 1.5 seconds. After obtaining a successful inventory, it switches discovery to HTTP 503 and reloads the project location. A nonzero exit reports an observed missing model, not a passing integration test.

The latest real-host result still shows:

1. On a genuinely cold setup, the host returns 13 built-in models before discovery completes. A valid standalone generation probe returns 404 `ModelNotFoundError`; the successful response later adds the mock model (14 total).
2. Immediately after location reload, the discovery RPC can be unavailable, or report zero providers, while provider configuration is still being established. The model catalog can again contain only the 13 built-in models.
3. The snapshot cannot safely restore a provider that the host has not yet identified/configured. Treating every empty provider listing as a transient error could resurrect an intentionally removed provider or models from a different account.

This is distinct from a failed network refresh of a known provider, which the snapshot tests cover. The plugin now preserves/restores last-success state for a known matching identity, but that does not establish host readiness before plugin/provider initialization. The original session-runner incident remains unresolved at that boundary. Do not report the successful unit suite as proof that all `ModelUnavailableError` failures are fixed.

Keep the PR in draft. The remaining investigation is the host's provider readiness and plugin replacement contract; no request delay or session hook gate is introduced in this implementation.
