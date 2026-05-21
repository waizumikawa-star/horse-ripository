# BABA抜き オンライン対戦ゲーム

VS嵐の「BABA嵐」をモチーフにした、シャッフルタイム付きババ抜きのWebゲームです。

## 構成

- `index.html` / `styles.css` / `app.js`: Cloudflare Pages向けの静的フロントエンド
- `server.js`: PartyKit WebSocketサーバー
- `_redirects`: Pagesで `/room/:id` へ直接アクセスしても `index.html` を返す設定

PartyKit hostを未設定のまま開くと、同一ブラウザ内で遊べるローカル/NPCモードになります。

## ローカル起動

```bash
npm install
npm run dev:party
```

別ターミナルで静的ファイルを配信します。

```bash
npm run dev:front
```

ブラウザで `http://localhost:4173/?host=localhost:1999` を開きます。

## デプロイ

```bash
npm run deploy:party
```

Cloudflare Pagesには、このリポジトリの静的ファイルをデプロイします。
デプロイ後、トップ画面の `PartyKit host` に PartyKit のホスト名を保存するとオンライン対戦で動作します。

## 実装済みルール

- 52枚 + ジョーカー1枚の配布
- 初期ペア捨て、引いた後の自動ペア捨て
- 4人/5人ルーム
- 人数不足分のNPC補填
- 途中切断プレイヤーのNPC化
- ジョーカー所持者のシャッフルタイム
- シャッフルタイム未使用制限と残り2人時の発動不可
- 「右から2番目」が残り3人で成立しない場合はドクロ扱い
- クリック2枚で自分の手札並び替え
