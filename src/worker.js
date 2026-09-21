const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const MAX_BODY_BYTES = 16000;
const PHASES = new Set(["turn", "direction", "item", "hand"]);

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

  return { phase, screen, inventory, recentMessages };
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

  return {
    question: choice(
      {
        task: "Play Rogue 5.4.4 as an autonomous dungeon explorer.",
        objective: "Survive, descend to level 26 or deeper, obtain the Amulet of Yendor, then return to the surface. Explore when the route is unknown, fight when necessary, conserve food and useful items, and do not assume unseen information.",
        question: "Choose exactly one legal next command from the listed actions.",
      },
      TURN_CRITERIA,
    ),
    keys: TURN_KEYS,
  };
}

function buildState(state) {
  return {
    game: "Rogue 5.4.4",
    terminal: state.screen.join("\n"),
    current_message: state.screen[0].trim(),
    status_line: state.screen[23].trim(),
    recent_messages: state.recentMessages,
    known_inventory: state.inventory,
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

    const { question, keys } = buildQuestion(state);
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
    const key = keys[label];
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
