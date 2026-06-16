(function () {
  var input = document.getElementById("blog-search");
  var list = document.getElementById("blog-list");
  var status = document.getElementById("blog-search-status");
  var monthJump = document.querySelector(".month-jump");
  var monthNav = document.getElementById("diary-month-links");
  var monthLinks = Array.prototype.slice.call(document.querySelectorAll("[data-month-link]"));
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

  function getMonthFromUrl() {
    var params = new URLSearchParams(window.location.search);
    return params.get("month");
  }

  function getDefaultMonth() {
    return monthLinks.length ? monthLinks[0].getAttribute("data-month-link") : "";
  }

  function setUrlMonth(month) {
    var url = new URL(window.location.href);
    if (month) {
      url.searchParams.set("month", month);
    } else {
      url.searchParams.delete("month");
    }
    window.history.replaceState({}, "", url);
  }

  function applyMonth(month, shouldUpdateUrl) {
    var activeMonth = month || getDefaultMonth();
    var sections = Array.prototype.slice.call(document.querySelectorAll(".diary-month-section"));
    var hasActiveMonth = sections.some(function (section) {
      return section.getAttribute("data-month") === activeMonth;
    });

    if (!hasActiveMonth) {
      activeMonth = getDefaultMonth();
    }

    sections.forEach(function (section) {
      section.hidden = section.getAttribute("data-month") !== activeMonth;
    });

    monthLinks.forEach(function (link) {
      link.classList.toggle("current", link.getAttribute("data-month-link") === activeMonth);
    });

    if (shouldUpdateUrl) {
      setUrlMonth(activeMonth);
    }
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

    var currentMonth = "";

    list.innerHTML = items.map(function (post) {
      var image = post.image
        ? '<img class="diary-entry-image" src="' + escapeHtml(post.image) + '" alt="' + escapeHtml(post.imageAlt || post.date) + '">'
        : "";
      var month = post.month || "";
      var monthLabel = post.monthLabel || month.replace("-", ".");
      var monthHeading = "";

      if (month !== currentMonth) {
        currentMonth = month;
        monthHeading = '<h2 class="diary-month search-month">' + escapeHtml(monthLabel) + '</h2>';
      }

      return (
        monthHeading +
        '<article class="diary-item">' +
          '<div class="diary-item-inner">' +
            image +
            '<div class="diary-item-body">' +
              '<strong><time>' + escapeHtml(post.date) + '</time></strong>' +
              '<span>' + escapeHtml(post.excerpt || "") + '</span>' +
            '</div>' +
          '</div>' +
        '</article>'
      );
    }).join("");
    status.textContent = "検索結果 " + items.length + "件";
  }

  function search() {
    var query = normalize(input.value);

    if (!query) {
      list.innerHTML = originalListHtml;
      status.textContent = "";
      applyMonth(getMonthFromUrl(), false);
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
      applyMonth(getMonthFromUrl(), false);

      if (monthJump && monthNav) {
        monthJump.addEventListener("click", function (event) {
          event.preventDefault();
          monthNav.scrollIntoView({ block: "start" });
          window.history.replaceState({}, "", "#diary-month-links");
        });
      }

      monthLinks.forEach(function (link) {
        link.addEventListener("click", function (event) {
          event.preventDefault();
          input.value = "";
          list.innerHTML = originalListHtml;
          applyMonth(link.getAttribute("data-month-link"), true);
        });
      });
    })
    .catch(function () {
      status.textContent = "検索インデックスを読み込めませんでした。";
      input.disabled = true;
    });
})();
