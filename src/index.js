import "./style.css";
import { DEFAULT_HORIZON, HORIZONS } from "./preferences.js";

const RAIL = "nav[data-app-navigation-rail]";
const FOOTER_ACTIONS = ':scope > .flex-col > [class~="empty:hidden"]';
const USAGE_TRIGGER = [
  'button[aria-label="Usage" i]',
  'button[aria-label="用量"]',
  'button[aria-label="使用量"]',
  'button[aria-description][aria-haspopup="menu"]'
].join(", ");
const SOURCE = "https://codex.gussuriworks.com/zh";
const REFRESH_INTERVAL = 10 * 60_000;
const timeOptions = {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
};
const timeFormat = new Intl.DateTimeFormat("zh-CN", timeOptions);
const dayFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: timeOptions.timeZone,
  month: "numeric",
  day: "numeric"
});
const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  ...timeOptions,
  year: "numeric",
  month: "long",
  day: "numeric"
});
const percentFormat = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 0 });
const percent = value => Number.isFinite(value) ? percentFormat.format(value) : "—";

function footerSlot(rail) {
  const footer = rail?.lastElementChild;
  if (!footer) return null;

  // The compact footer has an action stack (update, usage) and a separate profile row.
  const actions = footer.querySelector(FOOTER_ACTIONS);
  const usage = footer.querySelector(USAGE_TRIGGER) ?? actions?.querySelector(
    'button[aria-haspopup="menu"], button[disabled][aria-hidden="true"]'
  );

  if (!usage) return actions ? { parent: actions, before: null } : null;

  const parent = actions?.contains(usage) ? actions : usage.parentElement;
  let before = usage;
  while (before.parentElement !== parent) before = before.parentElement;
  return { parent, before };
}

export function activate({ node, onCleanup }) {
  if (!node) throw new Error("Forecast package requires its authorized Node runtime");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "ct-reset-forecast-trigger";
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-controls", "ct-reset-forecast-panel");
  button.innerHTML = `<span class="ct-reset-forecast-horizon">${DEFAULT_HORIZON}h</span><strong>—</strong>`;
  const horizon = button.querySelector(".ct-reset-forecast-horizon");
  const badge = button.querySelector("strong");

  const panel = document.createElement("section");
  panel.id = "ct-reset-forecast-panel";
  panel.className = "ct-reset-forecast-panel";
  panel.setAttribute("popover", "manual");
  panel.setAttribute("role", "dialog");
  panel.tabIndex = -1;
  panel.setAttribute("aria-labelledby", "ct-reset-forecast-title");
  panel.innerHTML = `
    <div data-forecast-view>
      <header class="ct-reset-forecast-heading">
        <h2 id="ct-reset-forecast-title">额外重置概率</h2>
        <p>社区估算 · 含直接重置或发放重置卡</p>
      </header>
      <div class="ct-reset-forecast-separator" aria-hidden="true"></div>
      <p class="ct-reset-forecast-stale" data-stale role="status" hidden>数据已过期 · 以下为上次预测</p>
      <dl class="ct-reset-forecast-windows">
        ${HORIZONS.map(hours => `
          <div class="ct-reset-forecast-row" data-hours="${hours}">
            <dt>未来 ${hours} 小时内</dt>
            <dd>—</dd>
          </div>`).join("")}
      </dl>
      <div data-notice-group hidden>
        <div class="ct-reset-forecast-separator" aria-hidden="true"></div>
        <div class="ct-reset-forecast-row" data-notice></div>
        <p class="ct-reset-forecast-caption" data-summary hidden></p>
        <p class="ct-reset-forecast-caption" data-window hidden></p>
        <a class="ct-reset-forecast-row ct-reset-forecast-action" data-post target="_blank" rel="noopener noreferrer" hidden>查看预告原帖 ↗</a>
      </div>
      <div class="ct-reset-forecast-separator" aria-hidden="true"></div>
      <div class="ct-reset-forecast-metadata">
        <span data-status aria-live="polite">正在更新预测…</span>
        <a href="${SOURCE}" target="_blank" rel="noopener noreferrer">查看重置观测站 ↗</a>
      </div>
      <button type="button" class="ct-reset-forecast-row ct-reset-forecast-action" data-settings-open>
        <span>左下角显示</span>
        <span class="ct-reset-forecast-selected"><span data-selected-hours></span><span aria-hidden="true">›</span></span>
      </button>
    </div>
    <div data-settings-view hidden>
      <header class="ct-reset-forecast-settings-header">
        <button type="button" data-settings-back aria-label="返回预测" title="返回预测"><span aria-hidden="true">‹</span></button>
        <h2 id="ct-reset-forecast-settings-title">左下角显示时段</h2>
      </header>
      <div class="ct-reset-forecast-separator" aria-hidden="true"></div>
      <fieldset class="ct-reset-forecast-options" aria-labelledby="ct-reset-forecast-settings-title">
        ${HORIZONS.map(hours => `
          <label class="ct-reset-forecast-row ct-reset-forecast-option">
            <span>${hours} 小时</span>
            <input type="radio" name="ct-reset-forecast-hours" value="${hours}">
            <span class="ct-reset-forecast-check" aria-hidden="true">✓</span>
          </label>`).join("")}
      </fieldset>
      <p class="ct-reset-forecast-caption" data-settings-error role="status" hidden></p>
    </div>`;
  document.body.append(panel);

  const fields = Object.fromEntries(
    ["notice-group", "notice", "summary", "window", "post", "status", "stale",
      "forecast-view", "settings-view", "settings-open", "settings-back", "selected-hours", "settings-error"].map(name => [name, panel.querySelector(`[data-${name}]`)])
  );
  const windows = [...panel.querySelectorAll("[data-hours]")].map(row => ({
    hours: Number(row.dataset.hours),
    value: row.querySelector("dd")
  }));
  const settingsOptions = panel.querySelector("fieldset");
  const radios = [...settingsOptions.querySelectorAll("input")];
  const events = new AbortController();
  const listeners = { signal: events.signal };

  let rail;
  let pending;
  let snapshot;
  let sidebarHours = DEFAULT_HORIZON;
  let status = "loading";
  let preferenceRevision = 0;
  let disposed = false;
  let frame = 0;

  function renderSidebar() {
    const probability = status === "current" ? snapshot?.probabilities[sidebarHours] : null;
    const headline = percent(probability);
    horizon.textContent = `${sidebarHours}h`;
    badge.textContent = headline;
    button.dataset.notice = String(status === "current" && Boolean(snapshot?.notice));
    const description = status === "current" ? `未来 ${sidebarHours} 小时内 ${Number.isFinite(probability) ? headline : "暂无预测"}` :
      status === "loading" ? "正在更新" : "等待更新";
    button.setAttribute("aria-label", `额外重置预测 · ${description}`);
    button.title = button.getAttribute("aria-label");
  }

  function render(nextStatus) {
    status = nextStatus;
    renderSidebar();
    panel.dataset.status = status;
    for (const row of windows) {
      row.value.textContent = percent(snapshot?.probabilities[row.hours]);
    }

    const notice = status === "current" ? snapshot?.notice : null;
    fields["notice-group"].hidden = !notice;
    fields.notice.textContent = notice?.label ?? "";
    fields.summary.textContent = notice?.summary ?? "";
    fields.summary.hidden = !notice?.summary;
    fields.window.textContent = notice?.time ?? "";
    fields.window.hidden = !notice?.time;
    fields.post.hidden = !notice?.source;
    if (notice?.source) fields.post.href = notice.source;
    else fields.post.removeAttribute("href");

    const updated = snapshot ? new Date(snapshot.observedAt) : null;
    fields.stale.hidden = status !== "stale";
    fields.status.title = updated ? `预测更新于 ${dateFormat.format(updated)}（北京时间 UTC+8）` : "";
    if (updated) {
      const today = new Date();
      const day = dayFormat.format(updated);
      const time = timeFormat.format(updated);
      const displayTime = day === dayFormat.format(today) &&
        updated.getTime() > today.getTime() - 24 * 60 * 60_000 ? time : `${day} ${time}`;
      const label = status === "current" ? "预测更新于" : "更新于";
      fields.status.textContent = `${label} ${displayTime}`;
    } else {
      fields.status.textContent = status === "loading" ? "正在更新预测…" : "暂时无法获取预测";
    }
  }

  function applySidebarHours(hours) {
    if (disposed || !HORIZONS.includes(hours)) return;
    sidebarHours = hours;
    fields["selected-hours"].textContent = `${hours} 小时`;
    for (const radio of radios) radio.checked = Number(radio.value) === sidebarHours;
    renderSidebar();
  }

  function showSettings(show, moveFocus = true) {
    fields["forecast-view"].hidden = show;
    fields["settings-view"].hidden = !show;
    panel.setAttribute("aria-labelledby", show ? "ct-reset-forecast-settings-title" : "ct-reset-forecast-title");
    if (moveFocus) {
      const target = show ? radios.find(radio => radio.checked && !settingsOptions.disabled) : fields["settings-open"];
      (target ?? panel).focus({ preventScroll: true });
    }
    positionPanel();
  }

  async function refresh() {
    if (!button.isConnected || pending) return;
    pending = Promise.resolve().then(() => node.invoke("forecast"));
    try {
      const result = await pending;
      if (disposed) return;
      snapshot = result.snapshot;
      render(result.status);
    } catch {
      if (!disposed) render(snapshot ? "stale" : "unavailable");
    } finally {
      pending = null;
      if (!disposed) positionPanel();
    }
  }

  function isOpen() {
    return panel.matches(":popover-open");
  }

  function positionPanel() {
    if (!isOpen() || !button.isConnected) return;
    const anchor = button.getBoundingClientRect();
    const left = Math.min(anchor.right + 5, innerWidth - panel.offsetWidth - 8);
    const top = anchor.bottom - panel.offsetHeight;
    panel.style.left = `${Math.max(8, left)}px`;
    panel.style.top = `${Math.max(8, Math.min(top, innerHeight - panel.offsetHeight - 8))}px`;
  }

  function closePanel(returnFocus = false) {
    if (!isOpen()) return;
    panel.hidePopover();
    showSettings(false, false);
    button.setAttribute("aria-expanded", "false");
    if (returnFocus && button.isConnected) button.focus({ preventScroll: true });
  }

  function queueMount() {
    if (!frame) frame = requestAnimationFrame(mount);
  }

  const railObserver = new MutationObserver(queueMount);

  function mount() {
    frame = 0;
    const next = document.querySelector(RAIL);
    if (rail !== next) {
      rail = next;
      railObserver.disconnect();
      if (rail) {
        railObserver.observe(rail, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["aria-label", "aria-description", "aria-haspopup"]
        });
      }
    }

    const slot = footerSlot(rail);
    if (!slot) {
      closePanel();
      button.remove();
      return;
    }

    if (button.parentElement !== slot.parent || button.nextElementSibling !== slot.before) {
      const firstMount = !button.isConnected;
      const wasFocused = document.activeElement === button;
      slot.parent.insertBefore(button, slot.before);
      if (wasFocused) button.focus({ preventScroll: true });
      if (firstMount) void refresh();
    }
    positionPanel();
  }

  render("loading");
  applySidebarHours(DEFAULT_HORIZON);
  const unsubscribe = node.on("sidebar-hours-changed", hours => {
    preferenceRevision++;
    applySidebarHours(hours);
  });
  void node.invoke("get-sidebar-hours").then(hours => {
    if (preferenceRevision === 0) applySidebarHours(hours);
  }).catch(() => {});
  fields["settings-open"].addEventListener("click", () => showSettings(true), listeners);
  fields["settings-back"].addEventListener("click", () => showSettings(false), listeners);
  settingsOptions.addEventListener("change", async event => {
    const choice = event.target;
    if (!radios.includes(choice)) return;
    settingsOptions.disabled = true;
    fields["settings-error"].hidden = true;
    const revision = preferenceRevision;
    try {
      const hours = await node.invoke("set-sidebar-hours", { hours: Number(choice.value) });
      if (revision === preferenceRevision) applySidebarHours(hours);
    } catch {
      applySidebarHours(sidebarHours);
      fields["settings-error"].textContent = "保存失败，请重试";
      fields["settings-error"].hidden = false;
    } finally {
      settingsOptions.disabled = false;
      if (isOpen() && !fields["settings-view"].hidden) {
        radios.find(radio => radio.checked)?.focus({ preventScroll: true });
        positionPanel();
      }
    }
  }, listeners);
  button.addEventListener("click", event => {
    if (isOpen()) {
      closePanel();
      return;
    }
    panel.showPopover();
    button.setAttribute("aria-expanded", "true");
    positionPanel();
    if (event.detail === 0) panel.focus({ preventScroll: true });
    void refresh();
  }, listeners);
  document.addEventListener("pointerdown", event => {
    if (!button.contains(event.target) && !panel.contains(event.target)) closePanel();
  }, { ...listeners, capture: true });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !isOpen()) return;
    event.preventDefault();
    event.stopPropagation();
    closePanel(true);
  }, { ...listeners, capture: true });
  window.addEventListener("resize", positionPanel, listeners);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refresh();
  }, listeners);

  const observer = new MutationObserver(() => {
    if (!rail?.isConnected) queueMount();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  mount();
  const timer = setInterval(() => { if (!document.hidden) void refresh(); }, REFRESH_INTERVAL);

  onCleanup(() => {
    disposed = true;
    observer.disconnect();
    railObserver.disconnect();
    cancelAnimationFrame(frame);
    clearInterval(timer);
    events.abort();
    unsubscribe();
    closePanel();
    button.remove();
    panel.remove();
  });
}
