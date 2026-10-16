// Emergency stop, for when the app isn't there to do it (crashed, hung, or
// killed). The M1 LITE has no panel: this USB connection is the only way to
// turn the burner off short of unplugging it, and the roaster keeps heating
// on its own if the computer goes quiet (self-test watchdog, 2026-10-04).
//
//   node server/stop.js         heater off; air, drum and the tray's
//                               cooling fan keep running (if it's hot) so
//                               the machine and any dumped beans cool
//   node server/stop.js --all   everything off, but only once BT is under
//                               60 °C; while hot it does the same as above
//
// If the app is still running, it holds the port, and this can't connect:
// use the app's STOP button, or quit the app (Ctrl-C twice also turns the
// heater off) and run this again. guardian.js calls emergencyStop() too.

import {fileURLToPath} from 'url';
import {createClock} from './clock.js';
import {Machine} from './machine.js';
import {SerialTransport} from './port.js';

// Returns {ok, message}.
export async function emergencyStop({
  all = false,
  openTransport = () => new SerialTransport().open(),
  clock = createClock(),
  timeoutMs = 15_000,
} = {}) {
  const machine = new Machine({clock, openTransport});
  let lastError = null;
  machine.on('error', (err) => (lastError = err.message));
  machine.run();
  const deadline = clock.now() + timeoutMs;
  const until = async (cond, ms = Infinity) => {
    const end = Math.min(deadline, clock.now() + ms);
    while (!cond() && clock.now() < end) await clock.sleep(200);
    return cond();
  };
  try {
    if (!(await until(() => machine.connected)))
      return {
        ok: false,
        message: `Couldn't connect to the roaster: ${lastError ?? 'no answer'}`,
      };
    // Heater off first, without waiting for a temperature; BT only decides
    // the fans. With no reading, cool as if it's hot.
    machine.set({HS: 0, AH: 0, HP: 0});
    await until(() => machine.state.BT != null, 5000);
    const BT = machine.state.BT;
    const hot = !(BT < 60);
    // Never stop the cooling on a hot (or unknown) machine, --all or not.
    machine.set(
      hot ? {FC: 100, RC: 90, CS: 1} : all ? {FC: 0, RC: 0, CS: 0} : {},
    );
    const ok = await until(() => machine.settled() && machine.state.HS === 0);
    if (!ok)
      return {
        ok,
        message: `Sent, but not all confirmed: ${JSON.stringify(machine.state)}`,
      };
    const what = hot
      ? `heater off; air 100%, drum 90% and cooling fan running to cool${all ? ' (still hot, so not everything off)' : ''}`
      : all
        ? 'everything off'
        : 'heater off';
    return {
      ok,
      message: `${what[0].toUpperCase()}${what.slice(1)}. BT ${BT ?? 'unknown'}.`,
      BT,
    };
  } finally {
    await machine.stop();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const all = process.argv.includes('--all');
  const {ok, message, BT} = await emergencyStop({all});
  console.log(message);
  if (!ok) {
    console.log('If the app is running, use its STOP button or quit it first.');
    console.log('Last resort: unplug the roaster.');
  } else if (!(BT < 60))
    console.log(
      'Once BT is under 60, run with --all to turn the air and drum off.',
    );
  process.exit(ok ? 0 : 1);
}
