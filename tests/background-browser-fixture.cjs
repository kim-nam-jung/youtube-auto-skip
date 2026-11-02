"use strict";

// Real window/tab state, isolated Chromium + MV3, local playable fixtures.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || "playwright-core");
const root = path.resolve(__dirname, "..");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const origin = "https://www.youtube.com";
function wav() {
  const samples = 8000 * 60, b = Buffer.alloc(44 + samples, 128);
  b.write("RIFF"); b.writeUInt32LE(36 + samples, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(samples, 40);
  return "data:audio/wav;base64," + b.toString("base64");
}
const media = wav();
function html(reloaded) {
  return `<!doctype html><meta charset="utf-8"><title>Background ad regression fixture</title>
    <style>body{margin:0}.html5-video-player{position:relative;width:640px;height:360px}
    video{width:640px;height:360px}button{position:absolute;right:20px;bottom:20px;width:140px;height:44px}</style>
    <div class="html5-video-player ${reloaded ? "ad-showing" : ""}">
    <video class="html5-main-video" autoplay loop src="${media}"></video>
    <button class="ytp-skip-ad-button">Skip ad</button></div>
    <script>window.fixtureClicks=[];document.querySelector('button').addEventListener('click',e=>{
      window.fixtureClicks.push({trusted:e.isTrusted,visibility:document.visibilityState,focused:document.hasFocus()});
      if(e.isTrusted)document.querySelector('.html5-video-player').classList.remove('ad-showing');
    });</script>`;
}
async function eventually(check, label, timeout = 12000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try { if (await check()) return; } catch (error) { last = error; }
    await delay(100);
  }
  throw new Error(label + (last ? ": " + last.message : ""));
}
(async () => {
  if (!process.env.BACKGROUND_FIXTURE_MODE) {
    for (const mode of ["background-tab", "unfocused-window", "minimized-window"]) {
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [__filename], { stdio: "inherit", windowsHide: true,
          env: { ...process.env, BACKGROUND_FIXTURE_MODE: mode } });
        child.once("error", reject);
        child.once("exit", code => code === 0 ? resolve() : reject(new Error(mode + " failed: " + code)));
      });
    }
    return;
  }
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-background-fixture-"));
  let context, browser, browserProcess;
  const result = { source: "isolated headed Chromium, real window/tab state and local playable fixtures",
    browserExecutable: path.basename(process.env.FIXTURE_CHROMIUM_PATH || chromium.executablePath()),
    realYouTubeAdTest: false, sourceHashes: {}, checks: [] };
  for (const name of ["content.js", "background.js", "popup.js", "manifest.json"]) {
    result.sourceHashes[name] = crypto.createHash("sha256").update(await fs.readFile(path.join(root, name))).digest("hex");
  }
  try {
    // Connect with noDefaults: Playwright's usual focus emulation keeps hidden
    // pages artificially visible. Native launch also retains background timers.
    browserProcess = spawn(process.env.FIXTURE_CHROMIUM_PATH || chromium.executablePath(), [
      "--user-data-dir=" + profile, "--remote-debugging-port=0", "--no-first-run",
      "--no-default-browser-check", "--window-size=1000,720", "--disable-sync",
      "--disable-extensions-except=" + root, "--load-extension=" + root,
      "--autoplay-policy=no-user-gesture-required", "--mute-audio", "about:blank"
    ], { stdio: "ignore", windowsHide: true });
    let debugPort;
    await eventually(async () => {
      debugPort = (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0];
      return /^\d+$/.test(debugPort);
    }, "Isolated Chrome did not expose its debugging port");
    browser = await chromium.connectOverCDP("http://127.0.0.1:" + debugPort, { noDefaults: true });
    context = browser.contexts()[0];
    let worker;
    const expected = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
    await eventually(async () => {
      for (const candidate of context.serviceWorkers()) {
        if (!candidate.url().endsWith("/background.js")) continue;
        const manifest = await candidate.evaluate(() => chrome.runtime.getManifest()).catch(() => ({}));
        if (manifest.name === expected.name && manifest.version === expected.version) { worker = candidate; return true; }
      }
      return false;
    }, "The intended extension worker was not loaded");
    const actual = await worker.evaluate(() => fetch(chrome.runtime.getURL("background.js")).then(r => r.text()));
    assert.equal(crypto.createHash("sha256").update(actual).digest("hex"), result.sourceHashes["background.js"]);
    await worker.evaluate(() => {
      self.fixtureMessages = [];
      chrome.runtime.onMessage.addListener((m, s) => {
        self.fixtureMessages.push({ type: m.type, url: m.url, tabId: s.tab?.id, at: Date.now() });
      });
      return chrome.storage.local.set({ enabled: true, maxReloads: 1 });
    });
    const loads = new Map();
    await context.route("**/*", route => {
      const u = new URL(route.request().url());
      if (u.protocol === "chrome-extension:") return route.continue();
      if (u.origin !== origin || u.pathname !== "/watch") return route.abort();
      const id = u.searchParams.get("v");
      loads.set(id, (loads.get(id) || 0) + 1);
      return route.fulfill({ contentType: "text/html", body: html(loads.get(id) > 1) });
    });
    const modes = ["background-tab", "unfocused-window", "minimized-window"];
    const requestedMode = process.env.BACKGROUND_FIXTURE_MODE;
    if (requestedMode) assert.ok(modes.includes(requestedMode));
    for (const mode of requestedMode ? [requestedMode] : modes) {
      const oldPages = new Set(context.pages());
      const created = await worker.evaluate(() => chrome.windows.create({ url: "about:blank", focused: true }));
      const windowId = created.id, tabId = created.tabs[0].id;
      await eventually(() => context.pages().some(p => !oldPages.has(p)), "Missing test window");
      const page = context.pages().find(p => !oldPages.has(p));
      const id = "background-" + mode;
      await page.goto(origin + "/watch?v=" + id, { waitUntil: "domcontentloaded" });
      await page.bringToFront();
      // Aside can initially host an automation tab offscreen. Bootstrap real
      // media decoding while visible, then remove the override before testing
      // any background action. No ad is present during this setup.
      const setupSession = await context.newCDPSession(page);
      await setupSession.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      console.log("MEDIA_START " + JSON.stringify(await page.evaluate(async () => {
        const v = document.querySelector("video");
        let playError;
        try { await Promise.race([v.play(), new Promise((_, reject) => setTimeout(() => reject(new Error('play timeout')), 5000))]); } catch (e) { playError = String(e); }
        return { readyState: v.readyState, paused: v.paused, error: v.error?.message, playError,
          visibility: document.visibilityState, focused: document.hasFocus() };
      })));
      await eventually(() => page.evaluate(() => {
        const v = document.querySelector("video");
        return v.readyState >= 2 && !v.paused && v.currentTime > 0;
      }), "Fixture media did not play");
      await setupSession.send("Emulation.setFocusEmulationEnabled", { enabled: false });
      await setupSession.detach();
      await eventually(() => worker.evaluate(id => self.fixtureMessages.some(m => m.url?.endsWith(id) && m.type === "ad-reload-state"), id), "Missing content handshake");
      let otherWindow;
      if (mode === "background-tab") {
        await worker.evaluate(windowId => chrome.tabs.create({ windowId, url: "about:blank", active: true }), windowId);
      } else if (mode === "unfocused-window") {
        otherWindow = await worker.evaluate(() => chrome.windows.create({ url: "about:blank", focused: true }));
      } else {
        await worker.evaluate(windowId => chrome.windows.update(windowId, { state: "minimized" }), windowId);
      }
      const nativeState = inspect => process.platform === "win32" && mode === "minimized-window" ?
        JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-File", path.join(__dirname, "minimize-owned-fixture.ps1"),
          "-BrowserProcessId", String(browserProcess.pid), "-BrowserExecutable", process.env.FIXTURE_CHROMIUM_PATH || chromium.executablePath(),
          ...(inspect ? ["-Inspect"] : [])], { encoding: "utf8", windowsHide: true })) : null;
      const nativeBefore = nativeState(false);
      const state = () => worker.evaluate(async ({ tabId, windowId }) => {
        const t = await chrome.tabs.get(tabId), w = await chrome.windows.get(windowId);
        return { active: t.active, windowFocused: w.focused, windowState: w.state };
      }, { tabId, windowId });
      const isBackground = s => mode === "background-tab" ? !s.active :
        mode === "minimized-window" ? (nativeBefore ? nativeBefore.allMinimized && !nativeBefore.foregroundInProcess : s.windowState === "minimized" && !s.windowFocused) : !s.windowFocused;
      await eventually(async () => isBackground(await state()), "Native background state not reached");
      const before = await state();
      await eventually(() => page.evaluate(() => !document.hasFocus()), "Document focus did not follow the native window");
      if (mode !== "unfocused-window") {
        await eventually(() => page.evaluate(() => document.visibilityState === "hidden"), mode + ": document did not become hidden");
      }
      const visibility = await page.evaluate(() => ({ visibility: document.visibilityState, focused: document.hasFocus() }));
      assert.equal(visibility.focused, false);
      if (mode !== "unfocused-window") assert.equal(visibility.visibility, "hidden");
      await page.evaluate(() => { document.querySelector("video").pause(); document.querySelector(".html5-video-player").classList.add("ad-showing"); });
      await delay(1500);
      assert.equal(loads.get(id), 1);
      assert.equal(await page.evaluate(() => window.fixtureClicks.length), 0);
      const start = Date.now();
      await page.evaluate(() => document.querySelector("video").play());
      await eventually(() => loads.get(id) === 2, mode + ": no background reload");
      try {
        await eventually(() => page.evaluate(() => window.fixtureClicks?.some(c => c.trusted)), mode + ": no trusted background skip");
      } catch (error) {
        console.log("FAILED_STATE " + JSON.stringify({ mode, state: await state(),
          document: await page.evaluate(() => { const v=document.querySelector('video'),b=document.querySelector('button'),r=b.getBoundingClientRect();return {visibility:document.visibilityState,focused:document.hasFocus(),paused:v.paused,readyState:v.readyState,time:v.currentTime,buttonRect:r.toJSON(),hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.tagName,clicks:window.fixtureClicks}; }),
          content: await worker.evaluate(tabId => chrome.tabs.sendMessage(tabId, {type:'automation-content-status'}), tabId),
          settings: await worker.evaluate(() => chrome.storage.local.get(null)),
          messages: await worker.evaluate(() => self.fixtureMessages)
        }));
        throw error;
      }
      assert.equal(loads.get(id), 2, "Configured reload limit was exceeded");
      assert.equal(await page.evaluate(() => document.querySelector(".html5-video-player").classList.contains("ad-showing")), false);
      const after = await state();
      assert.ok(isBackground(after), "Automation stole the tab/window focus");
      const nativeAfter = nativeState(true);
      if (nativeAfter) assert.ok(nativeAfter.allMinimized && !nativeAfter.foregroundInProcess);
      const guard = await worker.evaluate(tabId => chrome.storage.session.get("ad-reload:" + tabId), tabId);
      assert.equal(guard["ad-reload:" + tabId].reloadCount, 1);
      const clicks = await page.evaluate(() => window.fixtureClicks);
      // Input briefly emulates renderer focus. Native focus must stay unchanged.
      // hasFocus can remain true after CDP input even for a hidden renderer;
      // emulation itself must be cleared (otherwise visibility stays visible).
      if (mode !== "unfocused-window") {
        await eventually(() => page.evaluate(() => document.visibilityState === "hidden"), "Renderer visibility emulation leaked");
      }
      result.checks.push({ mode, pausedAdUntouched: true, reloads: 1, trustedSkip: true,
        before, visibility, after, nativeBefore, nativeAfter, documentAfter: await page.evaluate(() => ({visibility:document.visibilityState,focused:document.hasFocus()})),
        clicks, completedAfterMs: Date.now() - start });
      console.log("PASS " + mode + ": paused guard, reload limit, trusted skip, focus preserved");
      // Pause the main video and add an unrelated confirmation first.
      await page.evaluate(() => {
        document.querySelector('video').pause();
        window.continueClicks=[];
        const dialog=document.createElement('ytd-confirm-dialog-renderer');
        dialog.style.cssText='position:fixed;left:40px;top:40px;width:500px;height:180px;background:white;z-index:10000';
        dialog.innerHTML='<p>이 동영상을 삭제하시겠어요?</p><button>확인</button>';
        document.body.append(dialog);
        dialog.querySelector('button').addEventListener('click',e=>{
          window.continueClicks.push({trusted:e.isTrusted});
          if(e.isTrusted){dialog.remove();document.querySelector('video').play();}
        });
      });
      await delay(1600);
      assert.equal(await page.evaluate(() => window.continueClicks.length), 0);
      assert.equal(await page.evaluate(() => document.querySelector('video').paused), true);
      await page.evaluate(() => document.querySelector('ytd-confirm-dialog-renderer p').textContent='동영상이 일시중지되었습니다. 계속 시청하시겠어요?');
      await eventually(() => page.evaluate(() => window.continueClicks.some(c=>c.trusted) && !document.querySelector('video').paused), mode + ': continue prompt was not confirmed');
      assert.equal(loads.get(id), 2, 'Continue prompt must not reload the video');
      assert.ok(isBackground(await state()));
      const finalNative = nativeState(true);
      if (finalNative) assert.ok(finalNative.allMinimized && !finalNative.foregroundInProcess);
      result.checks.push({ mode, unrelatedDialogUntouched: true, continuePromptTrusted: true, playbackResumed: true,
        additionalReloads: 0, nativeState: finalNative });
      console.log('PASS ' + mode + ': unrelated dialog ignored; continue-watching prompt confirmed and playback resumed');
      await worker.evaluate(windowId => chrome.windows.remove(windowId), windowId);
      if (otherWindow) await worker.evaluate(windowId => chrome.windows.remove(windowId), otherWindow.id);
    }
    for (const [name, hash] of Object.entries(result.sourceHashes)) {
      assert.equal(crypto.createHash("sha256").update(await fs.readFile(path.join(root, name))).digest("hex"), hash);
    }
    result.sourceUnchanged = true;
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error("FIXTURE_FAILURE " + error.stack);
    throw error;
  } finally {
    if (browser) {
      await browser.newBrowserCDPSession().then(s => s.send("Browser.close")).catch(() => {});
      await browser.close().catch(() => {});
    }
    if (browserProcess && browserProcess.exitCode === null) {
      await Promise.race([new Promise(resolve => browserProcess.once("exit", resolve)), delay(2000)]);
      if (browserProcess.exitCode === null) browserProcess.kill();
    }
    assert.ok(path.resolve(profile).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(profile).startsWith("youtube-background-fixture-"));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
