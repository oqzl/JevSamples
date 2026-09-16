const TURN_MS = 5000;
const INPUT_USD_PER_TOKEN = 42 / 1_000_000_000;
const SVG_NS = "http://www.w3.org/2000/svg";

const nodeLayout = {
  harbor: [130, 390],
  market: [300, 310],
  station: [465, 410],
  tower: [735, 180],
  alley: [315, 115],
  shrine: [500, 175],
  river: [700, 410],
};

const agentColors = {
  mira: "#76e6b5",
  ren: "#ffca72",
  sora: "#7bb8ff",
  tao: "#d8a0ff",
  ivy: "#ff9fc4",
  kade: "#ff8f72",
};

function makeInitialWorld() {
  return {
    turn: 0,
    time: "18:20",
    weather: "cool evening, light wind",
    worldLaw: "",
    intervention: "",
    nodes: [
      { id: "harbor", name: "Harbor", kind: "exchange", description: "Cargo, strangers, departures, and a direct edge to the River.", crowd: 5, danger: 2, opportunity: 7, anomaly: 2 },
      { id: "market", name: "Market", kind: "commerce", description: "Dense trade and gossip. Useful for supplies and social contact.", crowd: 8, danger: 2, opportunity: 9, anomaly: 2 },
      { id: "station", name: "Station", kind: "transit", description: "A movement hub where people arrive, leave, and lose track of one another.", crowd: 7, danger: 3, opportunity: 6, anomaly: 3 },
      { id: "tower", name: "Tower", kind: "information", description: "High visibility and signals, but little shelter or commerce.", crowd: 2, danger: 4, opportunity: 5, anomaly: 4 },
      { id: "alley", name: "Alley", kind: "shortcut", description: "Fast local access, low visibility, informal exchange, and concealed spaces.", crowd: 2, danger: 6, opportunity: 5, anomaly: 6 },
      { id: "shrine", name: "Shrine", kind: "social", description: "A quiet civic and spiritual anchor where people gather deliberately.", crowd: 4, danger: 1, opportunity: 4, anomaly: 2 },
      { id: "river", name: "River", kind: "boundary", description: "A scenic boundary and transport route whose safety changes with weather.", crowd: 3, danger: 3, opportunity: 5, anomaly: 4 },
    ],
    edges: [
      ["harbor", "market"],
      ["harbor", "river"],
      ["market", "station"],
      ["market", "alley"],
      ["alley", "shrine"],
      ["station", "shrine"],
      ["station", "river"],
      ["shrine", "tower"],
      ["shrine", "river"],
      ["tower", "river"],
    ],
    agents: [
      { id: "mira", name: "Mira", role: "courier", goal: "Deliver an urgent sealed parcel to the Tower without taking reckless risks.", temperament: "dutiful, alert, moderately social, dislikes pointless detours", node: "harbor", energy: 7, knowledge: 1, memory: [] },
      { id: "ren", name: "Ren", role: "scavenger", goal: "Find unusual objects or overlooked information that could later be valuable.", temperament: "curious, opportunistic, comfortable with moderate danger, suspicious of crowds", node: "alley", energy: 6, knowledge: 2, memory: [] },
      { id: "sora", name: "Sora", role: "caretaker", goal: "Keep vulnerable people safe and notice anyone who may need help.", temperament: "patient, prosocial, risk-aware, willing to interrupt plans for clear need", node: "station", energy: 7, knowledge: 2, memory: [] },
      { id: "tao", name: "Tao", role: "merchant", goal: "Trade where demand and foot traffic are good while protecting stock from avoidable risk.", temperament: "pragmatic, sociable, price-sensitive, prefers known routes", node: "market", energy: 6, knowledge: 1, memory: [] },
      { id: "ivy", name: "Ivy", role: "pilgrim", goal: "Reach the Shrine, then seek meaningful signs without endangering others.", temperament: "reflective, curious about anomalies, calm in sparse places, avoids conflict", node: "river", energy: 8, knowledge: 1, memory: [] },
      { id: "kade", name: "Kade", role: "warden", goal: "Reduce danger at busy or strategically important places before incidents spread.", temperament: "vigilant, decisive under clear threats, protective, skeptical of rumors", node: "tower", energy: 7, knowledge: 2, memory: [] },
    ],
  };
}

let world = makeInitialWorld();
let lastAnswers = null;
let selectedAgentId = "mira";
let running = false;
let inFlight = false;
let timer = null;
let generation = 0;
let abortController = null;
const log = [];

const $ = (id) => document.getElementById(id);
const elements = {
  graph: $("worldGraph"),
  agentList: $("agentList"),
  inspector: $("inspector"),
  inspectorTitle: $("inspectorTitle"),
  log: $("eventLog"),
  start: $("startButton"),
  step: $("stepButton"),
  reset: $("resetButton"),
  status: $("apiStatus"),
  turn: $("turnLabel"),
  latency: $("latencyMetric"),
  questions: $("questionMetric"),
  tokens: $("tokenMetric"),
  cost: $("costMetric"),
  raw: $("rawResponse"),
  law: $("worldLaw"),
  intervention: $("intervention"),
  mode: $("decisionMode"),
  gate: $("gateEnabled"),
  threshold: $("gateThreshold"),
  gateOutput: $("gateOutput"),
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function node(id) {
  return world.nodes.find((item) => item.id === id);
}

function agent(id) {
  return world.agents.find((item) => item.id === id);
}

function svg(tag, attrs = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}

function renderGraph() {
  elements.graph.replaceChildren();

  for (const [a, b] of world.edges) {
    const [x1, y1] = nodeLayout[a];
    const [x2, y2] = nodeLayout[b];
    elements.graph.appendChild(svg("line", { x1, y1, x2, y2, class: "edge" }));
  }

  for (const place of world.nodes) {
    const [x, y] = nodeLayout[place.id];
    const group = svg("g", { class: "node-hit" });
    group.appendChild(svg("circle", { cx: x, cy: y, r: 47, class: "node-core" }));

    const name = svg("text", { x, y: y - 7, class: "node-name" });
    name.textContent = place.name;
    group.appendChild(name);

    const kind = svg("text", { x, y: y + 11, class: "node-kind" });
    kind.textContent = place.kind.toUpperCase();
    group.appendChild(kind);

    const meterX = x - 34;
    const meterY = y + 23;
    const meters = [
      ["node-danger", place.danger],
      ["node-opportunity", place.opportunity],
      ["node-anomaly", place.anomaly],
    ];
    meters.forEach((entry, i) => {
      group.appendChild(svg("rect", { x: meterX, y: meterY + i * 6, width: 68, height: 3, rx: 1.5, class: "node-meter-bg" }));
      group.appendChild(svg("rect", { x: meterX, y: meterY + i * 6, width: 68 * clamp(entry[1] / 10, 0, 1), height: 3, rx: 1.5, class: entry[0] }));
    });
    elements.graph.appendChild(group);
  }

  const byNode = new Map();
  for (const person of world.agents) {
    if (!byNode.has(person.node)) byNode.set(person.node, []);
    byNode.get(person.node).push(person);
  }
  for (const [nodeId, people] of byNode) {
    const [x, y] = nodeLayout[nodeId];
    people.forEach((person, index) => {
      const angle = -Math.PI / 2 + (index * Math.PI * 2) / Math.max(people.length, 3);
      const ax = x + Math.cos(angle) * 61;
      const ay = y + Math.sin(angle) * 61;
      const dot = svg("circle", { cx: ax, cy: ay, r: 11, class: "agent-dot", fill: agentColors[person.id] });
      dot.addEventListener("click", () => {
        selectedAgentId = person.id;
        render();
      });
      elements.graph.appendChild(dot);
      const initial = svg("text", { x: ax, y: ay + .5, class: "agent-initial" });
      initial.textContent = person.name.slice(0, 1).toUpperCase();
      elements.graph.appendChild(initial);
    });
  }
}

function answerFor(agentId, kind) {
  return lastAnswers && lastAnswers["agent_" + agentId + "_" + kind];
}

function renderAgents() {
  elements.agentList.replaceChildren();
  for (const person of world.agents) {
    const card = document.createElement("button");
    card.className = "agent-card" + (person.id === selectedAgentId ? " selected" : "");
    const swatch = document.createElement("i");
    swatch.className = "agent-swatch";
    swatch.style.background = agentColors[person.id];
    const main = document.createElement("span");
    main.className = "agent-main";
    const title = document.createElement("b");
    title.textContent = person.name + " · " + person.role;
    const sub = document.createElement("span");
    sub.textContent = node(person.node).name + " · energy " + person.energy + " · knowledge " + person.knowledge;
    main.append(title, sub);
    const action = document.createElement("span");
    action.className = "agent-action";
    const actionAnswer = answerFor(person.id, "action");
    action.textContent = actionAnswer ? actionAnswer.choice.toUpperCase() : "—";
    card.append(swatch, main, action);
    card.addEventListener("click", () => {
      selectedAgentId = person.id;
      render();
    });
    elements.agentList.appendChild(card);
  }
}

function distView(label, answer) {
  const section = document.createElement("div");
  section.className = "judgment";
  const head = document.createElement("div");
  head.className = "judgment-head";
  const title = document.createElement("b");
  title.textContent = label + ": " + String(answer.choice).toUpperCase();
  const confidence = document.createElement("span");
  confidence.textContent = "conf " + answer.confidence.toFixed(2);
  head.append(title, confidence);
  section.appendChild(head);

  const dist = document.createElement("div");
  dist.className = "dist";
  Object.entries(answer.probabilities)
    .sort((a, b) => b[1] - a[1])
    .forEach(([name, probability]) => {
      const row = document.createElement("div");
      row.className = "dist-row";
      const key = document.createElement("span");
      key.className = "dist-label";
      key.textContent = name;
      const track = document.createElement("span");
      track.className = "dist-track";
      const fill = document.createElement("i");
      fill.className = "dist-fill";
      fill.style.width = (probability * 100).toFixed(1) + "%";
      track.appendChild(fill);
      const value = document.createElement("span");
      value.className = "dist-value";
      value.textContent = (probability * 100).toFixed(0) + "%";
      row.append(key, track, value);
      dist.appendChild(row);
    });
  section.appendChild(dist);
  return section;
}

function renderInspector() {
  const person = agent(selectedAgentId);
  elements.inspectorTitle.textContent = person.name + " / " + person.role;
  elements.inspector.replaceChildren();
  const action = answerFor(person.id, "action");
  if (!action) {
    elements.inspector.className = "inspector empty";
    elements.inspector.textContent = "Run one turn to inspect Jev's typed probability distributions.";
    return;
  }
  elements.inspector.className = "inspector";
  elements.inspector.appendChild(distView("ACTION", action));
  elements.inspector.appendChild(distView("DESTINATION · speculative", answerFor(person.id, "destination")));

  const social = answerFor(person.id, "social");
  elements.inspector.appendChild(distView("SOCIAL TARGET · speculative", social));

  const urgency = answerFor(person.id, "urgency");
  const urgencyBox = document.createElement("div");
  urgencyBox.className = "judgment";
  urgencyBox.innerHTML = '<div class="judgment-head"><b>GOAL URGENCY</b><span>' + urgency.score.toFixed(2) + " / 4 · conf " + urgency.confidence.toFixed(2) + "</span></div>";
  elements.inspector.appendChild(urgencyBox);

  const anomaly = answerFor(person.id, "anomaly");
  const anomalyBox = document.createElement("div");
  anomalyBox.className = "judgment";
  const anomalyHead = document.createElement("div");
  anomalyHead.className = "judgment-head";
  anomalyHead.innerHTML = "<b>ANOMALY WORTH INVESTIGATING</b><span>" + anomaly.noul.toFixed(2) + "</span>";
  const meter = document.createElement("div");
  meter.className = "noul-meter";
  const fill = document.createElement("i");
  fill.style.width = (anomaly.noul * 100).toFixed(1) + "%";
  meter.appendChild(fill);
  anomalyBox.append(anomalyHead, meter);
  elements.inspector.appendChild(anomalyBox);
}

function renderLog() {
  elements.log.replaceChildren();
  for (const item of log.slice(0, 50)) {
    const li = document.createElement("li");
    const turn = document.createElement("time");
    turn.textContent = "T" + item.turn;
    const actor = document.createElement("span");
    actor.className = "actor";
    actor.textContent = item.actor;
    const message = document.createElement("span");
    message.textContent = item.message;
    li.append(turn, actor, message);
    elements.log.appendChild(li);
  }
}

function render() {
  elements.turn.textContent = world.turn;
  renderGraph();
  renderAgents();
  renderInspector();
  renderLog();
}

function addLog(actorName, message) {
  log.unshift({ turn: world.turn, actor: actorName.toUpperCase(), message });
}

function choose(answer) {
  if (!answer) return null;
  if (elements.mode.value === "argmax") return answer.choice;
  let roll = Math.random();
  for (const [key, probability] of Object.entries(answer.probabilities)) {
    roll -= probability;
    if (roll <= 0) return key;
  }
  return answer.choice;
}

function coLocated(a, b) {
  return a.node === b.node;
}

function remember(person, message) {
  person.memory.push(message);
  person.memory = person.memory.slice(-4);
}

function applyDecision(person) {
  const actionAnswer = answerFor(person.id, "action");
  let action = choose(actionAnswer) || "observe";
  const threshold = Number(elements.threshold.value);
  if (elements.gate.checked && actionAnswer.confidence < threshold) {
    addLog(person.name, "Confidence " + actionAnswer.confidence.toFixed(2) + " fell below the demo gate; code replaced " + action + " with observe.");
    action = "observe";
  }

  if (person.energy <= 1 && action !== "rest") {
    action = "rest";
    addLog(person.name, "Deterministic rule: exhaustion overrides the AI-selected action.");
  }

  if (action === "move") {
    const destination = choose(answerFor(person.id, "destination"));
    if (destination && destination !== "stay" && world.edges.some((edge) => edge.includes(person.node) && edge.includes(destination))) {
      const from = node(person.node).name;
      person.node = destination;
      person.energy = clamp(person.energy - 1, 0, 10);
      addLog(person.name, "Moved from " + from + " to " + node(destination).name + ".");
      remember(person, "Moved to " + node(destination).name + " on turn " + world.turn + ".");
      return;
    }
    addLog(person.name, "Considered moving, but stayed at " + node(person.node).name + ".");
    return;
  }

  if (action === "investigate") {
    const place = node(person.node);
    person.knowledge = clamp(person.knowledge + 1, 0, 10);
    person.energy = clamp(person.energy - 1, 0, 10);
    place.anomaly = clamp(place.anomaly - 1, 0, 10);
    addLog(person.name, "Investigated " + place.name + "; knowledge increased and local anomaly decreased.");
    remember(person, "Investigated " + place.name + " on turn " + world.turn + ".");
    return;
  }

  if (action === "socialize") {
    const targetId = choose(answerFor(person.id, "social"));
    const target = agent(targetId);
    if (target && coLocated(person, target)) {
      person.energy = clamp(person.energy - .5, 0, 10);
      addLog(person.name, "Spoke with " + target.name + " at " + node(person.node).name + ".");
      remember(person, "Talked with " + target.name + " on turn " + world.turn + ".");
    } else {
      addLog(person.name, "Wanted social contact, but no selected contact was present.");
    }
    return;
  }

  if (action === "work") {
    const place = node(person.node);
    place.opportunity = clamp(place.opportunity + .4, 0, 10);
    if (person.role === "warden" || person.role === "caretaker") place.danger = clamp(place.danger - .6, 0, 10);
    person.energy = clamp(person.energy - 1, 0, 10);
    addLog(person.name, "Worked as " + person.role + " at " + place.name + ".");
    return;
  }

  if (action === "rest") {
    person.energy = clamp(person.energy + 2, 0, 10);
    addLog(person.name, "Rested at " + node(person.node).name + "; energy recovered.");
    return;
  }

  person.knowledge = clamp(person.knowledge + .2, 0, 10);
  addLog(person.name, "Observed " + node(person.node).name + " without committing.");
}

function driftWorld() {
  world.nodes.forEach((place, index) => {
    const wave = Math.sin((world.turn + index * 1.7) * .63);
    place.crowd = clamp(place.crowd + wave * .25, 0, 10);
    place.opportunity = clamp(place.opportunity + Math.cos((world.turn + index) * .47) * .15, 0, 10);
    if (Math.random() < .11) place.anomaly = clamp(place.anomaly + 1.2, 0, 10);
  });
  if (/rain|flood|river|storm/i.test(world.intervention)) {
    node("river").danger = clamp(node("river").danger + 1.4, 0, 10);
    node("harbor").danger = clamp(node("harbor").danger + .7, 0, 10);
  }
  if (/festival|shrine|crowd/i.test(world.intervention)) {
    node("shrine").crowd = clamp(node("shrine").crowd + 1.2, 0, 10);
    node("shrine").opportunity = clamp(node("shrine").opportunity + .8, 0, 10);
  }
  if (/blackout|power/i.test(world.intervention)) {
    node("station").anomaly = clamp(node("station").anomaly + 1, 0, 10);
    node("tower").anomaly = clamp(node("tower").anomaly + 1, 0, 10);
  }
  if (/medicine|cache|alley/i.test(world.intervention)) {
    node("alley").anomaly = clamp(node("alley").anomaly + 1, 0, 10);
    node("alley").opportunity = clamp(node("alley").opportunity + .5, 0, 10);
  }
}

function setStatus(label, kind = "") {
  elements.status.textContent = label;
  elements.status.className = "status-dot" + (kind ? " " + kind : "");
}

async function runTurn() {
  if (inFlight) return;
  inFlight = true;
  const myGeneration = generation;
  abortController = new AbortController();
  elements.step.disabled = true;
  setStatus("JEV…", "busy");

  world.turn += 1;
  world.worldLaw = elements.law.value;
  world.intervention = elements.intervention.value;
  driftWorld();
  render();

  let response;
  try {
    const started = performance.now();
    const request = await fetch("./api/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ world }),
      signal: abortController.signal,
    });
    const clientElapsed = performance.now() - started;
    response = await request.json();
    if (!request.ok) throw new Error(response.error || "HTTP " + request.status);

    if (myGeneration !== generation) return;
    lastAnswers = response.answers;
    world.agents.forEach(applyDecision);

    elements.latency.textContent = response.elapsed_ms + " ms";
    elements.questions.textContent = response.question_count;
    const inputTokens = response.usage && response.usage.input_tokens;
    elements.tokens.textContent = Number.isFinite(inputTokens) ? inputTokens.toLocaleString() : "—";
    elements.cost.textContent = Number.isFinite(inputTokens) ? "$" + (inputTokens * INPUT_USD_PER_TOKEN).toFixed(6) : "—";
    elements.raw.textContent = JSON.stringify(response, null, 2);
    setStatus(response.model ? response.model.toUpperCase() : "OK");
    addLog("SYSTEM", response.question_count + " typed judgments returned in " + response.elapsed_ms + " ms server-side (" + Math.round(clientElapsed) + " ms browser round trip).");
  } catch (error) {
    if (error.name !== "AbortError") {
      setStatus("ERROR", "error");
      addLog("SYSTEM", error.message + " — configure TYPESAFE_API_KEY if this is a new deployment.");
      elements.raw.textContent = String(error.stack || error);
    }
  } finally {
    if (myGeneration === generation) {
      inFlight = false;
      elements.step.disabled = false;
      render();
    }
  }
}

function scheduleNext() {
  clearTimeout(timer);
  if (!running) return;
  const started = performance.now();
  runTurn().finally(() => {
    const elapsed = performance.now() - started;
    timer = setTimeout(scheduleNext, Math.max(200, TURN_MS - elapsed));
  });
}

function setRunning(value) {
  running = value;
  elements.start.textContent = running ? "PAUSE" : "START";
  if (running) scheduleNext();
  else clearTimeout(timer);
}

function reset() {
  generation += 1;
  abortController && abortController.abort();
  setRunning(false);
  inFlight = false;
  world = makeInitialWorld();
  world.worldLaw = elements.law.value;
  world.intervention = "";
  elements.intervention.value = "";
  lastAnswers = null;
  log.length = 0;
  elements.latency.textContent = "—";
  elements.tokens.textContent = "—";
  elements.cost.textContent = "—";
  elements.raw.textContent = "No response yet.";
  setStatus("IDLE");
  render();
}

elements.start.addEventListener("click", () => setRunning(!running));
elements.step.addEventListener("click", runTurn);
elements.reset.addEventListener("click", reset);
elements.threshold.addEventListener("input", () => {
  elements.gateOutput.textContent = Number(elements.threshold.value).toFixed(2);
});
document.querySelectorAll(".preset").forEach((button) => {
  button.addEventListener("click", () => {
    elements.intervention.value = button.dataset.event || "";
  });
});

world.worldLaw = elements.law.value;
render();
addLog("SYSTEM", "World initialized. Press STEP to send 30 independent judgments to Jev in one call.");
renderLog();
