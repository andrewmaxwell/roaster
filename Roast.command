#!/bin/zsh
# Double-click to roast: starts the app on the real roaster and opens the UI
# in Chrome. Quit with Ctrl-C (it turns the heater off first).
cd "${0:A:h}" && exec node server/main.js --open
