// Cloudflare Workers: 静的ファイル (public/) と電話帳 (/config.json) を配る
//
// 電話帳は環境変数 PHONEBOOK (JSON) で渡す:
//   [{ "number": "0", "name": "NULL-BBS", "url": "wss://bbs.example.com/" }]

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/config.json") {
      let phonebook = [];
      try {
        phonebook = JSON.parse(env.PHONEBOOK || "[]");
      } catch {
        phonebook = [];
      }
      return Response.json({ phonebook }, { headers: { "cache-control": "no-store" } });
    }
    return env.ASSETS.fetch(request);
  },
};
