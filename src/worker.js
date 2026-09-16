const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const MAX_BODY_BYTES = 18000;
const MAX_AGENTS = 6;
const MAX_NODES = 12;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function validId(value) {
  return typeof value === "string" && /^[a-z0-9_-]{1,32}$/.test(value);
}

function text(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sanitizeWorld(input) {
  if (!input || typeof input !== "object") throw new Error("world is required");
  if (!Array.isArray(input.nodes) || input.nodes.length < 2 || input.nodes.length > MAX_NODES) {
    throw new Error("world.nodes must contain 2-" + MAX_NODES + " nodes");
  }
  if (!Array.isArray(input.agents) || input.agents.length < 1 || input.agents.length > MAX_AGENTS) {
    throw new Error("world.agents must contain 1-" + MAX_AGENTS + " agents");
  }

  const nodes = input.nodes.map((node) => {
    if (!validId(node.id)) throw new Error("invalid node id");
    return {
      id: node.id,
      name: text(node.name, 40),
      kind: text(node.kind, 40),
      description: text(node.description, 180),
      crowd: finite(node.crowd),
      danger: finite(node.danger),
      opportunity: finite(node.opportunity),
      anomaly: finite(node.anomaly),
    };
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (nodeIds.size !== nodes.length) throw new Error("node ids must be unique");

  const edges = Array.isArray(input.edges)
    ? input.edges
        .filter((edge) => Array.isArray(edge) && edge.length === 2)
        .map((edge) => [String(edge[0]), String(edge[1])])
        .filter((edge) => nodeIds.has(edge[0]) && nodeIds.has(edge[1]))
        .slice(0, 30)
    : [];

  const agents = input.agents.map((agent) => {
    if (!validId(agent.id)) throw new Error("invalid agent id");
    if (!nodeIds.has(agent.node)) throw new Error("agent references unknown node");
    return {
      id: agent.id,
      name: text(agent.name, 40),
      role: text(agent.role, 80),
      goal: text(agent.goal, 180),
      temperament: text(agent.temperament, 180),
      node: agent.node,
      energy: finite(agent.energy, 5),
      knowledge: finite(agent.knowledge),
      memory: Array.isArray(agent.memory)
        ? agent.memory.slice(-4).map((item) => text(item, 160))
        : [],
    };
  });

  return {
    turn: Math.max(0, Math.floor(finite(input.turn))),
    time: text(input.time, 24),
    weather: text(input.weather, 80),
    worldLaw: text(input.worldLaw, 900),
    intervention: text(input.intervention, 500),
    nodes,
    edges,
    agents,
  };
}

function neighbors(world, nodeId) {
  const result = [];
  for (const edge of world.edges) {
    if (edge[0] === nodeId) result.push(edge[1]);
    if (edge[1] === nodeId) result.push(edge[0]);
  }
  return [...new Set(result)];
}

function nodeById(world, id) {
  return world.nodes.find((node) => node.id === id);
}

function choice(instructions, criteria) {
  return { type: "choice", instructions, criteria };
}

function score(instructions, criteria) {
  return { type: "score", instructions, criteria };
}

function noul(instructions, criteria) {
  return { type: "noul", instructions, criteria };
}

function buildQuestions(world) {
  const questions = {};

  world.agents.forEach((agent, index) => {
    const currentNode = nodeById(world, agent.node);
    const prefix = "agent_" + agent.id + "_";
    const shared = {
      task_context: "Judge the behavior of one autonomous inhabitant in a bounded simulation.",
      agent_path: "agents[" + index + "]",
      current_node: currentNode,
      world_law: world.worldLaw,
      current_intervention: world.intervention || "none",
      instruction:
        "Use ordinary common sense. Respect the agent's role, goal, temperament, energy, memory, current place, topology, and current world conditions. Do not invent actions outside the allowed outputs.",
    };

    questions[prefix + "action"] = choice(
      {
        ...shared,
        question: "What is the agent most inclined to do next during this short turn?",
      },
      {
        move: "Travel to one directly connected place because another location better serves the agent now.",
        investigate: "Inspect something unusual or informative at the current place.",
        socialize: "Interact with another inhabitant at the current place.",
        work: "Perform useful role-related activity at the current place.",
        rest: "Recover energy and avoid unnecessary activity.",
        observe: "Stay put, watch the situation, and gather context without committing.",
      },
    );

    const destinationCriteria = { stay: "Remain at the current place." };
    for (const id of neighbors(world, agent.node)) {
      const node = nodeById(world, id);
      destinationCriteria[id] =
        "Move to " + node.name + " (" + node.kind + "): " + node.description;
    }
    questions[prefix + "destination"] = choice(
      {
        ...shared,
        hypothetical:
          "Answer this even if the agent may not move. IF the agent chooses move, which directly connected destination best fits? Otherwise this answer will be ignored by code.",
        question: "Select the best immediate destination.",
      },
      destinationCriteria,
    );

    const targetCriteria = { nobody: "Do not seek a social interaction this turn." };
    for (const other of world.agents) {
      if (other.id === agent.id) continue;
      targetCriteria[other.id] =
        other.name +
        ", " +
        other.role +
        ", currently at " +
        nodeById(world, other.node).name +
        ".";
    }
    questions[prefix + "social"] = choice(
      {
        ...shared,
        hypothetical:
          "Answer this even if the agent may not socialize. IF the agent socializes, select the most sensible person to approach. Prefer people who are actually co-located. Otherwise this answer will be ignored by code.",
        question: "Who should the agent interact with?",
      },
      targetCriteria,
    );

    questions[prefix + "urgency"] = score(
      {
        ...shared,
        question: "How urgent is it for this agent to advance their stated goal right now?",
      },
      [
        "0 — no immediate pressure; delaying is harmless.",
        "1 — mild relevance; the goal can wait.",
        "2 — useful to advance, but competing needs matter equally.",
        "3 — strong pressure; the agent should prefer goal-directed behavior.",
        "4 — immediate priority; delay would materially hurt the goal.",
      ],
    );

    questions[prefix + "anomaly"] = noul(
      {
        ...shared,
        question:
          "Is there enough unusual, surprising, suspicious, or newly relevant context at the current place to justify investigation?",
      },
      {
        true: "There is a concrete reason to investigate now.",
        false: "Nothing present is compelling enough to investigate now.",
      },
    );
  });

  return questions;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/turn") {
      return env.ASSETS.fetch(request);
    }
    if (request.method !== "POST") {
      return json({ error: "POST required" }, 405);
    }
    if (!env.TYPESAFE_API_KEY) {
      return json(
        {
          error: "TYPESAFE_API_KEY is not configured",
          setup: "Run: npx wrangler secret put TYPESAFE_API_KEY",
        },
        503,
      );
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: "request is too large" }, 413);

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }

    let world;
    try {
      world = sanitizeWorld(body.world);
    } catch (error) {
      return json({ error: error.message || "invalid world" }, 400);
    }

    const questions = buildQuestions(world);
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
          state: world,
          questions,
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      return json({ error: "TypeSafe request failed", detail: String(error) }, 502);
    }

    const upstreamText = await upstream.text();
    let result;
    try {
      result = JSON.parse(upstreamText);
    } catch {
      result = { error: upstreamText || "empty TypeSafe response" };
    }

    if (!upstream.ok) {
      return json(
        {
          error: "TypeSafe API returned " + upstream.status,
          detail: result,
        },
        upstream.status,
      );
    }

    return json({
      ...result,
      elapsed_ms: Date.now() - started,
      question_count: Object.keys(questions).length,
    });
  },
};
