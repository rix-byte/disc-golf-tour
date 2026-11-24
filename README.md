# Disc Golf Tour

A web disc golf game: Mežinieki (Alūksne), 9 holes, three.js. Play solo, pass & play
(2–4 on one computer) or online with friends through a room code.

## Run locally

    npm install
    npm run dev        # http://localhost:5190
    npm test
    npm run build      # static site in dist/

## Put it online (GitHub Pages)

1. Make this folder its own GitHub repository and push it (branch `main`).
2. In the repository: Settings → Pages → Source: **GitHub Actions**.
3. Every push to `main` builds and publishes it at `https://<user>.github.io/<repo>/`
   (workflow: `.github/workflows/deploy.yml`).

## Online play

No game server. The host's browser runs the room; players connect to it directly
(WebRTC through [PeerJS](https://peerjs.com/), whose free public broker only
introduces the browsers to each other). Share the 5-letter code, or a link:
`https://<user>.github.io/<repo>/?join=CODE`.

- Each thrower's browser computes the flight and sends it, so everyone sees the same throw.
- If the host leaves, the game ends for everyone.
- No relay (TURN) server: on some strict company or school networks the browsers
  cannot reach each other. Home networks and mobile hotspots normally work.
- Made for playing with friends: there is no cheat protection.

## Controls

Sim (mouse): drag back and swing forward. Arcade (keys): hold SPACE for power, let go,
tap in the zone. ←/→ aim, W/S angle, Z/X tilt, [ ] disc, F technique, T full line,
M switch mode, G graphics.
