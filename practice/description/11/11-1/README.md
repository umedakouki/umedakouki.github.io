# 記録物マッピング／クラスタ探索アプリ

位置情報付きの記録物を投稿し、編集画面で関係づけ、そのリンク構造からクラスタを作り、探索画面で地理的位置と関係的位置を重ねて見るためのプロトタイプです。

## 今回の実装範囲

- 公開先: GitHub Pagesで `11/11-1/index.html` を直接開ける静的成果物
- UI: React 18のCDN版を使ったコンポーネント構成
- 保存先: 端末内の `localStorage`
- 探索地図: 外部地図タイルを使わない相対位置の簡易地図
- クラスタリング: `graphEdges` の連結成分

この環境には `npm` / `npx` がなかったため、Viteの実ビルドではなく、GitHub Pagesでそのまま動く静的React成果物として配置しています。将来Vite化する場合も、現在の状態構造と画面分割をそのまま `src/` に移せます。

## 画面

- 送信ページ: テキスト、写真、1分以内の音声、投稿時の推定位置を保存
- 編集ページ: 記録物を編集空間のノードとして配置し、2件を選んでリンク線を作成
- 探索ページ: 現在地追跡、投稿地点、近接状態、同一クラスタ、関係線を表示
- データページ: サンプル追加、JSON書き出し、JSON読み込み、初期化

## 保存構造

```json
{
  "records": [],
  "graphNodes": {},
  "graphEdges": [],
  "clusters": [],
  "clusterMembers": [],
  "schemaVersion": 2
}
```

- `records.latitude / longitude / accuracy`: 投稿時の推定位置
- `graphNodes.x / y`: 編集画面上の位置
- `graphEdges`: 記録物間の関係
- `clusters`: 関係から生じるまとまり
- `clusterMembers`: 将来の複数クラスタ所属に備えた中間構造

## 動作上の注意

位置情報、マイク録音はブラウザの仕様上、HTTPSまたはlocalhostなどの安全なコンテキストでのみ動作します。

音声録音に対応しないブラウザでは、音声ファイル選択に切り替えます。iOS Safariなどでは録音形式や権限挙動が異なるため、実地確認が必要です。

写真と音声はdata URLとしてlocalStorageに保存します。容量が大きくなりやすいため、データページでJSONを書き出せるようにしています。

## 将来の移行先

- Supabase: `records`, `graph_nodes`, `graph_edges`, `clusters`, `cluster_members`
- Storage: 写真・音声ファイル
- MapLibre GL JS: 実地図表示
- React Flow: 編集キャンバス
- Louvain / Leiden: 記録物が増えた段階でのコミュニティ検出
