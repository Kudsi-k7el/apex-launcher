'use strict';

/**
 * Contact.
 * -------------------------------------------------------------------------
 * How to reach the person who builds Apex.
 *
 * The handles are the entire point of the page, so they are rendered large and
 * selectable, one button from the clipboard and one from the app that owns them.
 * A contact page that makes you retype a username by hand is a contact page
 * nobody uses.
 *
 * Copying needs a fallback: the renderer runs from a file:// origin, which is not
 * a secure context, so `navigator.clipboard` is not guaranteed to exist.
 */

/** Brand marks, inlined so the page needs no network and no icon font. These are
 *  filled paths, not strokes, so they are drawn as-is rather than through the
 *  shared icon set. */
const CONTACT_MARKS = {
  discord: '<path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.2256 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189z"/>',
  telegram: '<path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>'
};

const CONTACT_CHANNELS = [
  {
    id: 'discord',
    label: 'Discord',
    handle: 'z1.f',
    hint: 'Add friend, then paste the username',
    blurb: 'The fastest way to reach me. A friend request and a direct message both land in the same place.',
    url: 'https://discord.com/users/z1.f'
  },
  {
    id: 'telegram',
    label: 'Telegram',
    handle: '@kudsoo',
    hint: 'Opens straight in Telegram',
    blurb: 'No request needed, and the better one for files, screenshots and long messages.',
    url: 'https://t.me/kudsoo'
  }
];

/** Copies text, falling back for the non-secure file:// origin. */
async function copyHandle(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the textarea below */ }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function contactCard(c) {
  return `<article class="cc-card cc-${c.id}">
    <span class="cc-glow"></span>
    <header class="cc-head">
      <span class="cc-ico"><svg viewBox="0 0 24 24" aria-hidden="true">${CONTACT_MARKS[c.id] || ''}</svg></span>
      <div>
        <strong>${esc(c.label)}</strong>
        <small>${esc(c.hint)}</small>
      </div>
    </header>
    <p class="cc-handle">${esc(c.handle)}</p>
    <p class="cc-blurb">${esc(c.blurb)}</p>
    <div class="cc-actions">
      <button class="btn primary cc-copy" data-copy="${esc(c.handle)}">${icon('link', 15)} Copy handle</button>
      <button class="btn secondary" data-open="${esc(c.url)}">${icon('external', 15)} Open</button>
    </div>
  </article>`;
}

function renderContact(el) {
  el.innerHTML = `
    <h1 class="page-title">Contact</h1>

    <section class="cc-hero">
      <span class="cc-hero-mark">kudasai</span>
      <div class="cc-hero-body">
        <h2>Found a bug? Want a feature? Just say hi.</h2>
        <p>Apex is built and maintained by one person. Bug reports, feature requests
        and plain feedback all go to the same two places, and both are read.</p>
        <div class="cc-hero-chips">
          <span class="cc-chip">${icon('sparkles', 13)} Bug reports</span>
          <span class="cc-chip">${icon('rocket', 13)} Feature requests</span>
          <span class="cc-chip">${icon('heart', 13)} Feedback</span>
        </div>
      </div>
    </section>

    <div class="cc-grid">${CONTACT_CHANNELS.map(contactCard).join('')}</div>

    <section class="cc-tips">
      <h4>${icon('info', 15)} Worth including</h4>
      <ul>
        <li>The exact build you are running &mdash; it is printed at the bottom right of the window.</li>
        <li>What you expected to happen, and what actually happened.</li>
        <li>For a game Apex did not detect: which store it came from, and where it is installed.</li>
        <li>A screenshot, if the launcher itself looks wrong. F2 takes one.</li>
      </ul>
    </section>

    <div class="cc-sign">
      ${icon('apexMark', 14)}
      <span>built by <b>kudasai</b> &middot; <b>@kudsoo</b></span>
    </div>`;

  el.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    const text = b.dataset.copy;
    const ok = await copyHandle(text);
    if (typeof toast === 'function') {
      toast(ok ? `Copied ${text}` : `Copy it by hand: ${text}`, ok ? 'check' : 'warn');
    }
    if (!ok) return;
    const orig = b.innerHTML;
    b.innerHTML = `${icon('check', 15)} Copied`;
    setTimeout(() => { b.innerHTML = orig; }, 1400);
  }));

  el.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
    try { window.api.openExternal(b.dataset.open); } catch { /* nothing to do */ }
  }));
}
