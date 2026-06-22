/* GitManager landing — progressive enhancement only.
   The page is fully usable with JS disabled; this adds the theme
   toggle, copy-to-clipboard buttons, and a subtle scroll reveal. */
(function () {
  'use strict';

  // The reveal-on-scroll effect hides `.reveal` elements via the `js` class.
  // Add it here (not in the inline <head> script) so that if this file ever
  // fails to load, nothing stays hidden — content degrades to fully visible.
  document.documentElement.classList.add('js');

  /* ---- Theme toggle (persisted; initial theme set inline in <head>) ---- */
  var toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('gm-theme', next); } catch (e) {}
    });
  }

  /* ---- Copy buttons on code blocks ---- */
  document.querySelectorAll('.code').forEach(function (block) {
    var btn = block.querySelector('.copy');
    var code = block.querySelector('code');
    if (!btn || !code) return;
    btn.addEventListener('click', function () {
      var text = code.textContent;
      var done = function () {
        var prev = btn.textContent;
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(function () { btn.textContent = prev; btn.classList.remove('copied'); }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () {});
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (e) {}
        document.body.removeChild(ta);
      }
    });
  });

  /* ---- Hero showcase: spotlight one panel, dim the others ---- */
  var showcase = document.querySelector('.showcase');
  if (showcase) {
    var panels = Array.prototype.slice.call(showcase.querySelectorAll('.showcase__panel'));
    var pick = function (panel) {
      panels.forEach(function (p) { p.setAttribute('aria-pressed', String(p === panel)); });
    };
    panels.forEach(function (panel, i) {
      panel.addEventListener('click', function () { pick(panel); });
      panel.addEventListener('keydown', function (e) {
        var dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
                : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!dir) return;
        e.preventDefault();
        var next = panels[(i + dir + panels.length) % panels.length];
        pick(next);
        next.focus();
      });
    });
  }

  /* ---- Scroll reveal (skipped when motion is reduced) ---- */
  var reveals = document.querySelectorAll('.reveal');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('is-visible'); });
  }
})();
