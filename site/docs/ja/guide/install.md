# インストール

## 必要要件 {#requirements}

- [herdr](https://herdr.dev) >= 0.9.5 ([対応状況](../reference/troubleshooting#compatibility) を参照)
- Linux (amd64、arm64)。macOS (Apple シリコン、Intel) は試験的な対応です。
- ほかにインストールするものはありません。プラグインはビルド済みのバイナリ 1 つで、インストール時に
  `sh`、`curl` か `wget`、`sha256sum` か `shasum` という普通の道具で取得し、検証します。Node.js も
  Go も要りません。
- スマホからブリッジに到達する手段 — リバースプロキシ、トンネル、または VPN
  ([スマホへの公開](./phone) を参照)。Tailscale は手軽な選択肢の一つで、必須ではありません。
- 任意のコマンド (あれば使います):
  - `git` 2.31 以上 — カードのブランチ名、worktree
  - `qrencode` — 接続用の QR コード (無ければ接続ペインは URL を表示します)
  - `tailscale` — ブリッジを `tailscale serve` の後ろに置いたとき、接続 URL を自動で検出します
  - `direnv` — [orchestrator](./orchestrators) のための、ディレクトリごとの Claude アカウント
  - `gh` — `worktree remove` が squash merge されたブランチを見分けます

## セットアップ {#setup}

リリースを GitHub から直接インストールします:

```bash
herdr plugin install y011d4/herdr-yoicks --ref v0.1.0
```

clone もビルドも不要です。`herdr plugin install` はマニフェストの `[[build]]`
(`scripts/plugin-build.sh release`) を実行します。これは、その版の OS と CPU に合うバイナリを
[GitHub のリリース](https://github.com/y011d4/herdr-yoicks/releases) から取得し、そのタグの
リポジトリにコミットされた `release/checksums.txt` の SHA-256 と照らし合わせます。合わないバイナリは
インストールしません。(`--ref` を付けないと herdr は既定のブランチを入れ、その `herdr-plugin.toml` に
書かれた版のリリースを取得します。) ローカルのチェックアウトで開発したい場合は[開発](../development) を参照してください。

## 更新 {#updating}

ブリッジを止め、更新し、起動し直します。この順番を守ってください。更新でプラグインのディレクトリが
変わるので、新しい `stop` は古いバイナリが起動したブリッジを見つけられないことがあります:

```bash
herdr plugin action invoke y011d4.yoicks.stop   # 終わるまで待つ
herdr plugin update                               # または: herdr plugin install … --ref v<新しい版>
herdr plugin action invoke y011d4.yoicks.start
```

続いて、動いている orchestrator をそれぞれ起動し直します (Home の **Clear**)。bridge は起動のときに
rules と許可リストを新しい `yoicks` のパスに書き直しますが、動いている orchestrator は古いパスを呼び続けます。
ヘッドレスの orchestrator は何もしなくてかまいません。ブリッジの再起動でセッションが再開し、再開した
セッションは新しい rules を読みます。

## 前の版に戻す {#rolling-back}

前のリリースに戻すときは、ブリッジを止め、その版を入れ直して起動します:

```bash
herdr plugin action invoke y011d4.yoicks.stop   # 終わるまで待つ
herdr plugin uninstall y011d4.yoicks            # トークン、config、orchestrator のディレクトリは残る
herdr plugin install y011d4/herdr-yoicks --ref v<前の版>
herdr plugin action invoke y011d4.yoicks.start
```

そのあと、更新のときと同じく、動いている orchestrator を Clear してください。

link したチェックアウト ([開発](../development) を参照) は、代わりに `sh scripts/redeploy.sh <commit>` で戻します。

## アンインストール {#uninstalling}

```bash
herdr plugin action invoke y011d4.yoicks.stop
herdr plugin config-dir y011d4.yoicks            # アンインストールの前に config ディレクトリを控える
herdr plugin uninstall y011d4.yoicks
```

`herdr plugin uninstall` はファイルを残します。要らないものを消してください:

- インストールしたチェックアウト: `~/.config/herdr/plugins/github-installations/y011d4.yoicks-*`
  (古い herdr では `~/.config/herdr/plugins/github/y011d4.yoicks-*`)
- state ディレクトリ `~/.local/state/herdr/plugins/y011d4.yoicks` (`$XDG_STATE_HOME` があればその下):
  アクセストークン、`bridge.log`、`pane-profiles.json`
- 上で控えた config ディレクトリ (`config.json`)
- `~/.local/share/herdr-yoicks` (`$XDG_DATA_HOME` があればその下):
  orchestrator のディレクトリ。
  自分で書いた `local.md` も含みます
