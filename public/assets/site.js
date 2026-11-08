/* GCS Ware site script: one file for every page, loaded with `defer`.
   Everything here is progressive enhancement. Without JavaScript the pages still read in full, every
   "Get access" link scrolls to #pricing and the demo poster opens YouTube.

   Motion follows Apple's fluid-interface rules: things answer on pointer-down, drags track the finger
   1:1, releases hand their velocity to a spring, springs start from the value on screen (so any motion
   can be grabbed and reversed), and reduced-motion users get short cross-fades instead. */
(() => {
  'use strict';

  const doc = document.documentElement;
  const LANG = (doc.lang || 'en').toLowerCase().startsWith('pl') ? 'pl' : 'en';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const phoneSheet = window.matchMedia('(max-width: 759px)');
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const CONFIG = {
    // Sale countdown: change SALE_ENDS to move the deadline (the visitor's local time). Everything marked
    // data-sale stays hidden unless the sale is running, so crawlers and visitors after the deadline never
    // see a timer stuck at zero.
    SALE_ENDS: '2026-10-31T23:59:00',
    // Both are answered by src/worker.js, which passes them on to the store at gcscheats.com (no CORS there).
    PAYMENT_API: '/api/payment',
    RECENT_ORDERS_API: '/api/recent-orders',
    // Store product ids: 1 day 13203, 1 week 13202, 1 month 13201.
    PLANS: { day: 13203, week: 13202, month: 13201 }
  };

  const TEXT = {
    en: {
      loading: 'Opening secure checkout…',
      error: "Couldn't open the checkout. Please try again or message us on Discord.",
      menuOpen: 'Open menu',
      menuClose: 'Close menu',
      toast: { 13203: 'Someone bought the Day pass', 13202: 'Someone bought the Week pass', 13201: 'Someone bought the Month plan' },
      ago: (m) => (m < 60 ? m + ' min ago' : m < 1440 ? Math.floor(m / 60) + ' h ago' : Math.floor(m / 1440) === 1 ? '1 day ago' : Math.floor(m / 1440) + ' days ago')
    },
    pl: {
      loading: 'Otwieram bezpieczną płatność…',
      error: 'Nie udało się otworzyć płatności. Spróbuj ponownie albo napisz do nas na Discordzie.',
      menuOpen: 'Otwórz menu',
      menuClose: 'Zamknij menu',
      toast: { 13203: 'Ktoś kupił dostęp na dzień', 13202: 'Ktoś kupił dostęp na tydzień', 13201: 'Ktoś kupił dostęp na miesiąc' },
      ago: (m) => (m < 60 ? m + ' min temu' : m < 1440 ? Math.floor(m / 60) + ' godz. temu' : Math.floor(m / 1440) === 1 ? '1 dzień temu' : Math.floor(m / 1440) + ' dni temu')
    }
  }[LANG];

  /* ------------------------------------------------------------------------
     Physics helpers
     ------------------------------------------------------------------------ */

  // Apple-style spring: damping ratio (1 = no overshoot) and response (seconds, not a duration).
  // Starts from `from` with `velocity` (units per second), so a release hands its speed straight in.
  function spring({ from, to, velocity = 0, damping = 1, response = 0.4, precision = 0.01, onUpdate, onDone }) {
    const stiffness = (2 * Math.PI / response) ** 2;
    const friction = (4 * Math.PI * damping) / response;
    let x = from;
    let v = velocity;
    let last = 0;
    let raf = 0;
    let stopped = false;
    const step = (now) => {
      if (stopped) return;
      const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
      last = now;
      const n = 8;
      const h = dt / n;
      for (let i = 0; i < n; i++) {
        v += (-stiffness * (x - to) - friction * v) * h;
        x += v * h;
      }
      if (Math.abs(v) < precision * 10 && Math.abs(x - to) < precision) {
        x = to;
        v = 0;
        onUpdate(x);
        if (onDone) onDone();
        return;
      }
      onUpdate(x);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return {
      stop() { stopped = true; cancelAnimationFrame(raf); },
      get value() { return x; },
      get velocity() { return v; }
    };
  }

  // Short tween for reduced motion (opacity cross-fades instead of travel).
  function tween({ from, to, duration = 200, onUpdate, onDone }) {
    let raf = 0;
    let stopped = false;
    let x = from;
    const start = performance.now();
    const step = (now) => {
      if (stopped) return;
      const t = Math.min(1, (now - start) / duration);
      x = from + (to - from) * t;
      onUpdate(x);
      if (t < 1) raf = requestAnimationFrame(step);
      else if (onDone) onDone();
    };
    raf = requestAnimationFrame(step);
    return { stop() { stopped = true; cancelAnimationFrame(raf); }, get value() { return x; }, get velocity() { return 0; } };
  }

  // Past a boundary, follow less and less: real things slow before they stop.
  const rubberband = (overshoot, dimension, constant = 0.55) =>
    (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));

  // Where a flick would come to rest (Apple's projection, decelerationRate 0.998).
  const project = (velocity, rate = 0.998) => ((velocity / 1000) * rate) / (1 - rate);

  // Tracks the last ~100ms of pointer positions so a release knows its velocity (px/s).
  function velocityTracker() {
    let samples = [];
    return {
      reset() { samples = []; },
      add(value) {
        const t = performance.now();
        samples.push({ t, value });
        while (samples.length > 2 && t - samples[0].t > 100) samples.shift();
      },
      get() {
        if (samples.length < 2) return 0;
        const a = samples[0];
        const b = samples[samples.length - 1];
        const dt = (b.t - a.t) / 1000;
        return dt > 0 ? (b.value - a.value) / dt : 0;
      }
    };
  }

  // A tiny tap on phones that support it (Android). Only for commits: a plan picked, a sheet dismissed.
  function haptic(ms = 8) {
    if (reduceMotion.matches || !('vibrate' in navigator)) return;
    try { navigator.vibrate(ms); } catch (e) { /* not allowed yet */ }
  }

  /* ------------------------------------------------------------------------
     Header: scroll edge effect, current-section highlight, mobile menu
     ------------------------------------------------------------------------ */
  const header = $('.site-header');
  if (header) {
    let ticking = false;
    const update = () => {
      header.classList.toggle('is-scrolled', window.scrollY > 4);
      ticking = false;
    };
    window.addEventListener('scroll', () => {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
    update();

    // Wayfinding: the nav link for the section in the middle of the screen is marked current.
    const links = $$('.nav-links a[href^="#"]');
    const sections = links.map((a) => document.getElementById(a.hash.slice(1))).filter(Boolean);
    if (sections.length && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          links.forEach((a) => {
            if (a.hash === '#' + entry.target.id) a.setAttribute('aria-current', 'true');
            else a.removeAttribute('aria-current');
          });
        });
      }, { rootMargin: '-45% 0px -50% 0px' });
      sections.forEach((s) => io.observe(s));
    }

    const toggle = $('.nav-toggle', header);
    const menu = $('.mobile-menu', header);
    if (toggle && menu) {
      const setOpen = (open) => {
        toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', open ? TEXT.menuClose : TEXT.menuOpen);
        menu.classList.toggle('is-open', open);
        menu.inert = !open;
      };
      menu.inert = true;
      toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
      menu.addEventListener('click', (e) => { if (e.target.closest('a, [data-buy]')) setOpen(false); });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && menu.classList.contains('is-open')) { setOpen(false); toggle.focus(); }
      });
      document.addEventListener('pointerdown', (e) => {
        if (menu.classList.contains('is-open') && !header.contains(e.target)) setOpen(false);
      });
      window.matchMedia('(min-width: 901px)').addEventListener('change', (e) => { if (e.matches) setOpen(false); });
    }
  }

  /* ------------------------------------------------------------------------
     Sale countdown
     ------------------------------------------------------------------------ */
  (function countdown() {
    const end = new Date(CONFIG.SALE_ENDS).getTime();
    const digits = $$('[data-cd]');
    const sale = $$('[data-sale]');
    const pad = (n) => String(n).padStart(2, '0');
    function tick() {
      const left = Math.floor((end - Date.now()) / 1000);
      const live = left > 0; // false after the deadline, or if SALE_ENDS is not a valid date
      sale.forEach((el) => { el.hidden = !live; });
      doc.classList.toggle('has-salebar', live && !!$('.salebar'));
      if (!live) return false;
      const cd = {
        d: pad(Math.floor(left / 86400)),
        h: pad(Math.floor((left % 86400) / 3600)),
        m: pad(Math.floor((left % 3600) / 60)),
        s: pad(left % 60)
      };
      digits.forEach((el) => { el.textContent = cd[el.dataset.cd]; });
      return true;
    }
    if (sale.length && tick()) {
      const timer = setInterval(() => { if (!tick()) clearInterval(timer); }, 1000);
    }
  })();

  /* ------------------------------------------------------------------------
     Demo video: the real YouTube player is only loaded after a click, so the page never contacts
     Google until someone presses play. To swap the video, change the poster's link, length and
     thumbnail (save the new one from https://i.ytimg.com/vi_webp/<ID>/maxresdefault.webp).
     ------------------------------------------------------------------------ */
  $$('[data-video]').forEach((player) => {
    const poster = $('.video-poster', player);
    if (!poster) return;
    poster.addEventListener('click', (e) => {
      e.preventDefault();
      const f = document.createElement('iframe');
      f.src = 'https://www.youtube-nocookie.com/embed/' + new URL(poster.href).searchParams.get('v') + '?autoplay=1&rel=0&playsinline=1';
      f.title = poster.getAttribute('aria-label').replace(/^[^:]*:\s*/, '');
      f.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
      f.referrerPolicy = 'strict-origin-when-cross-origin';
      f.allowFullscreen = true;
      player.replaceChildren(f);
    });
  });

  /* ------------------------------------------------------------------------
     Checkout: POST the product id to /api/payment, then follow the Stripe payment_url it returns.
     ------------------------------------------------------------------------ */
  function setBusy(btn, busy) {
    if (busy) {
      btn.dataset.label = btn.innerHTML;
      btn.style.minWidth = btn.getBoundingClientRect().width + 'px';
      btn.setAttribute('aria-busy', 'true');
      btn.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>' + TEXT.loading + '</span>';
    } else {
      if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
      btn.removeAttribute('aria-busy');
      btn.style.minWidth = '';
    }
  }

  function errorFor(btn) {
    return btn.nextElementSibling && btn.nextElementSibling.classList.contains('pay-error') ? btn.nextElementSibling : null;
  }

  function showError(btn) {
    let msg = errorFor(btn);
    if (!msg) {
      msg = document.createElement('p');
      msg.className = 'pay-error';
      msg.setAttribute('role', 'alert');
      btn.insertAdjacentElement('afterend', msg);
    }
    msg.textContent = TEXT.error;
  }

  async function startCheckout(productId, btn) {
    if (btn.getAttribute('aria-busy') === 'true') return;
    const old = errorFor(btn);
    if (old) old.remove();
    setBusy(btn, true);
    try {
      const res = await fetch(CONFIG.PAYMENT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: Number(productId) })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success || !data.payment_url) throw new Error(data.message || 'HTTP ' + res.status);
      const url = new URL(data.payment_url, location.href);
      if (!/^https?:$/.test(url.protocol)) throw new Error('bad payment_url');
      window.location.href = url.href;
    } catch (err) {
      console.error('Checkout failed:', err);
      setBusy(btn, false);
      showError(btn);
    }
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-product]');
    if (!btn) return;
    e.preventDefault();
    startCheckout(btn.dataset.product, btn);
  });

  // Coming back from Stripe with the Back button restores the page as it was: un-stick the buttons.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) $$('[aria-busy="true"]').forEach((btn) => setBusy(btn, false));
  });

  /* ------------------------------------------------------------------------
     Checkout sheet. Any [data-buy] link opens it with that plan picked (data-buy="day|week|month").
     Phones: a bottom sheet. Grab the handle and drag; let go and it keeps your speed, projects where
     the flick would land and either settles open or slides away. Dragging up past the top resists.
     Larger screens: a centered panel that materializes. Esc, the scrim and the close button all work.
     ------------------------------------------------------------------------ */
  const sheet = (function buySheet() {
    const dialog = $('#buy');
    if (!dialog || typeof dialog.showModal !== 'function') return null;
    const panel = $('.buy-panel', dialog);
    const scrim = $('.buy-scrim', dialog);
    const form = $('form', dialog);
    const total = $('[data-total]', dialog);
    const submit = $('[type="submit"]', form);
    let progress = 0;          // 0 = closed, 1 = open
    let anim = null;
    let opener = null;
    let closing = false;
    let height = 0;

    function render(p) {
      progress = p;
      const visible = Math.max(0, Math.min(1, p));
      scrim.style.opacity = String(visible);
      if (reduceMotion.matches) {
        panel.style.transform = phoneSheet.matches ? 'none' : 'translateY(-50%)';
        panel.style.opacity = String(visible);
      } else if (phoneSheet.matches) {
        panel.style.opacity = '';
        let y = (1 - p) * height;
        if (y < 0) y = -rubberband(-y, height); // dragged above the top: resist
        panel.style.transform = 'translate3d(0,' + y.toFixed(2) + 'px,0)';
      } else {
        panel.style.opacity = String(visible);
        panel.style.transform = 'translateY(calc(-50% + ' + ((1 - p) * 28).toFixed(2) + 'px)) scale(' + (0.96 + 0.04 * visible).toFixed(4) + ')';
      }
    }

    function animateTo(target, velocity = 0, done) {
      if (anim) anim.stop();
      const opts = { from: progress, to: target, onUpdate: render, onDone: done };
      // Springs pick up from wherever the panel is right now, so opening mid-close (or the reverse) never jumps.
      anim = reduceMotion.matches
        ? tween({ ...opts, duration: 200 })
        : spring({ ...opts, velocity, damping: 1, response: phoneSheet.matches ? 0.38 : 0.34, precision: 0.0005 });
    }

    function select(plan) {
      const id = CONFIG.PLANS[plan] || CONFIG.PLANS.month;
      const input = $('input[value="' + id + '"]', form);
      if (input) { input.checked = true; syncTotal(); }
    }

    function syncTotal() {
      const checked = $('input:checked', form);
      if (checked && total) total.textContent = checked.dataset.price;
    }

    function open(plan, trigger) {
      opener = trigger || document.activeElement;
      select(plan);
      closing = false;
      if (!dialog.open) {
        dialog.showModal();
        doc.classList.add('sheet-open');
        height = panel.offsetHeight;
        render(progress); // start from where it is: 0 when fresh, mid-way if it was closing
      }
      height = panel.offsetHeight || height;
      animateTo(1);
      const checked = $('input:checked', form);
      if (checked) checked.focus({ preventScroll: true });
      document.dispatchEvent(new CustomEvent('sheet:toggle', { detail: true }));
    }

    function close(velocity = 0) {
      if (!dialog.open || closing) return;
      closing = true;
      animateTo(0, velocity, () => {
        dialog.close();
        doc.classList.remove('sheet-open');
        closing = false;
        if (opener && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
        document.dispatchEvent(new CustomEvent('sheet:toggle', { detail: false }));
      });
    }

    dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    dialog.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
    form.addEventListener('change', () => { syncTotal(); haptic(6); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const checked = $('input:checked', form);
      if (checked) startCheckout(checked.value, submit);
    });

    // Direct manipulation (phones): the handle and header follow the finger 1:1 from where it grabbed.
    const tracker = velocityTracker();
    let drag = null;
    function onDown(e) {
      if (!phoneSheet.matches || reduceMotion.matches || e.button > 0 || e.target.closest('button')) return;
      if (anim) anim.stop(); // catch it mid-flight
      height = panel.offsetHeight;
      drag = { id: e.pointerId, startY: e.clientY, startP: progress, el: e.currentTarget };
      tracker.reset();
      tracker.add(e.clientY);
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    function onMove(e) {
      if (!drag || e.pointerId !== drag.id) return;
      tracker.add(e.clientY);
      render(drag.startP - (e.clientY - drag.startY) / height);
    }
    function onUp(e) {
      if (!drag || e.pointerId !== drag.id) return;
      const v = tracker.get(); // px/s, positive = downward
      const y = (1 - progress) * height;
      const landing = y + project(v);
      drag = null;
      if (landing > height * 0.5) {
        haptic(10);
        close(-v / height);
      } else {
        animateTo(1, -v / height);
      }
    }
    $$('.buy-grab, .buy-head', dialog).forEach((el) => {
      el.addEventListener('pointerdown', onDown);
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    });

    phoneSheet.addEventListener('change', () => { if (dialog.open) { height = panel.offsetHeight; render(progress); } });
    window.addEventListener('pageshow', (e) => { if (e.persisted && dialog.open) render(1); });

    return { open, close, get isOpen() { return dialog.open && !closing; } };
  })();

  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-buy]');
    if (!trigger || !sheet) return; // without the sheet the link simply scrolls to #pricing
    e.preventDefault();
    sheet.open(trigger.dataset.buy, trigger);
  });

  /* ------------------------------------------------------------------------
     Live menu in the hero: weapon tabs load presets (sliders spring to the new values, mid-flight if
     you click fast), switches flip, sliders drag 1:1 and rubber-band past their ends.
     ------------------------------------------------------------------------ */
  (function liveMenu() {
    const menu = $('[data-live-menu]');
    if (!menu) return;

    const PRESETS = {
      pistols: { fov: 3.0, sx: 50, sy: 50, mp: 73 },
      heavy: { fov: 2.2, sx: 42, sy: 40, mp: 60 },
      smgs: { fov: 4.5, sx: 30, sy: 32, mp: 55 },
      rifles: { fov: 3.6, sx: 36, sy: 38, mp: 68 },
      snipers: { fov: 1.4, sx: 18, sy: 20, mp: 40 },
      shotguns: { fov: 6.0, sx: 25, sy: 25, mp: 80 },
      settings: { fov: 3.0, sx: 50, sy: 50, mp: 73 }
    };

    const sliders = {};
    $$('.gm-sl', menu).forEach((el) => {
      const s = {
        el,
        key: el.dataset.key,
        min: Number(el.getAttribute('aria-valuemin')),
        max: Number(el.getAttribute('aria-valuemax')),
        dec: Number(el.dataset.dec || 0),
        unit: el.dataset.unit || '',
        out: $('[data-out="' + el.dataset.key + '"]', menu),
        value: Number(el.getAttribute('aria-valuenow')),
        visual: 0,
        anim: null
      };
      s.visual = (s.value - s.min) / (s.max - s.min);
      sliders[s.key] = s;
      bindSlider(s);
    });

    function paint(s, visual) {
      s.visual = visual;
      s.el.style.setProperty('--p', visual.toFixed(4));
      const clamped = Math.max(0, Math.min(1, visual));
      const value = s.min + clamped * (s.max - s.min);
      const text = value.toFixed(s.dec) + s.unit;
      s.value = Number(value.toFixed(s.dec));
      if (s.out && s.out.textContent !== text) s.out.textContent = text;
      s.el.setAttribute('aria-valuenow', String(s.value));
      s.el.setAttribute('aria-valuetext', text);
    }

    function springTo(s, visual, velocity = 0, delay = 0) {
      if (s.anim) s.anim.stop();
      if (reduceMotion.matches) { paint(s, visual); return; }
      const run = () => {
        s.anim = spring({ from: s.visual, to: visual, velocity, damping: 1, response: 0.42, precision: 0.0005, onUpdate: (v) => paint(s, v) });
      };
      if (delay) {
        const t = setTimeout(run, delay);
        s.anim = { stop() { clearTimeout(t); } };
      } else run();
    }

    function bindSlider(s) {
      let dragging = null;
      const toVisual = (clientX) => {
        const r = s.el.getBoundingClientRect();
        const px = clientX - r.left;
        if (px < 0) return -rubberband(-px, r.width) / r.width;
        if (px > r.width) return 1 + rubberband(px - r.width, r.width) / r.width;
        return px / r.width;
      };
      s.el.addEventListener('pointerdown', (e) => {
        if (e.button > 0) return;
        e.preventDefault();
        if (s.anim) s.anim.stop();
        s.el.focus({ preventScroll: true });
        s.el.setPointerCapture(e.pointerId);
        s.el.classList.add('is-drag');
        dragging = e.pointerId;
        paint(s, toVisual(e.clientX));
      });
      s.el.addEventListener('pointermove', (e) => { if (dragging === e.pointerId) paint(s, toVisual(e.clientX)); });
      const end = (e) => {
        if (dragging !== e.pointerId) return;
        dragging = null;
        s.el.classList.remove('is-drag');
        // Let go past an end and it springs back inside
        if (s.visual < 0 || s.visual > 1) springTo(s, Math.max(0, Math.min(1, s.visual)));
      };
      s.el.addEventListener('pointerup', end);
      s.el.addEventListener('pointercancel', end);
      s.el.addEventListener('keydown', (e) => {
        const range = s.max - s.min;
        const step = (s.dec ? Math.pow(10, -s.dec) : 1) * (e.shiftKey ? 10 : 1);
        let v = s.value;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v += step;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v -= step;
        else if (e.key === 'PageUp') v += range / 10;
        else if (e.key === 'PageDown') v -= range / 10;
        else if (e.key === 'Home') v = s.min;
        else if (e.key === 'End') v = s.max;
        else return;
        e.preventDefault();
        if (s.anim) s.anim.stop();
        paint(s, (Math.max(s.min, Math.min(s.max, v)) - s.min) / range);
      });
    }

    const tabs = $$('.gm-tab', menu);
    tabs.forEach((tab) => tab.addEventListener('click', () => {
      tabs.forEach((t) => t.setAttribute('aria-pressed', String(t === tab)));
      const preset = PRESETS[tab.dataset.preset];
      if (!preset) return;
      Object.keys(preset).forEach((key, i) => {
        const s = sliders[key];
        if (s) springTo(s, (preset[key] - s.min) / (s.max - s.min), 0, i * 45);
      });
    }));

    const master = $('[data-master]', menu);
    $$('.gm-tg', menu).forEach((sw) => sw.addEventListener('click', () => {
      const on = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(on));
      if (sw === master) sw.closest('.gm-list').classList.toggle('is-off', !on);
    }));

    // Scale the fixed-width menu to its column (zoom keeps it crisp and keeps pointer math simple).
    const scaler = menu.closest('.gm-scale');
    const device = menu.closest('.device');
    const showcase = menu.closest('.showcase');
    if (scaler && device && showcase && 'ResizeObserver' in window) {
      const fit = () => {
        const cs = getComputedStyle(device);
        const chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
        const z = Math.min(1.18, (showcase.clientWidth - chrome) / parseFloat(getComputedStyle(menu).width));
        scaler.style.setProperty('--z', z.toFixed(4));
        // Below ~0.75x the switches are too small to hit, so on phones the menu is a picture, not controls
        menu.inert = z < 0.75;
      };
      new ResizeObserver(fit).observe(showcase);
      fit();
    }
  })();

  /* ------------------------------------------------------------------------
     Scroll reveal and number count-up. Only content that starts below the fold is touched, so
     nothing above it ever flickers and nothing is hidden if this script never runs.
     ------------------------------------------------------------------------ */
  if ('IntersectionObserver' in window) {
    const fold = window.innerHeight * 0.92;
    const below = (el) => el.getBoundingClientRect().top > fold;
    const fmt = new Intl.NumberFormat(LANG === 'pl' ? 'pl-PL' : 'en-US');

    const countUp = (el) => {
      const target = Number(el.dataset.count);
      const suffix = el.dataset.suffix || '';
      if (reduceMotion.matches || !Number.isFinite(target)) return;
      const start = performance.now();
      const dur = 1400;
      el.textContent = fmt.format(0) + suffix;
      const step = (now) => {
        const t = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - t, 4);
        el.textContent = fmt.format(Math.round(target * eased)) + suffix;
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };

    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        io.unobserve(el);
        if (el.classList.contains('reveal')) el.classList.add('is-in');
        if (el.dataset.count) countUp(el);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });

    $$('[data-reveal]').forEach((el) => {
      if (!below(el)) return;
      el.classList.add('reveal');
      io.observe(el);
    });
    // Children of a group arrive one after another
    $$('[data-reveal-group]').forEach((group) => {
      Array.from(group.children).forEach((child, i) => {
        if (!below(child)) return;
        child.style.setProperty('--d', (i * 0.07).toFixed(2) + 's');
        child.classList.add('reveal');
        io.observe(child);
      });
    });
    $$('[data-count]').forEach((el) => { if (below(el)) io.observe(el); });
  }

  /* ------------------------------------------------------------------------
     Spotlight: tiles catch a soft light under the pointer (mouse and pen only).
     ------------------------------------------------------------------------ */
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    $$('.tile').forEach((tile) => {
      let raf = 0;
      tile.addEventListener('pointermove', (e) => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          const r = tile.getBoundingClientRect();
          tile.style.setProperty('--mx', (e.clientX - r.left).toFixed(0) + 'px');
          tile.style.setProperty('--my', (e.clientY - r.top).toFixed(0) + 'px');
          raf = 0;
        });
      });
    });
  }

  /* ------------------------------------------------------------------------
     Mobile buy bar: appears once the hero's buttons scroll away, steps aside while the pricing
     section (which has its own buttons) is on screen or the sheet is open.
     ------------------------------------------------------------------------ */
  (function buyBar() {
    const bar = $('.buybar');
    const heroCtas = $('.hero-ctas');
    const pricing = $('#pricing');
    if (!bar || !('IntersectionObserver' in window)) return;
    const state = { hero: true, pricing: false, sheet: false };
    const sync = () => {
      const show = !state.hero && !state.pricing && !state.sheet;
      bar.classList.toggle('is-shown', show);
      bar.inert = !show;
    };
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.target === heroCtas) state.hero = entry.isIntersecting || entry.boundingClientRect.top > 0;
        if (entry.target === pricing) state.pricing = entry.isIntersecting;
      });
      sync();
    }, { threshold: 0 });
    if (heroCtas) io.observe(heroCtas); else state.hero = false;
    if (pricing) io.observe(pricing);
    document.addEventListener('sheet:toggle', (e) => { state.sheet = e.detail; sync(); });
    sync();
  })();

  /* ------------------------------------------------------------------------
     Recent purchase toast: the store's real latest orders per plan (the API only says how long ago).
     Desktop only, and only orders from the last 7 days.
     ------------------------------------------------------------------------ */
  (function recentOrders() {
    const toast = $('.toast');
    if (!toast || window.matchMedia('(max-width: 900px)').matches) return;
    const title = $('[data-toast-title]', toast);
    const time = $('[data-toast-time]', toast);
    const MAX_AGE_MIN = 7 * 24 * 60;
    const ids = [CONFIG.PLANS.month, CONFIG.PLANS.week, CONFIG.PLANS.day];
    const requests = ids.map((id) =>
      fetch(CONFIG.RECENT_ORDERS_API + '?product_id=' + id)
        .then((r) => (r.ok ? r.json() : []))
        .then((list) => (Array.isArray(list) ? list : []).map((o) => ({ id, minutes: Number(o.minutesAgo) })))
        .catch(() => []));

    Promise.all(requests).then((lists) => {
      const orders = lists.flat()
        .filter((o) => Number.isFinite(o.minutes) && o.minutes >= 0 && o.minutes <= MAX_AGE_MIN)
        .sort((a, b) => a.minutes - b.minutes);
      if (!orders.length) return;
      const loadedAt = Date.now();
      let i = 0;
      const show = () => {
        const o = orders[i++];
        title.textContent = TEXT.toast[o.id];
        time.textContent = TEXT.ago(Math.max(1, o.minutes + Math.floor((Date.now() - loadedAt) / 60000)));
        toast.hidden = false;
        requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.remove('is-out')));
      };
      const next = () => {
        toast.classList.add('is-out');
        setTimeout(() => {
          if (i >= orders.length) { toast.hidden = true; return; }
          show();
          setTimeout(next, 7000);
        }, toast.hidden ? 0 : 600);
      };
      setTimeout(next, 5000);
    });
  })();
})();
