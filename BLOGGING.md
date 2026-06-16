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

`/blog/` には月ごとにまとまって日付順で自動表示されます。日記の見出しは `2026.06.16` のような日付表示になります。全文検索は日付、本文、抜粋を対象にします。
