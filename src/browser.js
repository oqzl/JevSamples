import { A_CHARTEXT, startRogue } from "@ticktockbent/rogue-ts";

const ROWS = 24;
const COLS = 80;
const ESC = 27;
const RUN_DELAY_MS = 800;
const FAST_DELAY_MS = 120;
const FOLLOWUP_DELAY_MS = 120;

const $ = (id) => document.getElementById(id);
const ui = {
  viewport: $("terminalViewport"),
  terminal: $("terminalScreen"),
  messageOverlay: $("messageOverlay"),
  ripOverlay: $("ripOverlay"),
  ripArt: $("ripArt"),
  rogueStatus: $("rogueStatus"),
  equipmentList: $("equipmentList"),
  packList: $("packList"),
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

function isAutoContinueScreen(screen) {
  const joined = screen.join("\n").toLowerCase();
  if (joined.includes("--press space to continue--")) return true;
  return joined.includes("rest") && joined.includes("peace") && joined.includes("killed by");
}

function detectPhase(screen) {
  const top = (screen[0] || "").trim().toLowerCase();
  if (top.includes("--more--")) return "more";
  if (isAutoContinueScreen(screen)) return "continue";
  if (top.includes("direction")) return "direction";
  if (top.includes("left or right") || top.includes("which hand")) return "hand";
  if (
    top.includes("which object") ||
    top.includes("which item") ||
    /(?:eat|quaff|read|wield|wear|drop|zap|throw|identify|remove) what\?/.test(top)
  ) return "item";
  return "turn";
}

function parseStatus(statusLine) {
  const match = statusLine.match(/Level:\s*(\d+).*?Gold:\s*(\d+).*?Hp:\s*(\d+)\((\d+)\).*?Str:\s*(\d+)\((\d+)\).*?Arm:\s*(\d+).*?Exp:\s*(\d+)\/(\d+)\s*(.*)$/i);
  if (!match) return null;
  return {
    level: match[1],
    gold: match[2],
    hp: match[3],
    maxHp: match[4],
    str: match[5],
    maxStr: match[6],
    arm: match[7],
    expLevel: match[8],
    exp: match[9],
    hunger: match[10].trim(),
  };
}

function renderStatus(statusLine) {
  const status = parseStatus(statusLine);
  ui.rogueStatus.replaceChildren();
  if (!status) {
    ui.rogueStatus.textContent = statusLine.trim() || "STATUS —";
    return;
  }
  const values = [
    ["HP", status.hp + "/" + status.maxHp],
    ["STR", status.str + "/" + status.maxStr],
    ["ARM", status.arm],
    ["EXP", status.expLevel + "/" + status.exp],
    ["GOLD", status.gold],
  ];
  if (status.hunger) values.push(["FOOD", status.hunger.toUpperCase()]);
  for (const [label, value] of values) {
    const item = document.createElement("span");
    const key = document.createElement("i");
    const val = document.createElement("b");
    key.textContent = label;
    val.textContent = value;
    item.append(key, val);
    ui.rogueStatus.appendChild(item);
  }
}


const MOVE_KEYS = new Map([
  ["-1,-1", "y"], ["-1,0", "k"], ["-1,1", "u"],
  ["0,-1", "h"], ["0,1", "l"],
  ["1,-1", "b"], ["1,0", "j"], ["1,1", "n"],
]);

const ITEM_SYMBOLS = new Map([
  ["*", "gold"],
  [")", "weapon"],
  ["]", "armor"],
  ["!", "potion"],
  ["?", "scroll"],
  ["=", "ring"],
  ["/", "wand or staff"],
  [":", "food"],
  [",", "Amulet of Yendor"],
]);

function playerPosition(screen) {
  for (let y = 1; y < ROWS - 1; y++) {
    const x = screen[y]?.indexOf("@") ?? -1;
    if (x >= 0) return { x, y };
  }
  return null;
}

function isWalkable(screen, x, y) {
  if (x < 0 || x >= COLS || y <= 0 || y >= ROWS - 1) return false;
  const ch = screen[y]?.[x] ?? " ";
  return ch !== " " && ch !== "|" && ch !== "-";
}

function navigationNeighbors(screen, point) {
  const result = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = point.x + dx;
      const y = point.y + dy;
      if (!isWalkable(screen, x, y)) continue;
      if (dx !== 0 && dy !== 0) {
        if (!isWalkable(screen, point.x + dx, point.y) || !isWalkable(screen, point.x, point.y + dy)) continue;
      }
      result.push({ x, y });
    }
  }
  return result;
}

function shortestPath(screen, start, goal) {
  if (!start || !goal) return null;
  const startKey = start.x + "," + start.y;
  const goalKey = goal.x + "," + goal.y;
  if (startKey === goalKey) return [start];

  const queue = [start];
  const previous = new Map([[startKey, null]]);
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    for (const next of navigationNeighbors(screen, current)) {
      const key = next.x + "," + next.y;
      if (previous.has(key)) continue;
      previous.set(key, current);
      if (key === goalKey) {
        const path = [next];
        let cursor = current;
        while (cursor) {
          path.push(cursor);
          cursor = previous.get(cursor.x + "," + cursor.y);
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

function distanceMap(screen, start) {
  const distances = new Map();
  if (!start) return distances;
  const queue = [start];
  distances.set(start.x + "," + start.y, 0);
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    const currentDistance = distances.get(current.x + "," + current.y);
    for (const next of navigationNeighbors(screen, current)) {
      const key = next.x + "," + next.y;
      if (distances.has(key)) continue;
      distances.set(key, currentDistance + 1);
      queue.push(next);
    }
  }
  return distances;
}

function keyForStep(from, to) {
  return MOVE_KEYS.get((to.y - from.y) + "," + (to.x - from.x)) || null;
}

function isMonster(ch) {
  return /^[A-Z]$/.test(ch);
}

function isRipScreen(screen) {
  const joined = screen.join("\n").toLowerCase();
  return joined.includes("rest") && joined.includes("peace") && joined.includes("killed by");
}

function centeredRipText(screen) {
  const lines = screen.slice(0, ROWS - 1);
  const nonEmpty = lines
    .map((line, y) => ({ y, line }))
    .filter(({ line }) => line.trim().length > 0);
  if (nonEmpty.length === 0) return "";
  let minX = COLS;
  let maxX = 0;
  for (const { line } of nonEmpty) {
    const first = line.search(/\S/);
    const last = line.length - 1 - [...line].reverse().join("").search(/\S/);
    if (first >= 0) minX = Math.min(minX, first);
    if (last >= 0) maxX = Math.max(maxX, last);
  }
  return nonEmpty.map(({ line }) => line.slice(minX, maxX + 1).replace(/\s+$/, "")).join("\n");
}

function candidateDescription(type, ch, x, y, distance, extra = "") {
  const label =
    type === "item" ? (ITEM_SYMBOLS.get(ch) || "item") :
    type === "door" ? "new door" :
    type === "stairs" ? "staircase" :
    type === "monster" ? "visible monster " + ch :
    type === "frontier" ? "unexplored frontier" :
    "unvisited reachable area";
  return `${label} at (${x},${y}), ${distance} steps away${extra ? ". " + extra : ""}`;
}

function extractGoalCandidates(screen, visited) {
  const player = playerPosition(screen);
  if (!player) return [];
  const distances = distanceMap(screen, player);
  const buckets = { item: [], door: [], stairs: [], monster: [], frontier: [], explore: [] };

  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = 0; x < COLS; x++) {
      const key = x + "," + y;
      const distance = distances.get(key);
      if (!Number.isFinite(distance) || distance === 0) continue;
      const ch = screen[y]?.[x] ?? " ";

      if (ITEM_SYMBOLS.has(ch)) {
        const extra = ch === "," ? "This is the mandatory Amulet." :
          ch === ":" ? "Food directly supports survival." :
          ch === "*" ? "Gold is optional compared with exploration and survival." :
          "Potentially useful equipment or consumable.";
        buckets.item.push({ id: `item_${x}_${y}`, type: "item", ch, x, y, distance, description: candidateDescription("item", ch, x, y, distance, extra) });
        continue;
      }
      if (ch === "%") {
        buckets.stairs.push({ id: `stairs_${x}_${y}`, type: "stairs", ch, x, y, distance, description: candidateDescription("stairs", ch, x, y, distance, "Use it to change dungeon level when appropriate.") });
        continue;
      }
      if (ch === "+" && !visited.has(key)) {
        buckets.door.push({ id: `door_${x}_${y}`, type: "door", ch, x, y, distance, description: candidateDescription("door", ch, x, y, distance, "A newly discovered door may lead to unexplored rooms or corridors.") });
        continue;
      }
      if (isMonster(ch) && distance <= 3) {
        buckets.monster.push({ id: `monster_${x}_${y}`, type: "monster", ch, x, y, distance, description: candidateDescription("monster", ch, x, y, distance, "Only prioritize if it blocks progress or is an immediate threat.") });
        continue;
      }

      if (isWalkable(screen, x, y) && !visited.has(key)) {
        let unknownNeighbor = false;
        for (let dy = -1; dy <= 1 && !unknownNeighbor; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (Math.abs(dx) + Math.abs(dy) !== 1) continue;
            const adjacent = screen[y + dy]?.[x + dx] ?? " ";
            if (adjacent === " ") {
              unknownNeighbor = true;
              break;
            }
          }
        }
        if (unknownNeighbor && (ch === "#" || ch === "+" || ch === ".")) {
          buckets.frontier.push({ id: `frontier_${x}_${y}`, type: "frontier", ch, x, y, distance, description: candidateDescription("frontier", ch, x, y, distance, "Reaching this edge can reveal more of the level.") });
        } else if (ch === "." || ch === "#") {
          buckets.explore.push({ id: `explore_${x}_${y}`, type: "explore", ch, x, y, distance, description: candidateDescription("explore", ch, x, y, distance) });
        }
      }
    }
  }

  for (const values of Object.values(buckets)) values.sort((a, b) => a.distance - b.distance);
  const selected = [
    ...buckets.item.slice(0, 6),
    ...buckets.door.slice(0, 4),
    ...buckets.stairs.slice(0, 2),
    ...buckets.monster.slice(0, 2),
    ...buckets.frontier.slice(0, 4),
  ];
  if (selected.length < 4) selected.push(...buckets.explore.slice(0, 4 - selected.length));
  return selected.slice(0, 18);
}


function inventoryHas(inventory, pattern) {
  return Object.values(inventory).some((description) => pattern.test(description));
}

function visibleMonsterCount(screen, radius = 3) {
  const player = playerPosition(screen);
  if (!player) return 0;
  let count = 0;
  for (let y = Math.max(1, player.y - radius); y <= Math.min(ROWS - 2, player.y + radius); y++) {
    for (let x = Math.max(0, player.x - radius); x <= Math.min(COLS - 1, player.x + radius); x++) {
      if (Math.max(Math.abs(x - player.x), Math.abs(y - player.y)) > radius) continue;
      if (isMonster(screen[y]?.[x] ?? " ")) count++;
    }
  }
  return count;
}

function tacticalTrigger(screen, inventory) {
  const status = parseStatus(screen[23] || "");
  if (!status) return false;
  const hp = Number(status.hp);
  const maxHp = Number(status.maxHp);
  const hpRatio = maxHp > 0 ? hp / maxHp : 1;
  const str = Number(status.str);
  const maxStr = Number(status.maxStr);
  const monsters = visibleMonsterCount(screen, 3);

  if (/hungry|weak|faint/i.test(status.hunger || "") && inventoryHas(inventory, /food|ration|fruit|slime mold/i)) return true;
  if (hpRatio < 0.75 && inventoryHas(inventory, /potion/i)) return true;
  if (hpRatio < 0.55 && monsters === 0) return true;
  if (str < maxStr && inventoryHas(inventory, /(restore strength|gain strength|potion)/i)) return true;
  if (monsters > 0 && inventoryHas(inventory, /(wand|staff|scroll|potion)/i)) return true;
  return false;
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
    this.inventoryRefreshPending = false;
    this.pendingTurn = null;
    this.noEffectLabels = new Set();
    this.recentActions = [];
    this.currentGoal = null;
    this.visitedByLevel = new Map();
    this.lastTacticalFingerprint = "";
    this.screen = Array.from({ length: ROWS }, () => " ".repeat(COLS));
    this.updateModeUI();
    this.renderInventory();
  }

  screenUpdated(screen) {
    this.screen = screen;
    const message = (screen[0] || "").trim();
    if (message && message !== this.lastMessage && !message.endsWith("--More--")) {
      this.lastMessage = message;
      ui.messageOverlay.textContent = message;
      ui.messageOverlay.hidden = false;
      this.recentMessages.push(message);
      this.recentMessages = this.recentMessages.slice(-16);
      this.learnInventory(message);
      this.renderMessages();
    }
    const status = parseStatus(screen[23] || "");
    ui.floor.textContent = status?.level || "—";
    renderStatus(screen[23] || "");
    ui.terminal.textContent = screen.slice(0, ROWS - 1).join("\n");

    const rip = isRipScreen(screen);
    ui.ripOverlay.hidden = !rip;
    if (rip) {
      ui.ripArt.textContent = centeredRipText(screen);
      ui.messageOverlay.hidden = true;
    } else if (this.lastMessage) {
      ui.messageOverlay.hidden = false;
    }
    if (this.following) requestAnimationFrame(() => this.centerPlayer());
  }

  learnInventory(message) {
    let changed = false;
    let match = message.match(/^([a-z])\)\s+(.+)$/);
    if (match) {
      this.inventory[match[1]] = match[2];
      changed = true;
    } else {
      match = message.match(/^(.+?)\s+\(([a-z])\)$/);
      if (match) {
        this.inventory[match[2]] = match[1];
        changed = true;
      }
    }
    if (/empty handed|aren't carrying anything/i.test(message)) {
      this.inventory = {};
      changed = true;
    }
    if (changed) this.renderInventory();
  }

  renderInventory() {
    const equipment = {
      WPN: null,
      ARM: null,
      LEFT: null,
      RIGHT: null,
    };
    const pack = Object.entries(this.inventory).sort(([a], [b]) => a.localeCompare(b));

    for (const [letter, description] of pack) {
      if (/\(weapon in hand\)/i.test(description)) equipment.WPN = [letter, description];
      if (/\(being worn\)/i.test(description)) equipment.ARM = [letter, description];
      if (/\(on left hand\)/i.test(description)) equipment.LEFT = [letter, description];
      if (/\(on right hand\)/i.test(description)) equipment.RIGHT = [letter, description];
    }

    ui.equipmentList.replaceChildren();
    for (const [slot, entry] of Object.entries(equipment)) {
      const row = document.createElement("div");
      const label = document.createElement("span");
      const value = document.createElement("b");
      label.textContent = slot;
      value.textContent = entry
        ? entry[1].replace(/\s+\((?:weapon in hand|being worn|on left hand|on right hand)\)$/i, "")
        : "—";
      row.append(label, value);
      ui.equipmentList.appendChild(row);
    }

    ui.packList.replaceChildren();
    if (pack.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "—";
      ui.packList.appendChild(li);
      return;
    }
    for (const [letter, description] of pack) {
      const li = document.createElement("li");
      const key = document.createElement("b");
      const text = document.createElement("span");
      key.textContent = letter + ")";
      text.textContent = description
        .replace(/\s+\((?:weapon in hand|being worn|on left hand|on right hand)\)$/i, "");
      li.append(key, text);
      ui.packList.appendChild(li);
    }
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
    const cellHeight = ui.terminal.scrollHeight / (ROWS - 1);
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
    } else if (this.mode === "fast" && phase === "turn") {
      await sleep(FAST_DELAY_MS);
      if (this.mode === "paused") return this.waitUntilAllowed(phase);
    }
  }

  async getch(screen) {
    let phase = detectPhase(screen);

    if (phase === "turn" && this.pendingTurn) {
      const fingerprint = screen.join("\n");
      if (fingerprint === this.pendingTurn.fingerprint) {
        this.noEffectLabels.add(this.pendingTurn.label);
      } else {
        this.noEffectLabels.clear();
      }
      this.pendingTurn = null;
    }

    if (phase === "more" || phase === "continue") {
      ui.apiStatus.textContent = phase === "continue" ? "CONTINUE" : "MORE";
      await sleep(70);
      return " ".charCodeAt(0);
    }
    if (phase === "item" && Object.keys(this.inventory).length === 0) {
      this.addSystemMessage("No known pack slots for this prompt; cancelling it.");
      return ESC;
    }

    if ((this.bootstrapInventory || this.inventoryRefreshPending) && phase === "turn") {
      this.bootstrapInventory = false;
      this.inventoryRefreshPending = false;
      this.bootstrapInProgress = true;
      this.inventory = {};
      this.renderInventory();
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
        if (phase === "turn") return await this.nextTurnKey(screen);
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

  visitedSet(screen) {
    const status = parseStatus(screen[23] || "");
    const level = status?.level || "unknown";
    if (!this.visitedByLevel.has(level)) this.visitedByLevel.set(level, new Set());
    return this.visitedByLevel.get(level);
  }

  rememberCurrentPosition(screen) {
    const player = playerPosition(screen);
    if (player) this.visitedSet(screen).add(player.x + "," + player.y);
  }

  goalStillValid(screen, goal) {
    const player = playerPosition(screen);
    if (!player || !goal) return false;
    if (player.x === goal.x && player.y === goal.y) return true;
    const ch = screen[goal.y]?.[goal.x] ?? " ";
    if (goal.type === "item") return ch === goal.ch;
    if (goal.type === "stairs") return ch === "%";
    if (goal.type === "door") return ch === "+";
    if (goal.type === "monster") return ch === goal.ch;
    return isWalkable(screen, goal.x, goal.y);
  }

  hasAmulet() {
    return Object.values(this.inventory).some((description) => /amulet/i.test(description)) ||
      this.recentMessages.some((message) => /amulet/i.test(message));
  }

  tacticalFingerprint(screen) {
    const status = parseStatus(screen[23] || "");
    const nearby = visibleMonsterCount(screen, 3);
    return JSON.stringify({
      hp: status?.hp,
      maxHp: status?.maxHp,
      str: status?.str,
      maxStr: status?.maxStr,
      hunger: status?.hunger,
      nearby,
      inventory: this.inventory,
    });
  }

  async askTactic(screen) {
    this.currentAbort = new AbortController();
    ui.apiStatus.textContent = "TACTIC…";
    ui.apiStatus.classList.remove("error");

    const response = await fetch("/api/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phase: "tactic",
        screen,
        inventory: this.inventory,
        recentMessages: this.recentMessages,
        recentActions: this.recentActions,
      }),
      signal: this.currentAbort.signal,
    });
    const data = await response.json().catch(() => ({ error: "Invalid server response" }));
    this.currentAbort = null;
    if (!response.ok) throw new Error(data.error || "Jev tactic request failed");

    this.inputCount += 1;
    ui.inputCount.textContent = String(this.inputCount);
    this.renderDecision(data);
    this.recentActions.push("tactic:" + data.label);
    this.recentActions = this.recentActions.slice(-16);
    return data;
  }

  async askGoal(screen, candidates) {
    this.currentAbort = new AbortController();
    ui.apiStatus.textContent = "GOAL…";
    ui.apiStatus.classList.remove("error");

    const response = await fetch("/api/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phase: "goal",
        screen,
        inventory: this.inventory,
        recentMessages: this.recentMessages,
        recentActions: this.recentActions,
        candidates,
      }),
      signal: this.currentAbort.signal,
    });
    const data = await response.json().catch(() => ({ error: "Invalid server response" }));
    this.currentAbort = null;
    if (!response.ok) throw new Error(data.error || "Jev goal request failed");

    this.inputCount += 1;
    ui.inputCount.textContent = String(this.inputCount);
    ui.apiStatus.textContent = "ROUTE";
    this.renderDecision(data);
    this.recentActions.push("goal:" + data.target.type + "@" + data.target.x + "," + data.target.y);
    this.recentActions = this.recentActions.slice(-16);
    return data.target;
  }

  async nextTurnKey(screen) {
    this.rememberCurrentPosition(screen);
    const player = playerPosition(screen);
    if (!player) return ".".charCodeAt(0);

    const tacticFingerprint = this.tacticalFingerprint(screen);
    if (tacticalTrigger(screen, this.inventory) && tacticFingerprint !== this.lastTacticalFingerprint) {
      this.lastTacticalFingerprint = tacticFingerprint;
      const tactic = await this.askTactic(screen);
      if (Number.isFinite(tactic.key)) {
        if (new Set(["eat", "quaff", "read_scroll", "wield", "wear_armor", "take_off_armor", "put_on_ring", "remove_ring", "zap", "drop"]).has(tactic.label)) {
          this.inventoryRefreshPending = true;
        }
        ui.apiStatus.textContent = "TACTIC";
        return tactic.key;
      }
      ui.apiStatus.textContent = "ROUTE";
    } else if (!tacticalTrigger(screen, this.inventory)) {
      this.lastTacticalFingerprint = "";
    }

    if (this.currentGoal && player.x === this.currentGoal.x && player.y === this.currentGoal.y) {
      const reached = this.currentGoal;
      this.currentGoal = null;
      if (reached.type === "stairs") {
        ui.apiStatus.textContent = this.hasAmulet() ? "ASCEND" : "DESCEND";
        return (this.hasAmulet() ? "<" : ">").charCodeAt(0);
      }
    }

    if (this.currentGoal && this.goalStillValid(screen, this.currentGoal)) {
      const path = shortestPath(screen, player, this.currentGoal);
      if (path && path.length > 1) {
        const key = keyForStep(path[0], path[1]);
        if (key) {
          ui.apiStatus.textContent = "ROUTE";
          return key.charCodeAt(0);
        }
      }
    }

    this.currentGoal = null;
    const candidates = extractGoalCandidates(screen, this.visitedSet(screen));
    if (candidates.length === 0) {
      ui.apiStatus.textContent = "SEARCH";
      return "s".charCodeAt(0);
    }

    this.currentGoal = await this.askGoal(screen, candidates);
    const path = shortestPath(screen, player, this.currentGoal);
    if (path && path.length > 1) {
      const key = keyForStep(path[0], path[1]);
      if (key) return key.charCodeAt(0);
    }
    if (this.currentGoal.type === "stairs") {
      const reached = this.currentGoal;
      this.currentGoal = null;
      return (this.hasAmulet() ? "<" : ">").charCodeAt(0);
    }

    this.currentGoal = null;
    return "s".charCodeAt(0);
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
        recentActions: this.recentActions,
        avoidLabels: phase === "turn" ? [...this.noEffectLabels] : [],
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
    ui.lastAction.textContent = data.target
      ? (`TARGET ${data.target.type.toUpperCase()} · ${data.target.description}`)
      : data.phase === "tactic"
        ? (`TACTIC · ${String(data.label || "—").replaceAll("_", " ").toUpperCase()}`)
        : String(data.label || "—").replaceAll("_", " ").toUpperCase();
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
