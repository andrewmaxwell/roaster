// The real USB serial connection, with the same interface as SimKaleido:
// open(), write(msg), close(), and 'line' / 'close' events.

import {EventEmitter} from 'events';
import fs from 'fs';
import {SerialPort} from 'serialport';
import {ReadlineParser} from '@serialport/parser-readline';

export const BAUD_RATE = 57600;

export async function findPort() {
  const ports = await SerialPort.list();
  const match = ports.find(
    (p) =>
      /usbserial|usbmodem|wchusbserial/i.test(p.path) ||
      /kaleido/i.test(p.manufacturer ?? ''),
  );
  if (!match) return null;
  // macOS lists /dev/tty.*, which blocks on carrier-detect; the matching
  // /dev/cu.* callout device is the one that works.
  const cu = match.path.replace('/dev/tty.', '/dev/cu.');
  return fs.existsSync(cu) ? cu : match.path;
}

export class SerialTransport extends EventEmitter {
  async open() {
    const path = await findPort();
    if (!path)
      throw new Error('Roaster not found. Is the USB cable plugged in?');
    this.port = new SerialPort({path, baudRate: BAUD_RATE, autoOpen: false});
    await new Promise((resolve, reject) =>
      this.port.open((err) => {
        if (!err) return resolve();
        if (/lock/i.test(err.message))
          err.message = `${path} is busy. Is Artisan connected? (${err.message})`;
        reject(err);
      }),
    );
    this.path = path;
    this.port.on('close', () => this.emit('close'));
    this.port.on('error', (err) => this.emit('error', err));
    this.port
      .pipe(new ReadlineParser({delimiter: '\n'}))
      .on('data', (line) => this.emit('line', line));
    return this;
  }

  get isOpen() {
    return !!this.port?.isOpen;
  }

  write(msg) {
    this.port.write(msg);
  }

  close() {
    if (this.port?.isOpen) this.port.close();
  }
}
