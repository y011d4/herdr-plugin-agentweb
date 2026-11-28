# 起動と接続

## 起動 {#starting}

ブリッジを起動する (いずれかの方法):

```bash
herdr plugin action invoke y011d4.yoicks.start   # デタッチしたデーモンとして起動
herdr plugin pane open --plugin y011d4.yoicks --entrypoint server  # ペイン内で可視化して起動
```

続いて、QR コードをスキャンしてスマホを接続します (システムパッケージ `qrencode` が必要。
無い場合は URL の表示にフォールバックします):

```bash
herdr plugin pane open --plugin y011d4.yoicks --entrypoint connect
```

このオーバーレイペインには、接続 URL の QR がアクセストークン付きで表示されます — 設定した
`public_url` があればそれを、無ければ自動検出した Tailscale アドレスを、それも無ければ
`http://127.0.0.1:<port>` を使います。経路の選び方と `public_url` の設定は [スマホへの公開](./phone) を
参照してください。トークンを表示するのはこのペインだけです。`start` / `status`、`server` ペイン、
`bridge.log` はトークンを含まない URL を表示します。トークンは state ディレクトリ (`token` ファイル。
パスはアクションの出力に表示されます) に置かれます。

## ブリッジの管理 {#managing-the-bridge}

プラグインは 3 つのワークスペースアクションと 2 つのペインを公開しています:

| エントリポイント | 種別 | 内容 |
| --- | --- | --- |
| `y011d4.yoicks.start` | action | ブリッジをデタッチしたデーモンとして起動 |
| `y011d4.yoicks.stop` | action | 動作中のブリッジを停止 |
| `y011d4.yoicks.status` | action | 動作状況、URL (トークンなし)、プラグインと herdr の版、見つかった任意のコマンドを表示 |
| `server` | pane | ブリッジを可視ペインで起動 (フォアグラウンド。URL はここに表示。トークンは含まない) |
| `connect` | pane | 接続用の QR / URL をオーバーレイ表示 |

アクションは `herdr plugin action invoke <id>` で実行し、ペインは
`herdr plugin pane open --plugin y011d4.yoicks --entrypoint <id>` で開きます。デタッチした
デーモンとフォアグラウンドの `server` ペインは排他です — どちらか一方だけを起動してください。
