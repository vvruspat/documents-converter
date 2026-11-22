// Keep this small, dependency-free and compatible with browsers that cannot parse the app bundle.
(function () {
  try {
    var theme = localStorage.getItem('docs.theme');
    document.documentElement.dataset.theme = theme === 'dark' || theme === 'light' ? theme :
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } catch (ignored) { /* Storage can be disabled by the browser. */ }
  function showFailure(code) {
    if (!document.getElementById('startup')) return;
    document.getElementById('startup-status').textContent = 'Не удалось загрузить приложение.';
    document.getElementById('startup-help').hidden = false;
    var details = document.getElementById('startup-code');
    details.hidden = false;
    details.textContent = 'Код: ' + code;
  }
  window.addEventListener('error', function (event) {
    var target = event.target;
    if (target && (target.tagName === 'SCRIPT' || target.tagName === 'LINK')) showFailure('asset-load');
    else showFailure('app-start');
  }, true);
  window.addEventListener('unhandledrejection', function () { showFailure('app-start'); });
  window.setTimeout(function () { showFailure('startup-timeout'); }, 15000);
}());
