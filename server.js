// Call screener: Vapi sends call events here, Exa checks the caller's story,
// Jev scores the conversation, and plain code picks the action.
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PORT = Number(process.env.PORT || 3000);
const { EXA_API_KEY, TYPESAFE_API_KEY } = process.env;
const CAN_TRANSFER = Boolean(process.env.FORWARD_TO_NUMBER);

const calls = new Map();
const clients = new Set();

// Calls are kept in a local file so the history survives a restart.
const HISTORY_FILE = process.env.HISTORY_FILE || new URL('./calls.json', import.meta.url);
if (existsSync(HISTORY_FILE)) {
  try {
    for (const call of JSON.parse(readFileSync(HISTORY_FILE, 'utf8'))) {
      if (call.status !== 'ended') call.status = 'ended';
      calls.set(call.id, call);
    }
  } catch (err) { console.error(`Could not read call history: ${err.message}`); }
}
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeFileSync(HISTORY_FILE, JSON.stringify([...calls.values()], null, 1));
  }, 500);
}

function getCall(id, from) {
  if (!calls.has(id)) {
    calls.set(id, {
      id, from: from || 'unknown', status: 'ringing', startedAt: Date.now(),
      transcript: [], facts: {}, evidence: [], evidenceQuery: null,
      jev: null, jevMs: null, exaMs: null, decision: null, message: null,
    });
  }
  const call = calls.get(id);
  if (from && call.from === 'unknown') call.from = from;
  return call;
}

function publish(call) {
  const data = `data: ${JSON.stringify(call)}\n\n`;
  for (const res of clients) res.write(data);
  scheduleSave();
}

// ---------- Exa: check the caller's story against the web ----------
async function exaSearch(query) {
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'x-api-key': EXA_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query, numResults: 3,
      contents: { highlights: { numSentences: 2, highlightsPerUrl: 1 } },
    }),
  });
  if (!res.ok) throw new Error(`Exa ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return (json.results || []).map((r) => ({
    title: r.title || r.url, url: r.url,
    snippet: (r.highlights?.[0] || r.text || '').replace(/\s+/g, ' ').slice(0, 300),
  }));
}

function behaviourRisk(a) {
  return Math.max(a.pressure.noul, a.scam_tactics.score / 2, a.purpose.probabilities.scam || 0);
}

async function gatherEvidence(call) {
  const { organization, reason } = call.facts;
  const latest = call.transcript.filter((t) => t.role === 'caller').slice(-1)[0]?.text || '';
  const story = [organization, reason].filter(Boolean).join(' ') || latest;
  // Only look for scam reports when the caller's own behaviour is already suspicious.
  const suspicious = call.jev ? behaviourRisk(call.jev) >= 0.25 : false;
  const key = `${suspicious}|${story}`;
  if (!story || story.length < 8 || key === call.evidenceQuery) return;
  call.evidenceQuery = key;
  const started = Date.now();
  const queries = [story];
  if (organization) queries.push(`${organization} official contact phone number`);
  if (suspicious) queries.push(`scam warning: phone caller says "${story}"`);
  try {
    const results = (await Promise.all(queries.map(exaSearch))).flat();
    const seen = new Set();
    // Scam reports first when we searched for them, so they are not cut off.
    if (suspicious) results.unshift(...results.splice(-3));
    call.evidence = results.filter((r) => !seen.has(r.url) && seen.add(r.url)).slice(0, 5);
    call.exaMs = Date.now() - started;
  } catch (err) {
    console.error(err.message);
  }
}

// ---------- Jev: typed questions about the call so far ----------
const QUESTIONS = {
  identified: { type: 'noul', instructions: 'Has the caller clearly stated their own name or the organization they are calling from?' },
  stated_purpose: { type: 'noul', instructions: 'Has the caller clearly stated the reason for the call?' },
  pressure: { type: 'noul', instructions: 'Is the caller demanding payment, gift cards, crypto, passwords or personal identity details, or threatening arrest, fines or account closure?' },
  evidence_scam: { type: 'noul', instructions: 'Does the web_evidence describe a scam whose script closely matches what this caller actually said, with the same kind of demands or threats? Answer no if the caller made no demands or threats.' },
  evidence_supports: { type: 'noul', instructions: 'Does the web_evidence support that the caller\'s stated organization is real and that it makes calls like this one?' },
  purpose: {
    type: 'choice', instructions: 'What kind of call is this?',
    criteria: {
      personal: 'A friend, family member or personal acquaintance',
      delivery: 'A courier, delivery driver or service appointment',
      medical: 'A doctor, pharmacy, clinic or hospital',
      official: 'A bank, government agency, utility or other institution',
      sales: 'A sales, marketing, survey or fundraising call',
      recruiter: 'A recruiter or job-related call',
      scam: 'A fraud attempt or impersonation',
      unknown: 'Not enough information yet',
    },
  },
  scam_tactics: {
    type: 'score', instructions: 'How strongly does the caller use scam tactics?',
    criteria: [
      'No pressure or suspicious requests',
      'Some urgency or vague, evasive answers',
      'Clear scam tactics: threats, urgent payment, gift cards, or requests for sensitive information',
    ],
  },
};

async function askJev(call) {
  const state = {
    caller_number: call.from,
    caller_claims: call.facts,
    transcript: call.transcript.map((t) => `${t.role}: ${t.text}`).join('\n'),
    web_evidence: call.evidence.map(({ title, snippet }) => ({ title, snippet })),
  };
  const started = Date.now();
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'jev-latest', state, questions: QUESTIONS }),
  });
  if (!res.ok) throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  call.jev = json.answers;
  call.jevMs = Date.now() - started;
}

// ---------- Code decides; Jev only supplies the probabilities ----------
const LINES = {
  ask_name: 'Could I get your name and where you are calling from?',
  ask_purpose: 'And what is this call regarding?',
  probe: 'To verify that, can you give me a reference number and your official callback number?',
  forward: CAN_TRANSFER ? 'Thanks, that checks out. Putting you through now.' : 'Thanks, that checks out. I will let them know you are on the line right away.',
  take_message: 'They are not available right now. What message would you like me to pass along?',
  official: 'Thanks. For security they will call back on your organization\'s official published number. Is there a reference they should quote?',
  hang_up: 'This call matches a known scam pattern, so I will not be connecting you. Goodbye.',
};

function decide(call, lock = true) {
  const a = call.jev;
  const turns = call.transcript.filter((t) => t.role === 'caller').length;
  const hasEvidence = call.evidence.length > 0;
  // Web evidence can raise the risk of a suspicious caller, never convict a polite one.
  const behaviour = behaviourRisk(a);
  const scam = behaviour >= 0.25 && hasEvidence ? Math.min(1, behaviour + 0.4 * a.evidence_scam.noul) : behaviour;
  const purpose = a.purpose.choice;
  let action, say, why;
  if (scam >= 0.7) {
    [action, say, why] = ['hang_up', LINES.hang_up, `Scam risk ${Math.round(scam * 100)}%`];
  } else if (a.identified.noul < 0.5) {
    [action, say, why] = turns >= 3
      ? ['take_message', LINES.take_message, 'Caller would not identify themselves']
      : ['keep_asking', LINES.ask_name, 'Caller not identified yet'];
  } else if (a.stated_purpose.noul < 0.5) {
    [action, say, why] = turns >= 3
      ? ['take_message', LINES.take_message, 'Caller gave no clear reason']
      : ['keep_asking', LINES.ask_purpose, 'No reason for the call yet'];
  } else if (scam >= 0.35 && turns < 3) {
    [action, say, why] = ['keep_asking', LINES.probe, `Suspicious (${Math.round(scam * 100)}%), asking for proof`];
  } else if (['personal', 'delivery', 'medical'].includes(purpose) && scam < 0.35) {
    [action, say, why] = ['forward', LINES.forward, `Looks like a genuine ${purpose} call`];
  } else if (purpose === 'official') {
    [action, say, why] = ['take_message', LINES.official, 'Institution call: call back on the official number'];
  } else {
    [action, say, why] = ['take_message', LINES.take_message, `Non-urgent ${purpose} call`];
  }
  call.decision = { action, say, why, scam: Number(scam.toFixed(2)), at: Date.now() };
  // The outcome shown in the call history is set only by the real decision path, not the live preview.
  if (lock && action !== 'keep_asking') call.outcome = action;
}

async function screen(call) {
  await askJev(call);
  if (behaviourRisk(call.jev) >= 0.85) {
    // Obvious scam: answer the caller now, fetch the web evidence for the dashboard afterwards.
    decide(call);
    publish(call);
    gatherEvidence(call).then(() => askJev(call)).then(() => { decide(call); publish(call); }).catch((e) => console.error(e.message));
    return call.decision;
  }
  await gatherEvidence(call);
  await askJev(call);
  decide(call);
  publish(call);
  return call.decision;
}

function directive(d) {
  const next = {
    keep_asking: 'Wait for the answer, then call screen_caller again.',
    forward: CAN_TRANSFER ? 'Then call transferCall.' : 'Then say goodbye and call endCall.',
    take_message: 'Wait for their message, then call save_message.',
    hang_up: 'Then call endCall immediately.',
  }[d.action];
  return `ACTION: ${d.action}. Say exactly: "${d.say}" ${next}`;
}

// ---------- Vapi webhook ----------
function syncTranscript(call, message) {
  const conv = message.conversation || message.artifact?.messagesOpenAIFormatted;
  if (!Array.isArray(conv)) return false;
  const lines = conv
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role === 'user' ? 'caller' : 'screener', text: m.content.trim() }));
  if (lines.length < call.transcript.length) return false;
  const changed = JSON.stringify(lines) !== JSON.stringify(call.transcript);
  call.transcript = lines;
  return changed;
}

async function handleVapi(body) {
  const message = body.message || {};
  if (!message.type || !message.call?.id) return {};
  const callId = message.call.id;
  const call = getCall(callId, message.call?.customer?.number);

  if (message.type === 'status-update') {
    call.status = message.status;
    publish(call);
  } else if (message.type === 'conversation-update') {
    if (syncTranscript(call, message)) {
      if (call.status === 'ringing') call.status = 'in-progress';
      publish(call);
      // Live scores for the dashboard; the tool call below makes the real decision.
      const last = call.transcript[call.transcript.length - 1];
      if (last?.role === 'caller' && !call.outcome) {
        askJev(call).then(() => { if (!call.outcome) { decide(call, false); publish(call); } }).catch((e) => console.error(e.message));
      }
    }
  } else if (message.type === 'end-of-call-report') {
    call.status = 'ended';
    call.endedReason = message.endedReason;
    publish(call);
  } else if (message.type === 'tool-calls') {
    syncTranscript(call, message);
    const list = message.toolCallList || (message.toolWithToolCallList || []).map((t) => t.toolCall);
    const results = [];
    for (const tc of list) {
      const name = tc.function?.name || tc.name;
      let args = tc.function?.arguments ?? tc.arguments ?? {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      let result = 'ok';
      try {
        if (name === 'screen_caller') {
          for (const key of ['caller_name', 'organization', 'reason']) if (args[key]) call.facts[key] = args[key];
          const said = (args.latest_caller_statement || '').trim();
          const lastCaller = call.transcript.filter((t) => t.role === 'caller').slice(-1)[0]?.text;
          if (said && said !== lastCaller) call.transcript.push({ role: 'caller', text: said });
          result = directive(await screen(call));
        } else if (name === 'save_message') {
          call.message = { text: args.message || '', callback: args.callback_number || '' };
          publish(call);
          result = 'Saved. Say: "Thanks, I will pass that along. Goodbye." Then call endCall.';
        }
      } catch (err) {
        console.error(err.message);
        result = `ACTION: take_message. Say exactly: "${LINES.take_message}" Wait for their message, then call save_message.`;
      }
      results.push({ toolCallId: tc.id, result });
    }
    return { results };
  }
  return {};
}

// ---------- HTTP ----------
function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(new URL('./dashboard.html', import.meta.url)));
    } else if (req.method === 'GET' && url.pathname === '/config') {
      const file = new URL('./.vapi.json', import.meta.url);
      const number = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).number : null;
      send(200, { number: number || null, canTransfer: CAN_TRANSFER });
    } else if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      for (const call of calls.values()) res.write(`data: ${JSON.stringify(call)}\n\n`);
      req.on('close', () => clients.delete(res));
    } else if (req.method === 'POST' && url.pathname === '/vapi') {
      send(200, await handleVapi(await readJson(req)));
    } else if (req.method === 'POST' && url.pathname === '/simulate') {
      // Type a caller line on the dashboard to test without a phone.
      const { id = 'simulated', text = '', reset, from } = await readJson(req);
      if (reset) calls.delete(id);
      const call = getCall(id, from || 'simulated caller');
      call.status = 'in-progress';
      call.transcript.push({ role: 'caller', text });
      const d = await screen(call);
      call.transcript.push({ role: 'screener', text: d.say });
      if (d.action !== 'keep_asking') call.status = 'ended';
      publish(call);
      send(200, d);
    } else {
      send(404, { error: 'not found' });
    }
  } catch (err) {
    console.error(err);
    send(500, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`Call screener listening on http://localhost:${PORT}`));
