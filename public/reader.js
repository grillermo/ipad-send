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
  var SCROLL_STEP = 1.25;
  var autoscrollTimer = null;
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

  function render(state) {
    var doc = state.current;
    show('previous', state.hasPrevious);
    show('next', state.hasNext);

    var currentId = doc ? doc.id : null;
    if (currentId === shownId) return;
    shownId = currentId;
    stopAutoscroll();

    if (!doc) {
      $('article').innerHTML = EMPTY_HTML;
      show('original', false);
      document.title = 'iPad Send';
      window.scrollTo(0, 0);
      return;
    }

    // Never show the previous body under the new id.
    $('article').innerHTML = LOADING_HTML;
    show('original', false);
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
      if (safeUrl(doc.url) === '#') {
        show('original', false);
      } else {
        $('original').href = doc.url;
        show('original', true);
      }
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
      window.scrollTo(0, anchor ? Math.max(0, pageTop(anchor) - ANCHOR_MARGIN_PX) : 0);
      landedAt = window.pageYOffset; // the page may still be too short to reach the anchor
    }

    jump();
    if (!anchor) return;
    for (i = 0; i < images.length; i++) {
      if (!images[i].complete) images[i].onload = images[i].onerror = jump;
    }
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

  function go(step) {
    if (!shownId) return;
    request('POST', '/api/go', { from: shownId, step: step }, function (text) {
      var state;
      try { state = JSON.parse(text); } catch (e) { refreshState(); return; }
      version = state.version;
      stateGeneration++; // fresh state supersedes any in-flight refresh chain
      render(state);
    });
  }

  function onTap(id, handler) {
    $(id).onclick = function () { handler(); return false; };
  }

  onTap('smaller', function () { changeFontSize(-2); });
  onTap('bigger', function () { changeFontSize(2); });
  onTap('theme', cycleTheme);
  onTap('previous', function () { go(-1); });
  onTap('next', function () { go(1); });
  onTap('autoscroll', function () { if (autoscrollTimer) stopAutoscroll(); else startAutoscroll(); });
  onTap('slower', function () { changeScrollSpeed(false); });
  onTap('faster', function () { changeScrollSpeed(true); });

  document.addEventListener('touchstart', function () { touching = true; }, false);
  document.addEventListener('touchend', function () { touching = false; }, false);
  document.addEventListener('touchcancel', function () { touching = false; }, false);

  // Debounced, except during autoscroll: its scroll events never stop, so a debounce would never save.
  window.addEventListener('scroll', function () {
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
