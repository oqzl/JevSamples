const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const MAX_BODY_BYTES = 16000;
const PHASES = new Set(["turn", "goal", "direction", "item", "hand"]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function cleanText(value, max) {
  return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max) : "";
}

function sanitizeInput(input) {
  if (!input || typeof input !== "object") throw new Error("state is required");
  const phase = PHASES.has(input.phase) ? input.phase : "turn";
  const screen = Array.isArray(input.screen)
    ? input.screen.slice(0, 24).map((line) => cleanText(line, 80).padEnd(80, " ").slice(0, 80))
    : [];
  if (screen.length !== 24) throw new Error("screen must contain 24 rows");

  const inventory = {};
  if (input.inventory && typeof input.inventory === "object") {
    for (const [letter, description] of Object.entries(input.inventory)) {
      if (/^[a-z]$/.test(letter)) inventory[letter] = cleanText(description, 120);
    }
  }

  const recentMessages = Array.isArray(input.recentMessages)
    ? input.recentMessages.slice(-16).map((message) => cleanText(message, 160))
    : [];

  const recentActions = Array.isArray(input.recentActions)
    ? input.recentActions.slice(-16).map((action) => cleanText(action, 40))
    : [];

  const avoidLabels = Array.isArray(input.avoidLabels)
    ? input.avoidLabels.filter((label) => typeof label === "string").slice(-16)
    : [];

  const candidates = Array.isArray(input.candidates)
    ? input.candidates.slice(0, 20).flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const id = cleanText(candidate.id, 80);
        const description = cleanText(candidate.description, 240);
        const type = cleanText(candidate.type, 40);
        const x = Number(candidate.x);
        const y = Number(candidate.y);
        const distance = Number(candidate.distance);
        if (!id || !description || !Number.isFinite(x) || !Number.isFinite(y)) return [];
        return [{ id, description, type, x, y, distance: Number.isFinite(distance) ? distance : null }];
      })
    : [];

  return { phase, screen, inventory, recentMessages, recentActions, avoidLabels, candidates };
}

function choice(instructions, criteria) {
  return { type: "choice", instructions, criteria };
}

const DIRECTION_CRITERIA = {
  north: "Move one cell up on the screen (Rogue key k).",
  south: "Move one cell down on the screen (Rogue key j).",
  west: "Move one cell left on the screen (Rogue key h).",
  east: "Move one cell right on the screen (Rogue key l).",
  north_west: "Move diagonally up-left (Rogue key y).",
  north_east: "Move diagonally up-right (Rogue key u).",
  south_west: "Move diagonally down-left (Rogue key b).",
  south_east: "Move diagonally down-right (Rogue key n).",
  cancel: "Cancel the pending directional command if using it would be harmful or pointless.",
};

const DIRECTION_KEYS = {
  north: "k",
  south: "j",
  west: "h",
  east: "l",
  north_west: "y",
  north_east: "u",
  south_west: "b",
  south_east: "n",
  cancel: "\u001b",
};

const TURN_CRITERIA = {
  north: "Move one cell up. Use to explore, approach useful terrain, or attack a monster directly above.",
  south: "Move one cell down. Use to explore, approach useful terrain, or attack a monster directly below.",
  west: "Move one cell left. Use to explore, approach useful terrain, or attack a monster directly left.",
  east: "Move one cell right. Use to explore, approach useful terrain, or attack a monster directly right.",
  north_west: "Move diagonally up-left, including attacking a monster there when legal.",
  north_east: "Move diagonally up-right, including attacking a monster there when legal.",
  south_west: "Move diagonally down-left, including attacking a monster there when legal.",
  south_east: "Move diagonally down-right, including attacking a monster there when legal.",
  search: "Search adjacent cells for hidden doors or traps. Useful when exploration appears blocked or suspicious.",
  rest: "Spend a turn doing nothing. Useful to heal when safe, but consumes food and lets monsters move.",
  descend: "Use the staircase under @ to descend one dungeon level. Only works when standing on %.",
  ascend: "Use the staircase under @ to ascend. The Amulet is required before the return journey can succeed.",
  pickup: "Pick up the object under @. Movement normally auto-picks items up, so use only when needed.",
  inventory: "Inspect the pack without spending a game turn. Use when item knowledge is stale or a tactical item may help.",
  eat: "Eat food from the pack when Hungry, Weak, Faint, or when starvation risk is approaching.",
  quaff: "Drink a potion from the pack when its possible benefit justifies using a consumable.",
  read_scroll: "Read a scroll from the pack when its possible benefit justifies using a consumable.",
  wield: "Choose a weapon to wield. Use when a better weapon is known in the pack.",
  wear_armor: "Choose armor to wear. Only works when not already wearing armor.",
  take_off_armor: "Take off current armor when there is a reason to switch it.",
  put_on_ring: "Choose a ring to wear, then choose a hand.",
  remove_ring: "Choose a worn ring to remove.",
  zap: "Zap a wand or staff. Rogue will ask for a direction and then the item.",
  throw: "Throw an item. Rogue will ask for an item and direction.",
  drop: "Drop a carried item onto the current floor cell.",
};

const TURN_KEYS = {
  ...DIRECTION_KEYS,
  search: "s",
  rest: ".",
  descend: ">",
  ascend: "<",
  pickup: ",",
  inventory: "i",
  eat: "e",
  quaff: "q",
  read_scroll: "r",
  wield: "w",
  wear_armor: "W",
  take_off_armor: "T",
  put_on_ring: "P",
  remove_ring: "R",
  zap: "z",
  throw: "t",
  drop: "d",
};

delete TURN_CRITERIA.cancel;
delete TURN_KEYS.cancel;

const TURN_DIRECTIONS = {
  north: [-1, 0],
  south: [1, 0],
  west: [0, -1],
  east: [0, 1],
  north_west: [-1, -1],
  north_east: [-1, 1],
  south_west: [1, -1],
  south_east: [1, 1],
};

function findPlayer(screen) {
  for (let y = 1; y < screen.length - 1; y++) {
    const x = screen[y].indexOf("@");
    if (x >= 0) return { y, x };
  }
  return null;
}

function visiblyBlocked(ch) {
  return ch === " " || ch === "|" || ch === "-";
}

function movementContext(screen) {
  const player = findPlayer(screen);
  const legalMoves = new Set(Object.keys(TURN_DIRECTIONS));
  const visibleStairs = [];

  for (let y = 1; y < screen.length - 1; y++) {
    for (let x = 0; x < screen[y].length; x++) {
      if (screen[y][x] === "%") visibleStairs.push({ y, x });
    }
  }

  if (!player) return { player, legalMoves, visibleStairs };

  legalMoves.clear();
  for (const [label, [dy, dx]] of Object.entries(TURN_DIRECTIONS)) {
    const target = screen[player.y + dy]?.[player.x + dx] ?? " ";
    if (visiblyBlocked(target)) continue;

    if (dy !== 0 && dx !== 0) {
      const vertical = screen[player.y + dy]?.[player.x] ?? " ";
      const horizontal = screen[player.y]?.[player.x + dx] ?? " ";
      if (visiblyBlocked(vertical) || visiblyBlocked(horizontal)) continue;
    }
    legalMoves.add(label);
  }
  return { player, legalMoves, visibleStairs };
}

function statusContext(line) {
  const match = line.match(/Level:\s*(\d+).*?Gold:\s*(\d+).*?Hp:\s*(\d+)\((\d+)\).*?Str:\s*(\d+)\((\d+)\).*?Arm:\s*(\d+).*?Exp:\s*(\d+)\/(\d+)\s*(.*)$/i);
  if (!match) return { raw: line.trim() };
  return {
    level: Number(match[1]),
    gold: Number(match[2]),
    hp: Number(match[3]),
    max_hp: Number(match[4]),
    strength: Number(match[5]),
    max_strength: Number(match[6]),
    armor: Number(match[7]),
    experience_level: Number(match[8]),
    experience_points: Number(match[9]),
    hunger: match[10].trim() || "normal",
  };
}

function hasInventoryType(inventory, pattern) {
  return Object.values(inventory).some((description) => pattern.test(description));
}

function turnQuestion(state) {
  const movement = movementContext(state.screen);
  const status = statusContext(state.screen[23] || "");
  const avoid = new Set(state.avoidLabels);
  const criteria = {};
  const keys = {};

  for (const [label, description] of Object.entries(TURN_CRITERIA)) {
    if (label in TURN_DIRECTIONS && !movement.legalMoves.has(label)) continue;
    if (avoid.has(label)) continue;

    if (label === "inventory" || label === "pickup") continue;
    if (label === "rest" && !(Number.isFinite(status.hp) && Number.isFinite(status.max_hp) && status.hp < status.max_hp * 0.45)) continue;
    if (label === "search" && movement.legalMoves.size >= 2) continue;
    if (label === "eat" && !/hungry|weak|faint/i.test(status.hunger || "")) continue;
    if (label === "wield" && !hasInventoryType(state.inventory, /mace|sword|bow|arrow|dagger|dart|shuriken|spear|weapon/i)) continue;
    if (label === "wear_armor" && !hasInventoryType(state.inventory, /armor|mail|leather|plate|splint|scale|chain|ring mail/i)) continue;
    if (label === "put_on_ring" && !hasInventoryType(state.inventory, /ring/i)) continue;
    if (label === "zap" && !hasInventoryType(state.inventory, /wand|staff/i)) continue;
    if (label === "quaff" && !hasInventoryType(state.inventory, /potion/i)) continue;
    if (label === "read_scroll" && !hasInventoryType(state.inventory, /scroll/i)) continue;
    if (label === "throw" && !hasInventoryType(state.inventory, /arrow|dagger|dart|shuriken|spear/i)) continue;
    if (label === "drop" || label === "take_off_armor" || label === "remove_ring") continue;

    criteria[label] = description;
    keys[label] = TURN_KEYS[label];
  }

  if (Object.keys(criteria).length < 2) {
    for (const label of movement.legalMoves) {
      if (avoid.has(label)) continue;
      criteria[label] = TURN_CRITERIA[label];
      keys[label] = TURN_KEYS[label];
    }
    criteria.search = TURN_CRITERIA.search;
    keys.search = TURN_KEYS.search;
  }

  return { criteria, keys, movement, status };
}

function itemQuestion(state) {
  const criteria = {};
  const keys = {};
  for (const [letter, description] of Object.entries(state.inventory)) {
    const id = "slot_" + letter;
    criteria[id] = description || "Pack slot " + letter + ".";
    keys[id] = letter;
  }
  criteria.cancel = "Cancel because no known pack item fits the current prompt.";
  keys.cancel = "\u001b";
  return { criteria, keys };
}

function buildQuestion(state) {
  if (state.phase === "goal") {
    const criteria = {};
    const targets = {};
    for (const candidate of state.candidates) {
      criteria[candidate.id] = candidate.description;
      targets[candidate.id] = candidate;
    }
    if (Object.keys(criteria).length === 0) throw new Error("goal phase requires candidates");
    return {
      question: choice(
        {
          role: "You are choosing a persistent navigation goal for an autonomous Rogue 5.4.4 player. Code, not you, will compute and follow the shortest known path to the chosen coordinate.",
          objective: "WIN THE GAME: survive, explore each level, descend toward level 26, obtain the Amulet of Yendor, then climb back to the surface.",
          priority: "First handle immediate survival or a nearby blocking monster. The Amulet is mandatory. When safe, visible useful items are normally worth collecting, especially food and equipment. Newly discovered doors and unexplored frontiers are the main way to expand the known map and should be pursued rather than wandering inside an already seen room. Gold is optional. Use stairs when there is no clearly better nearby objective or the useful reachable area is already explored.",
          persistence: "Pick a destination worth committing several movement turns to. Do not optimize the next single key; choose what the player should accomplish next.",
          question: "Which candidate should become the next persistent goal?",
        },
        criteria,
      ),
      keys: null,
      targets,
    };
  }

  if (state.phase === "direction") {
    return {
      question: choice(
        "Choose the best direction for the pending Rogue command. Use only what is visible on the terminal and recent events.",
        DIRECTION_CRITERIA,
      ),
      keys: DIRECTION_KEYS,
    };
  }

  if (state.phase === "hand") {
    return {
      question: choice(
        "Choose which hand should receive the ring for the current Rogue prompt.",
        {
          left: "Use the left hand.",
          right: "Use the right hand.",
          cancel: "Cancel the ring action.",
        },
      ),
      keys: { left: "l", right: "r", cancel: "\u001b" },
    };
  }

  if (state.phase === "item") {
    const { criteria, keys } = itemQuestion(state);
    return {
      question: choice(
        "Choose the pack item that best satisfies the current Rogue prompt. The prompt is on the first terminal row. Prefer a matching known item; cancel rather than guessing an unknown slot.",
        criteria,
      ),
      keys,
    };
  }

  const { criteria, keys } = turnQuestion(state);
  return {
    question: choice(
      {
        role: "You are the sole player of Rogue 5.4.4. No human will rescue or steer you.",
        objective: "WIN THE GAME: explore each level efficiently, find the staircase, descend toward level 26, obtain the Amulet of Yendor, then reverse direction and climb back to the surface alive.",
        default_policy: "Make progress. On an ordinary safe turn, movement/exploration is the default. Prefer unexplored exits, doors, corridors, visible items, and routes toward a visible staircase. Do not loiter, repeatedly rest, repeatedly inspect inventory, or bounce between the same cells.",
        tactical_policy: "Fight monsters blocking progress. Use food when hungry. Use consumables or equipment when there is a concrete tactical reason. Search only when visible exploration routes are exhausted or a hidden door is plausible. Rest only when significantly injured and currently safe.",
        stairs_policy: "Before obtaining the Amulet, descend whenever you reach the downstairs staircase. After obtaining it, prioritize ascending toward the surface.",
        question: "Choose the single next command that most directly advances the win condition from the currently offered legal actions.",
      },
      criteria,
    ),
    keys,
  };
}

function buildState(state) {
  return {
    game: "Rogue 5.4.4",
    terminal: state.screen.join("\n"),
    current_message: state.screen[0].trim(),
    status_line: state.screen[23].trim(),
    recent_messages: state.recentMessages,
    recent_actions: state.recentActions,
    known_inventory: state.inventory,
    excluded_no_effect_actions: state.avoidLabels,
    movement_context: (() => {
      const info = movementContext(state.screen);
      return {
        player: info.player,
        legal_directions: [...info.legalMoves],
        visible_stairs: info.visibleStairs,
      };
    })(),
    status: statusContext(state.screen[23] || ""),
    goal_candidates: state.candidates,
    symbols: {
      "@": "player",
      ".": "room floor",
      "#": "corridor",
      "+": "door",
      "*": "gold",
      ")": "weapon",
      "]": "armor",
      "!": "potion",
      "?": "scroll",
      "=": "ring",
      "/": "wand or staff",
      "^": "trap",
      "%": "stairs",
      ":": "food",
      "A-Z": "monsters",
    },
    spatial_rule: "Rows increase downward and columns increase to the right. The player is @. Only visible terminal information is known.",
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/decision") return env.ASSETS.fetch(request);
    if (request.method !== "POST") return json({ error: "POST required" }, 405);
    if (!env.TYPESAFE_API_KEY) {
      return json({ error: "TYPESAFE_API_KEY is not configured" }, 503);
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: "request is too large" }, 413);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }

    let state;
    try {
      state = sanitizeInput(parsed);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "invalid state" }, 400);
    }

    let built;
    try {
      built = buildQuestion(state);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "invalid question" }, 400);
    }
    const { question, keys, targets } = built;
    const started = Date.now();
    let upstream;
    try {
      upstream = await fetch(TYPESAFE_URL, {
        method: "POST",
        headers: {
          authorization: "Bearer " + env.TYPESAFE_API_KEY,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "jev-latest",
          state: buildState(state),
          questions: { command: question },
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      return json({ error: "TypeSafe request failed", detail: String(error) }, 502);
    }

    const bodyText = await upstream.text();
    let result;
    try {
      result = JSON.parse(bodyText);
    } catch {
      result = { error: bodyText || "empty TypeSafe response" };
    }
    if (!upstream.ok) {
      return json({ error: "TypeSafe API returned " + upstream.status, detail: result }, upstream.status);
    }

    const answer = result?.answers?.command;
    const label = typeof answer?.choice === "string" ? answer.choice : "";
    if (state.phase === "goal") {
      const target = targets?.[label];
      if (!target) return json({ error: "Jev returned an unsupported goal", detail: result }, 502);
      return json({
        label,
        target,
        answer,
        model: result.model,
        usage: result.usage,
        elapsed_ms: Date.now() - started,
        phase: state.phase,
      });
    }

    const key = keys?.[label];
    if (typeof key !== "string" || key.length !== 1) {
      return json({ error: "Jev returned an unsupported command", detail: result }, 502);
    }

    return json({
      key: key.charCodeAt(0),
      label,
      answer,
      model: result.model,
      usage: result.usage,
      elapsed_ms: Date.now() - started,
      phase: state.phase,
    });
  },
};
