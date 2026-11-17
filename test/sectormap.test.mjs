// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHIP_KEY, FM1, SMK37 } from "../lib/unit.js";
import { regionRanges, sectorMap } from "../lib/sectormap.js";

const blank = () => new Uint8Array(0x100000).fill(0xff);

test("an FM-1 without a readable table gets the stock layout, as in the desktop legend", () => {
  const map = sectorMap(blank(), CHIP_KEY, FM1);
  assert.equal(map.length, 256);
  assert.equal(regionRanges(map, "boot"), "00-03");
  assert.equal(regionRanges(map, "firmware"), "04-92");
  assert.equal(regionRanges(map, "settings"), "93-E8");
  assert.equal(regionRanges(map, "pairings"), "E9");
  assert.equal(regionRanges(map, "sounds"), "EA-FB");
  assert.equal(regionRanges(map, "free"), "FC-FE");
  assert.equal(regionRanges(map, "mac"), "FF");
});

test("an SMK-37 always marks its factory calibration", () => {
  const map = sectorMap(blank(), CHIP_KEY, SMK37);
  assert.equal(regionRanges(map, "calibration"), "C1");
  assert.equal(regionRanges(map, "pairings"), "C0");
});

test("with no model, only the boot area and the key area are known", () => {
  const map = sectorMap(blank(), CHIP_KEY, null);
  assert.equal(regionRanges(map, "boot"), "00-03");
  assert.equal(regionRanges(map, "mac"), "FF");
  assert.equal(regionRanges(map, "free"), "04-FE");
});
