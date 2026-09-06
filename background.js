
const SETTINGS_KEY = "unlinkV4Settings";
const STATE_KEY = "unlinkV4State";
const POLICIES_KEY = "unlinkV4Policies";

const COLORS = ["turquoise","blue","green","purple","orange","pink","red","yellow"];

const DEFAULT_SETTINGS = {
  enabled: true,
  isolateCrossDomainByDefault: true,
  anonymousDomainBudget: 3,
  autoLearnStateSharing: true
};

const DEFAULT_POLICIES = [
  {
    id: "google-session",
    name: "Google Session",
    description: "Shared login state for Google productivity apps. Public Google Search remains outside this cluster and stays isolated.",
    rules: [
      {host: "gmail.com", source: "seed"},
      {host: "mail.google.com", source: "seed"},
      {host: "drive.google.com", source: "seed"},
      {host: "docs.google.com", source: "seed"},
      {host: "sheets.google.com", source: "seed"},
      {host: "slides.google.com", source: "seed"},
      {host: "calendar.google.com", source: "seed"},
      {host: "keep.google.com", source: "seed"},
      {host: "meet.google.com", source: "seed"},
      {host: "accounts.google.com", source: "auth-anchor"},
      {host: "myaccount.google.com", source: "auth-anchor"}
    ]
  },
  {
    id: "microsoft-session",
    name: "Microsoft Session",
    description: "Seed identity for Outlook and Microsoft authentication. Additional tools can be added manually or learned when the dependency is same-organization and observable.",
    rules: [
      {host: "outlook.live.com", source: "seed"},
      {host: "outlook.office.com", source: "seed"},
      {host: "login.microsoftonline.com", source: "auth-anchor"},
      {host: "account.microsoft.com", source: "auth-anchor"}
    ]
  }
];

const DEFAULT_STATE = {
  nextContainerNumber: 1,

  // cookieStoreId -> metadata
  containers: {},

  // clusterId -> [cookieStoreId, ...]
  clusterInstances: {},

  // Most recently used instance for each cluster.
  lastUsedClusterInstance: {},

  // tab -> last committed host
  lastCommittedByTab: {},

  // chooser token -> pending destination
  pendingChoices: {},

  lastDecision: null,
  routingLog: [],
  learnedStateRules: [],

  stats: {
    freshEphemeralCreated: 0,
    clusterInstancesCreated: 0,
    clusterReuses: 0,
    clusterChoosers: 0,
    sameSiteKeeps: 0,
    redirectKeeps: 0,
    formKeeps: 0,
    crossDomainSplits: 0,
    domainBudgetRotations: 0,
    stateDependenciesLearned: 0,
    authWallsDetected: 0,
    trackingParamsRemoved: 0,
    referrersTrimmed: 0
  }
};

const rerouteGuard = new Map();
const redirectGuard = new Map();
let stateQueue = Promise.resolve();

function enqueue(fn) {
  stateQueue = stateQueue.catch(() => {}).then(fn);
  return stateQueue;
}

function randomToken() {
  return globalThis.crypto?.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseUrl(raw) {
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    return u;
  } catch {
    return null;
  }
}

function normalizeHost(raw) {
  const u = parseUrl(raw);
  if (!u) return null;
  let h = u.hostname.toLowerCase();
  if (h.startsWith("www.")) h = h.slice(4);
  return h;
}

// Small built-in registrable-domain helper.
// This avoids the old "last two labels" bug for common multi-label public suffixes.
// It is still intentionally smaller than the full Public Suffix List.
const COMMON_TWO_LABEL_SUFFIXES = new Set([
  "co.uk","org.uk","gov.uk","ac.uk",
  "com.au","net.au","org.au","edu.au",
  "co.jp","ne.jp","or.jp",
  "co.nz","org.nz","net.nz",
  "co.in","firm.in","net.in","org.in","gen.in","ind.in",
  "com.br","net.br","org.br",
  "com.cn","net.cn","org.cn",
  "com.sg","net.sg","org.sg",
  "com.mx","org.mx","com.tr","com.tw","com.hk","com.my"
]);

function registrableDomain(host) {
  if (!host) return null;
  host = host.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || /^[0-9.]+$/.test(host) || host.includes(":")) return host;

  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;

  const last2 = parts.slice(-2).join(".");
  if (COMMON_TWO_LABEL_SUFFIXES.has(last2) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return last2;
}

function sameSite(a, b) {
  return !!a && !!b && registrableDomain(a) === registrableDomain(b);
}

function domainForUrl(url) {
  const host = normalizeHost(url);
  return registrableDomain(host);
}

function recordContainerDomain(state, cookieStoreId, url) {
  const meta = state.containers[cookieStoreId];
  if (!meta) return null;
  meta.domains ||= [];
  const domain = domainForUrl(url);
  if (domain && !meta.domains.includes(domain)) meta.domains.push(domain);
  return domain;
}

function looksLikeAuthUrl(raw) {
  const u = parseUrl(raw);
  if (!u) return false;

  const host = u.hostname.toLowerCase();
  const path = (u.pathname + " " + u.search).toLowerCase();

  const hostSignals = [
    "account.", "accounts.", "login.", "signin.", "auth.", "oauth.", "sso.", "identity."
  ];
  const pathSignals = [
    "/login", "/signin", "/sign-in", "/auth", "/oauth", "/sso",
    "/account/chooser", "/selectaccount", "continue=", "redirect_uri="
  ];

  return hostSignals.some(x => host.includes(x)) ||
         pathSignals.some(x => path.includes(x));
}

function sameOrganizationAuthHop(fromUrl, authUrl) {
  const from = domainForUrl(fromUrl);
  const auth = domainForUrl(authUrl);
  return !!from && !!auth && from === auth;
}

function clusterForAuthAnchor(url, policies) {
  const host = normalizeHost(url);
  if (!host) return null;

  for (const cluster of policies) {
    for (const rule of cluster.rules || []) {
      if (rule.source === "auth-anchor" && hostMatches(host, rule.host || "")) {
        return cluster;
      }
    }
  }
  return null;
}

function addLearnedRule(cluster, host, authUrl, state) {
  if (!host) return false;
  cluster.rules ||= [];
  if (cluster.rules.some(r => hostMatches(host, r.host || ""))) return false;

  cluster.rules.push({
    host,
    source: "learned-auth-dependency",
    learnedAt: new Date().toISOString()
  });

  state.learnedStateRules ||= [];
  state.learnedStateRules.unshift({
    clusterId: cluster.id,
    clusterName: cluster.name,
    host,
    authHost: normalizeHost(authUrl),
    learnedAt: Date.now()
  });
  if (state.learnedStateRules.length > 100) state.learnedStateRules.length = 100;

  state.stats.stateDependenciesLearned += 1;
  return true;
}

function hostMatches(host, ruleHost) {
  host = host.toLowerCase();
  ruleHost = ruleHost.toLowerCase();

  // Exact by default; users may use "*.example.com" for suffix matching.
  if (ruleHost.startsWith("*.")) {
    const suffix = ruleHost.slice(2);
    return host === suffix || host.endsWith("." + suffix);
  }
  return host === ruleHost;
}

function ruleMatches(url, rule) {
  const u = parseUrl(url);
  if (!u) return false;
  let host = u.hostname.toLowerCase();
  if (!hostMatches(host, rule.host || "")) return false;

  if (rule.pathPrefix && !u.pathname.startsWith(rule.pathPrefix)) return false;

  if (rule.queryParam) {
    if (!u.searchParams.has(rule.queryParam)) return false;
  }

  return true;
}

function clusterForUrl(url, policies) {
  for (const cluster of policies) {
    if ((cluster.rules || []).some(rule => ruleMatches(url, rule))) {
      return cluster;
    }
  }
  return null;
}

async function getSettings() {
  const x = await browser.storage.local.get(SETTINGS_KEY);
  return {...DEFAULT_SETTINGS, ...(x[SETTINGS_KEY] || {})};
}

async function getPolicies() {
  const x = await browser.storage.local.get(POLICIES_KEY);
  return Array.isArray(x[POLICIES_KEY]) ? x[POLICIES_KEY] : structuredClone(DEFAULT_POLICIES);
}

async function savePolicies(policies) {
  await browser.storage.local.set({[POLICIES_KEY]: policies});
}

async function getState() {
  const x = await browser.storage.local.get(STATE_KEY);
  const s = {...structuredClone(DEFAULT_STATE), ...(x[STATE_KEY] || {})};
  s.containers ||= {};
  s.clusterInstances ||= {};
  s.lastUsedClusterInstance ||= {};
  s.lastCommittedByTab ||= {};
  s.pendingChoices ||= {};
  s.routingLog ||= [];
  s.learnedStateRules ||= [];
  s.stats = {...DEFAULT_STATE.stats, ...(s.stats || {})};
  return s;
}

async function saveState(state) {
  await browser.storage.local.set({[STATE_KEY]: state});
}

function pushRoutingLog(state, entry) {
  state.routingLog ||= [];
  state.routingLog.unshift({ts: Date.now(), ...entry});
  if (state.routingLog.length > 120) state.routingLog.length = 120;
}

function colorFor(n) {
  return COLORS[(n - 1) % COLORS.length];
}

async function newContainerName(kind, clusterName, n, instanceIndex) {
  if (kind === "cluster") {
    return `Unlink · ${clusterName} #${instanceIndex}`;
  }
  return `Unlink · Ephemeral ${n}`;
}

async function createContainer(kind, cluster, state) {
  const n = state.nextContainerNumber++;
  let instanceIndex = null;

  if (kind === "cluster") {
    const ids = state.clusterInstances[cluster.id] || [];
    instanceIndex = ids.length + 1;
  }

  const name = await newContainerName(
    kind,
    cluster?.name || null,
    n,
    instanceIndex
  );

  const identity = await browser.contextualIdentities.create({
    name,
    color: colorFor(n),
    icon: kind === "cluster" ? "briefcase" : "fingerprint"
  });

  state.containers[identity.cookieStoreId] = {
    kind,
    clusterId: cluster?.id || null,
    clusterName: cluster?.name || null,
    instanceIndex,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    domains: []
  };

  if (kind === "cluster") {
    state.clusterInstances[cluster.id] ||= [];
    state.clusterInstances[cluster.id].push(identity.cookieStoreId);
    state.lastUsedClusterInstance[cluster.id] = identity.cookieStoreId;
    state.stats.clusterInstancesCreated += 1;
  } else {
    state.stats.freshEphemeralCreated += 1;
  }

  return {
    cookieStoreId: identity.cookieStoreId,
    meta: state.containers[identity.cookieStoreId]
  };
}

async function ensureKnownContainer(cookieStoreId, state) {
  if (!cookieStoreId || cookieStoreId === "firefox-default") return null;
  if (state.containers[cookieStoreId]) {
    return {cookieStoreId, meta:state.containers[cookieStoreId]};
  }

  // Recover extension-created containers after an extension reload.
  try {
    const ident = await browser.contextualIdentities.get(cookieStoreId);
    if (!ident?.name?.startsWith("Unlink · ")) return null;

    const clusterMatch = /^Unlink · (.+) #(\d+)$/.exec(ident.name);
    const ephemeralMatch = /^Unlink · Ephemeral (\d+)$/.exec(ident.name);

    if (clusterMatch) {
      const policies = await getPolicies();
      const cluster = policies.find(c => c.name === clusterMatch[1]);
      if (!cluster) return null;

      state.containers[cookieStoreId] = {
        kind:"cluster",
        clusterId:cluster.id,
        clusterName:cluster.name,
        instanceIndex:Number(clusterMatch[2]),
        createdAt:null,
        lastUsedAt:Date.now(),
        domains:[]
      };
      state.clusterInstances[cluster.id] ||= [];
      if (!state.clusterInstances[cluster.id].includes(cookieStoreId)) {
        state.clusterInstances[cluster.id].push(cookieStoreId);
      }
      return {cookieStoreId, meta:state.containers[cookieStoreId]};
    }

    if (ephemeralMatch) {
      state.containers[cookieStoreId] = {
        kind:"ephemeral",
        clusterId:null,
        clusterName:null,
        instanceIndex:null,
        createdAt:null,
        lastUsedAt:Date.now(),
        domains:[]
      };
      return {cookieStoreId, meta:state.containers[cookieStoreId]};
    }
  } catch {}

  return null;
}

function recentRedirect(tabId, url) {
  const r = redirectGuard.get(tabId);
  if (!r) return false;
  if (Date.now() - r.ts > 7000) {
    redirectGuard.delete(tabId);
    return false;
  }
  return r.url === url || sameSite(normalizeHost(r.url), normalizeHost(url));
}

async function chooseClusterInstance(cluster, current, state) {
  // If already inside the same cluster, preserve that exact instance.
  if (current?.meta?.kind === "cluster" && current.meta.clusterId === cluster.id) {
    return {mode:"reuse-current", cookieStoreId:current.cookieStoreId};
  }

  const instances = (state.clusterInstances[cluster.id] || [])
    .filter(id => state.containers[id]);

  if (instances.length === 0) {
    const created = await createContainer("cluster", cluster, state);
    return {mode:"create-first", cookieStoreId:created.cookieStoreId};
  }

  if (instances.length === 1) {
    return {mode:"reuse-only", cookieStoreId:instances[0]};
  }

  // Multiple principals/sessions exist. Do not guess which one the user means.
  return {mode:"choose", instances};
}

async function openChooser(details, tab, cluster, instances, state) {
  const token = randomToken();
  state.pendingChoices[token] = {
    url:details.url,
    clusterId:cluster.id,
    sourceTabId:tab.id,
    sourceWindowId:tab.windowId,
    sourceIndex:tab.index,
    createdAt:Date.now()
  };
  state.stats.clusterChoosers += 1;

  await saveState(state);

  const chooserUrl = browser.runtime.getURL(
    `chooser.html?token=${encodeURIComponent(token)}`
  );

  const created = await browser.tabs.create({
    windowId:tab.windowId,
    index:tab.index,
    active:tab.active,
    url:chooserUrl
  });

  await browser.tabs.remove(tab.id);

  state.lastDecision = {
    action:"CHOOSE",
    reason:`Multiple ${cluster.name} instances exist`,
    clusterId:cluster.id,
    chooserTabId:created.id,
    url:details.url
  };
  await saveState(state);

  return {cancel:true};
}

async function moveNavigationToStore(details, tab, targetStore, state, decision) {
  state.lastDecision = decision;
  pushRoutingLog(state, {...decision, targetStore});
  state.containers[targetStore].lastUsedAt = Date.now();
  recordContainerDomain(state, targetStore, details.url);

  if (state.containers[targetStore].kind === "cluster") {
    const cid = state.containers[targetStore].clusterId;
    state.lastUsedClusterInstance[cid] = targetStore;
  }

  await saveState(state);

  if (tab.cookieStoreId === targetStore) {
    return {};
  }

  try {
    const created = await browser.tabs.create({
      windowId:tab.windowId,
      index:tab.index,
      active:tab.active,
      url:details.url,
      cookieStoreId:targetStore
    });

    rerouteGuard.set(created.id, {url:details.url, ts:Date.now()});
    setTimeout(() => rerouteGuard.delete(created.id), 4500);

    await browser.tabs.remove(tab.id);
    return {cancel:true};
  } catch (e) {
    console.error("Unlink reroute failed", e);
    return {};
  }
}


async function routeMainFrame(details) {
  if (details.type !== "main_frame" || details.tabId < 0) return {};

  const settings = await getSettings();
  if (!settings.enabled) return {};


  const guard = rerouteGuard.get(details.tabId);
  if (guard && guard.url === details.url && Date.now() - guard.ts < 3500) {
    return {};
  }

  return enqueue(async () => {
    let tab;
    try {
      tab = await browser.tabs.get(details.tabId);
    } catch {
      return {};
    }

    const [state, policies] = await Promise.all([getState(), getPolicies()]);
    const current = await ensureKnownContainer(tab.cookieStoreId, state);
    const destinationCluster = clusterForUrl(details.url, policies);

    const host = normalizeHost(details.url);
    const previousHost =
      state.lastCommittedByTab[String(tab.id)] || normalizeHost(tab.url);

    // 0) Authentication dependency interception.
    //
    // This is deliberately handled INSIDE the main router so there is only one
    // owner of the transition. In v4.0 the onBeforeRedirect learner and this
    // router could both react to the same auth redirect.
    //
    // Example:
    //   drive.google.com (anonymous)
    //     -> accounts.google.com (auth redirect)
    //
    // We learn "drive.google.com needs Google Session", then reopen the
    // ORIGINAL Drive URL in that stateful container. We do not route the auth
    // endpoint independently first.
    const redirect = redirectGuard.get(details.tabId);
    if (
      current?.meta?.kind === "ephemeral" &&
      redirect &&
      Date.now() - redirect.ts < 7000 &&
      redirect.url === details.url &&
      looksLikeAuthUrl(details.url) &&
      sameOrganizationAuthHop(redirect.sourceUrl, details.url)
    ) {
      const authCluster = clusterForAuthAnchor(details.url, policies);

      if (authCluster) {
        const sourceHost = normalizeHost(redirect.sourceUrl);

        if (sourceHost) {
          state.stats.authWallsDetected += 1;

          const learned = addLearnedRule(
            authCluster,
            sourceHost,
            details.url,
            state
          );

          if (learned) {
            await savePolicies(policies);
          }

          // Consume this redirect so it cannot later be treated as ordinary
          // redirect continuity.
          redirectGuard.delete(details.tabId);

          const target = await chooseClusterInstance(
            authCluster,
            current,
            state
          );

          if (target.mode === "choose") {
            return openChooser(
              {url:redirect.sourceUrl},
              tab,
              authCluster,
              target.instances,
              state
            );
          }

          if (target.mode.startsWith("reuse")) {
            state.stats.clusterReuses += 1;
          }

          return moveNavigationToStore(
            {url:redirect.sourceUrl},
            tab,
            target.cookieStoreId,
            state,
            {
              action:learned ? "LEARN_SHARE" : "REUSE_CLUSTER",
              reason:learned
                ? `${sourceHost} redirected to ${normalizeHost(details.url)}; learned login dependency`
                : `${sourceHost} already has a learned login dependency`,
              clusterId:authCluster.id,
              clusterName:authCluster.name,
              cookieStoreId:target.cookieStoreId,
              url:redirect.sourceUrl
            }
          );
        }
      }
    }

    // 1) Cluster destinations: shared state is explicitly justified.
    if (destinationCluster) {
      const target = await chooseClusterInstance(
        destinationCluster,
        current,
        state
      );

      if (target.mode === "choose") {
        return openChooser(
          details, tab, destinationCluster, target.instances, state
        );
      }

      if (target.mode.startsWith("reuse")) state.stats.clusterReuses += 1;

      return moveNavigationToStore(
        details,
        tab,
        target.cookieStoreId,
        state,
        {
          action:target.mode === "create-first" ? "CREATE_CLUSTER" : "REUSE_CLUSTER",
          reason:`Destination belongs to ${destinationCluster.name}`,
          clusterId:destinationCluster.id,
          clusterName:destinationCluster.name,
          cookieStoreId:target.cookieStoreId,
          url:details.url
        }
      );
    }

    // 2) Hard continuity exceptions for non-cluster browsing.
    if (current && recentRedirect(details.tabId, details.url)) {
      state.stats.redirectKeeps += 1;
      return moveNavigationToStore(
        details, tab, current.cookieStoreId, state,
        {
          action:"KEEP",
          reason:"redirect continuity",
          cookieStoreId:current.cookieStoreId,
          url:details.url
        }
      );
    }

    if (current && sameSite(previousHost, host)) {
      state.stats.sameSiteKeeps += 1;
      return moveNavigationToStore(
        details, tab, current.cookieStoreId, state,
        {
          action:"KEEP",
          reason:"same-site continuity",
          cookieStoreId:current.cookieStoreId,
          url:details.url
        }
      );
    }

    if (
      current &&
      details.method &&
      !["GET","HEAD"].includes(details.method.toUpperCase())
    ) {
      state.stats.formKeeps += 1;
      return moveNavigationToStore(
        details, tab, current.cookieStoreId, state,
        {
          action:"KEEP",
          reason:`${details.method.toUpperCase()} form/session handoff`,
          cookieStoreId:current.cookieStoreId,
          url:details.url
        }
      );
    }

    // 3) Anonymous browsing uses a simple distinct-domain budget.
    // Stateful cluster containers never absorb unrelated browsing: fork away immediately.
    if (current?.meta?.kind === "cluster") {
      const fresh = await createContainer("ephemeral", null, state);
      state.stats.crossDomainSplits += 1;
      return moveNavigationToStore(
        details,
        tab,
        fresh.cookieStoreId,
        state,
        {
          action:"FORK",
          reason:"destination does not require the current stateful cluster",
          cookieStoreId:fresh.cookieStoreId,
          url:details.url
        }
      );
    }

    // No Unlink identity yet: begin a fresh anonymous identity.
    if (!current) {
      const fresh = await createContainer("ephemeral", null, state);
      return moveNavigationToStore(
        details,
        tab,
        fresh.cookieStoreId,
        state,
        {
          action:"FRESH",
          reason:"new anonymous identity",
          cookieStoreId:fresh.cookieStoreId,
          url:details.url
        }
      );
    }

    if (!settings.isolateCrossDomainByDefault) {
      return moveNavigationToStore(
        details, tab, current.cookieStoreId, state,
        {
          action:"KEEP",
          reason:"default isolation disabled",
          cookieStoreId:current.cookieStoreId,
          url:details.url
        }
      );
    }

    // Current identity is ephemeral. Count registrable domains locally.
    current.meta.domains ||= [];
    const destinationDomain = domainForUrl(details.url);
    const known = destinationDomain && current.meta.domains.includes(destinationDomain);
    const budget = Math.max(2, Number(settings.anonymousDomainBudget || 3));

    // Repeated visits to an already-seen domain cost nothing.
    if (known) {
      return moveNavigationToStore(
        details, tab, current.cookieStoreId, state,
        {
          action:"KEEP",
          reason:`anonymous domain budget ${current.meta.domains.length}/${budget}`,
          cookieStoreId:current.cookieStoreId,
          url:details.url
        }
      );
    }

    // The threshold-crossing domain starts the next identity.
    if (destinationDomain && current.meta.domains.length >= budget - 1) {
      const fresh = await createContainer("ephemeral", null, state);
      state.stats.domainBudgetRotations += 1;
      state.stats.crossDomainSplits += 1;

      return moveNavigationToStore(
        details,
        tab,
        fresh.cookieStoreId,
        state,
        {
          action:"ROTATE",
          reason:`third distinct domain starts a fresh anonymous identity`,
          cookieStoreId:fresh.cookieStoreId,
          url:details.url
        }
      );
    }

    // Still under budget: allow this unrelated domain into the current anonymous identity.
    return moveNavigationToStore(
      details, tab, current.cookieStoreId, state,
      {
        action:"KEEP",
        reason:`anonymous domain budget ${(current.meta.domains.length + (destinationDomain ? 1 : 0))}/${budget}`,
        cookieStoreId:current.cookieStoreId,
        url:details.url
      }
    );
  });
}

browser.webRequest.onBeforeRequest.addListener(
  routeMainFrame,
  {urls:["<all_urls>"], types:["main_frame"]},
  ["blocking"]
);

browser.webRequest.onBeforeRedirect.addListener(details => {
  if (details.type !== "main_frame" || details.tabId < 0 || !details.redirectUrl) return;

  redirectGuard.set(details.tabId, {
    sourceUrl:details.url,
    url:details.redirectUrl,
    ts:Date.now()
  });
});

browser.webNavigation.onCommitted.addListener(async details => {
  if (details.frameId !== 0) return;
  const host = normalizeHost(details.url);
  if (!host) return;

  const state = await getState();
  state.lastCommittedByTab[String(details.tabId)] = host;
  await saveState(state);
});

browser.tabs.onRemoved.addListener(async tabId => {
  rerouteGuard.delete(tabId);
  redirectGuard.delete(tabId);

  const state = await getState();
  delete state.lastCommittedByTab[String(tabId)];

  // Drop stale pending choices that referenced this source tab.
  for (const [token, pending] of Object.entries(state.pendingChoices)) {
    if (pending.sourceTabId === tabId && Date.now() - pending.createdAt > 60000) {
      delete state.pendingChoices[token];
    }
  }
  await saveState(state);
});

async function openUrlInStore(url, cookieStoreId, sourceWindowId, sourceIndex) {
  return browser.tabs.create({
    windowId:sourceWindowId,
    index:sourceIndex,
    active:true,
    url,
    cookieStoreId
  });
}

async function getLiveContainerView(state) {
  const tabs = await browser.tabs.query({});
  const byStore = new Map();

  for (const tab of tabs) {
    const store = tab.cookieStoreId;
    if (!store || store === "firefox-default") continue;

    const known = await ensureKnownContainer(store, state);
    if (!known) continue;

    if (!byStore.has(store)) {
      byStore.set(store, {
        cookieStoreId: store,
        ...known.meta,
        tabs: []
      });
    }

    byStore.get(store).tabs.push({
      tabId: tab.id,
      title: tab.title || "",
      url: tab.url || "",
      active: !!tab.active
    });
  }

  return [...byStore.values()];
}

browser.runtime.onMessage.addListener(async msg => {
  if (msg?.type === "GET_DASHBOARD") {
    const [settings, state, policies] = await Promise.all([
      getSettings(), getState(), getPolicies()
    ]);

    const clusters = policies.map(cluster => {
      const stores = (state.clusterInstances[cluster.id] || [])
        .filter(id => state.containers[id])
        .map(id => ({
          cookieStoreId:id,
          ...state.containers[id]
        }));

      return {
        ...cluster,
        instances:stores
      };
    });

    const liveContainers = await getLiveContainerView(state);
    return {ok:true, settings, state, clusters, liveContainers};
  }

  if (msg?.type === "SET_SETTING") {
    const settings = await getSettings();
    if (!(msg.key in DEFAULT_SETTINGS)) {
      return {ok:false, error:"Unknown setting"};
    }
    settings[msg.key] = !!msg.value;
    await browser.storage.local.set({[SETTINGS_KEY]:settings});
    return {ok:true, settings};
  }

  if (msg?.type === "FORGET_LEARNED_RULE") {
    const [state, policies] = await Promise.all([getState(), getPolicies()]);
    const cluster = policies.find(c => c.id === msg.clusterId);
    if (!cluster) return {ok:false, error:"Unknown cluster."};

    const before = cluster.rules.length;
    cluster.rules = cluster.rules.filter(r =>
      !(r.source === "learned-auth-dependency" && r.host === msg.host)
    );

    state.learnedStateRules = (state.learnedStateRules || []).filter(r =>
      !(r.clusterId === msg.clusterId && r.host === msg.host)
    );

    if (cluster.rules.length !== before) {
      await savePolicies(policies);
      await saveState(state);
      return {ok:true};
    }
    return {ok:false, error:"Learned rule not found."};
  }

  if (msg?.type === "GET_POLICIES") {
    return {ok:true, policies:await getPolicies()};
  }

  if (msg?.type === "SAVE_POLICIES") {
    if (!Array.isArray(msg.policies)) {
      return {ok:false, error:"Policies must be an array."};
    }

    // Basic validation.
    for (const cluster of msg.policies) {
      if (!cluster?.id || !cluster?.name || !Array.isArray(cluster.rules)) {
        return {ok:false, error:"Each cluster needs id, name and rules."};
      }
      for (const rule of cluster.rules) {
        if (!rule?.host) {
          return {ok:false, error:`Cluster ${cluster.name} has a rule without a host.`};
        }
      }
    }

    await savePolicies(msg.policies);
    return {ok:true};
  }

  if (msg?.type === "RESET_POLICIES") {
    await savePolicies(structuredClone(DEFAULT_POLICIES));
    return {ok:true, policies:structuredClone(DEFAULT_POLICIES)};
  }

  if (msg?.type === "CREATE_CLUSTER_INSTANCE") {
    const policies = await getPolicies();
    const cluster = policies.find(c => c.id === msg.clusterId);
    if (!cluster) return {ok:false, error:"Unknown cluster."};

    const state = await getState();
    const created = await createContainer("cluster", cluster, state);
    await saveState(state);

    if (msg.openUrl) {
      await browser.tabs.create({
        url:msg.openUrl,
        active:true,
        cookieStoreId:created.cookieStoreId
      });
    }

    return {
      ok:true,
      cookieStoreId:created.cookieStoreId,
      meta:created.meta
    };
  }

  if (msg?.type === "OPEN_CLUSTER_INSTANCE") {
    const state = await getState();
    const meta = state.containers[msg.cookieStoreId];
    if (!meta || meta.kind !== "cluster") {
      return {ok:false, error:"Unknown cluster instance."};
    }

    await browser.tabs.create({
      url:msg.url || "about:blank",
      active:true,
      cookieStoreId:msg.cookieStoreId
    });
    return {ok:true};
  }

  if (msg?.type === "NEW_FRESH_TAB") {
    const state = await getState();
    const fresh = await createContainer("ephemeral", null, state);
    await saveState(state);

    const tab = await browser.tabs.create({
      url:msg.url || "about:blank",
      active:true,
      cookieStoreId:fresh.cookieStoreId
    });

    return {ok:true, tabId:tab.id, cookieStoreId:fresh.cookieStoreId};
  }

  if (msg?.type === "GET_PENDING_CHOICE") {
    const state = await getState();
    const pending = state.pendingChoices[msg.token];
    if (!pending) return {ok:false, error:"Choice expired or not found."};

    const policies = await getPolicies();
    const cluster = policies.find(c => c.id === pending.clusterId);
    if (!cluster) return {ok:false, error:"Cluster no longer exists."};

    const instances = (state.clusterInstances[cluster.id] || [])
      .filter(id => state.containers[id])
      .map(id => ({
        cookieStoreId:id,
        ...state.containers[id]
      }));

    return {
      ok:true,
      pending,
      cluster,
      instances
    };
  }

  if (msg?.type === "RESOLVE_PENDING_CHOICE") {
    const state = await getState();
    const pending = state.pendingChoices[msg.token];
    if (!pending) return {ok:false, error:"Choice expired or not found."};

    const policies = await getPolicies();
    const cluster = policies.find(c => c.id === pending.clusterId);
    if (!cluster) return {ok:false, error:"Cluster no longer exists."};

    let targetStore = msg.cookieStoreId;

    if (msg.createNew) {
      const created = await createContainer("cluster", cluster, state);
      targetStore = created.cookieStoreId;
    }

    const meta = state.containers[targetStore];
    if (!meta || meta.kind !== "cluster" || meta.clusterId !== cluster.id) {
      return {ok:false, error:"Invalid cluster instance."};
    }

    delete state.pendingChoices[msg.token];
    state.lastUsedClusterInstance[cluster.id] = targetStore;
    state.stats.clusterReuses += msg.createNew ? 0 : 1;
    state.lastDecision = {
      action:msg.createNew ? "CREATE_CLUSTER" : "REUSE_CLUSTER",
      reason:"User selected cluster instance",
      clusterId:cluster.id,
      clusterName:cluster.name,
      cookieStoreId:targetStore,
      url:pending.url
    };
    await saveState(state);

    await openUrlInStore(
      pending.url,
      targetStore,
      pending.sourceWindowId,
      pending.sourceIndex
    );

    return {ok:true};
  }

  if (msg?.type === "CLEAR_ROUTING_LOG") {
    const state = await getState();
    state.routingLog = [];
    state.lastDecision = null;
    await saveState(state);
    return {ok:true};
  }

  if (msg?.type === "RESET_SESSION_STATE") {
    const state = await getState();
    const preserve = {
      nextContainerNumber:state.nextContainerNumber,
      containers:state.containers,
      clusterInstances:state.clusterInstances,
      lastUsedClusterInstance:state.lastUsedClusterInstance
    };
    const fresh = structuredClone(DEFAULT_STATE);
    Object.assign(fresh, preserve);
    await saveState(fresh);
    return {ok:true};
  }
});

browser.runtime.onInstalled.addListener(async () => {
  const policies = await getPolicies();
  if (!policies?.length) await savePolicies(structuredClone(DEFAULT_POLICIES));
});