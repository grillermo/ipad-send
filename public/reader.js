(function () {
  var RETRY_MIN_MS = 1000;
  var RETRY_MAX_MS = 10000;
  // Server holds polls for 25s; if nothing comes back in 35s the XHR is hung (screen lock).
  var POLL_WATCHDOG_MS = 35000;
  var THEMES = ['light', 'sepia', 'dark'];
  var EMPTY_HTML = '<p class="empty">Waiting for documents&hellip;</p>';

  var version = -1;
  var shownId = null;
  var pollXhr = null;
  var pollGeneration = 0;
  var pollWatchdog = null;
  var retryDelay = RETRY_MIN_MS;
  var saveScrollTimer = null;

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

  function hostOf(url) {
    var match = /^https?:\/\/([^\/]+)/.exec(url || '');
    return match ? match[1] : 'original';
  }

  function header(doc) {
    var html = '<h1>' + escapeHtml(doc.title || doc.url) + '</h1><p class="meta">';
    if (doc.raw) html += '<span class="raw">raw page</span> ';
    if (doc.byline) html += escapeHtml(doc.byline) + ' &middot; ';
    return html + '<a href="' + escapeHtml(doc.url) + '" target="_blank">' + escapeHtml(hostOf(doc.url)) + '</a></p>';
  }

  function show(id, display) { $(id).style.display = display ? 'inline-block' : 'none'; }

  function render(state) {
    var doc = state.current;
    $('next').innerHTML = state.queued + ' queued &rsaquo;';
    show('next', state.queued > 0);
    show('done', doc && state.queued === 0);

    var currentId = doc ? doc.id : null;
    if (currentId === shownId) return;
    shownId = currentId;

    if (!doc) {
      $('article').innerHTML = EMPTY_HTML;
      show('original', false);
      document.title = 'iPad Send';
      window.scrollTo(0, 0);
      return;
    }

    request('GET', '/api/doc/' + doc.id, null, function (html) {
      if (shownId !== doc.id) return;
      $('article').innerHTML = header(doc) + html;
      $('original').href = doc.url;
      show('original', true);
      document.title = doc.title || 'iPad Send';
      window.scrollTo(0, parseInt(getPref('pos:' + doc.id, '0'), 10));
    }, function () {
      shownId = null; // let the next state refresh retry
    });
  }

  function refreshState() {
    request('GET', '/api/state', null, function (text) {
      var state = JSON.parse(text);
      version = state.version;
      render(state);
    }, function () {
      setTimeout(refreshState, 2000);
    });
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
      setOnline(true);
      retryDelay = RETRY_MIN_MS;
      var latest = JSON.parse(text).version;
      if (latest !== version) {
        version = latest; // set now so the next poll waits instead of returning immediately
        refreshState();
      }
      poll();
    }, function () {
      if (generation !== pollGeneration) return; // aborted by a newer poll
      setOnline(false);
      clearTimeout(pollWatchdog);
      setTimeout(function () {
        if (generation === pollGeneration) poll();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    });
  }

  function advance() {
    if (!shownId) return;
    request('POST', '/api/advance', { from: shownId }, function (text) {
      var state = JSON.parse(text);
      version = state.version;
      render(state);
    });
  }

  function onTap(id, handler) {
    $(id).onclick = function () { handler(); return false; };
  }

  onTap('smaller', function () { changeFontSize(-2); });
  onTap('bigger', function () { changeFontSize(2); });
  onTap('theme', cycleTheme);
  onTap('next', advance);
  onTap('done', advance);

  window.addEventListener('scroll', function () {
    var id = shownId;
    if (!id) return;
    clearTimeout(saveScrollTimer);
    saveScrollTimer = setTimeout(function () { setPref('pos:' + id, String(window.pageYOffset)); }, 300);
  }, false);

  // Safari kills or hangs XHRs while the screen is locked; restart polling when we come back.
  window.addEventListener('pageshow', poll, false);
  window.addEventListener('focus', poll, false);

  applyPrefs();
  poll();
})();
