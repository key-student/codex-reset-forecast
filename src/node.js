import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_HORIZON, HORIZONS } from "./preferences.js";

const ENDPOINT = "https://codex.gussuriworks.com/api/current?locale=zh";
const REFRESH_INTERVAL = 10 * 60_000;
const RETRY_INTERVAL = 60_000;
const MAX_SNAPSHOT_AGE = 30 * 60_000;
const NOTICE_LABELS = { banked: "已预告发放重置卡", forced: "已预告直接重置" };

const validTime = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const text = (value, length) => typeof value === "string" ? value.trim().slice(0, length) : "";

function postLink(value) {
  if (typeof value !== "string") return null;
  const match = /^https:\/\/(?:x\.com|twitter\.com)\/thsottiaux\/status\/(\d+)(?:[/?#]|$)/i.exec(value);
  return match ? `https://x.com/thsottiaux/status/${match[1]}` : null;
}

export function readSnapshot(payload) {
  const view = payload?.viewModel;
  const observedAt = payload?.dataHealth?.generatedAt ?? payload?.checkedAt;
  if (payload?.schemaVersion !== "public-v1" || !view || !validTime(observedAt)) {
    throw new Error("Unrecognized forecast response");
  }

  const probabilities = Object.fromEntries(HORIZONS.map(hours => {
    const value = view[`probability${hours}h`];
    return [hours, Number.isFinite(value) && value >= 0 && value <= 1 ? value : null];
  }));
  if (Object.values(probabilities).every(value => value === null)) {
    throw new Error("Forecast probabilities unavailable");
  }

  const forecastWindow = view.activeWindow;
  const notice = forecastWindow?.active === true && forecastWindow.kind === "official" ? {
    label: Object.hasOwn(NOTICE_LABELS, forecastWindow.noticeKind) ? NOTICE_LABELS[forecastWindow.noticeKind] : "已发布额外重置预告",
    summary: text(forecastWindow.summary, 220),
    time: forecastWindow.isOverduePending ? text(forecastWindow.overdueText, 100) :
      [text(forecastWindow.forecastDate, 40), text(forecastWindow.forecastTime, 80)].filter(Boolean).join(" "),
    source: postLink(forecastWindow.source)
  } : null;

  return {
    probabilities,
    observedAt,
    upstreamStale: payload.dataHealth?.stale === true,
    notice
  };
}

export function activate({ rpc, signal, dataDirectory }) {
  const settingsPath = join(dataDirectory, "settings.json");
  const temporaryPath = join(dataDirectory, "settings.json.tmp");
  let sidebarHours = DEFAULT_HORIZON;
  let settingsReady = readFile(settingsPath, "utf8").then(value => {
    const { sidebarHours: saved } = JSON.parse(value) ?? {};
    if (HORIZONS.includes(saved)) sidebarHours = saved;
  }).catch(error => {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
      console.warn("Could not read sidebar settings:", error.code);
    }
  });

  rpc.handle("get-sidebar-hours", async () => {
    await settingsReady;
    return sidebarHours;
  });
  rpc.handle("set-sidebar-hours", ({ hours }) => {
    if (!HORIZONS.includes(hours)) throw new Error("Invalid sidebar forecast horizon");
    const save = settingsReady.then(async () => {
      await writeFile(temporaryPath, JSON.stringify({ sidebarHours: hours }) + "\n", { mode: 0o600 });
      await rename(temporaryPath, settingsPath);
      sidebarHours = hours;
      rpc.emit("sidebar-hours-changed", hours);
      return hours;
    });
    settingsReady = save.catch(() => {});
    return save;
  });

  let snapshot = null;
  let nextRequestAt = 0;
  let pending = null;

  async function refresh() {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
    try {
      const response = await fetch(ENDPOINT, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: requestSignal
      });
      if (!response.ok) throw new Error("Forecast request failed");
      snapshot = readSnapshot(await response.json());
      nextRequestAt = Date.now() + REFRESH_INTERVAL;
      return false;
    } catch {
      nextRequestAt = Date.now() + RETRY_INTERVAL;
      return true;
    }
  }

  let failed = false;
  rpc.handle("forecast", async () => {
    if (Date.now() >= nextRequestAt) {
      pending ??= refresh().then(result => { failed = result; }).finally(() => { pending = null; });
    }
    await pending;

    const stale = snapshot && (
      snapshot.upstreamStale || Date.now() - Date.parse(snapshot.observedAt) > MAX_SNAPSHOT_AGE
    );
    const status = snapshot ? (failed || stale ? "stale" : "current") : "unavailable";
    return { snapshot, status };
  });
}
