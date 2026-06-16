(function () {
  var input = document.getElementById("blog-search");
  var list = document.getElementById("blog-list");
  var status = document.getElementById("blog-search-status");
  var indexUrl = window.BLOG_SEARCH_INDEX || "/search.json";
  var originalListHtml = list ? list.innerHTML : "";
  var posts = [];

  if (!input || !list) {
    return;
  }

  function normalize(value) {
    return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function render(items, query) {
    if (!query) {
      status.textContent = "";
      return;
    }

    if (!items.length) {
      list.innerHTML = '<p class="muted">該当する日記はありません。</p>';
      status.textContent = "0件";
      return;
    }

    list.innerHTML = items.map(function (post) {
      var image = post.image
        ? '<img class="diary-thumb" src="' + escapeHtml(post.image) + '" alt="' + escapeHtml(post.imageAlt || post.date) + '">'
        : "";
      return (
        '<article class="diary-item">' +
          '<a href="' + escapeHtml(post.url) + '">' +
            image +
            '<span class="diary-item-body">' +
              '<strong><time>' + escapeHtml(post.date) + '</time></strong>' +
              '<span>' + escapeHtml(post.excerpt || "") + '</span>' +
            '</span>' +
          '</a>' +
        '</article>'
      );
    }).join("");
    status.textContent = items.length + "件";
  }

  function search() {
    var query = normalize(input.value);

    if (!query) {
      list.innerHTML = originalListHtml;
      status.textContent = "";
      return;
    }

    var terms = query.split(" ");
    var results = posts.filter(function (post) {
      var haystack = normalize([post.date, post.excerpt, post.content].join(" "));
      return terms.every(function (term) {
        return haystack.indexOf(term) !== -1;
      });
    });

    render(results, query);
  }

  fetch(indexUrl)
    .then(function (response) {
      if (!response.ok) {
        throw new Error("Failed to load search index");
      }
      return response.json();
    })
    .then(function (data) {
      posts = Array.isArray(data) ? data : [];
      input.addEventListener("input", search);
    })
    .catch(function () {
      status.textContent = "検索インデックスを読み込めませんでした。";
      input.disabled = true;
    });
})();
