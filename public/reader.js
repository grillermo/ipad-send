(function () {
  var RETRY_MIN_MS = 1000;
  var RETRY_MAX_MS = 10000;
  // Server holds polls for 25s; if nothing comes back in 35s the XHR is hung (screen lock).
  var POLL_WATCHDOG_MS = 35000;
  var THEMES = ['light', 'sepia', 'dark'];
  var LOADING_HTML = '<p class="empty">Loading&hellip;</p>';
  var ERROR_HTML = '<p class="empty">Could not load this document.</p>';
  var EMPTY_HTML = '<p class="empty">Waiting for documents&hellip;</p>';

  var version = -1;
  var shownId = null;
  var pollXhr = null;
  var pollGeneration = 0;
  var pollWatchdog = null;
  var retryDelay = RETRY_MIN_MS;
  var saveScrollTimer = null;
  var docXhr = null;
  var docAttempt = 0;
  var docWatchdog = null;
  var DOC_RETRY_MIN_MS = 2000;
  var DOC_RETRY_MAX_MS = 10000;
  var docRetryDelay = DOC_RETRY_MIN_MS;
  var stateGeneration = 0;
  var DOC_WATCHDOG_MS = 20000;
  // Placed by the server on the block that was at the top of Chrome's window when sent.
  var ANCHOR_ID = 'ipad-send-continue';
  var ANCHOR_MARGIN_PX = 16;
  // Autoscroll moves 1px per tick, so the interval sets the speed. 70ms on the iPad 1 matches 60ms on an
  // iPhone 16e, whose CSS pixels are about 17% smaller. No requestAnimationFrame on iOS 5.
  var SCROLL_INTERVAL_MS = 70;
  var SCROLL_MIN_MS = 20;
  var SCROLL_MAX_MS = 250;
  var SCROLL_STEP = 1.6;
  var autoscrollTimer = null;
  // Markdown documents get a fixed index bar at the top. iOS 5 has no position: sticky.
  var TOC_BAR_PX = 40;
  var tocHeadings = [];
  var tocCurrent = -1;
  var tocTimer = null;
  var touching = false;

  function $(id) { return document.getElementById(id); }

  function request(method, url, body, onSuccess, onError) {
    var xhr = new XMLHttpRequest();
    var separator = url.indexOf('?') === -1 ? '?' : '&';
    xhr.open(method, url + separator + '_=' + new Date().getTime(), true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status >= 200 && xhr.status < 300) onSuccess(xhr.responseText);
      else if (onError) onError(xhr.status);
    };
    if (body) {
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify(body));
    } else {
      xhr.send(null);
    }
    return xhr;
  }

  // localStorage throws in Private Browsing on iOS 5.
  function getPref(key, fallback) {
    var value = null;
    try { value = localStorage.getItem(key); } catch (e) {}
    return value === null ? fallback : value;
  }

  function setPref(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }

  function applyPrefs() {
    document.documentElement.className = getPref('theme', 'light');
    $('article').style.fontSize = getPref('fontSize', '20') + 'px';
  }

  function changeFontSize(delta) {
    var size = parseInt(getPref('fontSize', '20'), 10) + delta;
    setPref('fontSize', String(Math.max(14, Math.min(36, size))));
    applyPrefs();
  }

  function cycleTheme() {
    var index = THEMES.indexOf(getPref('theme', 'light'));
    setPref('theme', THEMES[(index + 1) % THEMES.length]);
    applyPrefs();
  }

  function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function safeUrl(url) {
    return /^https?:\/\//i.test(url || '') ? url : '#';
  }

  function hostOf(url) {
    var match = /^https?:\/\/([^\/]+)/.exec(url || '');
    return match ? match[1] : 'original';
  }

  function header(doc) {
    var html = '<h1>' + escapeHtml(doc.title || doc.url) + '</h1><p class="meta">';
    if (doc.raw) html += '<span class="raw">raw page</span> ';
    if (doc.byline) html += escapeHtml(doc.byline) + ' &middot; ';
    return html + '<a href="' + escapeHtml(safeUrl(doc.url)) + '" target="_blank" rel="noopener">' + escapeHtml(hostOf(doc.url)) + '</a></p>';
  }

  function show(id, display) { $(id).style.display = display ? 'inline-block' : 'none'; }

  function scrollInterval() {
    return parseInt(getPref('scrollInterval', String(SCROLL_INTERVAL_MS)), 10) || SCROLL_INTERVAL_MS;
  }

  function changeScrollSpeed(faster) {
    var interval = faster ? scrollInterval() / SCROLL_STEP : scrollInterval() * SCROLL_STEP;
    setPref('scrollInterval', String(Math.round(Math.max(SCROLL_MIN_MS, Math.min(SCROLL_MAX_MS, interval)))));
  }

  function tick() {
    var before = window.pageYOffset;
    // Hold still while a finger is down so dragging by hand doesn't fight the timer.
    if (!touching) {
      window.scrollBy(0, 1);
      if (window.pageYOffset === before) { stopAutoscroll(); return; } // reached the end
    }
    autoscrollTimer = setTimeout(tick, scrollInterval());
  }

  function startAutoscroll() {
    if (autoscrollTimer || !shownId) return;
    $('autoscroll').className = 'on';
    show('slower', true);
    show('faster', true);
    autoscrollTimer = setTimeout(tick, scrollInterval());
  }

  function stopAutoscroll() {
    clearTimeout(autoscrollTimer);
    autoscrollTimer = null;
    $('autoscroll').className = '';
    show('slower', false);
    show('faster', false);
  }

  var pinnedDocs = [];

  function isPinned(id) {
    for (var i = 0; i < pinnedDocs.length; i++) if (pinnedDocs[i].id === id) return true;
    return false;
  }

  function renderPinned() {
    var pin = $('pin');
    var pinned = !!shownId && isPinned(shownId);
    show('pin', !!shownId);
    pin.textContent = pinned ? 'Pinned' : 'Pin';
    pin.className = pinned ? 'on' : '';
    show('pinned-toggle', pinnedDocs.length > 0);
    var html = '';
    for (var i = 0; i < pinnedDocs.length; i++) {
      var d = pinnedDocs[i];
      html += '<div class="pinned-row' + (d.id === shownId ? ' current' : '') + '">' +
        '<a class="pinned-open" href="#" data-open="' + escapeHtml(d.id) + '">' + escapeHtml(d.title || d.url) + '</a>' +
        '<a class="pinned-unpin" href="#" data-unpin="' + escapeHtml(d.id) + '">&#9733;</a></div>';
    }
    $('pinned-list').innerHTML = html;
    if (!pinnedDocs.length) $('pinned-list').style.display = 'none';
  }

  function render(state) {
    var doc = state.current;
    show('previous', state.hasPrevious);
    show('next', state.hasNext);
    pinnedDocs = state.pinned || [];

    var currentId = doc ? doc.id : null;
    if (currentId === shownId) { renderPinned(); return; }
    shownId = currentId;
    renderPinned();
    stopAutoscroll();
    $('doctitle').textContent = doc ? doc.title || doc.url : '';

    if (!doc) {
      $('article').innerHTML = EMPTY_HTML;
      buildToc();
      document.title = 'iPad Send';
      window.scrollTo(0, 0);
      return;
    }

    // Never show the previous body under the new id.
    $('article').innerHTML = LOADING_HTML;
    buildToc();
    docRetryDelay = DOC_RETRY_MIN_MS;
    loadDoc(doc);
  }

  function loadDoc(doc) {
    var attempt = ++docAttempt;
    clearTimeout(docWatchdog);
    if (docXhr) docXhr.abort();

    function retry(status) {
      if (attempt !== docAttempt || shownId !== doc.id) return; // superseded or navigated away
      clearTimeout(docWatchdog);
      if (status >= 400 && status < 500) { // terminal, e.g. 404 for an evicted doc
        $('article').innerHTML = ERROR_HTML;
        return;
      }
      var delay = docRetryDelay;
      docRetryDelay = Math.min(docRetryDelay * 2, DOC_RETRY_MAX_MS);
      setTimeout(function () {
        if (attempt === docAttempt && shownId === doc.id) loadDoc(doc);
      }, delay);
    }

    // xhr.timeout is unreliable on iOS 5, so abort hung requests ourselves.
    docWatchdog = setTimeout(function () {
      if (attempt !== docAttempt || shownId !== doc.id) return;
      loadDoc(doc);
    }, DOC_WATCHDOG_MS);

    docXhr = request('GET', '/api/doc/' + doc.id, null, function (html) {
      if (attempt !== docAttempt || shownId !== doc.id) return;
      clearTimeout(docWatchdog);
      docRetryDelay = DOC_RETRY_MIN_MS;
      $('article').innerHTML = header(doc) + html;
      buildToc();
      document.title = doc.title || 'iPad Send';
      var saved = getPref('pos:' + doc.id, null);
      if (saved === null) followAnchor(doc.id);
      else window.scrollTo(0, parseInt(saved, 10));
    }, retry);
  }

  function pageTop(el) {
    var top = 0;
    for (; el; el = el.offsetParent) top += el.offsetTop;
    return top;
  }

  // Images above the anchor have no size until they load and push it down, so jump again after each
  // one, until the reader scrolls by hand.
  function followAnchor(id) {
    var anchor = $(ANCHOR_ID);
    var images = $('article').getElementsByTagName('img');
    var landedAt = null;
    var i;

    function jump() {
      if (shownId !== id) return;
      if (landedAt !== null && window.pageYOffset !== landedAt) return;
      window.scrollTo(0, anchor ? Math.max(0, pageTop(anchor) - topMargin()) : 0);
      landedAt = window.pageYOffset; // the page may still be too short to reach the anchor
    }

    jump();
    if (!anchor) return;
    for (i = 0; i < images.length; i++) {
      if (!images[i].complete) images[i].onload = images[i].onerror = jump;
    }
  }

  // Room above a block so it lands below the index bar, when there is one.
  function topMargin() {
    return ANCHOR_MARGIN_PX + (tocHeadings.length ? TOC_BAR_PX : 0);
  }

  function buildToc() {
    var headings = $('article').querySelectorAll('.md h1, .md h2, .md h3');
    var minLevel = 3;
    var html = '';
    var i;
    tocHeadings = [];
    tocCurrent = -1;
    for (i = 0; i < headings.length; i++) {
      tocHeadings.push(headings[i]);
      minLevel = Math.min(minLevel, parseInt(headings[i].tagName.charAt(1), 10));
    }
    for (i = 0; i < tocHeadings.length; i++) {
      html += '<a href="#" data-toc="' + i + '" class="toc-l' + (parseInt(tocHeadings[i].tagName.charAt(1), 10) - minLevel) +
        '">' + escapeHtml(tocHeadings[i].textContent) + '</a>';
    }
    $('toc-list').innerHTML = html;
    $('toc-list').style.display = 'none';
    document.body.className = tocHeadings.length ? 'has-toc' : '';
    updateTocCurrent();
  }

  // The section being read is the last heading at or above the bar's bottom edge.
  function updateTocCurrent() {
    var limit = window.pageYOffset + topMargin() + 1;
    var current = -1;
    var items = $('toc-list').getElementsByTagName('a');
    for (var i = 0; i < tocHeadings.length && pageTop(tocHeadings[i]) <= limit; i++) current = i;
    if (current === tocCurrent) return;
    if (items[tocCurrent]) items[tocCurrent].className = items[tocCurrent].className.replace(' current', '');
    if (items[current]) items[current].className += ' current';
    tocCurrent = current;
    $('toc-current').textContent = current === -1 ? 'Contents' : tocHeadings[current].textContent;
  }

  function toggleToc() {
    var list = $('toc-list');
    var current = list.getElementsByTagName('a')[tocCurrent];
    if (list.style.display === 'block') { list.style.display = 'none'; return; }
    updateTocCurrent();
    list.style.maxHeight = Math.max(120, window.innerHeight - TOC_BAR_PX - 64) + 'px';
    list.style.display = 'block';
    list.scrollTop = current ? Math.max(0, current.offsetTop - 80) : 0;
  }

  function jumpToSection(event) {
    var target = event.target;
    // Old Safari can report the text node itself as the target.
    while (target && target !== this && (target.nodeType !== 1 || !target.getAttribute('data-toc'))) target = target.parentNode;
    if (!target || target === this) return false;
    var heading = tocHeadings[parseInt(target.getAttribute('data-toc'), 10)];
    $('toc-list').style.display = 'none';
    if (heading) window.scrollTo(0, Math.max(0, pageTop(heading) - topMargin()));
    updateTocCurrent();
    return false;
  }

  function refreshState() {
    var generation = ++stateGeneration;

    function again() {
      setTimeout(function () {
        if (generation === stateGeneration) attempt();
      }, 2000);
    }

    function attempt() {
      request('GET', '/api/state', null, function (text) {
        if (generation !== stateGeneration) return;
        var state;
        try { state = JSON.parse(text); } catch (e) { again(); return; }
        version = state.version;
        render(state);
      }, function () {
        if (generation === stateGeneration) again();
      });
    }

    attempt();
  }

  function setOnline(online) { $('status').className = online ? '' : 'offline'; }

  function poll() {
    var generation = ++pollGeneration;
    clearTimeout(pollWatchdog);
    if (pollXhr) pollXhr.abort();

    pollWatchdog = setTimeout(function () {
      if (generation === pollGeneration) poll();
    }, POLL_WATCHDOG_MS);

    pollXhr = request('GET', '/api/wait?since=' + version, null, function (text) {
      if (generation !== pollGeneration) return;
      var latest;
      try { latest = JSON.parse(text).version; } catch (e) { pollFailed(); return; }
      setOnline(true);
      retryDelay = RETRY_MIN_MS;
      if (latest !== version) {
        version = latest; // set now so the next poll waits instead of returning immediately
        refreshState();
      }
      poll();
    }, pollFailed);

    function pollFailed() {
      if (generation !== pollGeneration) return; // aborted by a newer poll
      setOnline(false);
      clearTimeout(pollWatchdog);
      setTimeout(function () {
        if (generation === pollGeneration) poll();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    }
  }

  function post(url, body) {
    request('POST', url, body, function (text) {
      var state;
      try { state = JSON.parse(text); } catch (e) { refreshState(); return; }
      version = state.version;
      stateGeneration++; // fresh state supersedes any in-flight refresh chain
      render(state);
    });
  }

  function go(step) {
    if (!shownId) return;
    post('/api/go', { from: shownId, step: step });
  }

  function pinnedTap(event) {
    var target = event.target;
    while (target && target !== this && (target.nodeType !== 1 || !(target.getAttribute('data-open') || target.getAttribute('data-unpin')))) target = target.parentNode;
    if (!target || target === this) return false;
    var unpin = target.getAttribute('data-unpin');
    if (unpin) {
      post('/api/pin', { id: unpin, pinned: false });
    } else {
      $('pinned-list').style.display = 'none';
      post('/api/open', { id: target.getAttribute('data-open') });
    }
    return false;
  }

  function onTap(id, handler) {
    $(id).onclick = function () { handler(); return false; };
  }

  onTap('menu-toggle', function () {
    var menu = $('menu');
    menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
  });
  onTap('pin', function () { if (shownId) post('/api/pin', { id: shownId, pinned: !isPinned(shownId) }); });
  onTap('pinned-toggle', function () {
    var list = $('pinned-list');
    list.style.display = list.style.display === 'block' ? 'none' : 'block';
  });
  $('pinned-list').onclick = pinnedTap;
  onTap('smaller', function () { changeFontSize(-2); });
  onTap('bigger', function () { changeFontSize(2); });
  onTap('theme', cycleTheme);
  onTap('previous', function () { go(-1); });
  onTap('next', function () { go(1); });
  onTap('autoscroll', function () { if (autoscrollTimer) stopAutoscroll(); else startAutoscroll(); });
  onTap('toc-toggle', toggleToc);
  $('toc-list').onclick = jumpToSection;
  onTap('slower', function () { changeScrollSpeed(false); });
  onTap('faster', function () { changeScrollSpeed(true); });

  // Light the speed buttons on touchstart: click arrives ~300ms later on iOS, and :active is unreliable.
  function pressFeedback(id) {
    var el = $(id);
    function release() { setTimeout(function () { el.className = ''; }, 150); }
    el.addEventListener('touchstart', function () { el.className = 'pressed'; }, false);
    el.addEventListener('touchend', release, false);
    el.addEventListener('touchcancel', release, false);
  }

  pressFeedback('slower');
  pressFeedback('faster');

  document.addEventListener('touchstart', function () { touching = true; }, false);
  document.addEventListener('touchend', function () { touching = false; }, false);
  document.addEventListener('touchcancel', function () { touching = false; }, false);

  // Debounced, except during autoscroll: its scroll events never stop, so a debounce would never save.
  window.addEventListener('scroll', function () {
    // Throttled, since autoscroll fires a scroll event every tick.
    if (tocHeadings.length && !tocTimer) {
      tocTimer = setTimeout(function () { tocTimer = null; updateTocCurrent(); }, 200);
    }
    var id = shownId;
    if (!id) return;
    if (autoscrollTimer && saveScrollTimer) return;
    clearTimeout(saveScrollTimer);
    saveScrollTimer = setTimeout(function () {
      saveScrollTimer = null;
      setPref('pos:' + id, String(window.pageYOffset));
    }, 300);
  }, false);

  // Safari kills or hangs XHRs while the screen is locked; restart polling when we come back.
  window.addEventListener('pageshow', poll, false);
  window.addEventListener('focus', poll, false);

  applyPrefs();
  poll();
})();
