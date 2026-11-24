# P4 の記録（進行中）

計画（docs/go-migration-plan.md）の P4 の経過。P4 が終わったら、結果と K4 の判断をこのファイルにまとめる。

## 経過

| 日時（JST） | 出来事 |
|---|---|
| 2026-11-24 15:43 | **4a 開始。** Go 版の bridge を `127.0.0.1:8391` で起動（`tools/shadowdiff/shadow.sh start`。PR #47）。設定はコピー（ntfy と `public_url` なし、orchestrator は今のディレクトリに固定して管理しない扱い）、state と data は一時ディレクトリ |
| 2026-11-24 15:54 | 比較の道具（`shadowdiff watch`）を最終版で起動し直す。最初の比較から違いは 0 件 |
| 2026-11-24 17:19:53 | **4b 開始（前倒し）。** 利用者が `tailscale serve --bg --https=10000 8391` で割り当て、携帯から Go 版を使い始めた（時刻は tailscaled のログの serve の設定の変更。最初のアクセスは 17:20:21）。8443 は別のものが使っているので 10000 にした（PR #48）。4a の並走と重なっている |

K4 の期限（P4 の開始から 14 日）は 2026-12-08。

## 計画からずれたこと

1. **4b を 4a の 3 日の途中で始めた（利用者の判断）。** 4b からは Go 版から本物の herdr に書き込むが、Node 版も同じ herdr を見ているので、`/api/state` と `agent_status` の比較はそのまま続けられる。17:24 の時点で 1,077 回比べて違いは 0 件、`agent_status` の遷移は両方で 68 件ずつ一致していた（携帯からの操作が始まった後を含む）。
2. **計画 4b の 3（本番の `pane-profiles.json` を Go 版の state にコピーして起動し直す）をしていない。** 並走中の bridge は止めない。コピーしないと何が変わるかを確かめた。
   - 本番の記録の 8 件はどれも既定の `claude` で、今もあるペインは 3 つの orchestrator（`w45:p3`、`w46:p2`、`w47:p2`）だけ。
   - 記録がないとき、Go 版の clear は検出した agent の種類と同じ名前の profile を選ぶ（`profileForAgentType`）。claude なら `claude` で、記録と同じになる。
   - よって、4b を始めた時点でもうあった agent は、Go 版から clear してよい。**4b を始めた後に Node 版（今までの携帯の接続）から既定以外の profile（例: `claude-sonnet`）で起動した agent は、Node 版から clear する**（Go 版からだと素の `claude` で起動し直される）。Go 版から既定以外の profile で起動した agent は、計画どおり 4b の終わりに閉じる。
