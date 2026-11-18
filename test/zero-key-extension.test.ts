import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "..");
const EXT_DIR = path.join(REPO_ROOT, "gmail-extension");
const CLIENT_DIR = path.join(REPO_ROOT, "client");

const EXPECTED_STORAGE_ALLOWLIST = [
  "pf_panel_zoom",
  "pf_ap_FilterQuery",
  "pf_ap_TaskConfig",
] as const;

const FORBIDDEN_SECRET_ENV_NAMES: readonly string[] = [
  ["TAI", "API", "KEY"],
  ["SUPABASE", "SERVICE", "ROLE", "KEY"],
  ["GEMINI", "API", "KEY"],
  ["OPENAI", "API", "KEY"],
  ["GOOGLE", "MAPS", "API", "KEY"],
  ["OPS", "GATEWAY", "TOKEN"],
  ["PFD", "GATEWAY", "TOKEN"],
  ["GOOGLE", "CLIENT", "SECRET"],
].map((parts) => parts.join("_"));

interface PatternRule {
  label: string;
  regex: RegExp;
}

const API_KEY_LITERAL_RULES: readonly PatternRule[] = [
  {
    label: "Google/Gemini API key literal",
    regex: new RegExp(`\\b${["AI", "za"].join("")}[0-9A-Za-z_-]{16,}`),
  },
  {
    label: "OpenAI/Anthropic secret key literal",
    regex: new RegExp(`(?<![A-Za-z0-9_-])${["s", "k-"].join("")}(?:proj-|svcacct-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}`),
  },
  {
    label: "Supabase secret key literal",
    regex: new RegExp(`\\b${["sb", "secret"].join("_")}_[A-Za-z0-9_-]{8,}`),
  },
  {
    label: "Hardcoded HS256 JWT token",
    regex: new RegExp(`${["eyJhbGciOiJIUzI1NiIs", "InR5cCI6IkpXVCJ9"].join("")}`),
  },
];

const DIRECT_BROWSER_ENDPOINT_RULES: readonly PatternRule[] = [
  {
    label: "Direct TAI PublicApi endpoint",
    regex: new RegExp(`${["taicloud", "net"].join("\\.")}\\/PublicApi`, "i"),
  },
  {
    label: "Direct OpenAI HTTP endpoint",
    regex: new RegExp(`${["api", "openai", "com"].join("\\.")}`, "i"),
  },
  {
    label: "Direct Gemini HTTP endpoint",
    regex: new RegExp(`${["generativelanguage", "googleapis", "com"].join("\\.")}`, "i"),
  },
  {
    label: "Direct Google Maps HTTP endpoint",
    regex: new RegExp(`${["maps", "googleapis", "com"].join("\\.")}\\/maps\\/api`, "i"),
  },
  {
    label: "Direct Supabase REST/Auth/Storage endpoint",
    regex: new RegExp(`${["supabase", "co"].join("\\.")}\\/(?:rest|auth|storage|functions)\\b`, "i"),
  },
];

function collectFilesRecursively(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFilesRecursively(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

function scanSourceForViolations(content: string, relPath: string): string[] {
  const violations: string[] = [];
  const lines = content.split(/\r?\n/);

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    for (const rule of API_KEY_LITERAL_RULES) {
      if (rule.regex.test(line)) {
        violations.push(`${relPath}:${lineNo} matched ${rule.label}`);
      }
    }

    for (const envName of FORBIDDEN_SECRET_ENV_NAMES) {
      const envRegex = new RegExp(`\\b${envName}\\b`);
      if (envRegex.test(line)) {
        violations.push(`${relPath}:${lineNo} references secret env name ${envName}`);
      }
    }

    for (const rule of DIRECT_BROWSER_ENDPOINT_RULES) {
      if (rule.regex.test(line)) {
        violations.push(`${relPath}:${lineNo} calls ${rule.label}`);
      }
    }
  });

  return violations;
}

test("manifest.json is valid MV3, keyless, and uses minimal scoped permissions", () => {
  const manifestPath = path.join(EXT_DIR, "manifest.json");
  const raw = fs.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as Record<string, unknown>;

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.key, undefined, "manifest must not contain a hardcoded extension key");
  assert.equal(manifest.oauth2, undefined, "manifest must not embed browser OAuth client secrets/tokens");

  const permissions = manifest.permissions as string[];
  assert.ok(Array.isArray(permissions));
  assert.deepEqual(
    [...permissions].sort(),
    ["activeTab", "scripting", "sidePanel", "storage", "tabs"],
  );

  const hostPermissions = manifest.host_permissions as string[];
  assert.ok(Array.isArray(hostPermissions));
  assert.deepEqual(
    [...hostPermissions].sort(),
    ["https://fivenines-ops.fly.dev/*", "https://mail.google.com/*"],
  );

  for (const hp of hostPermissions) {
    assert.notEqual(hp, "<all_urls>");
    assert.ok(!hp.includes("*://*/*"), `broad wildcard host permission disallowed: ${hp}`);
    assert.ok(!hp.startsWith("http://"), `insecure http host permission disallowed: ${hp}`);
  }

  const background = manifest.background as { service_worker?: string };
  assert.equal(background?.service_worker, "background.js");

  const sidePanel = manifest.side_panel as { default_path?: string };
  assert.equal(sidePanel?.default_path, "sidepanel.html");

  const contentScripts = manifest.content_scripts as Array<{ matches: string[]; js: string[] }>;
  assert.equal(contentScripts.length, 1);
  assert.deepEqual(contentScripts[0].matches, ["https://mail.google.com/*"]);
  assert.deepEqual(contentScripts[0].js, ["capture.js"]);
});

test("zero-key scanner catches synthetic API keys, secret env names, and direct API URLs", () => {
  const fakeGoogleKey = ["AI", "zaSyD9fFakeTestKey1234567890abcdef"].join("");
  const fakeOpenAiKey = ["s", "k-proj-FakeOpenAiSecret1234567890abcdef"].join("");
  const fakeSbSecret = ["sb", "secret", "FakeSupabaseKey12345"].join("_");
  const fakeJwt = `${["eyJhbGciOiJIUzI1NiIs", "InR5cCI6IkpXVCJ9"].join("")}.e30.sig`;
  const fakeTaiEnv = ["TAI", "API", "KEY"].join("_");
  const fakeGatewayEnv = ["OPS", "GATEWAY", "TOKEN"].join("_");
  const fakeTaiUrl = `https://primaryfreightllc.${["taicloud", "net"].join(".")}/PublicApi/Shipping/v2/Shipments`;
  const fakeOpenAiUrl = `https://${["api", "openai", "com"].join(".")}/v1/responses`;
  const fakeGeminiUrl = `https://${["generativelanguage", "googleapis", "com"].join(".")}/v1beta/models`;
  const fakeSupabaseUrl = `https://example.${["supabase", "co"].join(".")}/rest/v1/loads`;

  for (const sample of [
    fakeGoogleKey,
    fakeOpenAiKey,
    fakeSbSecret,
    fakeJwt,
    `const k = process.env.${fakeTaiEnv};`,
    `headers["x-token"] = ${fakeGatewayEnv};`,
    fakeTaiUrl,
    fakeOpenAiUrl,
    fakeGeminiUrl,
    fakeSupabaseUrl,
  ]) {
    const found = scanSourceForViolations(sample, "synthetic.ts");
    assert.ok(found.length > 0, `expected scanner to flag synthetic sample: ${sample.slice(0, 24)}`);
  }

  const benignSample = [
    '<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans" rel="stylesheet" />',
    '<div className="task-configuration-panel risk-badge-high ask-operator-btn" />',
    'const prefKey = "pf_panel_zoom";',
    'fetch("/api/loads/preview", { method: "POST" });',
  ].join("\n");
  assert.deepEqual(scanSourceForViolations(benignSample, "benign.tsx"), []);
});

test("every file in gmail-extension/ and client/ contains zero keys, secret env names, or direct vendor APIs", () => {
  const extFiles = collectFilesRecursively(EXT_DIR);
  const clientFiles = collectFilesRecursively(CLIENT_DIR);

  assert.ok(extFiles.length >= 5, "expected at least 5 files in gmail-extension/");
  assert.ok(clientFiles.length >= 5, "expected client/ files to be present");

  const allViolations: string[] = [];
  for (const filePath of [...extFiles, ...clientFiles]) {
    const relPath = path.relative(REPO_ROOT, filePath).replace(/\\/g, "/");
    const content = fs.readFileSync(filePath, "utf8");
    allViolations.push(...scanSourceForViolations(content, relPath));
  }

  assert.deepEqual(allViolations, [], `Zero-key violations detected:\n${allViolations.join("\n")}`);

  for (const jsName of ["background.js", "capture.js", "sidepanel.js"]) {
    const jsSource = fs.readFileSync(path.join(EXT_DIR, jsName), "utf8");
    assert.ok(!/\bfetch\s*\(/.test(jsSource), `${jsName} must not make direct fetch() network requests`);
    assert.ok(!/\bXMLHttpRequest\b/.test(jsSource), `${jsName} must not use XMLHttpRequest`);
  }
});

test("sidepanel.html embeds https://fivenines-ops.fly.dev/?panel=1 with reload and full dashboard controls", () => {
  const html = fs.readFileSync(path.join(EXT_DIR, "sidepanel.html"), "utf8");

  assert.match(html, /id="toolkit-frame"/);
  assert.match(html, /src="https:\/\/fivenines-ops\.fly\.dev\/\?panel=1"/);
  assert.match(html, /id="btn-reload-frame"/);
  assert.match(html, /id="link-open-dashboard"/);
  assert.match(html, /href="https:\/\/fivenines-ops\.fly\.dev\/"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /<script src="sidepanel\.js"><\/script>/);

  const scriptTags = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
  assert.equal(scriptTags.length, 1, "MV3 sidepanel.html must only include external sidepanel.js");
});

interface SidepanelHarnessOptions {
  search?: string;
  onRuntimeMessage?: (msg: Record<string, unknown>) => unknown;
}

function createSidepanelHarness(options: SidepanelHarnessOptions = {}) {
  const source = fs.readFileSync(path.join(EXT_DIR, "sidepanel.js"), "utf8");

  const postedToIframe: Array<{ payload: Record<string, unknown>; targetOrigin: string }> = [];
  const storageData = new Map<string, unknown>();
  let storageReadCalls = 0;
  let storageWriteCalls = 0;

  const frameWindow = {
    postMessage(payload: Record<string, unknown>, targetOrigin: string) {
      postedToIframe.push({
        payload: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>,
        targetOrigin,
      });
    },
  };

  const frameListeners = new Map<string, Array<() => void>>();
  let frameAttrSrc = "https://fivenines-ops.fly.dev/?panel=1";
  const frameEl = {
    src: frameAttrSrc,
    contentWindow: frameWindow,
    getAttribute(name: string) {
      return name === "src" ? frameAttrSrc : null;
    },
    setAttribute(name: string, val: string) {
      if (name === "src") {
        frameAttrSrc = val;
        this.src = val;
      }
    },
    addEventListener(type: string, fn: () => void) {
      const list = frameListeners.get(type) || [];
      list.push(fn);
      frameListeners.set(type, list);
    },
  };

  const reloadListeners: Array<() => void> = [];
  const reloadBtnEl = {
    addEventListener(type: string, fn: () => void) {
      if (type === "click") reloadListeners.push(fn);
    },
    click() {
      for (const fn of reloadListeners) fn();
    },
  };

  let dashboardHref = "";
  const dashboardLinkEl = {
    setAttribute(name: string, val: string) {
      if (name === "href") dashboardHref = val;
    },
    getAttribute(name: string) {
      return name === "href" ? dashboardHref : null;
    },
  };

  const windowMessageListeners: Array<(ev: Record<string, unknown>) => void> = [];
  const runtimeMessageListeners: Array<(msg: Record<string, unknown>) => void> = [];

  const context = vm.createContext({
    URL,
    URLSearchParams,
    Promise,
    Set,
    Object,
    Array,
    String,
    Boolean,
    Error,
    JSON,
    encodeURIComponent,
    Number,
    Math,
    window: {
      location: {
        search: options.search || "",
      },
      addEventListener(type: string, listener: (ev: Record<string, unknown>) => void) {
        if (type === "message") windowMessageListeners.push(listener);
      },
    },
    document: {
      getElementById(id: string) {
        if (id === "toolkit-frame") return frameEl;
        if (id === "btn-reload-frame") return reloadBtnEl;
        if (id === "link-open-dashboard") return dashboardLinkEl;
        return null;
      },
    },
    chrome: {
      runtime: {
        lastError: null as { message: string } | null,
        sendMessage(msg: Record<string, unknown>, cb?: (res: unknown) => void) {
          const result = options.onRuntimeMessage
            ? options.onRuntimeMessage(msg)
            : { ok: true, payload: {} };
          if (cb) cb(result);
          return Promise.resolve(result);
        },
        onMessage: {
          addListener(fn: (msg: Record<string, unknown>) => void) {
            runtimeMessageListeners.push(fn);
          },
        },
      },
      storage: {
        local: {
          get(keys: string[], cb?: (items: Record<string, unknown>) => void) {
            storageReadCalls += 1;
            const out: Record<string, unknown> = {};
            for (const k of keys) {
              if (storageData.has(k)) out[k] = storageData.get(k);
            }
            if (cb) cb(out);
            return Promise.resolve(out);
          },
          set(items: Record<string, unknown>, cb?: () => void) {
            storageWriteCalls += 1;
            for (const [k, v] of Object.entries(items)) {
              storageData.set(k, v);
            }
            if (cb) cb();
            return Promise.resolve();
          },
        },
      },
    },
  });

  vm.runInContext(`${source}\nglobalThis.__allowedKeys = [...ALLOWED_STORAGE_KEYS];`, context);

  async function dispatchPanelPostMessage(
    data: Record<string, unknown>,
    origin = "https://fivenines-ops.fly.dev",
    sourceWin: unknown = frameWindow,
  ) {
    const before = postedToIframe.length;
    for (const listener of windowMessageListeners) {
      listener({ origin, source: sourceWin, data });
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
    return postedToIframe.slice(before);
  }

  function emitRuntimeMessage(msg: Record<string, unknown>) {
    for (const listener of runtimeMessageListeners) {
      listener(msg);
    }
  }

  return {
    allowedKeys: (context.__allowedKeys as string[]) || [],
    frameEl,
    reloadBtnEl,
    dashboardHref: () => dashboardHref,
    postedToIframe,
    storageData,
    getStorageStats: () => ({ storageReadCalls, storageWriteCalls }),
    dispatchPanelPostMessage,
    emitRuntimeMessage,
  };
}

test("sidepanel.js preserves ?panel=1 and ?view=... deep-linking, reload button, and strict origin checks", async () => {
  const defaultHarness = createSidepanelHarness();
  assert.equal(defaultHarness.frameEl.src, "https://fivenines-ops.fly.dev/?panel=1");
  assert.equal(defaultHarness.dashboardHref(), "https://fivenines-ops.fly.dev/");
  assert.deepEqual([...defaultHarness.allowedKeys].sort(), [...EXPECTED_STORAGE_ALLOWLIST].sort());

  const deepLinkHarness = createSidepanelHarness({ search: "?view=quote-builder" });
  assert.equal(deepLinkHarness.frameEl.src, "https://fivenines-ops.fly.dev/?panel=1&view=quote-builder");

  deepLinkHarness.emitRuntimeMessage({ type: "PF_NAVIGATE_VIEW", view: "dispatch" });
  assert.equal(deepLinkHarness.frameEl.src, "https://fivenines-ops.fly.dev/?panel=1&view=dispatch");
  deepLinkHarness.reloadBtnEl.click();
  assert.equal(deepLinkHarness.frameEl.src, "https://fivenines-ops.fly.dev/?panel=1&view=dispatch");

  const unsafeViewHarness = createSidepanelHarness({ search: "?view=javascript:alert(1)" });
  assert.equal(unsafeViewHarness.frameEl.src, "https://fivenines-ops.fly.dev/?panel=1");

  const untrustedReplies = await defaultHarness.dispatchPanelPostMessage(
    { type: "PF_EXT_BRIDGE", action: "captureThread", requestId: "evil-1" },
    "https://attacker.example.com",
  );
  assert.equal(untrustedReplies.length, 0);
});

test("sidepanel.js enforces exact 3-key chrome.storage.local allowlist on storageGet and storageSet", async () => {
  const harness = createSidepanelHarness();

  for (const allowedKey of EXPECTED_STORAGE_ALLOWLIST) {
    const sampleVal = allowedKey === "pf_panel_zoom" ? 110 : { filter: "unread", key: allowedKey };
    const [setRes] = await harness.dispatchPanelPostMessage({
      type: "PF_EXT_BRIDGE",
      action: "storageSet",
      requestId: `set-${allowedKey}`,
      payload: { key: allowedKey, value: sampleVal },
    });
    assert.ok(setRes);
    assert.equal(setRes.targetOrigin, "https://fivenines-ops.fly.dev");
    assert.equal(setRes.payload.type, "PF_EXT_BRIDGE_RES");
    assert.equal(setRes.payload.action, "storageSet");
    assert.equal(setRes.payload.requestId, `set-${allowedKey}`);
    assert.equal(setRes.payload.ok, true);

    const [getRes] = await harness.dispatchPanelPostMessage({
      type: "PF_EXT_BRIDGE",
      action: "storageGet",
      requestId: `get-${allowedKey}`,
      key: allowedKey,
    });
    assert.equal(getRes.payload.type, "PF_EXT_BRIDGE_RES");
    assert.equal(getRes.payload.action, "storageGet");
    assert.equal(getRes.payload.ok, true);
    assert.deepEqual(getRes.payload.value, sampleVal);
  }

  const statsAfterAllowed = harness.getStorageStats();
  assert.equal(statsAfterAllowed.storageWriteCalls, 3);
  assert.equal(statsAfterAllowed.storageReadCalls, 3);

  const disallowedKeys = [
    ["TAI", "API", "KEY"].join("_"),
    "pf_saved_draft_payload",
    "oauth_access_token",
    "",
  ];

  for (const badKey of disallowedKeys) {
    const [badSet] = await harness.dispatchPanelPostMessage({
      type: "PF_EXT_BRIDGE",
      action: "storageSet",
      requestId: `bad-set-${badKey}`,
      key: badKey,
      value: "forbidden",
    });
    assert.equal(badSet.payload.ok, false);
    assert.equal(badSet.payload.error, "disallowed_storage_key");
    assert.equal(harness.storageData.has(badKey), false);

    const [badGet] = await harness.dispatchPanelPostMessage({
      type: "PF_EXT_BRIDGE",
      action: "storageGet",
      requestId: `bad-get-${badKey}`,
      key: badKey,
    });
    assert.equal(badGet.payload.ok, false);
    assert.equal(badGet.payload.error, "disallowed_storage_key");
  }

  const [mixedBatch] = await harness.dispatchPanelPostMessage({
    type: "PF_EXT_BRIDGE",
    action: "storageGet",
    requestId: "bad-batch",
    keys: ["pf_panel_zoom", "pf_unallowed_draft"],
  });
  assert.equal(mixedBatch.payload.ok, false);
  assert.equal(mixedBatch.payload.error, "disallowed_storage_key");

  const statsAfterRejected = harness.getStorageStats();
  assert.equal(statsAfterRejected.storageWriteCalls, 3, "disallowed storageSet must never invoke chrome.storage.local.set");
  assert.equal(statsAfterRejected.storageReadCalls, 3, "disallowed storageGet must never invoke chrome.storage.local.get");
});

test("sidepanel.js bridges captureThread, captureAttachments, insertReply, and legacy FIVENINES_* messages", async () => {
  const mockThread = {
    subject: "Tender PO 42705 - Beaver Falls PA to Lithonia GA",
    sender: "dispatch@acmemetals.com",
    timestamp: "Nov 18, 2026, 8:15 AM",
    bodyText: "Please cover 48ft flatbed w/ 8ft tarps, 38,644 lbs.",
    permalink: "https://mail.google.com/mail/u/0/#inbox/FMfcgzQXJkLmNoPq",
    messageId: "FMfcgzQXJkLmNoPq",
    attachments: [
      {
        id: "att-1",
        name: "Tender_42705.pdf",
        fileName: "Tender_42705.pdf",
        mimeType: "application/pdf",
        downloadUrl: "https://mail.google.com/mail/u/0?ui=2&attid=0.1",
      },
    ],
  };

  const seenRuntimeMessages: Array<Record<string, unknown>> = [];
  const harness = createSidepanelHarness({
    onRuntimeMessage(msg) {
      seenRuntimeMessages.push(msg);
      if (msg.type === "PF_BG_CAPTURE_THREAD" || msg.type === "CAPTURE_ACTIVE_GMAIL") {
        return { ok: true, payload: mockThread };
      }
      if (msg.type === "PF_BG_CAPTURE_ATTACHMENTS") {
        return { ok: true, payload: { attachments: mockThread.attachments } };
      }
      if (msg.type === "PF_BG_INSERT_REPLY") {
        return { ok: true, message: "Inserted into Gmail reply" };
      }
      return { ok: false, error: "unexpected" };
    },
  });

  const [threadRes] = await harness.dispatchPanelPostMessage({
    type: "PF_EXT_BRIDGE",
    action: "captureThread",
    requestId: "req-thread-1",
  });
  assert.deepEqual(threadRes.payload, {
    type: "PF_EXT_BRIDGE_RES",
    action: "captureThread",
    requestId: "req-thread-1",
    ok: true,
    payload: mockThread,
  });

  const [attRes] = await harness.dispatchPanelPostMessage({
    type: "PF_EXT_BRIDGE",
    action: "captureAttachments",
    requestId: "req-att-1",
  });
  assert.deepEqual(attRes.payload, {
    type: "PF_EXT_BRIDGE_RES",
    action: "captureAttachments",
    requestId: "req-att-1",
    ok: true,
    payload: { attachments: mockThread.attachments },
  });

  const [replyRes] = await harness.dispatchPanelPostMessage({
    type: "PF_EXT_BRIDGE",
    action: "insertReply",
    requestId: "req-reply-1",
    payload: {
      text: "Rate Quote: $3,050 all-in on 48ft Flatbed w/ tarps.",
      subject: "Re: Tender PO 42705",
    },
  });
  assert.equal(replyRes.payload.type, "PF_EXT_BRIDGE_RES");
  assert.equal(replyRes.payload.action, "insertReply");
  assert.equal(replyRes.payload.requestId, "req-reply-1");
  assert.equal(replyRes.payload.ok, true);
  assert.equal(replyRes.payload.message, "Inserted into Gmail reply");

  const [legacyRes] = await harness.dispatchPanelPostMessage({
    type: "FIVENINES_CAPTURE_GMAIL_REQ",
    requestId: "legacy-1",
  });
  assert.deepEqual(legacyRes.payload, {
    type: "FIVENINES_GMAIL_CAPTURED",
    requestId: "legacy-1",
    ok: true,
    payload: mockThread,
  });

  const countBeforeContext = harness.postedToIframe.length;
  harness.emitRuntimeMessage({ type: "PF_GMAIL_THREAD_CHANGED", payload: mockThread });
  const contextPosts = harness.postedToIframe.slice(countBeforeContext);
  assert.ok(contextPosts.some((p) => p.payload.type === "FIVENINES_GMAIL_CONTEXT"));
  assert.equal(seenRuntimeMessages.length, 4);
});

test("capture.js and background.js extract Gmail thread + attachments and click Reply + insert draft cleanly", async () => {
  const captureSource = fs.readFileSync(path.join(EXT_DIR, "capture.js"), "utf8");
  const backgroundSource = fs.readFileSync(path.join(EXT_DIR, "background.js"), "utf8");

  let composeBoxMounted = false;
  let replyButtonClicked = 0;
  const dispatchedEditorEvents: string[] = [];

  const composeEditor = {
    innerHTML: "",
    textContent: undefined as string | undefined,
    isConnected: true,
    hidden: false,
    focus() {},
    getAttribute(name: string) {
      if (name === "role") return "textbox";
      if (name === "contenteditable") return "true";
      if (name === "aria-label") return "Message Body";
      return null;
    },
    querySelector() {
      return null;
    },
    dispatchEvent(ev: { type: string }) {
      dispatchedEditorEvents.push(ev.type);
      return true;
    },
  };

  const replyButton = {
    isConnected: true,
    hidden: false,
    innerText: "Reply",
    getAttribute(name: string) {
      if (name === "role") return "button";
      if (name === "aria-label") return "Reply";
      return null;
    },
    click() {
      replyButtonClicked += 1;
      setTimeout(() => {
        composeBoxMounted = true;
      }, 20);
    },
  };

  const subjectHeading = {
    innerText: "Load Tender #88412 - Houston TX to Tulsa OK",
    isConnected: true,
    getAttribute(name: string) {
      if (name === "data-legacy-thread-id") return "1933f9a00112233";
      return null;
    },
  };

  const senderSpan = {
    innerText: "Jane Doe",
    isConnected: true,
    getAttribute(name: string) {
      if (name === "email") return "shipping@acmemetals.com";
      if (name === "name") return "Jane Doe";
      return null;
    },
  };

  const timeSpan = {
    innerText: "9:42 AM",
    isConnected: true,
    getAttribute(name: string) {
      if (name === "title") return "Wed, Nov 18, 2026, 9:42 AM";
      return null;
    },
  };

  const messageNode = {
    isConnected: true,
    getAttribute(name: string) {
      if (name === "data-legacy-message-id") return "msg-88412-a";
      return null;
    },
  };

  const bodyNode = {
    innerText: "Pickup 1200 Industrial Pkwy Houston TX 77015 -> Drop 4500 Commerce Rd Tulsa OK 74107",
    isConnected: true,
    closest() {
      return null;
    },
  };

  const chipAttachment = {
    isConnected: true,
    getAttribute(name: string) {
      if (name === "download_url") {
        return "application/pdf:RateCon_88412.pdf:https://mail.google.com/mail/u/0?ui=2&ik=abc&attid=0.1";
      }
      return null;
    },
    querySelector(sel: string) {
      if (sel.includes(".SaH2Ve")) return { innerText: "148 KB" };
      return null;
    },
  };

  const inlineAttachment = {
    isConnected: true,
    closest() {
      return null;
    },
    getAttribute(name: string) {
      if (name === "href") return "data:application/pdf;base64,JVBERi0xLjQK";
      if (name === "download") return "Inline_BOL.pdf";
      return null;
    },
  };

  const mainContainer = {
    isConnected: true,
    innerText: "Load Tender #88412",
    querySelector(sel: string) {
      if (sel.includes("h2.hP")) return subjectHeading;
      return null;
    },
    querySelectorAll(sel: string) {
      if (sel.includes("span[email]")) return [senderSpan];
      if (sel.includes("span.g3")) return [timeSpan];
      if (sel.includes("[data-legacy-message-id]")) return [messageNode];
      if (sel === ".a3s.aiL, .a3s") return [bodyNode];
      if (sel === "[download_url]") return [chipAttachment];
      if (sel.includes(".aZo")) return [];
      if (sel.includes('img[src^="data:"]')) return [inlineAttachment];
      return [];
    },
  };

  let captureListener: ((msg: Record<string, unknown>, sender: unknown, sendResponse: (r: unknown) => void) => boolean) | null = null;

  class MockEvent {
    type: string;
    bubbles: boolean;
    constructor(type: string, init?: { bubbles?: boolean }) {
      this.type = type;
      this.bubbles = Boolean(init?.bubbles);
    }
  }

  const captureContext = vm.createContext({
    Event: MockEvent,
    URL,
    Date,
    Promise,
    Set,
    String,
    Boolean,
    setTimeout,
    decodeURIComponent,
    Number,
    Math,
    window: {
      location: {
        href: "https://mail.google.com/mail/u/0/#inbox/FMfcgzQXJkLmNoPq",
        origin: "https://mail.google.com",
        hash: "#inbox/FMfcgzQXJkLmNoPq",
      },
      addEventListener() {},
    },
    document: {
      querySelectorAll(sel: string) {
        if (sel === '[role="main"]') return [mainContainer];
        if (sel === '[role="textbox"][contenteditable="true"]') {
          return composeBoxMounted ? [composeEditor] : [];
        }
        if (sel.includes('[role="button"]')) return [replyButton];
        if (sel === 'input[name="subjectbox"]') return [];
        return [];
      },
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(fn: typeof captureListener) {
            captureListener = fn;
          },
        },
        sendMessage() {
          return Promise.resolve();
        },
      },
    },
  });

  vm.runInContext(captureSource, captureContext);
  assert.ok(captureListener, "capture.js must register chrome.runtime.onMessage listener");

  let backgroundListener: ((msg: Record<string, unknown>, sender: unknown, sendResponse: (r: unknown) => void) => boolean) | null = null;
  let injectedCaptureScriptCount = 0;
  let scriptReadyInTab = false;

  const backgroundContext = vm.createContext({
    Promise,
    chrome: {
      sidePanel: {
        setPanelBehavior() {
          return Promise.resolve();
        },
      },
      tabs: {
        query() {
          return Promise.resolve([{ id: 77, url: "https://mail.google.com/mail/u/0/#inbox/FMfcgzQXJkLmNoPq" }]);
        },
        sendMessage(_tabId: number, tabMessage: Record<string, unknown>) {
          if (!scriptReadyInTab) {
            return Promise.reject(new Error("Receiving end does not exist."));
          }
          return new Promise((resolve) => {
            captureListener!(tabMessage, {}, (res) => resolve(res));
          });
        },
      },
      scripting: {
        executeScript(opts: { target: { tabId: number }; files: string[] }) {
          assert.equal(opts.target.tabId, 77);
          assert.deepEqual(Array.from(opts.files), ["capture.js"]);
          injectedCaptureScriptCount += 1;
          scriptReadyInTab = true;
          return Promise.resolve();
        },
      },
      runtime: {
        onMessage: {
          addListener(fn: typeof backgroundListener) {
            backgroundListener = fn;
          },
        },
      },
    },
  });

  vm.runInContext(backgroundSource, backgroundContext);
  assert.ok(backgroundListener, "background.js must register chrome.runtime.onMessage listener");

  const sendToBg = (msg: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      backgroundListener!(msg, {}, (res) => resolve(res as Record<string, unknown>));
    });

  const capturedRes = await sendToBg({ type: "PF_BG_CAPTURE_THREAD" });
  assert.equal(injectedCaptureScriptCount, 1, "background.js should auto-inject capture.js on first tab miss");
  assert.equal(capturedRes.ok, true);

  const payload = capturedRes.payload as Record<string, unknown>;
  assert.equal(payload.subject, "Load Tender #88412 - Houston TX to Tulsa OK");
  assert.equal(payload.sender, "shipping@acmemetals.com");
  assert.equal(payload.timestamp, "Wed, Nov 18, 2026, 9:42 AM");
  assert.equal(payload.messageId, "msg-88412-a");
  assert.match(String(payload.bodyText), /1200 Industrial Pkwy/);

  const attachments = payload.attachments as Array<Record<string, unknown>>;
  assert.equal(attachments.length, 2);
  assert.equal(attachments[0].filename, "RateCon_88412.pdf");
  assert.equal(attachments[0].fileName, "RateCon_88412.pdf");
  assert.equal(attachments[0].mimeType, "application/pdf");
  assert.equal(attachments[0].sizeText, "148 KB");
  assert.equal(attachments[0].sizeBytes, 148 * 1024);
  assert.equal(attachments[1].filename, "Inline_BOL.pdf");
  assert.equal(attachments[1].fileName, "Inline_BOL.pdf");
  assert.equal(attachments[1].dataBase64, "JVBERi0xLjQK");
  assert.equal(attachments[1].base64, "JVBERi0xLjQK");

  const attOnlyRes = await sendToBg({ type: "PF_BG_CAPTURE_ATTACHMENTS" });
  assert.equal(attOnlyRes.ok, true);
  assert.equal(((attOnlyRes.payload as Record<string, unknown>).attachments as unknown[]).length, 2);

  assert.equal(composeBoxMounted, false);
  const insertRes = await sendToBg({
    type: "PF_BG_INSERT_REPLY",
    payload: {
      text: "Confirmed $2,050 all-in flatbed\nDriver ETA 08:00",
    },
  });
  assert.equal(insertRes.ok, true);
  assert.equal(insertRes.message, "Inserted into Gmail reply");
  assert.equal(replyButtonClicked, 1, "capture.js should click Gmail Reply button when no editor is open");
  assert.equal(composeBoxMounted, true);
  assert.match(composeEditor.innerHTML, /Confirmed \$2,050 all-in flatbed<br>Driver ETA 08:00/);
  assert.deepEqual(dispatchedEditorEvents, ["input", "change"]);
});
