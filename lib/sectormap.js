// SPDX-License-Identifier: MIT
// The flash as 256 sectors of 4 KiB (a 16 x 16 map), each labelled with the region it belongs to,
// from the unit's own file tables, as in M-Flasher's src/sectormap.rs.
import { BOOT_AREA, SECTOR, appTable } from "./formats.js";

export const REGIONS = ["boot", "firmware", "settings", "pairings", "calibration", "presets", "sequences", "free", "sounds", "mac"];

const NAMED = { VM: "settings", BTIF: "pairings", USRTRIM: "calibration", USRFLASH: "presets", SEQ64: "sequences", USR: "sounds" };

/** Stock layouts, for a unit whose firmware table cannot be read. */
const STOCK = {
  smk37: [["firmware", 0x04000, 0x9d000], ["settings", 0x9d000, 0xc0000], ["pairings", 0xc0000, 0xc1000],
    ["calibration", 0xc1000, 0xc2000], ["presets", 0xc2000, 0xeb000], ["sounds", 0xf4000, 0xfe000]],
  fm1: [["firmware", 0x04000, 0x93000], ["settings", 0x93000, 0xe9000], ["pairings", 0xe9000, 0xea000], ["sounds", 0xea000, 0xfc000]],
};

export function sectorMap(flash, key, board) {
  const n = Math.floor(flash.length / SECTOR);
  const out = new Array(n).fill("free");
  const mark = (region, start, end) => {
    for (let s = Math.floor(start / SECTOR); s < Math.min(Math.ceil(end / SECTOR), n); s++) out[s] = region;
  };
  const table = appTable(flash, key);
  const files = table.filter((e) => e.attr === 0x82);
  if (files.length) {
    let end = BOOT_AREA + Math.max(0, ...files.map((e) => e.addr + e.len));
    for (const e of table) if (e.name === "PRCT" && e.addr === 0 && e.len <= flash.length) end = Math.max(end, e.len);
    mark("firmware", BOOT_AREA, end);
    for (const e of table) {
      if (e.attr !== 0x12 && e.attr !== 0x92) continue;
      const region = NAMED[e.name];
      if (region && e.len > 0 && e.addr + e.len <= flash.length) mark(region, e.addr, e.addr + e.len);
    }
  } else if (board) {
    for (const [region, a, e] of STOCK[board.key] ?? STOCK.fm1) mark(region, a, e);
  }
  if (board?.key === "smk37") mark("calibration", 0xc1000, 0xc2000); // factory data, whatever the firmware declares
  mark("boot", 0, BOOT_AREA);
  mark("mac", 0xff000, 0x100000);
  return out;
}

/** "C2-EA, F4-FD" (sector numbers in hex) for a region, for the legend. */
export function regionRanges(map, region) {
  const parts = [];
  const h = (s) => s.toString(16).toUpperCase().padStart(2, "0");
  for (let s = 0; s < map.length;) {
    let e = s;
    while (e + 1 < map.length && map[e + 1] === map[s]) e++;
    if (map[s] === region) parts.push(s === e ? h(s) : `${h(s)}-${h(e)}`);
    s = e + 1;
  }
  return parts.join(", ");
}
