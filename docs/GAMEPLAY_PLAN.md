# Gameplay port — slice plan

Goal: a full single-player round of Mežinieki (9 holes) in the browser that
plays like the Godot tour mode (Disc Golf Masters style). Godot stays the
reference; rules and numbers are ported, not reinvented.

## Slice G1 (this pass)

| Area | What | Godot source |
|---|---|---|
| Round rules (pure TS, tested) | holes, lie, strokes, aim to basket/dogleg, auto technique by distance, disc choice, power suggestion (binary search on the physics), skill model (release error -> yaw + wobble), tap-in inside 1.9 m, OB/water +1 with relief spot, stuck/on-top lies, hole done, round total | round_controller.gd, throw_controller.gd, game_state.gd, throw_skill.gd |
| Swing input | mouse: press, pull down = power, sideways = disc angle, flick up = throw; flick direction vs pull = release error; let go without flick = cancel | swing.gd |
| Aim & bag | ←/→ (or A/D) aim, [ ] disc, F technique (backhand/forehand/putt), Tab bag list | throw_controller.gd |
| Golfer | AI golfer plays the matching clip (bh_drive X-step, Mixamo backhand stand, Koling forehand, push putt); the disc leaves at the clip's release time; he is placed so his release happens over the lie | thrower_animator.gd |
| Flight | disc mesh flies the recorded physics positions/normals, trail, camera follows, lands, short settle | flight_player.gd, camera_director.gd |
| HUD (tour broadcast) | top-left score card, top-centre hole box, right disc rail, bottom-centre swing dial + power bar + release pill + wind label, toasts, scorecard after each hole, round summary | tour_hud.gd, menus.gd |
| World | look-test art; grass/scatter rebuilt around each hole when it starts | — |

## Later slices

- G2: run-up plant timing, straddle stances, walk to the lie, OB prompt (re-throw / move to), rangefinder, hole flyover, replay.
- G3: sound (ElevenLabs SFX/ambience) and commentary (Unity commentary.json, 25 events).
- G4: online turn-based rooms (OhMyGame), leaderboards, publish.

## Not doing

Chaos specials, puzzles, multiplayer hot-seat (until G4).
