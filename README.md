Kaleido - 2026 - Automated roast controller for a Kaleido M1 LITE that follows a per-bean procedure and learns from every batch.

> **Status:** in use on the real roaster since roast #38 (2026-10-04), after the hardware self-test passed. New behavior is tested in the simulator first.

## Running it

- `node kaleido/server/main.js` connects to the roaster (quit Artisan first) and serves the app at http://localhost:3100/. Click **Start** to turn on sound, then **Start preheating**.
- `node kaleido/server/main.js --sim --speed 20` does the same with a simulated roaster, so you can try the whole flow anywhere. Its roasts go to `logs-sim/`.
- **Stopping.** The roaster has no panel, so the computer is the only way to turn the burner off:
  - **STOP** (top right, click twice) turns the heater off now. Mid-roast it also calls for the drop. The air and drum keep running to cool.
  - Quitting the server (Ctrl-C twice) or a crash also turns the heater off first. The session is saved, so restarting within 30 minutes resumes it, heat included. A roast resumes only if the app was off for less than 2 minutes. After longer than that, the app ends the roast and goes back to preheating, because the beans have sat without heat.
  - A separate guardian process watches the app. If the app crashes, is killed, or hangs, the guardian turns the heater off within seconds and says so out loud. The roaster itself would keep heating.
  - If something still seems wrong, run `node kaleido/server/stop.js` for heater off with the fans left running, or `--all` once the roaster is cool. The very last resort is unplugging the roaster.
  - While the app runs, it keeps the Mac awake with `caffeinate`, but closing the lid can still put it to sleep. Leave the lid open.

## What it does

A local Node server connects to the roaster over USB serial. It runs a roast **procedure**: charge, temperature-triggered burner and air changes, and drop. A browser page at `localhost` shows a live chart with big buttons, and speaks to you when it needs your hands or ears. Each batch is saved as an Artisan-compatible `.alog` with a sidecar of extra info. Between sessions, you ask Claude Code to analyze the roasts and improve that bean's procedure.

It runs a whole session. Once a batch is dropped, it goes straight back to preheating. Meanwhile you pick the next bean, or tell it you're done for the day. When you're done, it cools the machine down and turns everything off.

## A session

1. **Start.** Pick the bean and variant, and type in the weight in from your scale. You can edit the weight until the drop. The server connects and starts preheating.
2. **Preheat** uses the same settings for every bean (`preheat.json`): Auto Burner ON, SV 185 °C, air 30%, drum 90%. It's ready when BT stays within about 1.5 °C of SV for about 3 minutes and ET has stopped climbing. From cold, that takes 15–18 minutes, because the drum keeps soaking up heat long after BT looks settled. Between batches it's about 5–10 minutes.
3. **"Ready for charge."** Pour in the beans. There's no CHARGE button: the program detects the charge from the sudden BT drop and switches to manual burner using the procedure's charge settings.
4. **Roast.** The program applies each BT-triggered step and plays a soft chime for each one. You listen, and press **FC** when you hear several pops close together. The microphone flashes a "pops detected?" hint, but it never marks FC by itself.
5. **Second crack.** If it starts, press **Second crack** twice (the second click confirms). That drops the batch immediately. **Drop now** works the same way.
6. **"Drop now!"** At the drop temperature, the program switches straight back to the preheat settings and turns the cooling fan on. You open the door. The burner stays off on its own, because BT is far above the 185 °C SV. The drum stays at 90% throughout, so the beans tumble out.
7. **While the next batch preheats,** do three things:
   - turn off the cooling fan when you're done with it (it stays on until you do)
   - enter the weight out
   - pick the next bean, which can be different, or choose **Done for today**
8. **Done for today.** The heater turns off, and the air, drum, and cooling fan keep running until BT is cool. Then everything turns off.

You can override at any time. Touching the burner or air slider takes that control away from the procedure until you hand it back.

## Procedures

There's one file per bean, `procedures/<bean>.json` (see `procedures/colombian_supremo.json`). Each file has these parts:

- **charge**: the burner and SV applied the moment CHARGE is detected.
- **steps**: `{bt, burner?, air?}` entries. Each fires once, when BT rises through `bt` after the turning point.
- **drop**: the drop BT.
- **reference**: the checkpoint times from a past roast you liked. They're shown on the chart but never chased.
- **history**: every change, why it was made, and which roast motivated it.

**Brew-method variants.** You can roast the same bean differently for espresso and for pour-over, without keeping two separate procedures. A procedure can have `variants`. Each variant overrides only the fields that differ. Usually that's just `drop`, and sometimes the steps after first crack. Everything up to first crack stays shared, so both variants add to the same history for that part of the roast. When you start a batch, you pick the bean and then a variant. The variant goes in the log filename (`#38_colombian_supremo_espresso_…`) and in the sidecar.

These rules hold for every procedure:

- Follow temperature, not time.
- The program never raises the burner on its own. Only an explicit step can raise it, so it won't chase an FC dip.
- The drop trigger doesn't depend on any other step, so the roast always ends.
- Pressing SC (twice, to confirm) drops immediately.

## Beans

`beans.json` maps each canonical bean slug to its name, supplier, and the spellings used in older log filenames. That way, every roast of a bean lines up even though the old names vary.

For a new bean, tell Claude what it is. Claude researches it (Sweet Maria's or Burman Coffee listing, origin, process, density, and the roaster's recommendations). It then drafts a procedure, starting from your most similar bean that already has history.

## Logs

Everything lives in `logs/` and is committed:

- `#38_colombian_supremo_espresso_26-10-04_1100.alog`: the curve and events, and it opens in Artisan. Artisan will ask "Not a genuine Artisan profile. Load it anyway?", because these files weren't written by Artisan; click Yes. To add a weight out or tasting notes later, tell Claude or use the UI. They go into both files.
- `#38_colombian_supremo_espresso_26-10-04_1100.json`: a sidecar file with everything else:
  - bean slug, weight in and out, and the procedure version
  - when each step fired, plus any overrides and alerts
  - detected pops (time and intensity; no audio is kept)
  - tasting notes

Roast numbers continue from the highest `#` in `logs/`.

## Improving a procedure

In Claude Code, ask "analyze roast #38" or "analyze my last Colombian Supremo roasts". Claude reads the roast's sidecar and curve, the bean's earlier roasts, and your tasting notes. It reports how the roast compared with the reference: RoR crash or flick, development time and %, FC temp, and weight loss. Then it proposes edits to the procedure. See `CLAUDE.md`.

## Trust path (before real beans)

1. **Simulator.** A thermal model fit to the existing logs, so BT responds to the burner and air like the real machine. Whole sessions run at 10× speed.
2. **Hardware self-test** with an empty drum: `node kaleido/server/main.js --selftest` (Artisan closed). It takes about 30–40 minutes and asks before it fires the burner; `--no-heat` runs a quick version. It checks four things:
   - each control is set, and the machine echoes the new value back
   - manual burner raises BT past the preheat SV, which proves the SV ceiling was lifted
   - the cooling fan and shutdown work
   - the program reconnects after the cable is pulled
3. **First real batch.** Use a bean you've roasted many times, keep the STOP button in reach, and compare the result against its past Artisan logs.
