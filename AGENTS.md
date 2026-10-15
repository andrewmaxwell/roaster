# kaleido

Controller for a Kaleido M1 LITE roaster. Read `README.md` first for what it does. This file covers how it's built, the hard-won facts about the machine, and the coding-agent workflows (roast analysis, procedures, inventory). `CLAUDE.md` just imports this file, so Claude Code and other agents (Codex reads `AGENTS.md`) share it: edit this one.

It needs a local Node server (`serialport`, `ws`, `express` from `package.json`; `npm install` once), because the server owns the serial port. `npm test` runs the tests, `npm run lint` checks ESLint and Prettier (`npm run format` fixes formatting), `npm run selftest` runs the hardware self-test without the burner (`npm run selftest:heat` for the full one), and GitHub Actions runs both on every push. The browser UI is a plain ES module page served by that server. Its one library, uPlot 1.6.32, is copied into `ui/vendor/` so the UI, STOP included, works with no internet. Keep it that way: no CDN imports here.

**Never edit `server/*.js` while the app is running on the roaster** (check `ps`). **Test every behavior in the simulator first**, and replay changes against the real logs in `logs/`, checking how much earlier or later things happen than in the real roasts, not just whether they happen.

## Layout

```
server/
  main.js        node server/main.js [--sim [--speed 10]]: the app at http://localhost:3100/
                 --monitor (read-only on real hardware), --sim --autopilot (terminal demo),
                 --selftest [--no-heat] [--no-cable]
  app.js         HTTP + WebSocket server for the UI; saves/resumes the session (logs/.session.json)
  clock.js       real clock (with a speed-up for the sim) and a virtual clock for tests
  protocol.js    encode {[TAG VAL]}, parse {sid,VAR:val,...}
  port.js        the USB serial transport (finds the port, maps tty→cu)
  machine.js     desired-state reconciler + reconnect loop
  session.js     phases, charge detection, alarms; everything the roaster does comes from desiredState()
  procedure.js   loads/validates procedures; RoastTracker (TP, steps, drop); preheat stability; RoR
  autopilot.js   a simulated person (charges, marks FC, discharges) for tests and the demo
  sim.js         simulated roaster: same interface as port.js, plus the machine's quirks
  physics.js     the thermal model sim.js runs
  fitSim.js      fits physics.js to logs/ → simParams.json (rerun after adding logs)
  roastlog.js    the roast log format (one .json per roast): read, write, find by number
  recorder.js    numbers roasts, writes each one's log, patches weight out / notes in later
  stop.js        emergency stop for when the app is gone: emergencyStop()
  guardian.js    separate process: heater off if the app dies or hangs
  selftest.js    empty-drum hardware checks (main.js --selftest)
test/            npm test (node --test, against the simulator)
index.html, main.js   browser UI: readouts, charts, side panel of actions, alarm banner
ui/charts.js          three stacked uPlot charts (temps, RoR, burner/air) sharing time + cursor
ui/vendor/            uPlot's ESM build and CSS
ui/sound.js           speech + chimes (needs the Start click to unlock audio)
ui/pops.js            mic pop detector (AudioWorklet); hints only
preheat.json          preheat settings + stability rule, shared by every bean
procedures/<bean>.json
beans.json            canonical bean slugs → name, supplier, old filename aliases
inventory.json        green beans on hand, in batches, by bean slug (the agent keeps it current)
logs/                 one .json per roast (roastlog.js)
logs-sim/             what --sim runs write (gitignored)
selftests/            self-test reports from the real roaster
```

Still unchecked by hand: the mic detector against real cracks. There's deliberately no `analyze.js`: the agent analyzes roasts directly (see below). Write one only if analyses start disagreeing or comparing many roasts gets slow.

## Talking to the machine (`machine.js`)

The old `roast/` project was never trusted on real beans. These rules are the fix.

- **Desired state, not commands.** Callers set the desired value of each control (`TS, HS, AH, HP, FC, RC, CS`); no caller sends a command. Every poll, anything the machine's echo doesn't match is resent, so a dropped command is just retried, and a reconnect re-applies everything. Values are rounded (the protocol sends integers; 45.5 went out as 46 and never matched) and `TS` is clamped to 240.
- **Mode switch order.** Into manual: `TS` first, confirmed, then `AH 0`, then `HP` (in auto mode HP belongs to the PID). Without the raised `TS`, the old preheat SV caps the burner even in manual mode.
- **The write queue.** Writes go out about 100 ms apart. A tag already queued is updated in place and keeps its position: moving it to the back once starved the `RD` poll, and leaving the old value once let an `HS 1` go out after the heater was locked off.
- **No readings, no heat.** Silent for 5 s means disconnected; reconnect and re-apply. If the roaster still answers but sends no numeric BT for 5 s, `HS/AH/HP` are held off (`blind`, `target()`) whatever is desired, until BT returns; the session alerts. Every connection, first or reconnect, holds them off until its own first BT (`awaitingReading`). (Reconnecting alone just re-applied the roast's heat.) A control nobody has set is never written, blind or not, so `--monitor` stays read-only.
- **Locked off.** `heaterOff()` locks `HS/AH/HP` at 0 for the rest of the process, so a step firing while the app waits to quit can't turn the heat back on. `heaterConfirmedOff()` needs the roaster itself to report `HS 0`, in a reply carrying `HS` received at least one poll after the lock (`lastHeaterReport`; an unrelated reply mustn't make an older `HS 0` count).

## Session behavior (`session.js`)

PREHEAT → READY → ROASTING → PREHEAT (next batch) → … → SHUTDOWN → OFF. The roaster's settings for each phase come only from `desiredState()`.

- **Ready** means every setting is confirmed, BT has stayed within 1.5 °C of SV for 3 minutes, and ET isn't *rising* faster than 0.5 °C/min over those 3 minutes *or* the last 1.5. (ET overshoots, dips, then climbs once BT reaches SV, and one fit across that reads as flat; that called a cold drum ready after 7 minutes on 2026-10-04.) Falling ET is fine: between batches the user charged with ET still falling 0.5–1.5 °C/min. Replayed on the real cold starts, ready comes at 12–16 minutes with ET 177–183 °C, before every real charge. A disconnect drops READY back to PREHEAT with fresh readings (a power cut can cool the drum unseen).
- **Charge is only auto-detected** (no button: the user's choice) and needs beans chosen first. Without them, a charge-like fall becomes a pending charge (`pendingCharge`): an urgent alert, then a spoken reminder every 30 s, and no "ready for charge" prompts, until the beans are chosen (the roast then starts from the charge, catching up on any steps BT has passed) or the person clicks "Not a charge" (`dismissCharge()`, which ignores that fall until BT turns back up). Detection: 2 readings at least 5 °C below the BT average of 10–30 s earlier; in PREHEAT, 20 °C, and not while the last batch's record is open (its beans coming out look like a charge). Real charges fall about 70 °C, and 25 °C within 6–10 s; real preheats swing up to 8.5 °C. Replayed on all 40 real logs, it never fires early and catches every charge within 9 s. 3 of the 12 roasts before #38 were charged before "ready", so PREHEAT charges start a roast too. The roast clock is backdated to the last reading before the fall.
- **Turning point** is the first reading 2 °C above the lowest BT so far. Steps arm only after it; the drop never waits for it.
- **Triggers** (steps and drop) need 3 consecutive readings at or above their temperature, so one thermocouple spike can't fire them. At ~5 °C/min that lands 0.2–0.5 °C past the target.
- **The cooling fan** comes on once BT is within 1 °C of the drop (`COOL_BEFORE_DROP_C`): a median 7.5 s before the drop on the real logs (3–18 s). It stays on until the user turns it off.
- **Drop:** `HP 0` while still in manual mode, then the preheat settings (`preheat.json`: AH 1, SV 185, air 30, drum 90) with `CS 1` and `HS 0` until the beans are out. (Without `HS 0`, an early drop under SV had the PID heat the beans; on a normal drop the beans are out before BT falls under SV, so nothing changes.) Never `RC 0` at drop; the drum turning discharges the beans. "Drop now!" repeats every 5 s, with a banner and chime, until the beans are out: the "Beans are out" button, or BT falling 10 °C within 30 s after the drop (12–24 s after a real drop, as the probe drops to air temperature). A closed drum cooling on its own is slower (#1, dropped early: about 7 °C/min) and never counts, because "out" turns the heat back on. The batch record closes a minute after the drop, once the beans are out (`batchComplete`).
- **Alerts never change the heat:** a stall (RoR under 1 °C/min for a minute after TP), a 16-minute roast, a control stuck for 8 s, a disconnect, no readings.
- **Shutdown:** heater off, air 100%, drum 90% until BT is under 60 °C, then everything off; `off` fires once the machine confirms it. "Turn everything off now" ends it early (and finishes any open batch record).
- **Saving and resuming.** `app.js` saves `toJSON()` to `logs/.session.json` on every change and resumes a session less than 30 minutes old, without firing any step twice. READY resumes as PREHEAT (the heater was off meanwhile). ROASTING resumes only if the app was down under 2 minutes (`RESUME_ROAST_WITHIN_MS`); otherwise `endInterruptedRoast()` ends the roast where its record stopped (drop reason `interrupted`) and treats it like any drop, beans possibly still in.

## Safety: the roaster has no panel

The M1 LITE is controlled only over USB, and it keeps heating with no computer: when the self-test went silent for 45 s at 60% manual burner, BT went 195 → 205 °C and HP still read 60. Every path out turns the heater off first:

- The UI's STOP (`session.emergencyStop()`: drop, then shutdown).
- Ctrl-C (after a confirmation when a session is running), SIGTERM, uncaught exceptions: `heaterOffAndExit()` in `main.js` locks the heater off, waits for confirmation, and leaves air and drum running if BT is 60 °C or more or unknown.
- `node server/stop.js [--all]` for when the app is gone. It sends heater-off as soon as it connects, without waiting for BT; BT only decides the fans (unknown counts as hot).
- **`guardian.js`**, a detached process `main.js` starts in app mode (not `--sim`). It watches the app's pid and `logs/.heartbeat`, which the app rewrites with its pid every 2 s. If the app dies, it runs `emergencyStop()` on the freed port and says so with `say`; if the heartbeat is over 15 s old (hung), it kills the app first. Verified on the real roaster with kill -9: heater off within about 2 s. Its log is `logs/.guardian.log`.
  - The app deletes the heartbeat on a clean exit, only after the heater is confirmed off (else the guardian retries), and stops its timer first, or one last beat would make its own guardian think it crashed.
  - A heartbeat with another pid means a restarted app took over; the old guardian leaves without touching the port or file. So only one app may run: `main.js` refuses to start while the heartbeat names another live process (`runningApp()`).
- `main.js` runs `caffeinate -is` while up. Not covered: the laptop losing power, or the lid closing. Leave the lid open.

## Simulator

`sim.js` speaks the real protocol with the machine's quirks: it randomly drops commands (`dropRate`), omits `HS` and `CS` until set, reads back the PID's duty as `HP` in auto mode, and caps the burner at `TS` in manual mode. `close()` is a cable pull and `muted` a hung adapter; either way the simulated machine keeps running on its last settings.

`physics.js` has two fitted parameter sets, `empty` and `roast`, because one couldn't fit both. The drum metal isn't measured, so at charge it's reset to `ET + drumOffset`, as the fit assumes. The roast set is fit **closed loop**: each logged burner and air change is applied when the simulated BT reaches the temperature where it really happened, the way the controller drives it. Compare closed-loop runs to real logs when debugging; open-loop replays looked fine while closed-loop roasts stalled. The fit integrates each sample interval for exactly its length, and skips missing readings (holding the last good inputs). Before 2026-10-15 it gave intervals just over 1.5 s an extra step, about 18% too much physics time, so live sim roasts reached FC 1.5-2 minutes late. Fit as of 2026-10-15:
- Roasts: about 4.8 °C RMSE. Closed loop over all 41 logs, FC a median 0.1 minutes later than real (±0.5), the drop temp 0.55 later (±0.8). Live `--sim` runs of each procedure against its reference roast: FC within 0.5 minutes (Colombian Supremo espresso 7:03 vs 7:14 in #30), drops within 0.8, except Espresso Monkey (1.7 late). Decafs and the Honduran MWP run late; bean differences aren't modeled.
- Preheat: about 9 °C RMSE, mostly from each log's leftover state from the previous batch. A cold start looks right: BT reaches 183 °C in about 4 minutes while ET soaks up over about 15.

After a discharge the drum restarts at the empty-drum steady state, and for 30 s the probe relaxes toward ET with a 9 s time constant (the real logs' fast fall, which beans-out detection relies on). The simulated PID is a hand-tuned PI loop that recovers from a drop in about 5 minutes, like the real one.

## UI

- **Served by the app server** (it needs the WebSocket). It serves only `index.html`, `main.js` and `ui/`: the logs, server code and `node_modules` share the folder.
- **Charts:** three plots, not a dual-axis chart. Colors follow the dataviz palette's order: BT 1 (blue), ET 2 (orange), burner 3 (aqua), air 4 (yellow), with dark-mode steps. The procedure's `reference.roast` BT (from `/api/roast/:n`, always from `logs/`, even in the sim) is a muted dashed line. While roasting, x is seconds since charge; otherwise the last 20 minutes. Only the *next* step and the drop get horizontal guides; more collide.
- **Side panel:** rebuilt only when its inputs change (`renderSide`'s key). A rebuild mid-typing keeps form values and focus by element id, so per-batch inputs get per-batch ids (`weightOut-<n>`). Numbers that change every reading update in place by id (`preheatInfo`, `devInfo`, `dropEta`).
- **Two clicks for anything irreversible:** STOP, second crack, drop now, done for today, and everything off need a second click within 3 s (`confirmed()`).
- **STOP** becomes a disabled "Heater off" once the phase isn't heating and the machine reports `HS 0`. An unreported HS counts as possibly on, so with no session the server sets `HS 0` at startup.
- **WebSocket origin:** only `localhost`, `127.0.0.1`, `[::1]`, or none (non-browser clients). Browsers let any site open a WebSocket to localhost; checking the Origin's host (not Host) also covers DNS rebinding.
- **Not live:** if the server or roaster drops out, the readouts fade; a lost server also shows a banner, and actions toast instead of silently failing.
- In `--sim`, "Pour beans in" and "Open the door" stand in for the person.
- **Crack listening** (hints only: never marks FC/SC or changes the roast; no audio stored) high-passes the mic at 1.5 kHz and reports transients 12× above an adaptive floor, at most one per 0.25 s. One sound rings for a while: in #38, three "pops" 0.1 s apart at 177 °C would have hinted a minute before FC. Pops during the app's own speech or chimes (plus 0.3 s; `busy()` in `ui/sound.js`) are ignored. Three pops within 8 s show a hint banner. Pops are logged in the roast's log and drawn as ticks on the chart.

## Self-test

`node server/main.js --selftest` (drum empty, Artisan closed), about 30–40 minutes: the connection and readings; every control echoing back with the heater off; the manual burner heating BT to 195 °C (proving the SV ceiling lifts); what a setpoint below BT does in manual mode (an observation); the PID taking over in auto mode; the cooling fan; a cable pull it asks for; a cool-down to 60 °C, then everything off. Air and drum turn off only once a fresh reading confirms BT is under 60 °C; a timeout, a failed control, or lost readings leave them running with the heater off.

The burner checks start only after Enter confirms the drum is empty. Ctrl-C turns the heater off and leaves air and drum running. `--no-heat` skips the burner checks and cool-down; Enter skips the cool-down. Long waits show a live status line whose estimates (`timeTo()` in `procedure.js`: linear heating, exponential cooling toward 25 °C) run a bit optimistic. The report in `selftests/` records each check, `sends` (writes per control; more than one per change means drops), and `observations`.

Measured on this roaster (2026-10-04):
- An empty drum at 60% manual burner went 41 → 195 °C in 8 minutes (the sim: about 9).
- The PID held 185 at 20–35% duty.
- After a cable pull, it was reconnected and back in sync in 25 s.
- Cooling 195 → 60 °C with air at 100% took 18 minutes.

## Protocol facts

Verified on hardware (the old `roast/` project, the self-tests) and in Artisan's `~/artisan/src/artisanlib/kaleido.py` and `~/artisan/src/includes/Machines/Kaleido/Serial.aset`:

- **Serial:** 57600 8N1. To the machine `{[TAG VALUE]}\n` (`{[TAG]}\n` queries); from it `{sid,VAR:val,...}\n`. Init: `PI` until a `sid` arrives, then `TU C`, then `SC AR`. Poll with `RD A0`. `SC AR` and `CL AR` (on exit) are Artisan's start and end "safety guard"; what they do is undocumented. Numbers go as integers, including `TS`, as Artisan sends them.
- **Variables:** `BT` bean temp, `ET` env temp, `AT` ambient, `TS` setpoint (SV), `HP` burner %, `FC` air %, `RC` drum %, `AH` auto-heat (1 = PID to `TS`, 0 = manual `HP`), `HS` master heater switch, `CS` cooling fan, `EV` event marker on the machine's display (1 CHARGE, 3 DRY, 4 FCs, 5 FCe, 6 SCs, 7 SCe, 8 DROP).
- **`HS 1` is required to heat**; `AH 1` alone leaves the burner off.
- **`TS` caps the burner in manual mode too.** With SV 15 °C below BT and HP 60 in manual, BT fell 15 °C in 90 s, and **HP still read 60**, so HP alone can't show the burner is off.
- **`TS` maxes out at 240:** asked for 250, it sets and echoes 240. Procedures reject `charge.sv` over 240.
- **`HS` and `CS` are missing from `RD A0` replies** until set, again on every new connection. The reconciler treats missing as a mismatch and resends.
- **A power cycle resets the controls** to `TS 0, AH 1, FC 0, RC 0`, HS and CS unset. The `SC AR`/`CL AR` handshake doesn't.
- **Dropped commands are rare with 100 ms spacing:** in both real self-tests every change was echoed on the first send. The old project's heavy dropping likely came from back-to-back sends. The reconciler stays anyway.
- **macOS port:** open `/dev/cu.usbserial-*`, not `tty.*` (which blocks on carrier-detect).
- **One program per port:** with Artisan connected, opening fails with a lock error. Say so clearly; don't spin silently.
- **Preheat heat-soak:** from cold, BT reaches 183 °C in about 3.5 minutes and holds, but ET keeps climbing (about 158 → 180 °C) for another 12–15 while the PID's duty drifts from about 37% to 25%: the drum soaking. Hence ready also needs ET to stop rising.

## Files

**Roast logs** `#N_….json` (`server/roastlog.js`, which describes every field): one file per roast with the bean slug, variant, procedure version and contents, weights, charge/TP/dry/FC/SC/drop/beans-out, every step, override, and alert, pops, tasting notes, and every reading (`samples`: one array per channel, `t` in seconds since charge, negative during the preheat before it, `null` for no reading). Event times are seconds since charge too, to the millisecond: a step's `t` and `BT` are its triggering reading; `fc` and `sc` are button presses, a moment after their reading; `drop` has a `reason` (temperature, button, second crack, emergency stop, interrupted). `indexAt(samples.t, ev.t)` finds an event's reading. Dry end is Artisan's rule: the first BT ≥ 152 after the TP.

Roasts #1-#37 were recorded by Artisan (`source: "artisan"`): their events come from Artisan's marks, `tp` from its computed TP, and `artisan` keeps Artisan's own numbers (`computed`, `phases`, every control change it logged as `events`, the between-batch `bbp_*` fields). Their extra channels (burner, air, setpoint...) were sampled up to 0.4 s off the BT/ET times; the logs put them on the BT/ET times, as everything that read them did. Four of them (#7, #7, #8, #12) have stretches with no readings. #38-#41 (`source: "app"`) were the app's .alog + sidecar; their step and event times were restored to the millisecond from the .alog, since the sidecar had rounded them to 0.1 s. The .alog files and their reader are in git history (before 2026-10-15) if Artisan is ever needed again.

**Naming:** `#N_<bean>_<variant>_YY-MM-DD_HHMM`, from the record's start time; N continues from the highest `#` in the folder. Written atomically on charge, every 30 s, on every event, and when the record closes.

## Procedures

A procedure's `variants` (e.g. `espresso`, `pourover`) shallowly override top-level fields; a variant's `steps` replaces the whole list. A `reference` names its roast by `roast` number, plus `file` when that number is shared (#7, #25); a test checks every reference resolves to exactly one log. Compare drop and development only within a variant; charge through first crack is shared, so all variants pool for that part. In old filenames, `_pour_over` means `pourover`.

**Drafting one for a new bean** (usually from Sweet Maria's or Burman Coffee): find its listing and note the origin, process, altitude/density, screen size, and the supplier's roast advice. Add it to `beans.json`. Copy the procedure of the most similar bean with roast history (decaf → decaf, dense high-grown → dense high-grown), adjust it, explain each difference, and record the research and reasoning in the first `history` entry.

## Analyzing a roast

Resolve bean names through `beans.json` (old filenames spell them inconsistently). Roast numbers aren't unique in old logs (#7 and #25 appear twice); go by filename when ambiguous. `findRoast()` in `roastlog.js` refuses an ambiguous number and takes the file name instead.

1. Get the facts:
   - **Read the log with `readRoast()`** from `server/roastlog.js` in a one-off script, never raw (each is 30-130 KB, mostly `samples`): print everything but `samples`, then compute from the columns.
   - **Older Artisan roasts** have no `procedure` or `steps`; what was done is in `artisan.events` (control changes) and the HP/FC columns.
2. Compute these the same way every time:
   - **Phases** from charge: drying to DRY (the log's `dry`: first BT ≥ 152 °C after TP; Artisan roasts used their own threshold, in `artisan.phases[1]`), Maillard to FC, development to the drop.
   - **Development %** = (drop − FC) / drop × 100, as the UI shows.
   - **RoR** = `rateOfRise()` from `server/procedure.js` (30 s least-squares slope, °C/min, as the app shows). It takes `{t, BT}` with `t` in **ms**: the log's `samples.t` × 1000. Report it every 30 s from 1 minute after TP to the drop.
   - **Crash and flick:** consecutive 30 s readings jump about ±1.5 °C/min from noise alone, so judge against the bean's earlier roasts. Colombian Supremo (#30, #31, #37, #38) always falls 3–4 °C/min in the minute after FC, then rises 1.5–2 °C/min around 8.5–9 minutes. Call out only what's clearly bigger than the bean's usual.
   - **Weight loss** = (in − out) / in × 100.
3. Compare with the bean's earlier roasts (same variant for drop and development) and the procedure's `reference`.
4. Propose concrete edits to `procedures/<bean>.json`, explained by the curve and the tasting notes. One or two changes per iteration, so cause and effect stay readable.
5. Once the user agrees, apply them and append a `history` entry (`date`, `afterRoast`, `change`, `why`).

## Tasting notes

The user mentions drinks in passing ("a latte with 11 g of the Colombian Supremo from 9/21 was excellent"). Record them without being asked:

- **Find the roast** by bean (through `beans.json`) and roast date. If several roasts of that bean share the date, put the note on each, say in it that which one is unknown, and ask; once known, remove it from the others.
- **Write a dated entry:** the drink, grams of each bean, blend partners with their roast numbers, days since roasting, and the user's own words about taste and grind. A blend's note goes on every roast in it.
- **Use `Recorder.addNote(roast, text, date)`** (`roast`: the number, or the file name for #7 and #25) (and `setWeightOut()` for weights) from `server/recorder.js` in a one-off script, with a stub session (`new EventEmitter()`) and `dir` set to `logs/`. It rewrites the roast's log with the note added. Don't edit the files by hand.
- **Check that nothing else changed** (compare the old and new log, `samples` included), then commit the logs.

## Green bean inventory

`inventory.json` holds the batches of each green bean left, by `beans.json` slug. The agent keeps it; the app doesn't read it. A batch is about 155 g, so 1 lb is 3 batches.

- **After every real roast**, subtract one batch, set `updated`, and commit it with the roast's logs. Check `logs/` for real roasts newer than `updated` not yet counted. `--sim` and self-test runs don't count.
- **When the user buys, runs out of, or recounts beans**, update it (new beans go in `beans.json` first). Remove a bean at 0, but say so: it may be worth reordering.
- **When asked what to roast**, read this file, the tasting notes in `logs/`, and which beans have a procedure.
