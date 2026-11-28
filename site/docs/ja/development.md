# 開発とリリース

ローカルで開発する場合は、GitHub からインストールする代わりに作業ツリーを clone して
**link** します — `herdr plugin link` は herdr にあなたのチェックアウトを指させるので、編集が
そのまま反映されます:

ソースからのビルドには、Go (`go.mod` の版) と、web UI の Vite によるビルドと Vitest のテストのための
Node.js 26.x (`package.json` の `engines`。CI もこれを使います) と `npm` が要ります。

```bash
git clone https://github.com/y011d4/herdr-yoicks
cd herdr-yoicks
sh scripts/plugin-build.sh          # web UI、続いて bin/yoicks (Go)。このチェックアウトから
herdr plugin link "$(pwd)"
```

bridge と CLI は Go (`cmd/yoicks`、`internal/bridge`) です。PWA は `web/src/` の TypeScript と React で
(`main.tsx` がシェルの `ui/App.tsx` を起動します)、Vite で `web/dist` にビルドされ、バイナリに埋め込まれます。

```bash
sh scripts/plugin-build.sh          # 変更後に再ビルド。web の変更も (バイナリが web UI を埋め込むため)
go test ./...                       # Go のテスト
npm test                            # web UI のテスト (Vitest)
./bin/yoicks run                    # ライブの herdr に対しフォアグラウンドで実行 (config は「設定 (config)」のページを参照)
YOICKS_DEV_BRIDGE=http://127.0.0.1:8390 npm run dev   # ソースの web UI を :5174 で (ホットリロード)。
                                    # /api と /ws は動いているブリッジへ中継。?token=<そのトークン> で開く
```

herdr は link したプラグインの build コマンドを実行**しません** (`herdr plugin link` でも、link したものを
飛ばす `herdr plugin update` でも) — 編集後は `sh scripts/plugin-build.sh` で再ビルドしてください
(`herdr plugin link` の再実行は `herdr-plugin.toml` を変更したときだけ)。これは常にチェックアウトをそのまま
ビルドします。`sh scripts/plugin-build.sh release` は、インストールのときと同じく、`herdr-plugin.toml` の版の
リリースのバイナリを取得します。

link したチェックアウトの新しいコミットを動いているブリッジに出すときや、前のコミットに戻すときは、
そのチェックアウトで次を実行します:

```bash
sh scripts/redeploy.sh main         # main を origin/main に fast-forward し、ビルドして再起動
sh scripts/redeploy.sh <commit>     # 前のコミットに同じことをする (detached)
```

stop と start のアクションと `/healthz` を待ち、そのあと Settings → App version に出るはずの `BUILD` と
`CACHE` を表示します。変更の残ったツリーや、`herdr-plugin.toml` が変わる切り替えは、何も止めずに断ります
(herdr は link した manifest をキャッシュするため。`herdr plugin link` を含む手作業の手順を表示します)。
`main` では、出すコミットの CI (GitHub Actions、`gh` で確認) が通るまで出しません。実行中ならその終わりを待ちます。
stop の後に失敗したときは、元のバイナリを起動し直します。

デタッチしたデーモンのログは `<state dir>/bridge.log` に出力されます
(`~/.local/state/herdr/plugins/y011d4.yoicks`、プラグインコマンド内では `$HERDR_PLUGIN_STATE_DIR`)。

## リリース {#releasing}

メンテナー向け。リリースするコミットの、変更のないチェックアウトで:

```bash
scripts/release.sh 0.2.0    # 一時的な worktree で、固定した Go のツールチェーンで dist/release/* を作り、
                            # release/checksums.txt とマニフェストの版を書く
git add herdr-plugin.toml release/checksums.txt && git commit -m "release v0.2.0" && git tag v0.2.0
git push origin main v0.2.0
gh release create v0.2.0 dist/release/* --title v0.2.0 --notes "…"
```

バイナリは作ったまま、圧縮せずに上げます。そのチェックサムはタグと一緒にコミットしたもので、
`scripts/plugin-build.sh` がインストールのときに照らし合わせます。リリースノートには、確認した herdr と
Claude Code の版を書いてください。
