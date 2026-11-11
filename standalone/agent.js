import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { activate as activateNode } from "../src/node.js";
import { DEFAULT_HORIZON, HORIZONS } from "../src/preferences.js";
import { createRenderer } from "../src/renderer.js";

const exec = promisify(execFile);
const binding = "ctResetForecastRequest";
const world = "Codex Reset Forecast";
const methods = new Set(["forecast", "get-sidebar-hours", "set-sidebar-hours"]);
const appURL = "app://-/index.html";
const scope = "__ctResetForecastStandalone";

function mount(css, createRenderer, preferences, binding, scope) {
  if (location.href.split(/[?#]/, 1)[0] !== "app://-/index.html" || !document.body) return false;
  if (globalThis[scope]) return true;

  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  const pending = new Map();
  const events = new EventTarget();
  const cleanup = [];
  let sequence = 0;

  globalThis[scope] = {
    settle(id, ok, value) {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      clearTimeout(request.timer);
      if (ok) request.resolve(value);
      else request.reject(new Error("Forecast request failed"));
    },
    emit(hours) { events.dispatchEvent(new CustomEvent("sidebar-hours-changed", { detail: hours })); },
    dispose() {
      for (const callback of cleanup.reverse()) callback();
      for (const id of pending.keys()) this.settle(id, false);
      style.remove();
      delete globalThis[scope];
    }
  };
  const activate = createRenderer(preferences);
  activate({
    onCleanup: callback => cleanup.push(callback),
    node: {
      invoke(method, params) {
        return new Promise((resolve, reject) => {
          const id = ++sequence;
          const timer = setTimeout(() => globalThis[scope]?.settle(id, false), 12_000);
          pending.set(id, { timer, resolve, reject });
          try {
            globalThis[binding](JSON.stringify({ id, method, hours: params?.hours }));
          } catch {
            globalThis[scope].settle(id, false);
          }
        });
      },
      on(name, callback) {
        const listener = event => callback(event.detail);
        events.addEventListener(name, listener);
        return () => events.removeEventListener(name, listener);
      }
    }
  });
  return true;
}

class Session {
  constructor(url, handlers) {
    this.handlers = handlers;
    this.socket = new WebSocket(url);
    this.pending = new Map();
    this.sequence = 0;
    this.socket.addEventListener("message", event => void this.receive(JSON.parse(event.data)));
    this.socket.addEventListener("close", () => {
      for (const request of this.pending.values()) request.finish(new Error("Codex connection closed"));
    });
  }

  get closed() { return this.socket.readyState >= WebSocket.CLOSING; }

  async start(source) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Connection timed out")), 3000);
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Connection failed")); }, { once: true });
    });
    await this.call("Runtime.enable");
    const { frameTree } = await this.call("Page.getFrameTree");
    if (frameTree.frame.url.split(/[?#]/, 1)[0] !== appURL) throw new Error("Unexpected Codex document");
    const { executionContextId } = await this.call("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id, worldName: world
    });
    this.context = executionContextId;
    await this.call("Runtime.addBinding", { name: binding, executionContextId });
    if (!await this.evaluate(source)) throw new Error("Codex document is loading");
  }

  call(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("Codex connection closed"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const finish = (error, result) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error("Codex request timed out")), 3000);
      this.pending.set(id, { finish });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { finish(error); }
    });
  }

  async evaluate(expression) {
    const response = await this.call("Runtime.evaluate", {
      expression, contextId: this.context, returnByValue: true
    });
    if (response.exceptionDetails) throw new Error("Codex renderer evaluation failed");
    return response.result.value;
  }

  async receive(message) {
    if (message.id) {
      this.pending.get(message.id)?.finish(message.error && new Error("Codex request failed"), message.result);
      return;
    }
    const event = message.params;
    if (message.method === "Runtime.executionContextsCleared" ||
      (message.method === "Runtime.executionContextDestroyed" && event.executionContextId === this.context)) {
      if (this.context !== undefined) this.socket.close();
      return;
    }
    if (message.method !== "Runtime.bindingCalled" || event.name !== binding ||
      event.executionContextId !== this.context || event.payload.length > 256) return;
    let request;
    try { request = JSON.parse(event.payload); } catch { return; }
    if (!Number.isSafeInteger(request?.id) || request.id <= 0 || !methods.has(request.method)) return;

    let ok = true;
    let value;
    try { value = await this.handlers.get(request.method)({ hours: request.hours }); }
    catch { ok = false; }
    try {
      await this.evaluate(`globalThis.${scope}?.settle(${request.id}, ${ok}, ${JSON.stringify(value ?? null)})`);
    } catch {
      this.socket.close();
    }
  }

  async close() {
    if (this.context !== undefined && !this.closed) {
      await this.evaluate(`globalThis.${scope}?.dispose()`).catch(() => {});
    }
    this.socket.close();
  }
}

async function ownsListener(pid, port) {
  try {
    const { stdout } = await exec("/usr/sbin/lsof", ["-a", "-p", String(pid), "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"], { timeout: 2000 });
    const listeners = stdout.split("\n").filter(line => line.startsWith("n"));
    return listeners.length === 1 && listeners[0] === `n127.0.0.1:${port}`;
  } catch { return false; }
}

function targetURL(target, port) {
  if (target.type !== "page" || target.url?.split(/[?#]/, 1)[0] !== appURL ||
    !/^[a-f0-9]{32}$/i.test(target.id)) return null;
  try {
    const url = new URL(target.webSocketDebuggerUrl);
    if (url.origin === `ws://127.0.0.1:${port}` && url.pathname === `/devtools/page/${target.id}` &&
      !url.search && !url.hash && !url.username && !url.password) return url;
  } catch {}
  return null;
}

async function run(pid, port, dataDirectory) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const css = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  const source = `(${mount})(${JSON.stringify(css)}, ${createRenderer}, ${JSON.stringify({ DEFAULT_HORIZON, HORIZONS })}, ${JSON.stringify(binding)}, ${JSON.stringify(scope)})`;
  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort());
  process.once("SIGINT", () => stop.abort());
  const sessions = new Map();
  const handlers = new Map();
  activateNode({
    dataDirectory, signal: stop.signal,
    rpc: {
      handle(name, handler) { handlers.set(name, handler); },
      emit(_name, hours) {
        for (const session of sessions.values()) {
          void session.evaluate(`globalThis.${scope}?.emit(${JSON.stringify(hours)})`).catch(() => {});
        }
      }
    }
  });

  try {
    const readyDeadline = Date.now() + 25_000;
    while (!stop.signal.aborted) {
      try { process.kill(pid, 0); } catch { break; }
      if (await ownsListener(pid, port)) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
            signal: AbortSignal.any([stop.signal, AbortSignal.timeout(2500)]), redirect: "error"
          });
          if (!response.ok) throw new Error("Codex discovery failed");
          const targets = await response.json();
          if (!await ownsListener(pid, port)) break;
          const urls = new Map(targets.flatMap(target => {
            const url = targetURL(target, port);
            return url ? [[target.id, url]] : [];
          }));
          for (const [id, session] of sessions) {
            if (session.closed || !urls.has(id)) {
              sessions.delete(id);
              await session.close();
            }
          }
          await Promise.all([...urls].map(async ([id, url]) => {
            if (sessions.has(id) || stop.signal.aborted) return;
            const session = new Session(url, handlers);
            try {
              await session.start(source);
              sessions.set(id, session);
            } catch {
              await session.close();
            }
          }));
        } catch {
          if (stop.signal.aborted) break;
        }
      } else if (Date.now() >= readyDeadline) break;
      await delay(1500, undefined, { signal: stop.signal }).catch(() => {});
    }
  } finally {
    await Promise.allSettled([...sessions.values()].map(session => session.close()));
  }
}

const [pid, port] = process.argv.slice(2, 4).map(Number);
const dataDirectory = process.argv[4];
if (!Number.isSafeInteger(pid) || pid < 2 || !Number.isInteger(port) || port < 49152 || port > 65535 ||
  !dataDirectory?.startsWith("/")) throw new Error("Expected Codex PID, local port and absolute data directory");
await run(pid, port, dataDirectory);
