# Deploying NIGHT SHIFT

The game is deployed split: the Colyseus server on **Render**, the Vite/Three.js
client on **Vercel**. Vercel cannot host a stateful WebSocket server, so it
serves the static client only.

Both sides auto-deploy on push to `master`.

| Piece | Host | URL |
| --- | --- | --- |
| Game (share this) | Vercel, project `dist` | https://dist-sooty-ten-wrihij32v2.vercel.app |
| Trailer | Vercel, project `night-shift-trailer` | https://night-shift-trailer.vercel.app |
| Server | Render, service `night-shift` | wss://night-shift-3jv4.onrender.com |

Vercel preview URLs shaped `-<hash>-sachman-blips-projects.vercel.app` are
SSO-gated — don't share them. Only the clean production alias is public.

## Server (Render)

Free web service `night-shift`, account `sachman-blip`. The hostname is
`night-shift-3jv4.onrender.com` — the bare `night-shift.onrender.com` belongs
to a stranger, since `*.onrender.com` names are globally unique.

Two things that will bite you:

**`render.yaml` in this repo is NOT applied.** The service was created by hand
rather than from a Blueprint, so the dashboard settings are the real config.
They disagree with the file: it says `npm ci` and Node 22.11.0, the service
actually runs `yarn` and Node 24. Trust the dashboard, not the file.

**Do not remove the `@colyseus/*` dependencies from `server/package.json`.**
`colyseus` declares its own internals (`@colyseus/core`, `redis-driver`,
`redis-presence`, `ws-transport`) as *peerDependencies* and imports all four
unconditionally at its entry point, redis included. npm 7+ auto-installs peers;
yarn 1 does not — so the yarn build on Render produced a `node_modules` missing
the framework itself and the server died with
`ERR_MODULE_NOT_FOUND: @colyseus/core`. They are declared explicitly to fix
that. They look unused. They are not.

**The free tier sleeps after 15 minutes idle** (~50s cold boot), and the first
request after a wake is sometimes dropped with `socket hang up` — retry once.
The server serves `GET /health` for this reason (the Colyseus transport
otherwise answers only WebSocket upgrades, and a plain GET hangs forever); the
client polls it before connecting and shows "waking the building up… Ns"
instead of failing. A cron ping every ~10 min keeps it warm.

Redeploy: push to `master`.

## Client (Vercel)

Account `sachman-blip`, scope `sachman-blips-projects`, project **`dist`** —
named that because it was originally created by deploying the `client/dist`
folder. It is connected to the GitHub repo, so pushes to `master` auto-deploy.

**`vercel.json` at the repo root is what makes that work.** Without it the git
build produced an *empty* output directory and served a 404 while every
deployment still reported "Ready". It sets `buildCommand`, `outputDirectory`,
and carries `VITE_SERVER_URL` in `build.env`.

`VITE_SERVER_URL` is baked in at **build** time (see `client/src/net.ts`). It
lives in `vercel.json` rather than as a dashboard env var on purpose: the Vercel
CLI on Windows saves an *empty* value when the value is piped to
`vercel env add` via stdin (verified by pulling it back). It is not a secret —
it ships inside the client bundle either way.

Manual redeploy from the repo root, keeping the public alias:

```bash
vercel deploy --prod --yes --scope sachman-blips-projects
```

## Trailer

A self-playing cinematic HTML trailer (real screenshots + a Web-Audio synth
score) in its own standalone Vercel project, separate from the game.

Its source is **generated, not stored in this repo**: it is built from
`screenshots/*.png`, compressed via ffmpeg and base64-inlined into a single
self-contained `index.html`. To redeploy from a directory containing that file:

```bash
vercel deploy . --prod --yes --scope sachman-blips-projects --name night-shift-trailer
```

## Verifying a deploy

```bash
curl https://night-shift-3jv4.onrender.com/health   # -> {"ok":true,"rooms":"game"}
```

`npm run smoke -w server` is written for localhost — its `sleep(300)` is too
short for a round trip to Render, so it fails on "host movement did not sync"
even when the server is fine. Raise that wait before pointing it at the live
server.

## Screenshots

`screenshots/` is git-ignored, so it does not travel with a clone. Regenerate it
against a running server with the capture scripts in `tools/`
(`capture.mjs`, `human-shots.mjs`, `enemy-shots.mjs`).
