# Doorman

A voice agent that answers unknown callers, checks their story against the live web, and only lets genuine calls through.

Built at the Side Quest Hotline Vapi Hackathon. Demo video: [doorman-launch.mp4](doorman-launch.mp4).

## How it works

1. A call arrives on a Vapi phone number. The assistant asks who is calling and why.
2. After every caller reply, the assistant calls this server.
3. The server searches the web with **Exa** to check the caller's claims.
4. **Jev** (TypeSafe) answers seven typed questions about the call: is the caller identified, are they making threats, does the web evidence support them, what kind of call is it.
5. Plain code turns those probabilities into one of four actions: keep asking, put the call through, take a message, or hang up. The language model only speaks the pre-written line for that action.
6. **Vapi** transfers the call or ends it. **Deepgram** does the listening (Nova-3) and the voice (Aura).

A live dashboard shows the transcript, the scores, the web evidence and the verdict for every call.

## Run it

Requires Node 20.6 or later. There are no dependencies to install.

1. Copy `.env.example` to `.env` and fill in the keys.
2. Start the server: `npm start`, then open http://localhost:3000.
3. Expose it publicly, for example `ngrok http 3000`.
4. Create the Vapi assistant and attach it to your number: `npm run setup -- https://your-public-url`.
5. Call the number, or type a caller line into the dashboard's test box.

## Files

- `server.js`: webhook, Exa and Jev calls, decision rules, dashboard feed
- `dashboard.html`: the live dashboard
- `setup-vapi.mjs`: creates the Vapi assistant and tools
