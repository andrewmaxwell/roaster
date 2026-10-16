#!/bin/zsh
# Double-click to try the app on a simulated roaster, 5x faster than real
# time. Nothing here touches the real roaster or the roast logs.
cd "${0:A:h}" && exec node server/main.js --sim --speed 5 --open
