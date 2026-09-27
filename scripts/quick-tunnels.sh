#!/bin/bash
# 一時トンネル (trycloudflare) で手元の BBS を null-modem の電話帳につなぎ、切れたら張り直して電話帳を更新し直す。
# 名前付きトンネルを用意するまでのつなぎ。
#   使い方: scripts/quick-tunnels.sh  (止めるときは Ctrl-C)
# 電話帳の内容はここで書く: 番号 名前 ローカルのポート
set -u
cd "$(dirname "$0")/.."
ENTRIES=(
  "03-1919-0721|NULL-BBS|5657"
  "03-4545-1919|NULL-NET|6869"
)
LOGDIR=${TMPDIR:-/tmp}
declare -a HOSTS PIDS

start() { # $1 = 番号
  local port=${ENTRIES[$1]##*|} log="$LOGDIR/quick-tunnel-$1.log"
  [ -n "${PIDS[$1]:-}" ] && kill "${PIDS[$1]}" 2>/dev/null
  cloudflared tunnel --no-autoupdate --protocol http2 --url "http://localhost:$port" >"$log" 2>&1 &
  PIDS[$1]=$!
  local url=""
  for _ in $(seq 1 60); do
    url=$(grep -o "https://[a-z0-9-]*\.trycloudflare\.com" "$log" | head -1)
    [ -n "$url" ] && break
    sleep 1
  done
  HOSTS[$1]=${url#https://}
  for _ in $(seq 1 30); do dig +short "${HOSTS[$1]}" | grep -q . && break; sleep 2; done
}

deploy() {
  local json="[" i
  for i in "${!ENTRIES[@]}"; do
    IFS='|' read -r num name _ <<<"${ENTRIES[$i]}"
    [ "$i" -gt 0 ] && json+=","
    json+="{\"number\":\"$num\",\"name\":\"$name\",\"url\":\"wss://${HOSTS[$i]}/\"}"
  done
  json+="]"
  npx wrangler deploy --var "PHONEBOOK:$json" 2>&1 | grep -E "Version|ERROR"
  echo "$(date '+%m/%d %H:%M:%S') 電話帳を更新しました: $json"
}

alive() { # WebSocket で入口の文字が返ってくるか
  WSURL="wss://${HOSTS[$1]}/" node -e '
const ws = new WebSocket(process.env.WSURL); ws.binaryType = "arraybuffer"; let got = false;
ws.onmessage = () => { got = true; }; ws.onerror = () => process.exit(1);
setTimeout(() => { ws.close(); process.exit(got ? 0 : 1); }, 8000);' 2>/dev/null
}

trap 'kill ${PIDS[*]} 2>/dev/null; exit 0' INT TERM
for i in "${!ENTRIES[@]}"; do start "$i"; done
deploy
while sleep 60; do
  changed=0
  for i in "${!ENTRIES[@]}"; do
    if ! alive "$i" && ! (sleep 10; alive "$i"); then
      echo "$(date '+%m/%d %H:%M:%S') ${ENTRIES[$i]} のトンネルが切れたので張り直します"
      start "$i"
      changed=1
    fi
  done
  [ "$changed" = 1 ] && deploy
done
