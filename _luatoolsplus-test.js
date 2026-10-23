'use strict';
// Offline sanity checks for luatoolsplus (no Steam writes, no real plugins).
const plus = require('./luatoolsplus.js');
const fs = require('fs');

const src = 'C:/Users/imadd/Downloads/4954910.lua';
const text = fs.readFileSync('C:/Users/imadd/Downloads/4954910.lua', 'utf8');
const d = plus.parseLuaDetails(text, '4954910.lua');
console.log('[1] parse:  appId =', d.appId, '| depots =', d.depotCount, '| dlc =', d.dlcCount,
  '| pins =', d.pins.map((p) => `${p.depot}->${p.manifest}${p.locked ? ' locked' : ''}`).join(', '));

// enable/disable (comment in/out) around the addappid line
const toggle = plus._toggleLines;
const on = toggle(text, 'addappid\\s*\\(\\s*4954911\\s*[,)]', true);
const off = toggle(on, 'addappid\\s*\\(\\s*4954911\\s*[,)]', false);
const backOn = toggle(off, 'addappid\\s*\\(\\s*4954911\\s*[,)]', true);
const nofa = plus.parseLuaDetails(off, '4954910.lua');
const yesfa = plus.parseLuaDetails(backOn, '4954910.lua');
console.log('[2] toggle off:', nofa.depots.find((x) => x.id === '4954911').enabled === false ? 'OK' : 'FAIL',
  '| back on:', yesfa.depots.find((x) => x.id === '4954911').enabled === true ? 'OK' : 'FAIL',
  '| identical roundtrip:', backOn === text ? 'OK' : 'FAIL');
console.log('    commented line ->', off.split('\n').find((l) => l.includes('--addappid(4954911') || l.includes('-- addappid(4954911')));

// pin lock/unlock via setManifestid toggle
const pinOff = toggle(text, 'setManifestid\\s*\\(\\s*4954911\\s*[,)]', false);
const pinOffD = plus.parseLuaDetails(pinOff, '4954910.lua');
console.log('[3] pin unlocked:', pinOffD.pins[0].locked === false ? 'OK' : 'FAIL',
  '| commented pin line ->', pinOff.split('\n').find((l) => /--\s*setManifestid\(4954911/.test(l)));

// restore every file to original bytes
console.log('[4] original content untouched on disk:',
  fs.readFileSync('C:/Users/imadd/Downloads/4954910.lua', 'utf8') === text ? 'OK' : 'FAIL');
