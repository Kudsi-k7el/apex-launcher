'use strict';

/**
 * Lucide-style stroke icons, inlined as SVG so the app never depends on an
 * icon font or network request. Every glyph is drawn on a 24x24 viewBox.
 */
const ICON_PATHS = {
  store: '<path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/>',
  library: '<path d="M4 4v16"/><path d="M9 4v16"/><path d="M14.5 5.5l5 14"/><path d="M14.5 5.5L18 4l3 .5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  heart: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/>',
  refresh: '<path d="M21 12a9 9 0 0 0-15-6.7L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15 6.7l3-2.7"/><path d="M16 16h5v5"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  chevronUp: '<path d="M18 15l-6-6-6 6"/>',
  left: '<path d="M15 18l-6-6 6-6"/>',
  right: '<path d="M9 18l6-6-6-6"/>',
  min: '<path d="M5 12h14"/>',
  max: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
  restore: '<rect x="4" y="8" width="12" height="12" rx="1"/><path d="M8 8V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-3"/>',
  close: '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  warning: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.4 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  sparkles: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/><path d="M12 8S10.5 3 8 3a2.5 2.5 0 0 0 0 5"/><path d="M12 8s1.5-5 4-5a2.5 2.5 0 0 1 0 5"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9z"/>',
  tray: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14h5l1 2h6l1-2h5"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.9 4.9l1.4 1.4"/><path d="M17.7 17.7l1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M4.9 19.1l1.4-1.4"/><path d="M17.7 6.3l1.4-1.4"/>',
  power: '<path d="M18.4 6.6a9 9 0 1 1-12.8 0"/><path d="M12 2v10"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2H17a5 5 0 0 0 5-5c0-4.9-4.5-8.4-10-8.4z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 21a6.5 6.5 0 0 1 13 0"/><path d="M16 5.2A3.5 3.5 0 0 1 16 12"/><path d="M18 15.3A6.5 6.5 0 0 1 21.5 21"/>',
  gamepad: '<path d="M6 12h4"/><path d="M8 10v4"/><circle cx="15.5" cy="11" r="1"/><circle cx="18" cy="13.5" r="1"/><rect x="2" y="6" width="20" height="12" rx="5"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3"/><path d="M15 2v3"/><path d="M9 19v3"/><path d="M15 19v3"/><path d="M2 9h3"/><path d="M2 15h3"/><path d="M19 9h3"/><path d="M19 15h3"/>',
  hardDrive: '<path d="M21 12H3"/><path d="M5 6h14a2 2 0 0 1 1.8 1.1L22 12v5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5l1.2-4.9A2 2 0 0 1 5 6z"/><circle cx="17" cy="15.5" r="1"/><circle cx="13" cy="15.5" r="1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  zap: '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>',
  star: '<path d="M12 3l2.9 5.9 6.1.9-4.5 4.3 1.1 6.1L12 17.8 6.4 20.2l1.1-6.1L3 9.8l6.1-.9L12 3z"/>',
  tag: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0l-7.2-7.2a2 2 0 0 1-.6-1.4V4a1 1 0 0 1 1-1h8a2 2 0 0 1 1.4.6l7.4 7.4a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
  cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.4 12.1a2 2 0 0 0 2 1.6h8.2a2 2 0 0 0 2-1.6L21 7H6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z"/>',
  wifi: '<path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8.5 16a5 5 0 0 1 7 0"/><path d="M12 19.5h.01"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8L3 5z"/>',
  arrowUpRight: '<path d="M7 17L17 7"/><path d="M8 7h9v9"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  lock: '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  trophy: '<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M7 6H4a3 3 0 0 0 3 3"/><path d="M17 6h3a3 3 0 0 1-3 3"/>',
  messageSquare: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  layers: '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>',
  box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v9"/>',
  userCheck: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M16 11l2 2 4-4"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  clockPlay: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="M21 15.5l-4.5-4.5L6 21"/>',
  news: '<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 0V9h4"/><path d="M18 14h-8"/><path d="M15 18h-5"/><rect x="10" y="6" width="8" height="4" rx="1"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  edit: '<path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  hourglass: '<path d="M6 2h12"/><path d="M6 22h12"/><path d="M6 2v4a6 6 0 0 0 12 0V2"/><path d="M6 22v-4a6 6 0 0 1 12 0v4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
  rocket: '<path d="M5 13a10 10 0 0 1 10-10c3 3 3 7 0 10l-3 3-7-3z"/><path d="M5 13l-2 6 6-2"/><circle cx="14.5" cy="9.5" r="1.5"/>',

  // --- console marks -------------------------------------------------------
  // Stylised vector interpretations of the two current-gen platform marks.
  // They are deliberately simplified: the badge always carries the platform
  // name in text beside the glyph, so the shape only has to be recognisable.
  xbox: '<circle cx="12" cy="12" r="9.2"/><path d="M7.4 7.4l9.2 9.2"/><path d="M16.6 7.4l-9.2 9.2"/>',
  ps5: '<g transform="skewX(-9)"><path d="M8.6 11.4V2.4h3.3a3 3 0 0 1 0 6H8.6"/><path d="M15.6 15.2a3.1 3.1 0 0 0-2.3-.9c-1.5 0-2.6.8-2.6 2s1 1.8 2.7 2.2c1.7.5 2.8 1.1 2.8 2.4 0 1.3-1.3 2.3-3.1 2.3-1.3 0-2.4-.5-3.1-1.2"/></g>',

  // --- storefront marks ----------------------------------------------------
  // Under the same rule as the console badges above: every badge sets the
  // storefront's name in text beside the glyph, so these are stylised
  // silhouettes rather than traced logos. They have to read at 12px on a card,
  // which is why each one is a single distinct shape and nothing finer.
  steam: '<circle cx="12" cy="12" r="9.2"/><circle cx="15.2" cy="8.8" r="2.1"/><path d="M13.6 10.5l-5 5"/><circle cx="7.1" cy="17.5" r="2.4"/>',
  epic: '<rect x="3.2" y="3.2" width="17.6" height="17.6" rx="4.4"/><path d="M9.2 8.2h6"/><path d="M9.2 12h4.4"/><path d="M9.2 15.8h6"/>',
  gog: '<circle cx="12" cy="12" r="9.2"/><path d="M15.7 9.1a4.7 4.7 0 1 0 .4 4.8h-4.4"/>',
  ubisoft: '<path d="M20.5 12a8.5 8.5 0 1 1-3.2-6.6"/><path d="M12 16.3a4.3 4.3 0 1 1 4.1-5.6"/>',
  ea: '<rect x="2.4" y="6.6" width="19.2" height="10.8" rx="2.6"/><path d="M6.5 15.2l2.6-6.4 2.6 6.4"/><path d="M7.4 13h3.4"/><path d="M14.1 9.2h4.3"/><path d="M14.1 12.4h3.1"/><path d="M14.1 15.2h4.3"/>',
  battlenet: '<path d="M12 2.6l3.2 6.4 6.2 3.2-6.2 3.2-3.2 6.4-3.2-6.4L2.6 12.2l6.2-3.2z"/>',
  windows: '<path d="M3.8 4.6l7.4-1.1v7.7H3.8z"/><path d="M12.8 3.3l7.4-1v8.9h-7.4z"/><path d="M3.8 13.1h7.4v7.7l-7.4-1.1z"/><path d="M12.8 13.1h7.4v8.9l-7.4-1z"/>',

  // --- publisher marks -----------------------------------------------------
  // The same rule as the storefront marks below: one readable silhouette that
  // always sits beside the publisher's name in text, so the shape only has to
  // be recognisable. Nothing here is a traced logo.
  denuvo: '<path d="M12 2.6l7.6 2.9v6.2c0 4.6-3.2 8.1-7.6 9.7-4.4-1.6-7.6-5.1-7.6-9.7V5.5L12 2.6z"/><circle cx="12" cy="10.3" r="2"/><path d="M12 12.3v3.6"/>',
  disc: '<circle cx="12" cy="12" r="9.2"/><circle cx="12" cy="12" r="2.6"/><path d="M18.5 8.1a7.2 7.2 0 0 0-4.7-3.7"/>',

  // --- window & sound ------------------------------------------------------
  fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/>',
  fullscreenExit: '<path d="M3 8h3a2 2 0 0 0 2-2V3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/>',
  volume: '<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
  volumeOff: '<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M22 9l-5 6"/><path d="M17 9l5 6"/>',
  // A television: the shorthand everywhere for the couch/10-foot layout.
  tv: '<rect x="2" y="7.5" width="20" height="13" rx="2.2"/><path d="M8 3l4 4.5"/><path d="M16 3l-4 4.5"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01"/><path d="M10 10h.01"/><path d="M14 10h.01"/><path d="M18 10h.01"/><path d="M6 14h.01"/><path d="M18 14h.01"/><path d="M9 14h6"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3"/><path d="M17 6l3 3"/>'
};

function icon(name, size = 18) {
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
}

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon, +el.dataset.size || 18);
    el.removeAttribute('data-icon');
  });
}
