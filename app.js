// SPDX-License-Identifier: MIT
// The page: finds a unit, says what it is, and offers what can be done with it. It is drawn like the
// Device tab of M-Flasher + (Figma: "Device · M-Flasher + web", and its phone version).
import { BOOT_AREA, crc32, hex, packageImage, rangesText, sha256Hex } from "./lib/formats.js";
import { FINISH, Link, Unit, UnitLost, findPorts } from "./lib/protocol.js";
import { CHIP_KEY, FM1, analyse, describePlan, flashTested, flashText, planFirmware, planRestore } from "./lib/unit.js";
import { loadManifest, loadPackage, hasOwnUpdater, variantOf } from "./lib/assets.js";
import { REGIONS, regionRanges, sectorMap } from "./lib/sectormap.js";

const TOOL = "m-flasher-plus web 0.1";
/** Firmware whose update route has run the helper on real hardware. */
const ROUTE_TESTED = new Set(["FM-1_015", "FM-1_016", "FM-1_102", "FM-1_918", "FM-1_900", "FM-1_920", "FM-1_91061", "SMK-37 Pro_016", "SMK-37+VA_102", "SMK-37 Pro_920", "SMK-37 Elite_016"]);
const OTHER_WAYS = "With m-bootloader installed, hold PLAY (SEQ PLAY on the SMK-37) at power-on and choose MIDI MODE. Otherwise, use the M-Flasher + app on a computer.";
const CHECK = "Check FM-1 status";
const $ = (id) => document.getElementById(id);

const ICONS = {
  bootloader: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 7H7V17H17V7Z"/><path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/><path d="M10 3V7M14 3V7M10 17V21M14 17V21M3 10H7M3 14H7M17 10H21M17 14H21"/></svg>',
  backup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4H12V20H3V4Z"/><path d="M21 12H8M12 16L8 12L12 8"/></svg>',
  restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4H21V20H12V4Z"/><path d="M3 12H16M12 16L16 12L12 8"/></svg>',
  firmware: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 7H7V17H17V7Z"/><path d="M10 3V7M14 3V7M10 17V21M14 17V21M3 10H7M3 14H7M17 10H21M17 14H21"/></svg>',
  "check-ok": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.17L4.83 12L3.41 13.41L9 19L21 7L19.59 5.59L9 16.17Z" fill="#7be8bb"/></svg>',
  "check-attention": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 21H23L12 2L1 21ZM13 18H11V16H13V18ZM13 14H11V10H13V14Z" fill="#f2b44c"/></svg>',
};
const REGION_NAMES = { boot: "Boot", firmware: "Firmware", settings: "Settings", pairings: "Pairings", calibration: "Calibration", presets: "Presets", sequences: "Sequences", free: "Free", sounds: "Sounds", mac: "MAC" };
const STEPS = ["read", "backup", "write", "verify"];
let stockLegend = null;

const state = {
  supported: Boolean(navigator.requestMIDIAccess),
  access: null,
  link: null,
  unit: null,
  mode: "none", // firmware, loader, bootloader or stage
  identity: null,
  model: null,
  info: null,
  flash: null,
  analysis: null,
  busy: false,
  backupSaved: false,
  backupName: null,
  progress: null, // { title, done, total, text } while something runs
  steps: {}, // read/backup/write/verify: "current" or "done"
  form: null, // "firmware" or "restore", after its operation is chosen
  plan: null,
  fileName: null,
};

function log(text) {
  $("log").textContent += `${new Date().toLocaleTimeString()} ${text}\n`;
  $("log").scrollTop = $("log").scrollHeight;
}

function status(text, kind = "") {
  $("status").textContent = text;
  $("status").className = `status ${kind}`;
  if (text) log(text);
}

/** A finished install's message, which stays when the unit restarts and reappears. */
const finished = () => $("status").classList.contains("done");

function progress(title, done, total, text = "") {
  state.progress = { title, done, total, text };
  renderLcd();
}

function hideProgress() {
  state.progress = null;
  renderLcd();
}

function setStep(name, value) {
  if (value) state.steps[name] = value;
  else delete state.steps[name];
  renderSteps();
}

// ---- finding the unit ----

async function connect() {
  try {
    state.access = await navigator.requestMIDIAccess({ sysex: true });
  } catch (cause) {
    message("MIDI permission", `The browser didn't give access to MIDI devices (${cause.message}). Allow it in the address bar, then press ${CHECK} again.`);
    status("The browser didn't give access to MIDI devices.", "error");
    return;
  }
  state.access.onstatechange = () => {
    clearTimeout(state.rescanTimer);
    state.rescanTimer = setTimeout(() => { if (!state.busy) scan(); }, 800);
  };
  await scan();
}

function closeLink() {
  state.link?.close();
  state.link = null;
  state.unit = null;
}

function clearUnit() {
  closeLink();
  Object.assign(state, { mode: "none", identity: null, model: null, info: null, flash: null, analysis: null, form: null, plan: null, fileName: null, steps: {} });
}

async function scan() {
  clearUnit();
  const ports = findPorts(state.access);
  const select = $("port-select");
  select.replaceChildren(...ports.map((p, i) => new Option(p.name, i)));
  $("port-row").hidden = ports.length < 2;
  if (!ports.length) {
    if (!finished()) status("No unit found. Is it on, and plugged in with a data cable?");
    render();
    return;
  }
  await open(ports[Number(select.value) || 0]);
}

async function open(port) {
  state.link = new Link(port.input, port.output);
  state.unit = new Unit(state.link);
  state.busy = true;
  render();
  try {
    log(`Port: ${port.name}`);
    state.identity = await state.unit.identity();
    if (!state.identity) {
      status(`${port.name} didn't answer. It may be starting up: this firmware can take half a minute to appear.`, "error");
      return;
    }
    log(`Identity: ${state.identity}`);
    state.info = await state.unit.info();
    const name = /^(?:ota-)?(.+)_\d+$/.exec(state.identity)?.[1] ?? null;
    state.model = name;
    if (state.info) state.mode = state.info.kind;
    else state.mode = state.identity.startsWith("ota-") ? "loader" : "firmware";
    // The unit reappears after an install: what the install said should outlast that.
    if (!finished()) status("");
    if (state.info) await readFlash();
  } catch (cause) {
    report(cause);
  } finally {
    state.busy = false;
    render();
  }
}

/** Waits for the unit to come back after a restart, and opens it. */
async function reconnect(seconds, wanted) {
  closeLink();
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 1000));
    const port = findPorts(state.access)[0];
    if (!port) continue;
    const link = new Link(port.input, port.output);
    const unit = new Unit(link);
    const identity = await unit.identity(800);
    const info = identity ? await unit.info(600) : null;
    link.close();
    if (identity && (!wanted || wanted(identity, info))) return port;
  }
  return null;
}

// ---- reading ----

async function readFlash() {
  const { unit, info } = state;
  const started = Date.now();
  setStep("read", "current");
  progress("Reading…", 0, info.capacity, "over USB MIDI");
  const flash = await unit.readAll(info.capacity, (done, total) => progress("Reading…", done, total, "over USB MIDI"));
  progress("Checking…", info.capacity, info.capacity, "The unit computes its own CRC");
  const theirs = await unit.check(0, info.capacity);
  const ours = crc32(flash);
  if (theirs !== ours) throw new Error(`what was read doesn't match the chip's CRC (${hex(theirs, 8)}, read ${hex(ours, 8)}). Try again.`);
  log(`Read ${flash.length} bytes in ${((Date.now() - started) / 1000).toFixed(1)} s, CRC-32 ${hex(ours, 8)} matches the chip's.`);
  state.flash = flash;
  state.analysis = analyse(flash, info.jedec, info.key);
  for (const e of state.analysis.evidence) log(`Evidence: ${e[2]}`);
  log(`${unitName()} · ${state.analysis.firmwareText} · ${state.analysis.bootloaderText} · unit ID ${info.unitId}`);
  setStep("read", "done");
  hideProgress();
}

// ---- saving ----

function saveFile(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const pad = (n) => String(n).padStart(2, "0");

async function saveBackup() {
  const { flash, analysis, info } = state;
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const name = `${analysis.board?.key ?? "unknown"}-${stamp}`;
  const fields = {
    model: analysis.modelText,
    bootloader: analysis.bootloaderText,
    firmware: analysis.firmwareText,
    app: analysis.appStatusText,
    "chip key": hex(info.key, 4),
    flash: hex(info.jedec, 6),
    "unit id": info.unitId,
    loader: `${info.kind === "stage" ? "web stage" : "MIDI mode"} ${info.version}`,
    sha256: await sha256Hex(flash),
    saved: stamp,
    tool: TOOL,
  };
  saveFile(`${name}.bin`, new Blob([flash], { type: "application/octet-stream" }));
  await new Promise((r) => setTimeout(r, 400));
  saveFile(`${name}.json`, new Blob([`${JSON.stringify(fields, null, 2)}\n`], { type: "application/json" }));
  state.backupSaved = true;
  state.backupName = `${name}.bin`;
  setStep("backup", "done");
  log(`Backup saved as ${name}.bin, SHA-256 ${fields.sha256}`);
  status(`Backup saved to Downloads: ${name}.bin and its .json. Keep them safe.`, "done");
  render();
}

// ---- dialogs ----

function confirmWrite({ title, plan = null, text, warnings = [], okLabel, check }) {
  $("confirm-title").textContent = title;
  $("confirm-plan").hidden = !plan;
  $("confirm-plan").textContent = plan ?? "";
  $("confirm-text").textContent = text;
  $("confirm-warnings").replaceChildren(...warnings.map((w) => {
    const li = document.createElement("li");
    li.textContent = w;
    return li;
  }));
  $("confirm-ok").textContent = okLabel;
  $("confirm-check-row").hidden = !check;
  $("confirm-check").checked = false;
  $("confirm-check-text").textContent = check ?? "";
  $("confirm-ok").disabled = Boolean(check);
  $("confirm-check").onchange = () => { $("confirm-ok").disabled = !$("confirm-check").checked; };
  const dialog = $("confirm");
  dialog.returnValue = "cancel";
  return new Promise((resolve) => {
    dialog.onclose = () => resolve(dialog.returnValue === "ok");
    dialog.showModal();
  });
}

function message(title, text) {
  $("message-title").textContent = title;
  $("message-text").textContent = text;
  const dialog = $("message");
  if (!dialog.open) dialog.showModal();
}

// ---- doing ----

async function run(what) {
  status("");
  state.busy = true;
  render();
  let lock = null;
  const guard = (event) => event.preventDefault();
  window.addEventListener("beforeunload", guard);
  try {
    lock = await navigator.wakeLock?.request("screen").catch(() => null);
    await what();
  } catch (cause) {
    report(cause);
  } finally {
    await lock?.release?.().catch(() => {});
    window.removeEventListener("beforeunload", guard);
    hideProgress();
    state.busy = false;
    render();
  }
}

function report(cause) {
  hideProgress();
  for (const s of STEPS) if (state.steps[s] === "current") delete state.steps[s];
  log(`Error: ${cause.stack ?? cause}`);
  if (cause instanceof UnitLost) {
    const after = state.mode === "bootloader" ? `Choose MIDI MODE in the menu again, then press ${CHECK}.`
      : state.mode === "stage" ? `If it doesn't start normally, switch it off and on, and press ${CHECK} again.`
        : `Switch it off and on, and press ${CHECK} again.`;
    status(`${cause.message}. ${after}`, "error");
  } else {
    status(`${cause.message}`, "error");
  }
}

async function startTools() {
  const variant = variantOf(state.model);
  if (!variant) {
    message("The browser can't read this firmware", `This page doesn't know the firmware "${state.identity}", so it can't start the helper on it. Nothing was written.\n\n${OTHER_WAYS}`);
    return;
  }
  const warnings = [];
  if (!ROUTE_TESTED.has(state.identity)) warnings.push(`The helper hasn't been tried on ${state.identity} yet. M-VAVE's firmware should take it, but custom firmware may refuse it or behave differently.`);
  const ok = await confirmWrite({
    title: "Start the tools",
    text: "The firmware stores a small helper (about 8 KiB) in its update area and restarts, and the helper then runs from RAM. Your firmware and settings stay. The unit goes back to its firmware when you finish here, or after 5 minutes of no activity.",
    warnings,
    okLabel: "Start",
    check: warnings.length ? "I have read this" : null,
  });
  if (!ok) return;
  await run(async () => {
    setStep("read", "current");
    // Felucca-family firmware, numbered from 900, wants a flash.bin listed in the package. M-VAVE's and
    // Baud Girl refuse a blank one. A refusal changes nothing, so the other package can follow.
    const family = Number(/_(\d+)$/.exec(state.identity)?.[1]) >= 900;
    let accepted = false;
    for (const kind of family ? ["stageListed", "stage"] : ["stage", "stageListed"]) {
      const pkg = await loadPackage(kind, variant);
      log(`Helper package ${kind}, ${pkg.image.length} bytes`);
      try {
        await state.unit.serveUpdate(pkg.image, {
          finish: FINISH.APP,
          idleMs: 15000,
          onProgress: (done) => progress("Starting…", Math.min(done, pkg.image.length), pkg.image.length, "Sending the helper"),
        });
        accepted = true;
        break;
      } catch (cause) {
        if (!(cause instanceof UnitLost)) throw cause;
        log(`Helper: ${cause.message}`);
      }
    }
    if (!accepted) {
      setStep("read", null);
      log("This firmware didn't accept the helper, and it keeps running.");
      message("The firmware didn't take the helper",
        `This firmware only updates from its own kind of package, so the browser can't read your FM-1 through it. Nothing was written: your firmware and settings are unchanged.\n\nOther ways:\n1 · With m-bootloader: hold PLAY while switching the unit on, choose MIDI MODE, then press ${CHECK} again.\n2 · Or use the M-Flasher + app on a computer, in download mode.`);
      return;
    }
    progress("Starting…", 1, 1, "The unit is restarting");
    const port = await reconnect(45, (identity, info) => info?.kind === "stage");
    if (!port) throw new UnitLost("the helper didn't appear within 45 s");
    state.busy = false;
    await open(port);
    state.busy = true;
    if (state.mode === "stage") status("The tools are running. The unit will go back to its firmware when you restart it.", "done");
  });
}

async function installBootloader() {
  const fromTools = state.mode === "stage";
  if (!variantOf(state.model) && !fromTools) {
    status(`This page doesn't know the firmware "${state.identity}".`, "error");
    return;
  }
  const manifest = await loadManifest();
  const ok = await confirmWrite({
    title: `Install m-bootloader ${manifest.bootloaderVersion}?`,
    plan: `m-bootloader ${manifest.bootloaderVersion} · 4 sectors (16 KiB) · 0x00000-0x03FFF`,
    text: "Installs the open bootloader, through the firmware's update route. Only the boot area changes; the firmware and your settings stay. It adds hold-REC download mode, a recovery menu and MIDI mode. The M-Flasher + app on a computer can put the stock bootloader back."
      + (fromTools ? "\n\nThe unit first goes back to its firmware, which takes the package." : ""),
    warnings: [
      state.backupSaved ? null : `You haven't saved a backup in this session. Press ${CHECK} and SAVE first to make one.`,
      "An interrupted boot-area write can leave a unit needing a USB_KEY dongle: don't unplug it during this.",
      "FM-1s with the newer UC25HQ80 flash chip have had little testing with m-bootloader.",
    ].filter(Boolean),
    okLabel: "Install",
    check: "I understand",
  });
  if (!ok) return;
  await run(async () => {
    if (state.mode === "stage") {
      // m-bootloader installs only through the firmware's update route: leave the helper first.
      progress("Restarting…", 1, 1, "Back to the firmware first");
      state.unit.restart();
      const port = await reconnect(45, (identity, info) => !info && !identity.startsWith("ota-"));
      if (!port) throw new UnitLost("the firmware didn't come back within 45 s");
      await rejoin(port);
    }
    const variant = variantOf(state.model);
    if (!variant) throw new Error(`this page doesn't know the firmware "${state.identity}"`);
    setStep("write", "current");
    const pkg = await loadPackage("bootloader", variant);
    await state.unit.serveUpdate(pkg.image, {
      finish: FINISH.APP,
      onProgress: (done) => progress("Installing", Math.min(done, pkg.image.length), pkg.image.length, `m-bootloader ${manifest.bootloaderVersion} · boot area`),
    });
    setStep("write", "done");
    setStep("verify", "current");
    progress("Installing", 1, 1, "The unit is writing its bootloader, and restarting");
    const port = await reconnect(60);
    if (port) await rejoin(port);
    setStep("verify", "done");
    status(`m-bootloader was sent. Hold PLAY (SEQ PLAY on the SMK-37) at power-on to see its version (${manifest.bootloaderVersion}).`, "done");
  });
}

async function rejoin(port) {
  state.busy = false;
  await open(port);
  state.busy = true;
}

async function applyPlan(plan) {
  if (!plan.sectors.length) {
    status("Nothing to write: the flash already holds this.", "done");
    return;
  }
  const warnings = [...plan.warnings];
  if (state.info.kind === "stage" && state.analysis.bootloaderKind !== "open") warnings.push("This unit has the stock bootloader, so it has no hold-REC or MIDI mode. If this write is interrupted, it may need the M-Flasher + app in download mode or a USB_KEY dongle.");
  const ok = await confirmWrite({
    title: `${plan.title}?`,
    plan: `${plan.title} · ${plan.sectors.length} sectors`,
    text: `${describePlan(plan)}\n\n${state.backupSaved ? "A backup of this unit was saved in this session." : "A full backup is saved to Downloads first."}\nThe unit checks everything it receives before it erases anything. Keep this tab in front, and don't unplug or switch off the unit while it writes.`,
    warnings,
    okLabel: "Write",
    check: "I understand this changes the unit",
  });
  if (!ok) return false;
  await run(async () => {
    if (!state.backupSaved) await saveBackup();
    const size = Math.max(plan.size, BOOT_AREA + 0x1000);
    const image = packageImage(plan.target, size);
    let pass = 0;
    let last = -1;
    const started = Date.now();
    setStep("write", "current");
    await state.unit.serveUpdate(image, {
      finish: FINISH.LOADER,
      onProgress: (done) => {
        // The check reads to the end, in order, once; the write starts again from low addresses.
        if (last >= image.length - 0x400 && done < last) pass = 1;
        last = Math.max(done, pass ? 0 : last);
        progress(pass ? "Writing" : "Checking", Math.min(done, image.length), image.length,
          pass ? `${plan.sectors.length} sectors` : "Nothing is erased until this is done");
      },
    });
    log(`Written in ${((Date.now() - started) / 1000).toFixed(0)} s; the unit checked each sector it wrote.`);
    setStep("write", "done");
    setStep("verify", "current");
    progress("Restarting", 1, 1, "The unit is restarting");
    state.backupSaved = false;
    state.backupName = null;
    Object.assign(state, { form: null, plan: null, fileName: null });
    const port = await reconnect(60);
    if (port) await rejoin(port);
    setStep("verify", "done");
    status(port ? `Done, and the unit is back. Press ${CHECK} to read it again.` : "Done. The unit has restarted, but it hasn't reappeared on USB MIDI: this can be normal for firmware without USB MIDI. Check it starts.", "done");
  });
  return true;
}

async function chooseFile(input) {
  return new Promise((resolve) => {
    input.value = "";
    input.oncancel = () => resolve(null);
    input.onchange = async () => {
      const file = input.files[0];
      resolve(file ? { name: file.name, data: new Uint8Array(await file.arrayBuffer()) } : null);
    };
    input.click();
  });
}

/** Restore or install: the operation opens its form, a file makes the plan, and the plan is marked on the map. */
function openForm(kind) {
  Object.assign(state, { form: kind, plan: null, fileName: null });
  status("");
  render();
}

async function chooseForForm() {
  const firmware = state.form === "firmware";
  const file = await chooseFile($(firmware ? "firmware-file" : "backup-file"));
  if (!file) return;
  state.plan = null;
  state.fileName = file.name;
  try {
    state.plan = firmware ? planFirmware(session(), file.data) : planRestore(session(), file.data, null);
    log(`Plan: ${file.name} · ${state.plan.sectors.length} sectors${state.plan.runs.length ? `, ${rangesText(state.plan.runs)}` : ""}`);
  } catch (cause) {
    report(cause);
  }
  render();
}

async function installFirmware() {
  const file = await chooseFile($("firmware-file"));
  if (file) await attempt(() => installOnLoader(file.data));
}

async function attempt(what) {
  try {
    await what();
  } catch (cause) {
    report(cause);
  }
}

const session = () => ({ flash: state.flash, key: state.info.key, unitId: state.info.unitId, analysis: state.analysis });

/** An update loader, or MIDI mode from before host reads, takes a package as it is. */
async function installOnLoader(raw) {
  const { parsePackage, packageFlash } = await import("./lib/formats.js");
  const pkg = parsePackage(raw);
  packageFlash(pkg);
  if (state.model && pkg.model !== state.model) throw new Error(`this package is for the ${pkg.model}, the connected unit says ${state.model}`);
  const ok = await confirmWrite({
    title: `Install firmware ${pkg.identity}?`,
    text: "Installs the package's firmware. This mode can't read the flash, so no backup can be made first, and the package can't be checked against the unit beyond its model.",
    warnings: ["There is no backup from here."],
    okLabel: "Write",
    check: "I understand",
  });
  if (!ok) return;
  await run(async () => {
    setStep("write", "current");
    await state.unit.serveUpdate(pkg.image, {
      finish: FINISH.LOADER,
      onProgress: (done) => progress("Installing", Math.min(done, pkg.image.length), pkg.image.length, pkg.identity),
    });
    setStep("write", "done");
    status("Done. The unit is restarting.", "done");
  });
}

function leave(what, text) {
  state.unit[what]();
  status(text, "done");
  clearUnit();
  render();
}

// ---- showing ----

function unitName() {
  const a = state.analysis;
  if (a?.board) return a.board.key === "fm1" ? "FM-1" : (a.modelName ?? "SMK-37");
  return state.model ?? "Unit";
}

const bootloaderVersion = () => state.analysis?.bootloaderText.replace(/ \(.*\)$/, "") ?? "";

/** A label with line breaks, as text (what the unit reports never becomes markup). */
function setLabel(el, text) {
  const parts = text.split("\n");
  el.replaceChildren(...parts.flatMap((p, i) => (i ? [document.createElement("br"), p] : [p])));
}

/** What the LCD says: the four lines of the design's scenarios. */
function lcdContent() {
  const p = state.progress;
  if (p) {
    const pct = p.total ? Math.round((p.done * 100) / p.total) : 0;
    return { state: "writing", title: p.title, status: p.text, detail: `${pct}%`, bar: pct, prompt: "Keep this tab in front · don't unplug" };
  }
  if (!state.supported) return { state: "alert", title: "No MIDI", status: "Safari has no Web MIDI", detail: "Get the MIDI Browser app", prompt: "Open this page in MIDI Browser" };
  const name = unitName();
  if (state.mode === "none") {
    return state.access
      ? { title: "No unit", status: "Not found on USB MIDI", detail: "Data cable? Switched on?", prompt: `Press ${CHECK}` }
      : { title: "No unit", status: "Waiting for USB MIDI", detail: "Plug it in, switch it on", prompt: `Press ${CHECK}` };
  }
  if (hasOwnUpdater(state.identity)) {
    return { state: "alert", title: `${name} running`, status: "Can't start the helper", detail: state.identity, prompt: "See the other ways below" };
  }
  if (state.mode === "firmware") {
    return { title: `${name} running`, status: `USB MIDI · ${state.identity}`, detail: "Flash not read yet", prompt: `Press ${CHECK}: it reads and backs up` };
  }
  if (state.mode === "loader") {
    return { title: `${name} updater`, status: `USB MIDI · ${state.identity}`, detail: "It can't read the flash", prompt: "Install firmware: no backup here" };
  }
  const running = state.info?.kind === "stage" ? `web tools ${state.info.version}` : `MIDI mode ${state.info?.version ?? ""}`;
  if (!state.flash) return { title: name, status: `USB MIDI · ${running}`, detail: "Flash not read", prompt: `Press ${CHECK}` };
  const a = state.analysis;
  let prompt = "Checked · choose an operation";
  if (!a.board) prompt = "Model uncertain: nothing is written";
  else if (state.plan) prompt = state.plan.sectors.length ? `Plan ready: ${state.plan.sectors.length} sectors · review it` : "Nothing to write: already on the unit";
  else if (state.form) prompt = state.form === "firmware" ? "Choose a firmware file (.fwsc)" : "Choose a backup file (.bin)";
  else if (a.bootloaderKind !== "open") prompt = "Install m-bootloader first: it protects against bricks";
  return { title: name, status: `USB MIDI · ${running}`, detail: `Flash ${state.info.capacity >> 20} MiB · read and checked`, prompt };
}

function renderLcd() {
  const c = lcdContent();
  $("lcd").dataset.state = c.state ?? "ready";
  $("lcd-title").textContent = c.title;
  $("lcd-status").textContent = c.status ?? "";
  $("lcd-detail").textContent = c.detail ?? "";
  $("lcd-prompt").textContent = c.prompt ?? "";
  $("lcd-bar").hidden = c.bar == null;
  $("lcd-bar-fill").style.width = `${c.bar ?? 0}%`;
  const doing = state.progress ? state.progress.title.replace(/…$/, "")
    : state.mode === "stage" ? "web tools" : state.mode === "bootloader" ? "MIDI mode" : "USB MIDI";
  $("unit-line-text").textContent = state.mode === "none" ? "No unit" : `${unitName()} · ${doing}`;
  $("unit-line").classList.toggle("on", state.mode !== "none");
}

function setOp(button, { label = null, state: look = "default", disabled = false, onClick = null }) {
  if (label != null) setLabel(button.querySelector(".label"), label);
  button.dataset.state = look;
  button.disabled = disabled || state.busy;
  button.onclick = onClick;
}

function renderSteps() {
  for (const li of $("steps").children) li.className = state.steps[li.dataset.step] ?? "";
}

function renderNotice() {
  let notice = null;
  const a = state.analysis;
  if (!state.supported) notice = ["MIDI Browser", "Safari doesn't support Web MIDI, so it can't reach the unit. Download the MIDI Browser app and open this page there: it installs m-bootloader and firmware without problems. On a computer or Android, Chrome, Edge, Brave and Firefox work too."];
  else if (state.mode === "none") notice = ["Beta", "Experimental: save a backup first, and keep the M-Flasher + app at hand"];
  else if (hasOwnUpdater(state.identity)) notice = ["Other ways", `This firmware only updates from its own kind of package, so the browser can't read it. Your firmware is unchanged. Use the M-Flasher + app on a computer, or m-bootloader 2.2's MIDI MODE (hold SEQ PLAY at power-on).${state.mode === "loader" ? " It's in its updater now: to leave, switch it off and on." : ""}`];
  else if (state.mode === "firmware") notice = ["Firmware route", `A browser can't read the flash through firmware: ${CHECK} starts the tools, which run from RAM. Your firmware stays.`];
  else if (state.mode === "loader") notice = ["Updater", "This can install firmware, but it can't read the flash, so no backup is possible here."];
  else if (a && !a.board) notice = ["Model", "The model is uncertain, so this page won't write anything to this unit. To choose it, use the M-Flasher + app on a computer."];
  else if (a && a.bootloaderKind !== "open") notice = ["Safety check", "You don't have m-bootloader · install it here: only the boot area changes"];
  $("notice").hidden = !notice;
  if (notice) {
    $("notice-name").textContent = notice[0];
    $("notice-text").textContent = notice[1];
  }
}

function renderInfo() {
  const a = state.analysis;
  $("device-info").hidden = !a;
  if (!a) return;
  const rows = [
    ["Model", a.modelText, a.certain ? "" : "warn"],
    ["Bootloader", a.bootloaderText, a.bootloaderKind === "open" ? "" : "warn"],
    ["Firmware", a.firmwareText, ""],
    ["Flash chip", flashText(state.info.jedec), flashTested(state.info.jedec) ? "" : "warn"],
    ["Firmware check", a.appStatusText, a.appStatus === "OK" ? "ok" : "warn"],
    ["Running", state.info.kind === "stage" ? `web tools ${state.info.version} (RAM)` : `MIDI mode ${state.info.version}`, ""],
  ];
  $("info").replaceChildren(...rows.flatMap(([k, v, cls]) => {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    if (cls) dd.className = cls;
    return [dt, dd];
  }));
}

function smallButton(label, title, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn small";
  b.textContent = label;
  b.title = title;
  b.disabled = state.busy;
  b.onclick = onClick;
  return b;
}

function renderOperations() {
  const read = Boolean(state.flash);
  const loader = state.mode === "loader";
  const canWrite = read && Boolean(state.analysis?.board);
  const more = [];
  if (state.mode === "stage" || state.mode === "bootloader") more.push(smallButton("Restart", "Leaves this mode, and starts the firmware.", () => leave("restart", "Restarting.")));
  if (state.mode !== "none") more.push(smallButton("Download mode", "For the M-Flasher + app on a computer. A browser can't use this mode.", () => leave("downloadMode", "Asked for download mode. Open the M-Flasher + app on a computer.")));
  $("more").replaceChildren(...more);
  // Before a read there are no operations, only the way to the computer app.
  $("operations").hidden = !(read || loader || more.length);
  $("ops").hidden = !(read || loader);
  setOp($("op-backup"), { disabled: !read, onClick: () => attempt(saveBackup) });
  setOp($("op-restore"), { disabled: !canWrite, state: state.form === "restore" ? "selected" : "default", onClick: () => openForm("restore") });
  setOp($("op-firmware"), { disabled: !(canWrite || loader), state: state.form === "firmware" ? "selected" : "default", onClick: () => (loader ? installFirmware() : openForm("firmware")) });
}

function renderForm() {
  const kind = state.form;
  $("form").hidden = !kind;
  if (!kind) return;
  const firmware = kind === "firmware";
  $("form-label").textContent = firmware ? "Firmware file (.fwsc)" : "Backup file (.bin)";
  $("form-choose").textContent = firmware ? "Choose file" : "Choose .bin";
  $("form-choose").disabled = state.busy;
  $("form-choose").onclick = () => attempt(chooseForForm);
  $("form-field").textContent = state.fileName ?? (firmware ? "No file chosen" : "A backup of this unit, usually in Downloads");
  const plan = state.plan;
  const go = $("form-go");
  go.disabled = state.busy || !plan || !plan.sectors.length;
  go.textContent = !plan ? (firmware ? "Install firmware" : "Restore backup")
    : !plan.sectors.length ? "Nothing to write"
      : `${firmware ? "Install firmware" : "Restore backup"} · review ${plan.sectors.length} sectors`;
  go.onclick = () => attempt(() => applyPlan(plan));
}

function renderMap() {
  const a = state.analysis;
  const map = a ? sectorMap(state.flash, state.info.key, a.board) : new Array(256).fill("free");
  const marked = new Set((state.plan?.sectors ?? []).map((addr) => addr >> 12));
  const grid = $("map");
  grid.classList.toggle("empty", !a);
  const cells = [document.createElement("span")];
  for (let c = 0; c < 16; c++) {
    const h = document.createElement("span");
    h.className = "h";
    h.textContent = c.toString(16).toUpperCase();
    cells.push(h);
  }
  for (let r = 0; r < 16; r++) {
    const h = document.createElement("span");
    h.className = "h rh";
    h.textContent = `${r.toString(16).toUpperCase()}0`;
    cells.push(h);
    for (let c = 0; c < 16; c++) {
      const s = r * 16 + c;
      const cell = document.createElement("span");
      cell.className = marked.has(s) ? "cell change" : "cell";
      cell.dataset.region = map[s];
      cell.title = `${s.toString(16).toUpperCase().padStart(2, "0")} · ${REGION_NAMES[map[s]]}`;
      cells.push(cell);
    }
  }
  grid.replaceChildren(...cells);
  // Before a read, the legend shows the FM-1's stock layout, as the design does.
  const legendMap = a ? map : (stockLegend ??= sectorMap(new Uint8Array(0x100000).fill(0xff), CHIP_KEY, FM1));
  $("legend").replaceChildren(...REGIONS.filter((r) => legendMap.includes(r)).map((r) => {
    const li = document.createElement("li");
    const sw = document.createElement("span");
    sw.className = "cell";
    sw.dataset.region = r;
    li.append(sw, `${REGION_NAMES[r]} ${regionRanges(legendMap, r)}`);
    return li;
  }));
  const note = $("change-note");
  const plan = state.plan;
  note.classList.toggle("marked", Boolean(plan?.sectors.length));
  note.textContent = plan?.sectors.length
    ? `Marked: ${plan.sectors.length} sectors change (${rangesText(plan.runs)}). Boot area and MAC kept: the browser never writes them.`
    : plan ? "Nothing to write: the unit already holds this"
      : `Nothing marked: choose a ${state.form === "restore" ? "backup" : "file"} to see what changes`;
}

function renderSafety() {
  const a = state.analysis;
  $("safety").hidden = !a;
  if (!a) return;
  const open = a.bootloaderKind === "open";
  const rows = [
    ["Recovery", open ? `${bootloaderVersion()} · REC: download mode · PLAY: menu` : "stock bootloader: no recovery from the keys", open,
      open || state.mode !== "stage" ? null : ["Install", installBootloader]],
    ["Backup", state.backupSaved ? `saved · ${state.backupName} (Downloads)` : "none of this session yet · saves to Downloads", state.backupSaved,
      state.backupSaved ? null : ["Save", () => attempt(saveBackup)]],
    ["Firmware", `${a.firmwareText} · ${a.appStatus === "OK" ? "checks OK" : a.appStatusText}`, a.appStatus === "OK", null],
    ["Chip", `chip key ${hex(state.info.key, 4)} · flash ${flashText(state.info.jedec)}`, flashTested(state.info.jedec), null],
  ];
  const attention = rows.filter((r) => !r[2]).length;
  const count = $("safety-count");
  count.textContent = attention ? `${attention} need attention` : "All clear";
  count.className = attention ? "" : "clear";
  $("safety-rows").replaceChildren(...rows.map(([name, detail, ok, act]) => {
    const li = document.createElement("li");
    li.className = ok ? "ok" : "attention";
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.innerHTML = ICONS[ok ? "check-ok" : "check-attention"];
    const text = document.createElement("div");
    text.className = "text";
    const n = document.createElement("p");
    n.className = "name";
    n.textContent = name.toUpperCase();
    const d = document.createElement("p");
    d.className = "detail";
    d.textContent = detail;
    text.append(n, d);
    li.append(mark, text);
    if (act) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn";
      b.textContent = act[0];
      b.disabled = state.busy;
      b.onclick = act[1];
      li.append(b);
    }
    return li;
  }));
}

function render() {
  renderLcd();
  renderNotice();
  const a = state.analysis;
  const own = hasOwnUpdater(state.identity);
  const firstSelected = state.mode === "none" || (state.mode === "firmware" && !own);
  setOp($("check-button"), { label: CHECK, state: firstSelected ? "selected" : "default", disabled: !state.supported, onClick: onCheck });
  const boot = $("bootloader-button");
  if (a && a.bootloaderKind === "open") {
    setOp(boot, { label: `${bootloaderVersion()}\ninstalled ✓`, disabled: true });
  } else {
    const can = (state.mode === "firmware" && !own) || (state.mode === "stage" && Boolean(a?.board));
    setOp(boot, { label: "Install m-bootloader", state: a && can ? "selected" : "default", disabled: !can, onClick: installBootloader });
  }
  renderInfo();
  renderOperations();
  renderForm();
  renderSteps();
  renderMap();
  renderSafety();
  document.body.dataset.mode = state.mode;
  document.body.dataset.busy = String(state.busy);
}

// The first button is always Check FM-1 status: it finds the unit and, on firmware, starts the tools to read it.
function onCheck() {
  status("");
  if (!state.access) return connect();
  if (state.mode === "firmware" && !hasOwnUpdater(state.identity)) return startTools();
  return scan();
}

for (const el of document.querySelectorAll("[data-icon]")) {
  const svg = ICONS[el.dataset.icon];
  if (!svg || el.querySelector("svg")) continue;
  if (el.classList.contains("op")) el.insertAdjacentHTML("afterbegin", `<span class="icon">${svg}</span>`);
  else el.innerHTML = svg;
}
const about = () => message("M-Flasher + web beta",
  "Back up, restore and install the firmware of the M-VAVE FM-1 and SMK-37 from the browser, over USB MIDI, and install m-bootloader. Nothing leaves your device.\n\nM-Flasher + by Wellington Saam. Based on M-Flasher by Julius Vitkauskas (MIT).\nUnofficial: not affiliated with M-VAVE or JieLi.");
$("about-tab").onclick = about;
$("about-tab-mobile").onclick = about;
$("port-select").onchange = async () => {
  closeLink();
  const ports = findPorts(state.access);
  await open(ports[Number($("port-select").value)]);
};
document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.busy) log("This tab went to the background: browsers slow it down, so an update may take far longer. Bring it back.");
});
log(state.supported ? "M-Flasher + (web beta) · Web MIDI OK" : "This browser has no Web MIDI: nothing can reach the unit");
render();
// For checking the design without a unit: a script that sets this hook before loading app.js gets the page's state.
window.__MFLASHER_PREVIEW__?.({ state, render, progress, setStep });
