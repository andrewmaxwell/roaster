Kaleido - 2026 - Automated roast controller for a Kaleido M1 LITE that follows a per-bean procedure and learns from every batch.

> **Status:** in use on the real roaster since roast #38 (2026-10-04), after the hardware self-test passed. New behavior is tested in the simulator first.

## Running it

Run `npm install` once, in this folder, then double-click one of these in Finder (or drag them to the Dock):

- **`Roast.command`** connects to the roaster (quit Artisan first), serves the app at http://localhost:3100/, and opens it in Chrome. Click **Start** to turn on sound and crack listening, then **Start preheating**. The same from a terminal: `npm start`.
- **`Simulator.command`** does the same with a simulated roaster at 5× speed, so you can try the whole flow anywhere. A blue SIMULATOR strip across the top says so. Its roasts go to `logs-sim/`, and it plays crack sounds around first and second crack. From a terminal: `npm run sim`, or `node server/main.js --sim --speed 20` for another speed.
- `npm run selftest` runs the empty-drum hardware checks without intentional heating. The drum and fans run, and the test prompts you to unplug and reconnect USB. Add `-- --no-cable` to skip the cable check.
- `npm run selftest:heat` runs the full empty-drum hardware test, including heating. It asks for confirmation before firing the burner.
- **Stopping.** The roaster has no panel, so the computer is the only way to turn the burner off:
  - **STOP** (top right, click twice) turns the heater off now. Mid-roast it also calls for the drop. The air and drum keep running to cool. Between batches it's also how the day ends.
  - Quitting the server (Ctrl-C twice) or a crash also turns the heater off first. The session is saved, so restarting within 30 minutes resumes it, heat included. A roast resumes only if the app was off for less than 2 minutes. After longer than that, the app ends the roast and goes back to preheating, because the beans have sat without heat.
  - A separate guardian process watches the app. If the app crashes, is killed, or hangs, the guardian turns the heater off within seconds and says so out loud. The roaster itself would keep heating.
  - If something still seems wrong, run `node server/stop.js` for heater off with the fans left running, or `--all` once the roaster is cool. The very last resort is unplugging the roaster.
  - If the app server stops mid-session, the page sounds an alarm and says so every 15 s until it's back. The heater was turned off on the way out; take any beans out.
  - While the app runs, it keeps the Mac and its screen awake with `caffeinate`, but closing the lid can still put it to sleep. Leave the lid open.

## What it does

A local Node server connects to the roaster over USB serial. It runs a roast **procedure**: charge, temperature-triggered burner and air changes, and drop. A browser page at `localhost` shows a live chart with big buttons, and speaks to you when it needs your hands or ears. Each batch is saved as one JSON log: the curve, the events, and everything else. Between sessions, you ask Claude Code to analyze the roasts and improve that bean's procedure.

It runs a whole session. Once a batch is dropped, it goes straight back to preheating. Meanwhile you pick the next bean, or press STOP when you're done for the day. When you're done, it cools the machine down and turns everything off.

## A session

1. **Start.** Click **Start preheating**, then pick the bean and variant and type in the weight in from your scale. Nothing is picked until you pick it. The list has only the beans `inventory.json` says you have, most recently roasted first. If the weight is more than 5% off the procedure's batch size, it warns you: the roast will run faster or slower than its reference.
2. **Preheat** uses the same settings for every bean (`preheat.json`): Auto Burner ON, SV 185 °C, air 30%, drum 90%. It's ready when BT stays within about 1.5 °C of SV for about 3 minutes and ET has stopped climbing. From cold, that takes 15–18 minutes, because the drum keeps soaking up heat long after BT looks settled. Between batches it's about 5–10 minutes.
3. **"Ready for charge: Honduran MWP Decaf, 140 grams."** It says which beans it expects, so a wrong choice is heard before they go in. Pour in the beans. There's no CHARGE button: the program detects the charge from the sudden BT drop and switches to manual burner using the procedure's charge settings. If you pour beans in before choosing them, it keeps reminding you until you do; the roast then starts from when they went in. If it wasn't a charge, click **Not a charge**.
4. **Roast.** The program applies each BT-triggered step and plays a soft chime for each one. You listen, and press **First crack** when you hear several pops close together. The microphone (on from the Start click) flashes a "pops detected?" hint, but it never marks first crack by itself. That's the only button mid-roast.
5. **Dropping early.** Just open the door: at second crack, or any time you want the beans out. The app sees BT fall (5 °C, about 10 s after the door opens), records the drop from when it opened, and goes back to preheating.
6. **"Drop now!"** At the drop temperature, the program switches straight back to the preheat settings and turns the cooling fan on. You open the door. The burner stays off on its own, because BT is far above the 185 °C SV. The drum stays at 90% throughout, so the beans tumble out.
7. **While the next batch preheats,** do two things (the cooling fan turns itself off 4 minutes after the beans are out):
   - enter the weight out
   - pick the next bean, which can be different, or press **STOP** if you're done for today
8. **Done for today.** After STOP, the heater turns off, and the air and drum keep running until BT is under 60 °C (15–20 minutes from a roast). Then everything turns off, and it says "All off. You can unplug the roaster." Keep it plugged in until then: without power the fans stop with the drum still hot. If it's unplugged mid-cool-down, the app alarms and asks you to plug it back in.

There are no burner or air controls: the procedure decides the heat, and changes to it go into the procedure between roasts, where they're recorded and explained.

## Procedures

There's one file per bean, `procedures/<bean>.json` (see `procedures/colombian_supremo.json`). Each file has these parts:

- **charge**: the burner and SV applied the moment CHARGE is detected.
- **steps**: `{bt, burner?, air?}` entries. Each fires once, when BT rises through `bt` after the turning point.
- **drop**: the drop BT.
- **reference**: the checkpoint times from a past roast you liked. They're shown on the chart but never chased.
- **history**: every change, why it was made, and which roast motivated it.

**Brew-method variants.** You can roast the same bean differently for espresso and for pour-over, without keeping two separate procedures. A procedure can have `variants`. Each variant overrides only the fields that differ. Usually that's just `drop`, and sometimes the steps after first crack. Everything up to first crack stays shared, so both variants add to the same history for that part of the roast. When you start a batch, you pick the bean and then a variant. The variant goes in the log filename (`#38_colombian_supremo_espresso_…`) and in the log.

These rules hold for every procedure:

- Follow temperature, not time.
- The program never raises the burner on its own. Only an explicit step can raise it, so it won't chase an FC dip.
- The drop trigger doesn't depend on any other step, so the roast always ends.
- Opening the door drops immediately.

## Beans

`beans.json` maps each canonical bean slug to its name, supplier, and the spellings used in older log filenames. That way, every roast of a bean lines up even though the old names vary.

For a new bean, tell Claude what it is. Claude researches it (Sweet Maria's or Burman Coffee listing, origin, process, density, and the roaster's recommendations). It then drafts a procedure, starting from your most similar bean that already has history.

## Logs

Everything lives in `logs/` and is committed:

- `#38_colombian_supremo_espresso_26-10-04_1100.json`, one file per roast:
  - bean, variant, weight in and out, and the procedure version
  - when each step fired, plus first crack, the drop, and any alerts
  - every reading (BT, ET, burner, air, and so on), from the end of the previous batch
  - detected pops (time and intensity; no audio is kept)
  - tasting notes

  To add a weight out or tasting notes later, tell Claude or use the UI. Roasts #1–#37 were recorded in Artisan and converted to the same format.

Roast numbers continue from the highest `#` in `logs/`.

## Improving a procedure

In Claude Code, ask "analyze roast #38" or "analyze my last Colombian Supremo roasts". Claude reads the roast's log, the bean's earlier roasts, and your tasting notes. It reports how the roast compared with the reference: RoR crash or flick, development time and %, FC temp, and weight loss. Then it proposes edits to the procedure. See `AGENTS.md`.

## Trust path (before real beans)

1. **Simulator.** A thermal model fit to the existing logs, so BT responds to the burner and air like the real machine. Whole sessions run at 10× speed.
2. **Hardware self-test** with an empty drum: `node server/main.js --selftest` (Artisan closed). It takes about 30–40 minutes and asks before it fires the burner; `--no-heat` runs a quick version. It checks four things:
   - each control is set, and the machine echoes the new value back
   - manual burner raises BT past the preheat SV, which proves the SV ceiling was lifted
   - the cooling fan and shutdown work
   - the program reconnects after the cable is pulled
3. **First real batch.** Use a bean you've roasted many times, keep the STOP button in reach, and compare the result against its past logs.
