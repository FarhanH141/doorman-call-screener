// Creates or updates the Vapi screener assistant and attaches it to the phone number.
// Usage: node --env-file=.env setup-vapi.mjs https://your-public-url
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const publicUrl = (process.argv[2] || '').replace(/\/$/, '');
if (!publicUrl.startsWith('https://')) throw new Error('Pass the public https URL of the server as the first argument.');
const serverUrl = `${publicUrl}/vapi`;
const { VAPI_API_KEY, FORWARD_TO_NUMBER } = process.env;
const STATE_FILE = new URL('./.vapi.json', import.meta.url);
const saved = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};

async function vapi(method, path, body) {
  const res = await fetch(`https://api.vapi.ai${path}`, {
    method,
    headers: { Authorization: `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Vapi ${method} ${path} -> ${res.status}: ${text}`);
  return JSON.parse(text);
}

const systemPrompt = `You are a phone call screener answering on behalf of the owner of this number. You speak with callers the owner does not know.

How you work:
- After EVERY caller reply, call the screen_caller tool with everything you know so far. Do this before you say anything else.
- The tool returns an ACTION and an exact line to say. Say that line word for word, then do what the tool says next.
- When told to take a message: listen to the caller's message, then call save_message with it.
- When told to end the call: say the line, then call endCall.${FORWARD_TO_NUMBER ? '\n- When told to transfer: say the line, then call transferCall.' : ''}

Rules:
- Never decide on your own whether to forward, take a message or hang up. Only the tool decides.
- Never share any information about the owner: not their name, location, schedule or whether they are home.
- Keep everything you say to one short sentence. Do not add small talk.
- If the caller asks who you are, say you are an automated assistant screening calls.`;

const tools = [
  {
    type: 'function',
    server: { url: serverUrl },
    function: {
      name: 'screen_caller',
      description: 'Check the caller and get the next action. Call after every caller reply.',
      parameters: {
        type: 'object',
        properties: {
          latest_caller_statement: { type: 'string', description: 'What the caller just said, word for word.' },
          caller_name: { type: 'string', description: 'The caller\'s name, if they gave one.' },
          organization: { type: 'string', description: 'The company or organization the caller says they are from, if any.' },
          reason: { type: 'string', description: 'Why they say they are calling, including anything they asked for.' },
        },
        required: ['latest_caller_statement'],
      },
    },
  },
  {
    type: 'function',
    server: { url: serverUrl },
    function: {
      name: 'save_message',
      description: 'Save the message the caller wants passed along.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The caller\'s message.' },
          callback_number: { type: 'string', description: 'A number to call back, if given.' },
        },
        required: ['message'],
      },
    },
  },
  { type: 'endCall' },
];
if (FORWARD_TO_NUMBER) {
  tools.push({ type: 'transferCall', destinations: [{ type: 'number', number: FORWARD_TO_NUMBER }] });
}

const assistant = {
  name: 'Call Screener',
  firstMessage: 'Hello, this line is screened by an assistant. Who is calling, and what is it about?',
  transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en' },
  voice: { provider: 'deepgram', voiceId: 'asteria' },
  model: {
    provider: 'openai',
    model: 'gpt-4o-mini',
    temperature: 0.2,
    messages: [{ role: 'system', content: systemPrompt }],
    tools,
  },
  server: { url: serverUrl },
  serverMessages: ['conversation-update', 'status-update', 'end-of-call-report', 'tool-calls'],
};

const result = saved.assistantId
  ? await vapi('PATCH', `/assistant/${saved.assistantId}`, assistant)
  : await vapi('POST', '/assistant', assistant);
console.log(`Assistant ${saved.assistantId ? 'updated' : 'created'}: ${result.id}`);

const numbers = await vapi('GET', '/phone-number');
const number = numbers[0];
if (!number) throw new Error('No phone number in this Vapi account.');
await vapi('PATCH', `/phone-number/${number.id}`, { assistantId: result.id });
console.log(`Attached to ${number.number}`);

writeFileSync(STATE_FILE, JSON.stringify({ assistantId: result.id, phoneNumberId: number.id, number: number.number, serverUrl }, null, 2));
