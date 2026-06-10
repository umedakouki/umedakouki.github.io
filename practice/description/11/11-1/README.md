# 記録物マッピング／クラスタ探索アプリ

位置情報付きの記録物を投稿し、編集画面で関係づけ、その関係を現地で探索するための静的Webアプリです。

## 画面

- 送信: テキスト、写真、音声を投稿する
- 編集: 記録物を選び、2つをつなぐ。選択した記録や既存のつながりも削除できる
- 探索: 投稿地点とクラスタ関係を簡易地図で見る

`データ` 画面やタイトル入力は削除し、設定・移行・削除などは `詳細` の中に畳んでいます。

## Supabase共有

`supabase-config.js` に値を入れると、他端末でも同じデータを閲覧・編集できます。

```js
window.RECORD_MAP_SUPABASE = {
  url: "https://YOUR_PROJECT_ID.supabase.co",
  publishableKey: "YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY",
  mediaBucket: "record-media",
};
```

Supabase側では `supabase-schema.sql` を実行してください。写真・音声用に `record-media` Storage bucket も作成し、匿名ユーザーが `select` と `insert` できるStorage policyを設定します。

このアプリは公開編集ボードです。URLを知っている人は投稿・編集・削除できます。荒らし対策やログインは入れていません。

## フォールバック

`supabase-config.js` が未設定の場合は、端末内localStorageだけで動くローカルデモになります。この場合、他端末共有はできません。

## データ構造

- `records`: 記録物本体、投稿時の推定位置、メディアURL
- `graph_nodes`: 編集画面上の座標
- `graph_edges`: 記録物間のリンク線
- `clusters`: リンク構造から作るクラスタ
- `cluster_members`: クラスタと記録物の対応

クラスタリングは初期実装として連結成分を使っています。
