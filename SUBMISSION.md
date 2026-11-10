# Doorman — submission copy

## Name
Doorman

## One-liner
A voice agent that answers unknown callers, checks their story against the live web, and only lets genuine calls through.

## Description
Unknown numbers are a gamble: a scam, a sales pitch, or your pharmacy. Doorman picks up instead of you.

It asks who is calling and why, then decides on every sentence whether to put the call through, take a message, or hang up. A live dashboard shows the transcript, the risk scores, the web evidence and the verdict as the caller speaks.

Three calls show the range:
- "This is the IRS, pay today with gift cards" → Doorman refuses and hangs up, citing the IRS's own warning pages.
- "This is the pharmacy, your prescription is ready" → the call is transferred to your real phone.
- "I'm a recruiter with a role for you" → Doorman takes a message for later.

## How it uses each tool
- **Vapi** answers the phone number, runs the conversation, and performs the transfer or hang-up.
- **Deepgram** transcribes the caller in real time (Nova-3) and gives Doorman its voice (Aura).
- **Exa** searches the live web to check the caller's claims: is the organization real, and does the script match known scams?
- **Jev (TypeSafe)** answers seven typed questions about the call on every turn, in under 300 ms: is the caller identified, are they making threats, does the web evidence support them, what kind of call is it. Plain code turns those probabilities into the action, so the language model never decides who gets through.

## What makes it different
The language model only speaks. Every decision comes from calibrated scores and written-down thresholds, and the agent only ever says pre-written lines for each outcome, so a scammer cannot talk it into forwarding the call.

## Try it
Call +1 (541) 919-9164 and pretend to be anyone.

## Demo video
doorman-launch.mp4 (59 seconds) in this folder.
