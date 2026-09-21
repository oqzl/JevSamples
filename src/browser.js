import { A_CHARTEXT, startRogue } from "@ticktockbent/rogue-ts";

const ROWS = 24;
const COLS = 80;
const ESC = 27;
const RUN_DELAY_MS = 800;
const FOLLOWUP_DELAY_MS = 120;

const $ = (id) => document.getElementById(id);
const ui = {
  viewport: $("terminalViewport"),
  terminal: $("terminalScreen"),
  follow: $("followButton"),
  run: $("runButton"),
  fast: $("fastButton"),
  step: $("stepButton"),
  pause: $("pauseButton"),
  restart: $("restartButton"),
  mode: $("modeLabel"),
  floor: $("floorLabel"),
  inputCount: $("inputCount"),
  apiStatus: $("apiStatus"),
  lastAction: $("lastAction"),
  lastConfidence: $("lastConfidence"),
  lastLatency: $("lastLatency"),
  lastTokens: $("lastTokens"),
  distribution: $("distribution"),
  messageLog: $("messageLog"),
  result: $("resultBanner"),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function blankGrid(rows, cols) {
  return Array.from({ length: rows }, () => Array(cols).fill(" "));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function writeCharacter(win, ch) {
  if (ch === "\n") {
    win.y = clamp(win.y + 1, 0, win.nlines - 1);
    win.x = 0;
    return;
  }
  if (win.y < 0 || win.y >= win.nlines || win.x < 0 || win.x >= win.ncols) return;
  win.cells[win.y][win.x] = ch;
  win.x += 1;
  if (win.x >= win.ncols) {
    win.x = 0;
    win.y = clamp(win.y + 1, 0, win.nlines - 1);
  }
}

function makeWindow(id, nlines, ncols, begy, begx) {
  return { id, nlines, ncols, begy, begx, y: 0, x: 0, cells: blankGrid(nlines, ncols) };
}

function minimalPrintf(format, args) {
  let index = 0;
  return String(format).replace(/%%|%[-+0 ]?(?:\d+|\*)?(?:\.\d+)?[sd]/g, (token) => {
    if (token === "%%") return "%";
    let width = null;
    if (token.includes("*")) width = Number(args[index++]);
    else {
      const match = token.match(/(\d+)/);
      if (match) width = Number(match[1]);
    }
    const value = args[index++];
    let text = token.endsWith("d") ? String(Math.trunc(Number(value) || 0)) : String(value ?? "");
    if (Number.isFinite(width) && width > text.length) {
      const padding = " ".repeat(width - text.length);
      text = token.includes("-") ? text + padding : padding + text;
    }
    return text;
  });
}

class BrowserCursesBackend {
  LINES = ROWS;
  COLS = COLS;

  constructor(controller) {
    this.controller = controller;
    this.nextWindowId = 1;
    this.ended = false;
    this.stdscr = makeWindow(0, ROWS, COLS, 0, 0);
    this.physical = blankGrid(ROWS, COLS);
  }

  initscr() {
    this.ended = false;
    this.stdscr = makeWindow(0, ROWS, COLS, 0, 0);
    this.physical = blankGrid(ROWS, COLS);
    return this.stdscr;
  }

  endwin() { this.ended = true; }
  isendwin() { return this.ended; }
  move(y, x) { this.wmove(this.stdscr, y, x); }
  addch(ch) { this.waddch(this.stdscr, ch); }
  addstr(str) { this.waddstr(this.stdscr, str); }
  mvaddch(y, x, ch) { this.move(y, x); this.addch(ch); }
  mvaddstr(y, x, str) { this.move(y, x); this.addstr(str); }
  printw(fmt, ...args) { this.addstr(minimalPrintf(fmt, args)); }
  mvprintw(y, x, fmt, ...args) { this.move(y, x); this.printw(fmt, ...args); }
  inch() { return this.mvinch(this.stdscr.y, this.stdscr.x); }
  mvinch(y, x) {
    const ch = this.stdscr.cells[y]?.[x] ?? " ";
    return ch.charCodeAt(0);
  }
  clear() { this.wclear(this.stdscr); }
  clrtoeol() { this.wclrtoeol(this.stdscr); }
  refresh() {
    this.physical = this.stdscr.cells.map((row) => row.slice());
    this.controller.screenUpdated(this.snapshot());
  }
  standout() {}
  standend() {}
  getyx() { return [this.stdscr.y, this.stdscr.x]; }

  newwin(nlines, ncols, begy, begx) {
    return makeWindow(this.nextWindowId++, nlines, ncols, begy, begx);
  }
  delwin() {}
  wmove(win, y, x) {
    win.y = clamp(Math.trunc(y), 0, Math.max(0, win.nlines - 1));
    win.x = clamp(Math.trunc(x), 0, Math.max(0, win.ncols - 1));
  }
  waddch(win, value) {
    const code = Number(value) & A_CHARTEXT;
    writeCharacter(win, String.fromCharCode(code || 32));
  }
  mvwaddch(win, y, x, ch) { this.wmove(win, y, x); this.waddch(win, ch); }
  waddstr(win, str) { for (const ch of String(str)) writeCharacter(win, ch); }
  mvwaddstr(win, y, x, str) { this.wmove(win, y, x); this.waddstr(win, str); }
  wprintw(win, fmt, ...args) { this.waddstr(win, minimalPrintf(fmt, args)); }
  wrefresh(win) {
    const next = this.physical.map((row) => row.slice());
    for (let y = 0; y < win.nlines; y++) {
      const py = win.begy + y;
      if (py < 0 || py >= ROWS) continue;
      for (let x = 0; x < win.ncols; x++) {
        const px = win.begx + x;
        if (px < 0 || px >= COLS) continue;
        next[py][px] = win.cells[y][x];
      }
    }
    this.physical = next;
    this.controller.screenUpdated(this.snapshot());
  }
  wclear(win) {
    win.cells = blankGrid(win.nlines, win.ncols);
    win.y = 0;
    win.x = 0;
  }
  wclrtoeol(win) {
    if (!win.cells[win.y]) return;
    for (let x = win.x; x < win.ncols; x++) win.cells[win.y][x] = " ";
  }
  touchwin() {}
  clearok() {}
  overwrite(src, dst) {
    const rows = Math.min(src.nlines, dst.nlines);
    const cols = Math.min(src.ncols, dst.ncols);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) dst.cells[y][x] = src.cells[y][x];
    }
  }

  async getch() { return this.controller.getch(this.snapshot()); }
  cbreak() {}
  nocbreak() {}
  noecho() {}
  echo() {}
  raw() {}
  noraw() {}
  keypad() {}
  typeahead() {}
  baudrate() { return 9600; }
  mvcur(_oldrow, _oldcol, newrow, newcol) { this.move(newrow, newcol); }
  idlok() {}
  async saveGame() { return false; }
  async restoreGame() { return null; }

  snapshot() { return this.physical.map((row) => row.join("")); }
}

function detectPhase(screen) {
  const top = (screen[0] || "").trim().toLowerCase();
  if (top.includes("--more--")) return "more";
  if (top.includes("direction")) return "direction";
  if (top.includes("left or right") || top.includes("which hand")) return "hand";
  if (
    top.includes("which object") ||
    top.includes("which item") ||
    /(?:eat|quaff|read|wield|wear|drop|zap|throw|identify|remove) what\?/.test(top)
  ) return "item";
  return "turn";
}

function parseFloor(statusLine) {
  const match = statusLine.match(/Level:\s*(\d+)/i);
  return match ? match[1] : "—";
}

class JevController {
  constructor() {
    this.mode = "paused";
    this.stepBudget = 0;
    this.stepChain = false;
    this.waiters = new Set();
    this.following = true;
    this.inventory = {};
    this.recentMessages = [];
    this.lastMessage = "";
    this.inputCount = 0;
    this.currentAbort = null;
    this.bootstrapInventory = true;
    this.bootstrapInProgress = false;
    this.screen = Array.from({ length: ROWS }, () => " ".repeat(COLS));
    this.updateModeUI();
  }

  screenUpdated(screen) {
    this.screen = screen;
    const message = (screen[0] || "").trim();
    if (message && message !== this.lastMessage && !message.endsWith("--More--")) {
      this.lastMessage = message;
      this.recentMessages.push(message);
      this.recentMessages = this.recentMessages.slice(-16);
      this.learnInventory(message);
      this.renderMessages();
    }
    ui.floor.textContent = parseFloor(screen[23] || "");
    ui.terminal.textContent = screen.join("\n");
    if (this.following) requestAnimationFrame(() => this.centerPlayer());
  }

  learnInventory(message) {
    let match = message.match(/^([a-z])\)\s+(.+)$/);
    if (match) {
      this.inventory[match[1]] = match[2];
      return;
    }
    match = message.match(/^(.+?)\s+\(([a-z])\)$/);
    if (match) this.inventory[match[2]] = match[1];
    if (/empty handed|aren't carrying anything/i.test(message)) this.inventory = {};
  }

  renderMessages() {
    ui.messageLog.replaceChildren();
    for (const message of this.recentMessages.slice(-8).reverse()) {
      const li = document.createElement("li");
      li.textContent = message;
      ui.messageLog.appendChild(li);
    }
  }

  centerPlayer() {
    const y = this.screen.findIndex((line, row) => row > 0 && row < ROWS - 1 && line.includes("@"));
    if (y < 0) return;
    const x = this.screen[y].indexOf("@");
    const cellWidth = ui.terminal.scrollWidth / COLS;
    const cellHeight = ui.terminal.scrollHeight / ROWS;
    const left = x * cellWidth - ui.viewport.clientWidth / 2 + cellWidth / 2;
    const top = y * cellHeight - ui.viewport.clientHeight / 2 + cellHeight / 2;
    ui.viewport.scrollTo({ left: Math.max(0, left), top: Math.max(0, top), behavior: "auto" });
  }

  setFollowing(value) {
    this.following = value;
    ui.follow.textContent = value ? "FOLLOWING @" : "FOLLOW @";
    ui.follow.classList.toggle("active", value);
    if (value) this.centerPlayer();
  }

  setMode(mode) {
    if (!new Set(["paused", "run", "fast"]).has(mode)) return;
    this.mode = mode;
    if (mode !== "paused") {
      this.stepBudget = 0;
      this.stepChain = false;
    }
    if (mode === "paused" && this.currentAbort) this.currentAbort.abort();
    this.updateModeUI();
    this.wake();
  }

  step() {
    this.mode = "paused";
    this.stepBudget += 1;
    this.updateModeUI();
    this.wake();
  }

  updateModeUI() {
    ui.mode.textContent = this.mode === "run" ? "RUN" : this.mode === "fast" ? "FAST" : this.stepBudget > 0 ? "STEP" : "PAUSED";
    ui.run.classList.toggle("selected", this.mode === "run");
    ui.fast.classList.toggle("selected", this.mode === "fast");
    ui.pause.classList.toggle("selected", this.mode === "paused" && this.stepBudget === 0);
  }

  wake() {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  waitForModeChange() {
    return new Promise((resolve) => this.waiters.add(resolve));
  }

  async waitUntilAllowed(phase) {
    if (phase !== "turn" && this.stepChain) return;
    if (phase === "turn" && this.stepChain) this.stepChain = false;

    while (this.mode === "paused" && this.stepBudget === 0) await this.waitForModeChange();

    if (this.mode === "paused" && this.stepBudget > 0 && phase === "turn") {
      this.stepBudget -= 1;
      this.stepChain = true;
      this.updateModeUI();
    }

    if (this.mode === "run") {
      await sleep(phase === "turn" ? RUN_DELAY_MS : FOLLOWUP_DELAY_MS);
      if (this.mode === "paused") return this.waitUntilAllowed(phase);
    }
  }

  async getch(screen) {
    let phase = detectPhase(screen);

    if (phase === "more") {
      await sleep(70);
      return " ".charCodeAt(0);
    }
    if (phase === "item" && Object.keys(this.inventory).length === 0) {
      this.addSystemMessage("No known pack slots for this prompt; cancelling it.");
      return ESC;
    }

    if (this.bootstrapInventory && phase === "turn") {
      this.bootstrapInventory = false;
      this.bootstrapInProgress = true;
      ui.apiStatus.textContent = "SCAN PACK";
      return "i".charCodeAt(0);
    }
    if (this.bootstrapInProgress && phase === "turn") {
      this.bootstrapInProgress = false;
      ui.apiStatus.textContent = "READY";
    }

    while (true) {
      await this.waitUntilAllowed(phase);
      try {
        return await this.askJev(screen, phase);
      } catch (error) {
        if (error?.name === "AbortError") {
          phase = detectPhase(this.screen);
          continue;
        }
        ui.apiStatus.textContent = "ERROR";
        ui.apiStatus.classList.add("error");
        this.setMode("paused");
        this.addSystemMessage(error instanceof Error ? error.message : String(error));
        await this.waitUntilAllowed(phase);
      }
    }
  }

  async askJev(screen, phase) {
    this.currentAbort = new AbortController();
    ui.apiStatus.textContent = "JEV…";
    ui.apiStatus.classList.remove("error");

    const response = await fetch("/api/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phase,
        screen,
        inventory: this.inventory,
        recentMessages: this.recentMessages,
      }),
      signal: this.currentAbort.signal,
    });
    const data = await response.json().catch(() => ({ error: "Invalid server response" }));
    this.currentAbort = null;
    if (!response.ok) throw new Error(data.error || "Jev request failed");

    this.inputCount += 1;
    ui.inputCount.textContent = String(this.inputCount);
    ui.apiStatus.textContent = "READY";
    this.renderDecision(data);
    return data.key;
  }

  renderDecision(data) {
    const answer = data.answer || {};
    ui.lastAction.textContent = String(data.label || "—").replaceAll("_", " ").toUpperCase();
    ui.lastConfidence.textContent = Number.isFinite(answer.confidence) ? answer.confidence.toFixed(2) : "—";
    ui.lastLatency.textContent = Number.isFinite(data.elapsed_ms) ? data.elapsed_ms + " ms" : "—";
    ui.lastTokens.textContent = Number.isFinite(data.usage?.input_tokens) ? String(data.usage.input_tokens) : "—";
    ui.distribution.replaceChildren();

    const entries = Object.entries(answer.probabilities || {}).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 6);
    for (const [label, probability] of entries) {
      const row = document.createElement("div");
      row.className = "prob-row";
      const name = document.createElement("span");
      name.textContent = label.replaceAll("_", " ");
      const track = document.createElement("i");
      const fill = document.createElement("b");
      fill.style.width = Math.max(0, Math.min(100, Number(probability) * 100)) + "%";
      track.appendChild(fill);
      const value = document.createElement("em");
      value.textContent = (Number(probability) * 100).toFixed(0) + "%";
      row.append(name, track, value);
      ui.distribution.appendChild(row);
    }
  }

  addSystemMessage(message) {
    this.recentMessages.push("SYSTEM: " + message);
    this.recentMessages = this.recentMessages.slice(-16);
    this.renderMessages();
  }
}

const controller = new JevController();
const backend = new BrowserCursesBackend(controller);

ui.viewport.addEventListener("pointerdown", () => controller.setFollowing(false), { passive: true });
ui.viewport.addEventListener("wheel", () => controller.setFollowing(false), { passive: true });
ui.follow.addEventListener("click", () => controller.setFollowing(true));
ui.run.addEventListener("click", () => controller.setMode("run"));
ui.fast.addEventListener("click", () => controller.setMode("fast"));
ui.step.addEventListener("click", () => controller.step());
ui.pause.addEventListener("click", () => controller.setMode("paused"));
ui.restart.addEventListener("click", () => location.reload());

controller.setFollowing(true);
controller.screenUpdated(backend.snapshot());

(async () => {
  try {
    const result = await startRogue(backend, {
      playerName: "Jev",
      seed: Date.now() & 0x7fffffff,
    });
    controller.setMode("paused");
    ui.result.hidden = false;
    ui.result.textContent = result.outcome === "victory"
      ? `VICTORY · ${result.gold} GOLD`
      : result.outcome === "death"
        ? `DIED ON LEVEL ${result.level} · ${result.killer || "UNKNOWN"}`
        : `${result.outcome.toUpperCase()} · LEVEL ${result.level}`;
    controller.addSystemMessage(ui.result.textContent);
  } catch (error) {
    controller.setMode("paused");
    ui.apiStatus.textContent = "ENGINE ERROR";
    ui.apiStatus.classList.add("error");
    controller.addSystemMessage(error instanceof Error ? error.stack || error.message : String(error));
  }
})();
