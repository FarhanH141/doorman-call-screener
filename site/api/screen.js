// Stateless copy of the screening logic in ../../server.js, for the website's text demo.
// The browser sends the whole conversation each time; nothing is stored.
const LIMITS = { turns: 6, chars: 400 };

async function exaSearch(query) {
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'x-api-key': process.env.EXA_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, numResults: 3, contents: { highlights: { numSentences: 2, highlightsPerUrl: 1 } } }),
  });
  if (!res.ok) throw new Error(`Exa ${res.status}`);
  const json = await res.json();
  return (json.results || []).map((r) => ({
    title: r.title || r.url, url: r.url,
    snippet: (r.highlights?.[0] || '').replace(/\s+/g, ' ').slice(0, 300),
  }));
}

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

async function askJev(transcript, evidence) {
  const started = Date.now();
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'jev-latest',
      state: {
        transcript: transcript.map((t) => `${t.role}: ${t.text}`).join('\n'),
        web_evidence: evidence.map(({ title, snippet }) => ({ title, snippet })),
      },
      questions: QUESTIONS,
    }),
  });
  if (!res.ok) throw new Error(`Jev ${res.status}`);
  return { answers: (await res.json()).answers, ms: Date.now() - started };
}

const behaviourRisk = (a) => Math.max(a.pressure.noul, a.scam_tactics.score / 2, a.purpose.probabilities.scam || 0);

const LINES = {
  ask_name: 'Could I get your name and where you are calling from?',
  ask_purpose: 'And what is this call regarding?',
  probe: 'To verify that, can you give me a reference number and your official callback number?',
  forward: 'Thanks, that checks out. Putting you through now.',
  take_message: 'They are not available right now. What message would you like me to pass along?',
  official: 'Thanks. For security they will call back on your organization\'s official published number. Is there a reference they should quote?',
  hang_up: 'This call matches a known scam pattern, so I will not be connecting you. Goodbye.',
};

function decide(a, turns, hasEvidence) {
  const behaviour = behaviourRisk(a);
  const scam = behaviour >= 0.25 && hasEvidence ? Math.min(1, behaviour + 0.4 * a.evidence_scam.noul) : behaviour;
  const purpose = a.purpose.choice;
  let action, say, why;
  if (scam >= 0.7) [action, say, why] = ['hang_up', LINES.hang_up, `Scam risk ${Math.round(scam * 100)}%`];
  else if (a.identified.noul < 0.5) {
    [action, say, why] = turns >= 3 ? ['take_message', LINES.take_message, 'Caller would not identify themselves'] : ['keep_asking', LINES.ask_name, 'Caller not identified yet'];
  } else if (a.stated_purpose.noul < 0.5) {
    [action, say, why] = turns >= 3 ? ['take_message', LINES.take_message, 'Caller gave no clear reason'] : ['keep_asking', LINES.ask_purpose, 'No reason for the call yet'];
  } else if (scam >= 0.35 && turns < 3) [action, say, why] = ['keep_asking', LINES.probe, `Suspicious (${Math.round(scam * 100)}%), asking for proof`];
  else if (['personal', 'delivery', 'medical'].includes(purpose) && scam < 0.35) [action, say, why] = ['forward', LINES.forward, `Looks like a genuine ${purpose} call`];
  else if (purpose === 'official') [action, say, why] = ['take_message', LINES.official, 'Institution call: call back on the official number'];
  else [action, say, why] = ['take_message', LINES.take_message, `Non-urgent ${purpose} call`];
  return { action, say, why, scam: Number(scam.toFixed(2)) };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const input = Array.isArray(req.body?.transcript) ? req.body.transcript : [];
    const transcript = input.slice(-LIMITS.turns * 2)
      .filter((t) => t && typeof t.text === 'string' && t.text.trim())
      .map((t) => ({ role: t.role === 'caller' ? 'caller' : 'screener', text: t.text.trim().slice(0, LIMITS.chars) }));
    const callerLines = transcript.filter((t) => t.role === 'caller');
    if (!callerLines.length) return res.status(400).json({ error: 'Nothing to screen' });

    const first = await askJev(transcript, []);
    const suspicious = behaviourRisk(first.answers) >= 0.25;
    const story = callerLines.slice(-2).map((t) => t.text).join(' ');
    const exaStarted = Date.now();
    const queries = [story];
    if (suspicious) queries.unshift(`scam warning: phone caller says "${story}"`);
    let evidence = [];
    try {
      const seen = new Set();
      evidence = (await Promise.all(queries.map(exaSearch))).flat().filter((r) => !seen.has(r.url) && seen.add(r.url)).slice(0, 4);
    } catch (err) { console.error(err.message); }
    const exaMs = Date.now() - exaStarted;
    const second = await askJev(transcript, evidence);
    const decision = decide(second.answers, callerLines.length, evidence.length > 0);
    res.status(200).json({ decision, jev: second.answers, jevMs: second.ms, exaMs, evidence });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Screening failed. Try again.' });
  }
}
