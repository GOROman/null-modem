# デプロイと BBS への接続

## 1. null-bbs で WebSocket を受ける

null-bbs の設定 (`null-bbs.toml`) で WebSocket の待ち受けを有効にします。既定値のままで大丈夫です。

```toml
[ws]
listen = ["127.0.0.1:5657"]
```

## 2. Cloudflare Tunnel で公開する

自宅の PC で cloudflared を動かし、Cloudflare に置いたドメインのホスト名 (例: `bbs.example.com`) を null-bbs の WebSocket につなぎます。

```sh
cloudflared tunnel login                         # ブラウザで Cloudflare にログインしてドメインを選ぶ
cloudflared tunnel create null-bbs               # トンネルを作る
cloudflared tunnel route dns null-bbs bbs.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: null-bbs
credentials-file: /Users/あなた/.cloudflared/<トンネルID>.json
ingress:
  - hostname: bbs.example.com
    service: http://localhost:5657
  - service: http_status:404
```

```sh
cloudflared tunnel run null-bbs
```

これで `wss://bbs.example.com/` が null-bbs の WebSocket 回線につながります。null-bbs の管理コンソールには、接続元として利用者の IP アドレスが出ます。

### すぐ試すとき (クイックトンネル)

Cloudflare アカウントやドメインが無くても、一時的な URL で公開できます。起動するたびに URL が変わり、cloudflared を止めると使えなくなります。

```sh
cloudflared tunnel --url http://localhost:5657
# → https://xxxx-xxxx.trycloudflare.com が表示される (wss://xxxx-xxxx.trycloudflare.com/ で使う)
```

URL は `wrangler.jsonc` に書かずに、デプロイのときに渡すこともできます。

```sh
npx wrangler deploy --var 'PHONEBOOK:[{"number":"0","name":"NULL-BBS","url":"wss://xxxx-xxxx.trycloudflare.com/"}]'
```

## 3. null-modem を Cloudflare Workers にデプロイする

`wrangler.jsonc` の電話帳 (`PHONEBOOK`) の接続先を、手順 2 のホスト名に書き換えます。

```jsonc
"vars": {
  "PHONEBOOK": "[{\"number\":\"0\",\"name\":\"NULL-BBS\",\"url\":\"wss://bbs.example.com/\"}]"
}
```

```sh
npx wrangler login    # 初回のみ
npx wrangler deploy
```

表示された `https://null-modem.<あなたのサブドメイン>.workers.dev/` を開き、POWER を押してから「ダイヤル」(または `ATDT0`) で接続します。

電話帳は複数書けます。番号ごとに別の BBS を割り当てられます。電話帳に無い番号にかけたときは、画面の「手入力の接続先」に入れた URL につなぎます。
