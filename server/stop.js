// Emergency stop, for when the app isn't there to do it (crashed, hung, or
// killed). The M1 LITE has no panel: this USB connection is the only way to
// turn the burner off short of unplugging it, and the roaster keeps heating
// on its own if the computer goes quiet (self-test watchdog, 2026-10-04).
//
//   node server/stop.js         heater off; air and drum keep running
//                                      (if it's hot) so the machine cools
//   node server/stop.js --all   everything off (once it's cool)
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
    machine.set(all ? {FC: 0, RC: 0, CS: 0} : hot ? {FC: 100, RC: 90} : {});
    const ok = await until(() => machine.settled() && machine.state.HS === 0);
    if (!ok)
      return {
        ok,
        message: `Sent, but not all confirmed: ${JSON.stringify(machine.state)}`,
      };
    const what = all
      ? 'everything off'
      : hot
        ? 'heater off; air 100% and drum 90% running to cool'
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
  } else if (!all && !(BT < 60))
    console.log(
      'Once BT is under 60, run with --all to turn the air and drum off.',
    );
  process.exit(ok ? 0 : 1);
}
