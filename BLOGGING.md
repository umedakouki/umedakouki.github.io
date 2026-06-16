# 日記の更新方法

1. 画像を `assets/blog/` に入れる。
2. `_posts/` に `YYYY-MM-DD-title.md` という名前でMarkdownを作る。
3. `_drafts/yyyy-mm-dd-diary-template.md` をコピーして、日付、画像、本文を書き換える。

投稿例:

```md
---
date: 2026-06-16
image: /assets/blog/2026-06-16.jpg
image_alt: 今日撮った写真
---

本文を書く。
```

`/blog/` には最新月の日記が新しい日付順に表示されます。上部の「年・月を選ぶ」リンクで下部の月一覧へ移動でき、下部の月リンクで月を切り替えられます。全文検索は月をまたいで日付、本文、抜粋を対象にします。
