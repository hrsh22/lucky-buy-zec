#!/bin/sh
# Keeps the server and the luckybuy tunnel running through judging: restarts either if it exits, and holds
# off idle sleep while this script runs. Start: nohup scripts/keepalive.sh > logs/keepalive.log 2>&1 &
# Stop: kill the keepalive.sh process (its two loops and caffeinate go with it).
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs

forever() { # name, command...
  name=$1; shift
  while :; do
    echo "$(date '+%F %T') starting $name"
    "$@" >> "logs/$name.log" 2>&1
    echo "$(date '+%F %T') $name exited ($?), restarting in 3 s"
    sleep 3
  done
}

forever server node --env-file-if-exists=.env src/server.ts &
forever tunnel cloudflared tunnel --no-autoupdate run --url http://localhost:8787 luckybuy &
trap 'kill 0' INT TERM
caffeinate -is -w $$ &
wait
