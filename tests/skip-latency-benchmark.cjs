"use strict";

// Optional end-to-end latency harness: isolated headed Chromium, the real MV3
// extension and a locally fulfilled page whose skip button is revealed exactly
// like YouTube's (aria-hidden removal starting an opacity fade-in). It measures
// reveal -> worker request -> trusted click on the page's own clock, in the
// foreground, a background tab and a minimized window. No real YouTube traffic.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const option = (key, fallback) => {
  const index = argv.indexOf(key);
  return index === -1 ? fallback : argv[index + 1];
};
const label = option("--label", "candidate");
assert.match(label, /^[a-zA-Z0-9_.-]+$/, "Label must be a simple artifact name");
const samples = Number(option("--samples", "15"));
assert.ok(Number.isInteger(samples) && samples >= 5 && samples <= 40, "Use 5 through 40 samples per mode");
const modes = option("--modes", "foreground,background-tab,minimized-window").split(",");
const output = path.join(root, "dist", `skip-latency-${label}.json`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || "playwright-core");
const executable = process.env.FIXTURE_CHROMIUM_PATH || chromium.executablePath();

function wav() {
  const count = 8000 * 60, bytes = Buffer.alloc(44 + count, 128);
  bytes.write("RIFF"); bytes.writeUInt32LE(36 + count, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(8000, 28); bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34); bytes.write("data", 36); bytes.writeUInt32LE(count, 40);
  return "data:audio/wav;base64," + bytes.toString("base64");
}
const media = wav();
// The skip button rules mirror YouTube's www-player.css.
const html = `<!doctype html><meta charset="utf-8"><title>Skip latency benchmark</title>
  <style>body{margin:0}.html5-video-player{position:relative;width:640px;height:360px}
  video{width:640px;height:360px}
  .ytp-skip-ad-button{position:absolute;right:22px;bottom:95px;height:36px;width:120px;
    transition:opacity .5s cubic-bezier(0,0,.2,1)}
  .ytp-skip-ad-button[aria-hidden=true]{opacity:0;transition:opacity .1s cubic-bezier(.4,0,1,1)}</style>
  <div class="html5-video-player ad-showing">
  <video class="html5-main-video" autoplay loop src="${media}"></video>
  <div class="ytp-skip-ad"><button class="ytp-skip-ad-button" aria-hidden="true">Skip</button></div></div>
  <script>window.bench={clicks:[]};
  document.querySelector('button').addEventListener('click',e=>{
    window.bench.clicks.push({at:Date.now(),trusted:e.isTrusted});
    if(e.isTrusted){document.querySelector('.html5-video-player').classList.remove('ad-showing');
      e.target.setAttribute('aria-hidden','true');}
  });</script>`;

// Reload cycle page: the ad player exists early, while a slow parser-blocking
// script (like a large YouTube bundle) delays DOMContentLoaded and document_idle.
const reloadHtml = ad => `<!doctype html><meta charset="utf-8"><title>Reload latency benchmark</title>
  <div class="html5-video-player${ad ? " ad-showing" : ""}" style="width:640px;height:360px">
  <video class="html5-main-video" autoplay loop src="${media}"></video></div>
  <script src="https://www.youtube.com/slow-bundle.js"></script><p>loaded</p>`;

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = fraction => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return { n: sorted.length, minMs: sorted[0], p50Ms: rank(0.5), p95Ms: rank(0.95), maxMs: sorted.at(-1),
    meanMs: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)) };
}
async function eventually(check, description, timeout = 10000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await delay(20);
  }
  throw new Error(description + (last ? ": " + last.message : ""));
}

(async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
  const result = { label, version: manifest.version, startedAt: new Date().toISOString(), realYouTubeAdTest: false,
    measurement: "page Date.now at aria-hidden removal -> page Date.now of the trusted click; worker receipt via passive listener",
    samplesPerMode: samples, modes: {} };
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-skip-latency-"));
  let browser, browserProcess;
  try {
    // Native launch without Playwright defaults keeps real hidden/minimized state.
    browserProcess = spawn(executable, ["--user-data-dir=" + profile, "--remote-debugging-port=0", "--no-first-run",
      "--no-default-browser-check", "--window-size=1000,720", "--disable-sync",
      "--disable-extensions-except=" + root, "--load-extension=" + root,
      "--autoplay-policy=no-user-gesture-required", "--mute-audio", "about:blank"], { stdio: "ignore", windowsHide: true });
    let port;
    await eventually(async () => {
      port = (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0];
      return /^\d+$/.test(port);
    }, "Chromium did not expose its debugging port");
    browser = await chromium.connectOverCDP("http://127.0.0.1:" + port, { noDefaults: true });
    const context = browser.contexts()[0];
    const worker = await eventually(async () => {
      for (const candidate of context.serviceWorkers()) {
        if (!candidate.url().endsWith("/background.js")) continue;
        const loaded = await candidate.evaluate(() => chrome.runtime.getManifest()).catch(() => ({}));
        if (loaded.name === manifest.name && loaded.version === manifest.version) return candidate;
      }
      return undefined;
    }, "The intended extension worker did not start");
    await worker.evaluate(() => {
      self.benchMessages = [];
      chrome.runtime.onMessage.addListener((message, sender) => {
        if (message.type === "skip-ad") self.benchMessages.push({ at: Date.now(), tabId: sender.tab?.id });
      });
      return chrome.storage.local.set({ enabled: true, maxReloads: 1 });
    });
    if (argv.includes("--trace")) {
      // Diagnostic only: time each extension API call made by the worker.
      await worker.evaluate(() => {
        self.benchTrace = [];
        const wrap = (owner, name, labelOf) => {
          const original = owner[name].bind(owner);
          owner[name] = (...args) => {
            const start = Date.now(), entry = { call: labelOf(args), start };
            self.benchTrace.push(entry);
            const value = original(...args);
            Promise.resolve(value).finally(() => { entry.ms = Date.now() - start; });
            return value;
          };
        };
        wrap(chrome.debugger, "sendCommand", args => args[1] + (args[2]?.type ? ":" + args[2].type : ""));
        wrap(chrome.debugger, "attach", () => "attach");
        wrap(chrome.debugger, "detach", () => "detach");
        wrap(chrome.tabs, "sendMessage", args => "tabs.sendMessage:" + args[1]?.type);
        wrap(chrome.tabs, "get", () => "tabs.get");
        wrap(chrome.windows, "get", () => "windows.get");
      });
    }
    const served = new Map();
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.protocol === "chrome-extension:") return route.continue();
      if (url.origin === "https://www.youtube.com" && url.pathname === "/slow-bundle.js") {
        await delay(800);
        return route.fulfill({ contentType: "text/javascript", body: "" });
      }
      if (url.origin !== "https://www.youtube.com" || url.pathname !== "/watch") return route.abort();
      const id = url.searchParams.get("v");
      if (!id.startsWith("reload-")) return route.fulfill({ contentType: "text/html", body: html });
      const times = served.get(id) || [];
      served.set(id, times);
      times.push(Date.now());
      return route.fulfill({ contentType: "text/html", body: reloadHtml(times.length <= 3) });
    });

    if (argv.includes("--reload")) {
      // Default budget of three reloads; measure document served -> reload request.
      await worker.evaluate(() => chrome.storage.local.set({ enabled: true, maxReloads: 3 }));
      await worker.evaluate(() => {
        self.benchReloads = [];
        chrome.runtime.onMessage.addListener((message, sender) => {
          if (message.type === "reload-ad") self.benchReloads.push({ at: Date.now(), url: message.url });
        });
      });
      const cycles = [], perReload = [];
      for (let index = 0; index < samples; index += 1) {
        const id = "reload-" + index, page = await context.newPage();
        await page.bringToFront();
        await page.goto("https://www.youtube.com/watch?v=" + id, { waitUntil: "commit" });
        await eventually(() => (served.get(id) || []).length === 4, "Reload cycle did not reach the main video", 20000);
        await delay(300);
        const requests = (await worker.evaluate(() => self.benchReloads)).filter(item => item.url.endsWith("v=" + id));
        assert.equal(requests.length, 3, "Expected exactly three reloads");
        const times = served.get(id);
        requests.forEach((request, k) => perReload.push(request.at - times[k]));
        cycles.push(times[3] - times[0]);
        await page.close();
      }
      result.reload = { servedToRequest: summarize(perReload), firstServeToMainVideo: summarize(cycles) };
      console.log("RELOAD " + JSON.stringify({ label, ...result.reload }));
      await worker.evaluate(() => chrome.storage.local.set({ maxReloads: 1 }));
    }

    for (const mode of argv.includes("--reload") ? [] : modes) {
      const oldPages = new Set(context.pages());
      const created = await worker.evaluate(() => chrome.windows.create({ url: "about:blank", focused: true }));
      const windowId = created.id, tabId = created.tabs[0].id, videoId = "latency-" + mode;
      const page = await eventually(() => context.pages().find(item => !oldPages.has(item)), "Missing benchmark window");
      // An exhausted reload budget isolates the skip path from reloads.
      await worker.evaluate(({ tabId, videoId }) => chrome.storage.session.set({ ["ad-reload:" + tabId]: {
        videoId, reloadCount: 1, lastReloadAt: Date.now() - 10000, sourceDocumentId: "latency-precondition" } }),
      { tabId, videoId });
      await page.goto("https://www.youtube.com/watch?v=" + videoId, { waitUntil: "domcontentloaded" });
      await page.bringToFront();
      const setup = await context.newCDPSession(page);
      await setup.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await page.evaluate(() => document.querySelector("video").play());
      await eventually(() => page.evaluate(() => { const v = document.querySelector("video");
        return v.readyState >= 2 && !v.paused && v.currentTime > 0; }), "Benchmark media did not play");
      await setup.send("Emulation.setFocusEmulationEnabled", { enabled: false });
      await setup.detach();
      if (mode === "background-tab") {
        await worker.evaluate(windowId => chrome.tabs.create({ windowId, url: "about:blank", active: true }), windowId);
      } else if (mode === "minimized-window") {
        await worker.evaluate(windowId => chrome.windows.update(windowId, { state: "minimized" }), windowId);
      }
      if (mode !== "foreground") {
        await eventually(() => page.evaluate(() => document.visibilityState === "hidden"), mode + ": page did not hide");
      }
      const status = () => worker.evaluate(tabId =>
        chrome.tabs.sendMessage(tabId, { type: "automation-content-status" }, { frameId: 0 }), tabId);
      await eventually(async () => { const s = await status();
        return s.state?.ready === true && s.state.reloadCount === 1 && s.adPlayers === 1; }, mode + ": content not ready");

      const raw = [];
      for (let index = 0; index < samples; index += 1) {
        // Spread reveals across the content script's 1s backup poll phase.
        await delay(1600 + Math.floor(index * 1000 / samples));
        const reveal = await page.evaluate(() => {
          document.querySelector(".html5-video-player").classList.add("ad-showing");
          window.bench.clicks = [];
          const at = Date.now();
          document.querySelector("button").removeAttribute("aria-hidden");
          return { at, visibility: document.visibilityState, focused: document.hasFocus() };
        });
        if (mode !== "foreground") assert.equal(reveal.visibility, "hidden");
        const click = await eventually(() => page.evaluate(() => window.bench.clicks.find(item => item.trusted)),
          mode + ": no trusted click for sample " + index, 6000);
        const request = (await worker.evaluate(() => self.benchMessages)).filter(item =>
          item.tabId === tabId && item.at >= reveal.at - 5).at(0);
        await delay(100);
        const trace = await worker.evaluate(() => { const t = self.benchTrace; if (t) self.benchTrace = [];
          self.benchMessages = []; return t; });
        raw.push({ index, totalMs: click.at - reveal.at, requestMs: request ? request.at - reveal.at : null,
          workerToClickMs: request ? click.at - request.at : null, visibility: reveal.visibility,
          ...(trace && request ? { trace: trace.filter(item => item.start >= request.at - 5)
            .map(item => ({ call: item.call, atMs: item.start - request.at, ms: item.ms })) } : {}) });
      }
      const pick = key => raw.map(item => item[key]).filter(value => typeof value === "number");
      result.modes[mode] = { total: summarize(pick("totalMs")), revealToRequest: summarize(pick("requestMs")),
        requestToClick: summarize(pick("workerToClickMs")), raw };
      console.log("MODE " + JSON.stringify({ label, mode, total: result.modes[mode].total,
        revealToRequest: result.modes[mode].revealToRequest, requestToClick: result.modes[mode].requestToClick }));
      await worker.evaluate(windowId => chrome.windows.remove(windowId), windowId);
    }
    result.finishedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(result, null, 2));
    console.log("RESULT " + output);
  } finally {
    if (browser) {
      await browser.newBrowserCDPSession().then(session => session.send("Browser.close")).catch(() => {});
      await browser.close().catch(() => {});
    }
    if (browserProcess && browserProcess.exitCode === null) {
      await Promise.race([new Promise(resolve => browserProcess.once("exit", resolve)), delay(2000)]);
      if (browserProcess.exitCode === null) browserProcess.kill();
    }
    assert.ok(path.basename(profile).startsWith("youtube-skip-latency-"));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
