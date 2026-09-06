# Unlink v3.0 — State-Sharing Clusters

## Core rule

**Share state only where functionality requires it. Isolate everything else by default.**

Unlink no longer uses a behavioral reference population or top-4 router.

### Example: Google

One Google Productivity instance can contain:

- Gmail
- Drive
- Docs
- Sheets
- Slides
- Calendar
- Meet
- Google Accounts / My Account handoffs

Google Search is intentionally **not** in that cluster.

So:

- Gmail → Docs: stays in the same Google Productivity instance.
- Gmail → Google Search: leaves the productivity state and gets a fresh ephemeral container.
- Search → Gmail: returns to a Google Productivity instance.
- Two Google Productivity instances can coexist for two separate account/session states.

## Multiple instances

If a cluster has one instance, Unlink reuses it automatically.

If a cluster has more than one instance and a navigation enters that cluster from
outside it, Unlink **does not guess**. It opens a chooser:

- Google Productivity #1
- Google Productivity #2
- New Google Productivity instance

This is how the same sites can support multiple isolated accounts/personas without
mixing their cookies.

## Default isolation

URLs that are not part of a state-sharing cluster are isolated aggressively:

- same-site navigation stays in its current container;
- redirects stay in their current container;
- top-level POST/form handoffs stay in their current container;
- ordinary cross-domain navigation gets a fresh ephemeral container.

This preserves immediate functional continuity without preserving unrelated
first-party state merely for personalization.

## Built-in clusters

- Google Productivity
- Microsoft Productivity

The cluster rules are editable at **Unlink → Edit cluster rules**. The options page
stores a JSON policy list, so more ecosystems can be added without changing the
router.

## Classic privacy protections

The build also includes:

- Firefox `resistFingerprinting`
- Tracking Protection
- reject tracker cookies + partition other third-party cookies
- common tracking-parameter stripping
- cross-site Referer trimming
- `Sec-GPC: 1`
- hyperlink auditing disabled
- network prediction disabled
- restricted WebRTC IP handling

## Important limitations

- State-sharing rules are policy, not proof that two domains technically require
  shared cookies. Built-ins should be tested against real workflows.
- The same-site helper is deliberately small and is not a full Public Suffix List.
- Containers isolate cookies/storage, not IP addresses.
- Firefox fingerprint resistance is browser-wide, not a separate randomized
  fingerprint per container.
- A service can still link two isolated containers if the user authenticates both
  to accounts that the service already knows belong to the same person.
- Cluster instances persist until the user removes them in Firefox; ephemeral
  automatic destruction is a separate lifecycle feature and is not enabled here.

## Install

1. Firefox → `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on**
3. Select this folder's `manifest.json`
4. Open the Unlink popup.

## Quick test

1. Open Gmail. It creates **Google Productivity #1**.
2. From there open Docs. It should remain in that same container.
3. Navigate to a normal Google Search URL. It should move into a fresh Ephemeral container.
4. In the popup, click **+ NEW INSTANCE** under Google Productivity. This opens a
   separate Google container suitable for another login.
5. From an external page navigate to Gmail. Because two Google instances now exist,
   Unlink should show the instance chooser instead of guessing.


## Live demo page

Open the Unlink popup and click **OPEN LIVE DEMO**. The page drives real browser navigations and shows live routing counters.


## v3.3 anonymous domain budget

Anonymous containers now rotate on a simple deterministic rule:

- the first and second distinct registrable domains may share the anonymous identity;
- the third distinct registrable domain is reopened in a fresh anonymous identity;
- repeat visits to a domain already seen in that identity do not consume another slot;
- state-sharing cluster containers are never retired by this rule;
- navigating from a stateful cluster to an unrelated destination forks immediately into an anonymous identity.

Example:

```text
Ephemeral #1
  wikipedia.org   #1
  reddit.com      #2

bbc.com would be #3
  -> ROTATE

Ephemeral #2
  bbc.com         #1
```

The threshold is a product policy, not a claim that two domains are anonymous or three domains are identifying.


# v4.0 — Automatic state-dependency learning

The core routing model is now:

1. **Stateful seed identity** — e.g. Gmail + `accounts.google.com`.
2. **Anonymous by default** — public destinations do not inherit the logged-in state.
3. **Learn only demonstrated authentication dependencies** — if an anonymous destination redirects to a same-organization authentication endpoint that anchors an existing stateful cluster, Unlink learns an exact host rule and reopens the destination in that stateful identity.
4. **Rotate anonymous identities** — the third distinct registrable domain starts a fresh anonymous container.

Example:

```text
Gmail
→ Google Session #1 (logged in)

new tab → google.com/search
→ anonymous identity
→ works publicly
→ stays anonymous

new tab → drive.google.com
→ anonymous attempt redirects to accounts.google.com
→ same registrable organization (google.com)
→ accounts.google.com is a Google Session auth anchor
→ LEARN: drive.google.com needs Google Session
→ reopen Drive in Google Session #1

future drive.google.com
→ routes directly to Google Session #1
```

## Why learning is conservative

Unlink does **not** automatically merge arbitrary third-party OAuth apps into an identity.

The automatic learner requires:
- a top-level redirect that looks like authentication,
- the destination and authentication endpoint to share a registrable organizational domain,
- the authentication endpoint to already be an `auth-anchor` for a stateful cluster.

This handles cases such as `drive.google.com → accounts.google.com` without treating every `google.com` page as stateful.

Cross-organization SSO (for example an unrelated SaaS app using Google OAuth) is deliberately not auto-merged because doing so could collapse identities that should remain separate.

The dashboard exposes every learned rule and includes a **Forget** control.

## Important limitation

"Login wall" detection is heuristic. Websites can implement authentication entirely in JavaScript, use unusual URL structures, or use cross-organization identity providers. Unlink therefore optimizes for conservative automation rather than pretending authentication dependence can be inferred perfectly.


## v4.0.1 — Flow race fix

This patch deliberately leaves the v4.0 Firefox container creation/rerouting
implementation unchanged.

The fix is only to the state-routing flow.

### Previous race

`drive.google.com` could redirect to `accounts.google.com`, and two independent
paths could react:

1. the ordinary main-frame router saw `accounts.google.com` as a stateful cluster;
2. the asynchronous auth-dependency learner separately tried to learn and reopen
   the original Drive URL.

That could produce competing routing decisions.

### New flow

There is now one owner: `routeMainFrame()`.

For a recent same-organization auth redirect from an anonymous container:

1. identify the auth anchor;
2. learn the original host as a state dependency;
3. consume the redirect;
4. reopen the **original destination URL** in the existing stateful container;
5. skip ordinary routing of the auth endpoint.

No Firefox contextual-identity/container creation code was rewritten.


## v4.0.2 — Google productivity usability fix

The Google login cluster now explicitly includes:

- Gmail
- Drive
- Docs
- Sheets
- Slides
- Calendar
- Keep
- Meet
- Google account/authentication endpoints

`google.com` / Google Search is intentionally **not** part of that cluster.

Expected flow:

```text
Gmail
→ Google Session

Docs
→ same Google Session

Drive
→ same Google Session

Google Search
→ isolated anonymous container
```

Automatic state-dependency learning is still available for unknown same-organization
apps, but obvious first-party productivity apps no longer depend on login-wall inference.


## v4.0.3 — Dashboard live-state fix

The "WITH UNLINK" side previously reconstructed identities only from
`state.routingLog`. That made it possible for the dashboard to show `0 identities`
even while Firefox visibly had colored container tabs.

The dashboard now queries Firefox's currently open tabs and groups them by their
real `cookieStoreId`. The routing log is only a secondary historical source.

This patch changes dashboard observability only. It does not rewrite the working
v4 container creation/routing engine.


## v4.0.6 — Classic protections removed

Unlink now focuses only on its distinct product layer:

- Firefox container identity routing
- state-sharing clusters
- anonymous isolation
- anonymous rotation before a third distinct registrable domain
- automatic state-dependency learning

Removed because Firefox or other privacy extensions can already handle them:

- fingerprint-resistance settings
- tracking-protection controls
- third-party cookie partitioning controls
- tracking-parameter stripping
- cross-site referrer trimming
- Global Privacy Control injection
- hyperlink-auditing controls
- network-prediction controls
- WebRTC IP-handling controls

This keeps Unlink centered on limiting how much unrelated browsing behavior
accumulates under one browser identity.
