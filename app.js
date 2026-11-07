'use strict';

/* ================= Daten ================= */

const SPEICHER = 'rezepte.daten';

function leereDaten() {
  return {
    version: 1,
    rezepte: [],
    einkauf: [],
    plan: [],   // Wochenplan: { id, datum: 'JJJJ-MM-TT', rezept: Rezept-ID oder '', name, geaendert }
    einstellungen: { proxy: '', sync: null },
    // Lokale Änderungen, die noch nicht im Google Sheet angekommen sind (nach Art und ID).
    ausstehend: { rezepte: {}, einkauf: {}, plan: {} },
  };
}

function ladeDaten() {
  try {
    const d = JSON.parse(localStorage.getItem(SPEICHER));
    if (d && Array.isArray(d.rezepte)) {
      const leer = leereDaten();
      return {
        ...leer,
        ...d,
        einkauf: Array.isArray(d.einkauf) ? d.einkauf : [],
        plan: Array.isArray(d.plan) ? d.plan : [],
        einstellungen: { ...leer.einstellungen, ...(d.einstellungen || {}) },
        ausstehend: { ...leer.ausstehend, ...(d.ausstehend || {}) },
      };
    }
  } catch (e) { /* leer anfangen */ }
  return leereDaten();
}

let daten = ladeDaten();

function speichere() {
  try {
    localStorage.setItem(SPEICHER, JSON.stringify(daten));
    return true;
  } catch (e) {
    zeigeStatus('Speicher voll – bitte unter ⚙ eine Sicherung exportieren und alte Rezepte löschen.', 6000);
    return false;
  }
}

function neueId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function rezeptMitId(id) {
  return daten.rezepte.find((r) => r.id === id);
}

/* ================= Gemeinsam nutzen über Google Sheets ================= */

const SKRIPT_RE = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/\s]+|macros)\/s\/[\w-]+\/exec$/;
// Version von apps-script/Code.gs, die alles kann, was diese App ins Sheet schreibt.
const SKRIPT_VERSION = 4;
let veraltetGemeldet = false;

function veraltetHinweis(antwort) {
  const v = Number(antwort && antwort.version) || 1;
  return v < SKRIPT_VERSION
    ? 'Im Google Sheet läuft noch ein altes Script. Sammlungen, Fotos und Wochenplan bleiben bis zum Update nur auf diesem Handy. Bitte die neue Code.gs einspielen (Anleitung: „Script ändern“).'
    : '';
}

function verbunden() {
  return Boolean(daten.einstellungen.sync && daten.einstellungen.sync.url && daten.einstellungen.sync.schluessel);
}

// Nach jeder lokalen Änderung aufrufen: merkt sie für den Abgleich vor und speichert.
function merke(art, eintrag) {
  eintrag.geaendert = Date.now();
  if (verbunden()) daten.ausstehend[art][eintrag.id] = JSON.parse(JSON.stringify(eintrag));
  planeAbgleich();
}

function merkeGeloescht(art, id) {
  if (verbunden()) daten.ausstehend[art][id] = { id, geloescht: true, geaendert: Date.now() };
  planeAbgleich();
}

function zufallsSchluessel() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

class SkriptFehler extends Error {
  constructor(text, code = '') {
    super(text);
    this.code = code;
  }
}

async function rufeSkript(nutzlast, zugang = daten.einstellungen.sync, zeit = 45000) {
  const ctl = new AbortController();
  const uhr = setTimeout(() => ctl.abort(), zeit);
  let antwort;
  try {
    // text/plain vermeidet die CORS-Vorabfrage, die Apps Script nicht beantwortet.
    antwort = await fetch(zugang.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...nutzlast, schluessel: zugang.schluessel }),
      signal: ctl.signal,
      credentials: 'omit',
    });
  } catch (e) {
    throw new SkriptFehler(navigator.onLine === false
      ? 'Keine Internetverbindung.'
      : 'Das Google Sheet ist nicht erreichbar. Stimmt die Adresse, und ist die Web-App für „Jeder“ freigegeben?', 'netz');
  } finally {
    clearTimeout(uhr);
  }
  let json;
  try {
    json = await antwort.json();
  } catch (e) {
    throw new SkriptFehler('Die Web-App antwortet nicht richtig. Ist sie für „Jeder“ freigegeben?', 'format');
  }
  if (!json || !json.ok) throw new SkriptFehler((json && json.fehler) || 'Unbekannter Fehler im Script.', json && json.code);
  return json;
}

let abgleichUhr = null;
let abgleichLaeuft = null;
let abgleichNochmal = false;
let letzterVersuch = 0;

function planeAbgleich(verzoegerung = 1200) {
  if (!verbunden()) return;
  clearTimeout(abgleichUhr);
  abgleichUhr = setTimeout(() => gleicheAb(), verzoegerung);
}

function setzeSyncAnzeige(zustand) {
  const knopf = $('#sync');
  knopf.hidden = !verbunden();
  knopf.className = `kopf-knopf ${zustand || ''}`;
  knopf.textContent = zustand === 'fehler' ? '⚠' : '☁';
  knopf.setAttribute('aria-label', zustand === 'fehler' ? 'Abgleich fehlgeschlagen – erneut versuchen' : 'Jetzt abgleichen');
  knopf.title = knopf.getAttribute('aria-label');
}

// Nimmt den Stand aus dem Sheet und legt die noch nicht übertragenen eigenen Änderungen darüber.
function uebernimmStand(antwort, gesendet) {
  for (const art of ['rezepte', 'einkauf', 'plan']) {
    // Ein älteres Script kennt z. B. den Wochenplan noch nicht: dann bleibt er hier und wartet.
    if (!Array.isArray(antwort[art])) continue;
    const offen = daten.ausstehend[art];
    for (const e of gesendet[art]) {
      if (offen[e.id] && offen[e.id].geaendert === e.geaendert) delete offen[e.id];
    }
    const stand = new Map();
    for (const e of Array.isArray(antwort[art]) ? antwort[art] : []) if (e && e.id) stand.set(String(e.id), e);
    for (const e of Object.values(offen)) stand.set(e.id, e);
    const liste = [...stand.values()].filter((e) => !e.geloescht);
    if (art === 'rezepte') {
      // Felder, die das Script nicht mitschickt (ältere Version ohne z. B. Sammlungen oder Fotos),
      // behalten ihren Wert vom Handy, statt geleert zu werden.
      const lokal = new Map(daten.rezepte.map((r) => [r.id, r]));
      daten.rezepte = liste.map((r) => {
        const m = { ...neuesRezept({}), ...(lokal.get(String(r.id)) || {}), ...r };
        return { ...m, zutaten: alsListe(m.zutaten), schritte: alsListe(m.schritte), kategorien: alsListe(m.kategorien), sammlungen: alsListe(m.sammlungen) };
      });
    } else if (art === 'einkauf') {
      daten.einkauf = liste.map((p) => ({ id: p.id, text: String(p.text || ''), erledigt: Boolean(p.erledigt), rezept: p.rezept || '', geaendert: p.geaendert || 0 }));
    } else {
      daten.plan = liste.filter((p) => ISO_TAG.test(p.datum || ''))
        .map((p) => ({ id: p.id, datum: p.datum, rezept: p.rezept || '', name: String(p.name || ''), geaendert: p.geaendert || 0 }));
    }
  }
}

async function gleicheAb({ laut = false, aktion = 'abgleich' } = {}) {
  if (!verbunden()) return false;
  if (abgleichLaeuft) {
    abgleichNochmal = true;
    return abgleichLaeuft;
  }
  clearTimeout(abgleichUhr);
  letzterVersuch = Date.now();
  abgleichLaeuft = (async () => {
    setzeSyncAnzeige('laeuft');
    const sync = daten.einstellungen.sync;
    try {
      let fotoFehler = '';
      try {
        await ladeFotosHoch(sync);
      } catch (e) {
        if (e.code === 'netz' || e.code === 'schluessel') throw e;
        fotoFehler = e.message;
      }
      if (daten.einstellungen.sync !== sync) return false;
      // Rezepte, deren Foto noch nicht hochgeladen ist, warten auf den nächsten Abgleich.
      const gesendet = {
        rezepte: Object.values(daten.ausstehend.rezepte).filter((e) => !istLokalesFoto(e.foto)),
        einkauf: Object.values(daten.ausstehend.einkauf),
        plan: Object.values(daten.ausstehend.plan),
      };
      const antwort = await rufeSkript({ aktion, ...gesendet });
      if (daten.einstellungen.sync !== sync) return false;   // inzwischen getrennt
      const vorher = JSON.stringify([daten.rezepte, daten.einkauf, daten.plan]);
      uebernimmStand(antwort, gesendet);
      sync.zuletzt = Date.now();
      const veraltet = veraltetHinweis(antwort);
      sync.fehler = fotoFehler || veraltet;
      // Script wurde aktualisiert: Was das alte nicht speichern konnte (Sammlungen, Fotos), einmal nachschicken.
      const alteVersion = Number(sync.version) || 0;
      sync.version = Number(antwort.version) || 1;
      if (alteVersion < SKRIPT_VERSION && sync.version >= SKRIPT_VERSION) {
        for (const r of daten.rezepte) {
          if (!daten.ausstehend.rezepte[r.id]) daten.ausstehend.rezepte[r.id] = JSON.parse(JSON.stringify(r));
        }
        abgleichNochmal = true;
      }
      speichere();
      if (JSON.stringify([daten.rezepte, daten.einkauf, daten.plan]) !== vorher) zeichneNachAbgleich();
      setzeSyncAnzeige(sync.fehler ? 'fehler' : 'ok');
      if (fotoFehler) zeigeStatus(fotoFehler, 7000);
      else if (veraltet && (laut || !veraltetGemeldet)) {
        veraltetGemeldet = true;
        zeigeStatus(veraltet, 9000);
      }
      else if (laut) zeigeStatus('Mit dem Google Sheet abgeglichen.');
      raeumeFotosAuf();
      holeFehlendeFotos();
      return true;
    } catch (e) {
      if (daten.einstellungen.sync !== sync) return false;
      sync.fehler = e.message;
      speichere();
      setzeSyncAnzeige('fehler');
      if (laut || e.code === 'schluessel') zeigeStatus(e.message, 6000);
      return false;
    } finally {
      abgleichLaeuft = null;
      if (abgleichNochmal) {
        abgleichNochmal = false;
        planeAbgleich(300);
      }
      if ($('#dlg-einstellungen').open) zeichneSyncEinstellungen();
    }
  })();
  return abgleichLaeuft;
}

function zeichneNachAbgleich() {
  aktualisiereEinkaufZahl();
  if (ansicht === 'liste') zeichneListe();
  else if (ansicht === 'sammlung') zeichneSammlung();
  else if (ansicht === 'einkauf') zeichneEinkauf();
  else if (ansicht === 'plan') zeichnePlan();
  else if (ansicht === 'rezept') {
    if (offenesRezept && rezeptMitId(offenesRezept.id)) zeichneRezept();
    else zeigeAnsicht('liste');
  }
}

// Verbindet dieses Handy. Ohne Schlüssel (erstes Handy) wird einer erzeugt und im Script hinterlegt.
async function verbinde(url, schluessel) {
  const zugang = { url, schluessel: schluessel || zufallsSchluessel(), zuletzt: 0, fehler: '' };
  // Alles, was schon auf diesem Handy ist, kommt ins Sheet.
  const ausstehend = { rezepte: {}, einkauf: {}, plan: {} };
  for (const r of daten.rezepte) ausstehend.rezepte[r.id] = { ...r, geaendert: r.geaendert || Date.now() };
  for (const p of daten.einkauf) ausstehend.einkauf[p.id] = { ...p, geaendert: p.geaendert || Date.now() };
  for (const p of daten.plan) ausstehend.plan[p.id] = { ...p, geaendert: p.geaendert || Date.now() };
  // Rezepte mit neuem Foto folgen gleich danach, wenn der Schlüssel im Script steht und das Foto hochgeladen ist.
  const gesendet = {
    rezepte: Object.values(ausstehend.rezepte).filter((e) => !istLokalesFoto(e.foto)),
    einkauf: Object.values(ausstehend.einkauf),
    plan: Object.values(ausstehend.plan),
  };
  const antwort = await rufeSkript({ aktion: 'einrichten', ...gesendet }, zugang);
  daten.einstellungen.sync = zugang;
  daten.ausstehend = ausstehend;
  uebernimmStand(antwort, gesendet);
  zugang.zuletzt = Date.now();
  zugang.version = Number(antwort.version) || 1;
  zugang.fehler = veraltetHinweis(antwort);
  speichere();
  setzeSyncAnzeige(zugang.fehler ? 'fehler' : 'ok');
  if (zugang.fehler) setTimeout(() => zeigeStatus(zugang.fehler, 9000), 5500);
  zeichneNachAbgleich();
  if (gesendet.rezepte.length < Object.keys(ausstehend.rezepte).length) planeAbgleich(300);
  else holeFehlendeFotos();
  return antwort;
}

function trenne() {
  daten.einstellungen.sync = null;
  daten.ausstehend = { rezepte: {}, einkauf: {}, plan: {} };
  speichere();
  setzeSyncAnzeige();
}

function einladungsLink() {
  const { url, schluessel } = daten.einstellungen.sync;
  const daten64 = btoa(JSON.stringify({ u: url, k: schluessel })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // Im #-Teil, damit der Schlüssel nie an GitHub geschickt wird.
  return `${location.origin}${location.pathname}#verbinden=${daten64}`;
}

function leseEinladung() {
  const m = location.hash.match(/verbinden=([\w-]+)/);
  if (!m) return null;
  history.replaceState(history.state, '', location.pathname + location.search);
  try {
    const roh = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const e = JSON.parse(atob(roh + '='.repeat((4 - (roh.length % 4)) % 4)));
    if (SKRIPT_RE.test(e.u) && typeof e.k === 'string' && e.k.length >= 16) return { url: e.u, schluessel: e.k };
  } catch (err) { /* ungültig */ }
  zeigeStatus('Der Einladungs-Link ist unvollständig. Bitte noch einmal schicken lassen.', 5000);
  return null;
}

/* ================= Eigene Fotos ================= */

// Fotos liegen im Cache-Speicher des Browsers (localStorage hat nur ~5 MB).
// Ein neues Foto heißt erst „lokal-…“; nach dem Hochladen ins Google Drive trägt es die Drive-ID.
const FOTO_CACHE = 'rezepte-fotos';
const FOTO_BASIS = new URL('foto/', location.href).href;
const FOTO_MAX_KANTE = 1280;
const fotoUrls = new Map();        // Foto-ID → Objekt-URL zum Anzeigen
const fotoLaden = new Map();       // Foto-ID → laufendes Laden
const fotoFehlschlag = new Map();  // Foto-ID → Zeitpunkt des letzten erfolglosen Downloads
const fotosInArbeit = new Set();   // gerade gespeicherte Fotos, die das Aufräumen nicht anfassen darf
let downloadsAktiv = 0;
const downloadWarteschlange = [];

function fotosMoeglich() {
  return 'caches' in window;
}

function istLokalesFoto(id) {
  return typeof id === 'string' && id.startsWith('lokal-');
}

function fotoAdresse(id) {
  return FOTO_BASIS + encodeURIComponent(id);
}

async function fotoBlob(id) {
  if (!id || !fotosMoeglich()) return null;
  try {
    const treffer = await (await caches.open(FOTO_CACHE)).match(fotoAdresse(id));
    return treffer ? await treffer.blob() : null;
  } catch (e) { return null; }
}

async function speichereFoto(id, blob) {
  const cache = await caches.open(FOTO_CACHE);
  await cache.put(fotoAdresse(id), new Response(blob, { headers: { 'Content-Type': blob.type || 'image/jpeg' } }));
}

function bildLaden(datei) {
  return new Promise((ja, nein) => {
    const img = new Image();
    const u = URL.createObjectURL(datei);
    img.onload = () => { URL.revokeObjectURL(u); ja(img); };
    img.onerror = () => { URL.revokeObjectURL(u); nein(new Error('kein Bild')); };
    img.src = u;
  });
}

// Handyfotos (4–8 MB) auf höchstens 1280 Pixel verkleinern, das ergibt etwa 150–300 KB.
async function verkleinereFoto(datei) {
  let quelle;
  try {
    quelle = await createImageBitmap(datei, { imageOrientation: 'from-image' });
  } catch (e) {
    quelle = await bildLaden(datei);
  }
  const b = quelle.width;
  const h = quelle.height;
  if (!b || !h) throw new Error('kein Bild');
  const mass = Math.min(1, FOTO_MAX_KANTE / Math.max(b, h));
  const leinwand = document.createElement('canvas');
  leinwand.width = Math.round(b * mass);
  leinwand.height = Math.round(h * mass);
  const ctx = leinwand.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, leinwand.width, leinwand.height);
  ctx.drawImage(quelle, 0, 0, leinwand.width, leinwand.height);
  if (quelle.close) quelle.close();
  return new Promise((ja, nein) => leinwand.toBlob((blob) => (blob ? ja(blob) : nein(new Error('kein Bild'))), 'image/jpeg', 0.82));
}

function blobAlsBase64(blob) {
  return new Promise((ja, nein) => {
    const leser = new FileReader();
    leser.onload = () => ja(String(leser.result).replace(/^data:[^,]*,/, ''));
    leser.onerror = () => nein(leser.error);
    leser.readAsDataURL(blob);
  });
}

function base64AlsBlob(daten, typ) {
  const roh = atob(daten);
  const bytes = new Uint8Array(roh.length);
  for (let i = 0; i < roh.length; i++) bytes[i] = roh.charCodeAt(i);
  return new Blob([bytes], { type: typ || 'image/jpeg' });
}

// Nicht mehr als zwei Fotos gleichzeitig vom Google Sheet holen.
function mitDownloadPlatz(aufgabe) {
  return new Promise((ja, nein) => {
    const starte = () => {
      downloadsAktiv++;
      aufgabe().then(ja, nein).finally(() => {
        downloadsAktiv--;
        if (downloadWarteschlange.length) downloadWarteschlange.shift()();
      });
    };
    if (downloadsAktiv < 2) starte();
    else downloadWarteschlange.push(starte);
  });
}

async function ladeFotoHerunter(id) {
  const zuletzt = fotoFehlschlag.get(id);
  if (zuletzt && Date.now() - zuletzt < 5 * 60 * 1000) return null;
  try {
    const antwort = await mitDownloadPlatz(() => rufeSkript({ aktion: 'foto', id }, daten.einstellungen.sync, 60000));
    if (!antwort.daten) throw new Error('kein Foto');
    let blob = base64AlsBlob(antwort.daten, antwort.typ);
    // Von Hand in Drive gelegte Fotos können riesig sein.
    if (blob.size > 600 * 1024) blob = await verkleinereFoto(blob).catch(() => blob);
    await speichereFoto(id, blob);
    fotoFehlschlag.delete(id);
    return blob;
  } catch (e) {
    fotoFehlschlag.set(id, Date.now());
    return null;
  }
}

// Objekt-URL zum Anzeigen; holt das Foto bei Bedarf aus dem Google Sheet.
function fotoUrl(id) {
  if (fotoUrls.has(id)) return Promise.resolve(fotoUrls.get(id));
  if (!fotoLaden.has(id)) {
    fotoLaden.set(id, (async () => {
      let blob = await fotoBlob(id);
      if (!blob && !istLokalesFoto(id) && verbunden()) blob = await ladeFotoHerunter(id);
      if (!blob) return '';
      const u = URL.createObjectURL(blob);
      fotoUrls.set(id, u);
      return u;
    })().finally(() => fotoLaden.delete(id)));
  }
  return fotoLaden.get(id);
}

// Setzt in einem frisch gezeichneten Bereich die Fotos ein, sobald sie geladen sind.
function fuelleFotos(wurzel) {
  for (const img of wurzel.querySelectorAll('img[data-foto]:not([src])')) {
    fotoUrl(img.dataset.foto).then((u) => {
      if (u) img.src = u;
      else if (img.dataset.ersatz) img.src = img.dataset.ersatz;
      else if (img.parentNode) img.parentNode.textContent = '🍲';
    });
  }
}

function alleFotoIds() {
  const ids = new Set(fotosInArbeit);
  for (const r of daten.rezepte) if (r.foto) ids.add(r.foto);
  for (const e of Object.values(daten.ausstehend.rezepte)) if (e.foto) ids.add(e.foto);
  return ids;
}

// Fotos gelöschter oder ersetzter Rezepte vom Handy entfernen.
async function raeumeFotosAuf() {
  if (!fotosMoeglich()) return;
  try {
    const cache = await caches.open(FOTO_CACHE);
    const ids = alleFotoIds();
    for (const anfrage of await cache.keys()) {
      const id = decodeURIComponent(anfrage.url.slice(anfrage.url.lastIndexOf('/') + 1));
      if (ids.has(id)) continue;
      await cache.delete(anfrage);
      if (fotoUrls.has(id)) {
        URL.revokeObjectURL(fotoUrls.get(id));
        fotoUrls.delete(id);
      }
    }
  } catch (e) { /* beim nächsten Mal */ }
}

// Nach dem Hochladen bekommt das Foto seine Drive-ID – überall umbenennen.
async function benenneFotoUm(alt, neu) {
  const blob = await fotoBlob(alt);
  if (blob) await speichereFoto(neu, blob);
  if (fotoUrls.has(alt)) {
    fotoUrls.set(neu, fotoUrls.get(alt));
    fotoUrls.delete(alt);
  }
  for (const r of daten.rezepte) if (r.foto === alt) r.foto = neu;
  for (const e of Object.values(daten.ausstehend.rezepte)) if (e.foto === alt) e.foto = neu;
  speichere();
  if (blob) await (await caches.open(FOTO_CACHE)).delete(fotoAdresse(alt));
}

// Lädt neue Fotos ins Google Drive, bevor ihre Rezepte abgeglichen werden.
async function ladeFotosHoch(zugang) {
  for (const e of Object.values(daten.ausstehend.rezepte)) {
    if (!istLokalesFoto(e.foto)) continue;
    const id = e.foto;
    const blob = await fotoBlob(id);
    if (!blob) {
      // Foto ging auf dem Handy verloren: Rezept ohne Foto weitergeben.
      for (const r of daten.rezepte) if (r.foto === id) r.foto = '';
      for (const x of Object.values(daten.ausstehend.rezepte)) if (x.foto === id) x.foto = '';
      speichere();
      continue;
    }
    const antwort = await rufeSkript({ aktion: 'foto-hoch', daten: await blobAlsBase64(blob), typ: blob.type || 'image/jpeg', name: e.titel || 'Rezept' }, zugang, 90000);
    if (!antwort.fotoId) {
      throw new SkriptFehler('Fotos brauchen die neue Version des Google-Scripts (siehe Anleitung, „Script ändern“). Bis dahin bleiben Rezepte mit neuem Foto nur auf diesem Handy.', 'version');
    }
    await benenneFotoUm(id, antwort.fotoId);
  }
}

// Nach dem Abgleich alle fehlenden Fotos im Hintergrund holen, damit sie auch offline da sind.
async function holeFehlendeFotos() {
  if (!fotosMoeglich() || !verbunden()) return;
  for (const r of daten.rezepte) {
    if (!r.foto || istLokalesFoto(r.foto) || fotoUrls.has(r.foto)) continue;
    if (!(await fotoBlob(r.foto))) await fotoUrl(r.foto);
  }
}

/* ================= Hilfen ================= */

const $ = (sel) => document.querySelector(sel);

function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let statusUhr;
function zeigeStatus(text, dauer = 3000) {
  const el = $('#status');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(statusUhr);
  statusUhr = setTimeout(() => { el.hidden = true; }, dauer);
}

// Text aus HTML-Schnipseln: Tags weg, &amp; & Co. auflösen, Leerraum glätten.
const zerleger = new DOMParser();
function reinText(wert, zeilenBehalten = false) {
  if (wert == null) return '';
  let s = String(wert);
  if (/[<&]/.test(s)) {
    if (zeilenBehalten) s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div)>/gi, '\n\n');
    s = zerleger.parseFromString(s, 'text/html').body.textContent || '';
  }
  s = s.replace(/ /g, ' ');
  if (zeilenBehalten) {
    return s.split('\n').map((z) => z.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  return s.replace(/\s+/g, ' ').trim();
}

function alsListe(wert) {
  if (wert == null) return [];
  return Array.isArray(wert) ? wert : [wert];
}

function absoluteUrl(adresse, basis) {
  if (!adresse) return '';
  try {
    const u = new URL(String(adresse).trim(), basis);
    return /^https?:$/.test(u.protocol) ? u.href : '';
  } catch (e) { return ''; }
}

function domain(adresse) {
  try { return new URL(adresse).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

// ISO-8601-Dauer wie PT1H30M oder P0DT0H20M in Minuten.
function isoMinuten(wert) {
  if (wert == null) return null;
  if (typeof wert === 'number') return wert > 0 ? Math.round(wert) : null;
  const m = String(wert).trim().match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!m) {
    const zahl = parseInt(wert, 10);
    return zahl > 0 ? zahl : null;
  }
  const min = (parseFloat(m[1] || 0) * 1440) + (parseFloat(m[2] || 0) * 60) + parseFloat(m[3] || 0) + (parseFloat(m[4] || 0) / 60);
  return min > 0 ? Math.round(min) : null;
}

function zeitText(min) {
  if (!min) return '';
  if (min < 60) return `${min} Min.`;
  const tage = Math.floor(min / 1440);
  const std = Math.floor((min % 1440) / 60);
  const rest = min % 60;
  const teile = [];
  if (tage) teile.push(`${tage} ${tage === 1 ? 'Tag' : 'Tage'}`);
  if (std) teile.push(`${std} Std.`);
  if (rest) teile.push(`${rest} Min.`);
  return teile.join(' ');
}

function gesamtMinuten(r) {
  return r.gesamtzeit || ((r.arbeitszeit || 0) + (r.kochzeit || 0)) || null;
}

/* ================= Mengen umrechnen ================= */

const BRUECHE = { '½': 1 / 2, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 1 / 4, '¾': 3 / 4, '⅕': 1 / 5, '⅙': 1 / 6, '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8 };
const BRUCH_ZEICHEN = Object.keys(BRUECHE).join('');
const ZAHL = `(?:\\d+\\s+\\d+\\s*\\/\\s*\\d+|\\d+\\s*\\/\\s*\\d+|\\d+(?:[.,]\\d+)?\\s*[${BRUCH_ZEICHEN}]?|[${BRUCH_ZEICHEN}])`;
const MENGE_RE = new RegExp(`^(${ZAHL})(?:\\s*(?:-|–|bis)\\s*(${ZAHL}))?`);
const EINHEITEN = [
  'kg', 'g', 'mg', 'ml', 'cl', 'dl', 'l', 'Liter', 'Gramm', 'Kilo', 'Pfund', 'EL', 'TL', 'Essl\\.?', 'Teel\\.?', 'Esslöffel', 'Teelöffel',
  'Msp\\.?', 'Messerspitzen?', 'Prisen?', 'Pck\\.?', 'Pkt\\.?', 'Päckchen', 'Packung(?:en)?', 'Becher', 'Dosen?', 'Gläser', 'Glas',
  'Stk\\.?', 'Stück', 'Bund', 'Bd\\.?', 'Zehen?', 'Tassen?', 'Scheiben?', 'Würfel', 'Handvoll', 'Zweige?', 'Stangen?', 'Köpfe', 'Kopf',
  'Blätter', 'Blatt', 'Spritzer', 'Schuss', 'Tropfen', 'Flaschen?', 'Beutel', 'Knollen?', 'Tüten?', 'Rollen?', 'Stiele?', 'Platten?',
  'Tafeln?', 'Riegel', 'Cups?', 'tbsp', 'tsp', 'oz', 'lb', 'cm',
];
const EINHEIT_RE = new RegExp(`^(?:${EINHEITEN.join('|')})(?=[\\s,(]|$)`, 'i');
const OHNE_MENGE_RE = /^(n\.\s?B\.|nach Belieben|etwas|evtl\.|optional|einige|ca\.)(?=\s|$)/i;

function zahlWert(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  let m = t.match(/^(\d+) (\d+) ?\/ ?(\d+)$/);
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = t.match(/^(\d+) ?\/ ?(\d+)$/);
  if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : null;
  m = t.match(new RegExp(`^(\\d+(?:[.,]\\d+)?)? ?([${BRUCH_ZEICHEN}])?$`));
  if (m && (m[1] || m[2])) return (m[1] ? parseFloat(m[1].replace(',', '.')) : 0) + (m[2] ? BRUECHE[m[2]] : 0);
  return null;
}

function formatZahl(x) {
  if (x >= 20) return String(Math.round(x));
  if (x >= 10) return String(Math.round(x * 2) / 2).replace('.', ',');
  const ganz = Math.floor(x);
  const rest = x - ganz;
  const brueche = [[0, ''], [1 / 4, '¼'], [1 / 3, '⅓'], [1 / 2, '½'], [2 / 3, '⅔'], [3 / 4, '¾'], [1, '']];
  for (const [wert, zeichen] of brueche) {
    if (Math.abs(rest - wert) < 0.03) {
      const g = wert === 1 ? ganz + 1 : ganz;
      if (!zeichen) return String(g);
      return g ? `${g}${zeichen}` : zeichen;
    }
  }
  return String(Math.round(x * 10) / 10).replace('.', ',');
}

// Zerlegt "500 g Mehl (Type 405)" in Menge, Einheit und Rest; Faktor rechnet die Menge um.
function zerlegeZutat(text, faktor = 1) {
  const t = text.trim();
  const m = t.match(MENGE_RE);
  if (!m) {
    const o = t.match(OHNE_MENGE_RE);
    if (o) return { menge: o[1], rest: t.slice(o[0].length).trim(), skaliert: false };
    return { menge: '', rest: t, skaliert: false };
  }
  let rest = t.slice(m[0].length).trim();
  let menge = m[0];
  const a = zahlWert(m[1]);
  const b = m[2] ? zahlWert(m[2]) : null;
  if (faktor !== 1 && a != null && (m[2] == null || b != null)) {
    menge = formatZahl(a * faktor) + (b != null ? `–${formatZahl(b * faktor)}` : '');
  }
  const e = rest.match(EINHEIT_RE);
  if (e) {
    menge += ` ${e[0]}`;
    rest = rest.slice(e[0].length).trim();
  }
  return { menge: menge.trim(), rest, skaliert: a != null };
}

function zutatText(text, faktor) {
  if (faktor === 1) return text;
  const z = zerlegeZutat(text, faktor);
  return [z.menge, z.rest].filter(Boolean).join(' ');
}

function istUeberschrift(zeile) {
  return zeile.startsWith('#');
}

function ueberschriftText(zeile) {
  return zeile.replace(/^#+\s*/, '').replace(/:$/, '');
}

/* ================= Rezept aus einer Webseite lesen ================= */

function istRezeptTyp(obj) {
  return alsListe(obj && obj['@type']).some((t) => /(^|[:/])Recipe$/i.test(String(t)));
}

function sucheRezept(knoten, tiefe = 0) {
  if (!knoten || typeof knoten !== 'object' || tiefe > 6) return null;
  if (Array.isArray(knoten)) {
    for (const k of knoten) {
      const r = sucheRezept(k, tiefe + 1);
      if (r) return r;
    }
    return null;
  }
  if (istRezeptTyp(knoten)) return knoten;
  for (const feld of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item', 'hasPart']) {
    const r = sucheRezept(knoten[feld], tiefe + 1);
    if (r) return r;
  }
  return null;
}

// Alle Knoten mit @id sammeln, damit Verweise wie {"@id": "…#primaryimage"} aufgelöst werden können.
function sammleIds(knoten, index = new Map(), tiefe = 0) {
  if (!knoten || typeof knoten !== 'object' || tiefe > 8) return index;
  if (Array.isArray(knoten)) {
    knoten.forEach((k) => sammleIds(k, index, tiefe + 1));
    return index;
  }
  if (knoten['@id'] && Object.keys(knoten).length > 1 && !index.has(knoten['@id'])) index.set(knoten['@id'], knoten);
  for (const wert of Object.values(knoten)) if (wert && typeof wert === 'object') sammleIds(wert, index, tiefe + 1);
  return index;
}

const BILD_ENDUNG = /\.(jpe?g|png|webp|avif|gif)(\?|$)/i;

function bildAus(wert, basis, index = new Map()) {
  for (let b of alsListe(wert)) {
    if (b && typeof b === 'object' && !b.url && !b.contentUrl && index.has(b['@id'])) b = index.get(b['@id']);
    let adresse = typeof b === 'string' ? b : b && (b.url || b.contentUrl);
    if (!adresse && b && BILD_ENDUNG.test(b['@id'] || '')) adresse = b['@id'];
    const u = absoluteUrl(adresse, basis);
    if (u) return u;
  }
  return '';
}

// recipeInstructions kann Text, HowToStep, HowToSection oder eine Mischung sein.
function schritteAus(wert, ausgabe = []) {
  for (const s of alsListe(wert)) {
    if (s == null) continue;
    if (typeof s === 'string') {
      ausgabe.push(...teileSchritte(reinText(s, true)));
    } else if (alsListe(s['@type']).some((t) => /HowToSection/i.test(t))) {
      const name = reinText(s.name);
      if (name && !/^(zubereitung|anleitung|instructions|directions|method)$/i.test(name)) ausgabe.push(`# ${name}`);
      schritteAus(s.itemListElement || s.steps, ausgabe);
    } else if (s.itemListElement && !s.text) {
      schritteAus(s.itemListElement, ausgabe);
    } else {
      const text = reinText(s.text || s.description || s.name, true);
      if (text) ausgabe.push(...teileSchritte(text));
    }
  }
  return ausgabe;
}

// Schritte durch Leerzeilen trennen; gibt es keine, ist jede Zeile ein Schritt.
function teileSchritte(text) {
  const t = String(text || '').replace(/\r/g, '').trim();
  if (!t) return [];
  const teile = /\n\s*\n/.test(t) ? t.split(/\n\s*\n/) : t.split('\n');
  return teile.map((s) => s.trim()).filter(Boolean);
}

function zahlAus(wert) {
  for (const w of alsListe(wert)) {
    const m = String(w).match(/\d+(?:[.,]\d+)?/);
    if (m) {
      const z = parseFloat(m[0].replace(',', '.'));
      if (z > 0 && z < 1000) return z;
    }
  }
  return null;
}

function kategorienAus(...werte) {
  const liste = [];
  for (const w of werte) {
    for (const eintrag of alsListe(w)) {
      for (const teil of String(eintrag).split(',')) {
        const k = reinText(teil);
        if (k && k.length <= 40 && !liste.some((x) => x.toLowerCase() === k.toLowerCase())) liste.push(k);
      }
    }
  }
  return liste.slice(0, 6);
}

function ausJsonLd(ld, basis, index) {
  const bewertung = ld.aggregateRating && parseFloat(String(ld.aggregateRating.ratingValue).replace(',', '.'));
  const naehrwerte = ld.nutrition || {};
  return {
    titel: reinText(ld.name || ld.headline),
    beschreibung: reinText(ld.description),
    bild: bildAus(ld.image || ld.thumbnailUrl, basis, index),
    portionen: zahlAus(ld.recipeYield || ld.yield),
    arbeitszeit: isoMinuten(ld.prepTime),
    kochzeit: isoMinuten(ld.cookTime),
    gesamtzeit: isoMinuten(ld.totalTime),
    zutaten: alsListe(ld.recipeIngredient || ld.ingredients).map((z) => reinText(typeof z === 'object' ? z.text || z.name : z)).filter(Boolean),
    schritte: schritteAus(ld.recipeInstructions),
    kategorien: kategorienAus(ld.recipeCategory, ld.recipeCuisine),
    kalorien: reinText(naehrwerte.calories),
    bewertung: bewertung > 0 ? {
      wert: Math.round(bewertung * 10) / 10,
      max: parseFloat(ld.aggregateRating.bestRating) || 5,
      anzahl: parseInt(ld.aggregateRating.ratingCount || ld.aggregateRating.reviewCount, 10) || 0,
    } : null,
  };
}

function lesbareJsonLd(doc) {
  const ergebnisse = [];
  for (const skript of doc.querySelectorAll('script[type="application/ld+json"]')) {
    const roh = skript.textContent.trim();
    if (!roh) continue;
    try {
      ergebnisse.push(JSON.parse(roh));
    } catch (e) {
      // Manche Seiten haben Zeilenumbrüche oder Steuerzeichen in Zeichenketten.
      try { ergebnisse.push(JSON.parse(roh.replace(/[\u0000-\u001f]+/g, ' '))); } catch (e2) { /* überspringen */ }
    }
  }
  return ergebnisse;
}

function itemprop(wurzel, name) {
  return [...wurzel.querySelectorAll(`[itemprop~="${name}"]`)];
}

function propWert(el) {
  if (!el) return '';
  return el.getAttribute('content') || el.getAttribute('datetime') || el.getAttribute('src') || el.getAttribute('href') || el.textContent;
}

function ausMicrodata(doc, basis) {
  const wurzel = doc.querySelector('[itemtype*="schema.org/Recipe" i]');
  if (!wurzel) return null;
  const schrittEls = itemprop(wurzel, 'recipeInstructions');
  let schritte = [];
  for (const el of schrittEls) {
    const teile = el.querySelectorAll('li, p, [itemprop="text"]');
    if (teile.length) teile.forEach((t) => schritte.push(...teileSchritte(reinText(t.innerHTML, true))));
    else schritte.push(...teileSchritte(reinText(el.innerHTML, true)));
  }
  schritte = schritte.filter(Boolean);
  return {
    titel: reinText(propWert(itemprop(wurzel, 'name')[0])),
    beschreibung: reinText(propWert(itemprop(wurzel, 'description')[0])),
    bild: absoluteUrl(propWert(itemprop(wurzel, 'image')[0]), basis),
    portionen: zahlAus(propWert(itemprop(wurzel, 'recipeYield')[0])),
    arbeitszeit: isoMinuten(propWert(itemprop(wurzel, 'prepTime')[0])),
    kochzeit: isoMinuten(propWert(itemprop(wurzel, 'cookTime')[0])),
    gesamtzeit: isoMinuten(propWert(itemprop(wurzel, 'totalTime')[0])),
    zutaten: [...itemprop(wurzel, 'recipeIngredient'), ...itemprop(wurzel, 'ingredients')].map((el) => reinText(propWert(el))).filter(Boolean),
    schritte,
    kategorien: kategorienAus(itemprop(wurzel, 'recipeCategory').map(propWert)),
  };
}

// Letzter Versuch: bekannte Rezept-Plugins und Überschriften wie „Zutaten“ / „Zubereitung“.
function ausHtml(doc) {
  const texte = (sel) => [...doc.querySelectorAll(sel)].map((el) => reinText(el.textContent)).filter(Boolean);
  const ersteTreffer = (selektoren) => {
    for (const sel of selektoren) {
      const t = texte(sel);
      if (t.length) return t;
    }
    return [];
  };

  let zutaten = ersteTreffer([
    '.wprm-recipe-ingredient', '.tasty-recipes-ingredients li', '.mv-create-ingredients li', '.recipe-ingredients li',
    '.ingredients li', '[class*="ingredient"] li', '[class*="zutat"] li', '[class*="Zutat"] li',
  ]);
  let schritte = ersteTreffer([
    '.wprm-recipe-instruction-text', '.tasty-recipes-instructions li', '.mv-create-instructions li', '.recipe-instructions li',
    '.instructions li', '[class*="instruction"] li', '[class*="preparation"] li', '[class*="zubereitung"] li', '[class*="Zubereitung"] li',
  ]);

  const nachUeberschrift = (muster) => {
    const kopf = [...doc.querySelectorAll('h1, h2, h3, h4, h5, strong, b')].find((el) => muster.test(el.textContent.trim()));
    if (!kopf) return [];
    let el = kopf.closest('h1, h2, h3, h4, h5, p') || kopf;
    for (let i = 0; i < 8 && el; i++) {
      el = el.nextElementSibling;
      if (!el) break;
      if (/^H[1-4]$/.test(el.tagName)) break;
      const liste = el.matches('ul, ol') ? el : el.querySelector('ul, ol');
      if (liste) return [...liste.querySelectorAll('li')].map((li) => reinText(li.textContent)).filter(Boolean);
    }
    return [];
  };

  if (!zutaten.length) zutaten = nachUeberschrift(/^(zutaten|ingredients|das brauchst du)/i);
  if (!schritte.length) schritte = nachUeberschrift(/^(zubereitung|anleitung|so geht'?s|instructions|directions|method)/i);
  return { zutaten, schritte };
}

function metaInhalt(doc, ...namen) {
  for (const n of namen) {
    const el = doc.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
    if (el && el.content) return el.content;
  }
  return '';
}

function leseRezept(html, url) {
  const doc = zerleger.parseFromString(html, 'text/html');
  let r = null;
  const alleLd = lesbareJsonLd(doc);
  const index = sammleIds(alleLd);
  for (const ld of alleLd) {
    const fund = sucheRezept(ld);
    if (fund) { r = ausJsonLd(fund, url, index); break; }
  }
  if (!r || (!r.zutaten.length && !r.schritte.length)) {
    const md = ausMicrodata(doc, url);
    if (md && (md.zutaten.length || md.schritte.length)) r = { ...(r || {}), ...md };
  }
  if (!r || (!r.zutaten.length && !r.schritte.length)) {
    const h = ausHtml(doc);
    r = { ...(r || {}), zutaten: h.zutaten, schritte: h.schritte };
  }
  r.titel = r.titel || reinText(metaInhalt(doc, 'og:title', 'twitter:title')) || reinText(doc.querySelector('h1') && doc.querySelector('h1').textContent) || reinText(doc.title);
  r.bild = r.bild || absoluteUrl(metaInhalt(doc, 'og:image', 'twitter:image'), url);
  r.beschreibung = r.beschreibung || reinText(metaInhalt(doc, 'og:description', 'description'));
  // Werbetexte wie „Über 800 Bewertungen ► Portionsrechner ► Kochbuch“ sind keine Beschreibung.
  if (/►|für lecker befunden|weitere (kostenlose )?Rezepte/i.test(r.beschreibung || '')) r.beschreibung = '';
  if (r.beschreibung && r.beschreibung.length > 600) r.beschreibung = `${r.beschreibung.slice(0, 597)}…`;
  // Chefkoch hängt den Benutzernamen an: „Kürbis-Lasagne von Schwedin16“.
  if (/(^|\.)chefkoch\.de$/.test(domain(url))) r.titel = r.titel.replace(/\s+von\s+\S+$/, '');
  // Andere Seiten hängen „Rezept“ an: „Mafaldine mit Garnelen Rezept“.
  r.titel = r.titel.replace(/\s+[-–|]?\s*Rezept$/i, '') || r.titel;
  // Englische Dezimalpunkte („0.5 Bund“) in deutsche Schreibweise bringen.
  r.zutaten = (r.zutaten || []).map((z) => z.replace(/^(\d+)\.(\d+)(?=\s|$)/, '$1,$2')).slice(0, 200);
  r.schritte = (r.schritte || []).slice(0, 200);
  return r;
}

function umwege(url) {
  const kodiert = encodeURIComponent(url);
  const liste = [];
  const eigener = (daten.einstellungen.proxy || '').trim();
  if (eigener) {
    liste.push({ name: 'eigenen Umweg', adresse: eigener.includes('{url}') ? eigener.replace('{url}', kodiert) : eigener + kodiert, zeit: 25000 });
  }
  liste.push({ name: 'direkt', adresse: url, zeit: 10000 });
  // Mit verbundenem Google Sheet ruft Google die Seite ab – ohne fremden Dienst.
  if (verbunden()) liste.push({ name: 'Google', skript: true, zeit: 30000 });
  liste.push(
    { name: 'r.jina.ai', adresse: `https://r.jina.ai/${url}`, kopf: { 'X-Return-Format': 'html' }, zeit: 30000 },
    { name: 'allorigins.win', adresse: `https://api.allorigins.win/raw?url=${kodiert}`, zeit: 15000 },
    { name: 'codetabs.com', adresse: `https://api.codetabs.com/v1/proxy/?quest=${kodiert}`, zeit: 15000 },
  );
  return liste;
}

async function holeText(weg, abbruch, url) {
  if (weg.skript) {
    const antwort = await Promise.race([
      rufeSkript({ aktion: 'seite', url }, daten.einstellungen.sync, weg.zeit),
      new Promise((_, nein) => abbruch.addEventListener('abort', () => nein(new DOMException('Abgebrochen', 'AbortError')))),
    ]);
    return antwort.html;
  }
  const ctl = new AbortController();
  const uhr = setTimeout(() => ctl.abort(), weg.zeit);
  const weiter = () => ctl.abort();
  abbruch.addEventListener('abort', weiter);
  try {
    const antwort = await fetch(weg.adresse, { signal: ctl.signal, headers: weg.kopf || {}, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`);
    return await antwort.text();
  } finally {
    clearTimeout(uhr);
    abbruch.removeEventListener('abort', weiter);
  }
}

// Probiert die Wege nacheinander, bis Zutaten oder Schritte gefunden sind.
async function importiereUrl(url, abbruch, fortschritt) {
  let teilweise = null;
  for (const weg of umwege(url)) {
    if (abbruch.aborted) throw new DOMException('Abgebrochen', 'AbortError');
    fortschritt(weg.name === 'direkt' ? 'Lade Rezeptseite …' : weg.skript ? 'Lade über dein Google Sheet …' : `Lade über ${weg.name} …`);
    let html;
    try {
      html = await holeText(weg, abbruch, url);
    } catch (e) {
      if (abbruch.aborted) throw e;
      continue;
    }
    if (!html || html.length < 300) continue;
    const r = leseRezept(html, url);
    if (r.zutaten.length || r.schritte.length) return r;
    const fehlerSeite = /^(404|403|error|fehler|not found|access denied|just a moment|seite nicht gefunden)\b/i.test(r.titel || '');
    if (!teilweise && r.titel && !fehlerSeite) teilweise = r;
  }
  if (teilweise) {
    teilweise.unvollstaendig = true;
    return teilweise;
  }
  throw new Error('nicht erreichbar');
}

function urlAusText(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0].replace(/[).,;!?]+$/, '') : '';
}

/* ================= Ansichten ================= */

let ansicht = 'liste';
let filter = 'alle';
let offenesRezept = null;   // { id, portionen, zutatenAus:Set, schritteAus:Set }
let wachSperre = null;
let kochmodus = false;

function zeigeAnsicht(name) {
  ansicht = name;
  const unterseite = name === 'rezept' || name === 'sammlung';
  for (const s of document.querySelectorAll('.ansicht')) s.hidden = s.id !== `ansicht-${name}`;
  for (const b of document.querySelectorAll('.navi button')) b.classList.toggle('aktiv', b.dataset.ansicht === (unterseite ? 'liste' : name));
  $('#neu').hidden = name !== 'liste' && name !== 'sammlung';
  $('#zurueck').hidden = !unterseite;
  $('#bearbeiten').hidden = !unterseite;
  $('#bearbeiten').setAttribute('aria-label', name === 'sammlung' ? 'Sammlung bearbeiten' : 'Rezept bearbeiten');
  $('#titel').textContent = name === 'einkauf' ? 'Einkaufsliste' : name === 'plan' ? 'Wochenplan' : name === 'rezept' ? 'Rezept' : name === 'sammlung' ? `📁 ${offeneSammlung}` : 'Rezepte';
  if (name !== 'rezept') beendeKochmodus();
  window.scrollTo(0, 0);
  if (name === 'liste') zeichneListe();
  if (name === 'sammlung') zeichneSammlung();
  if (name === 'einkauf') zeichneEinkauf();
  if (name === 'plan') zeichnePlan();
}

/* ---------- Sammlungen ---------- */

// Eine Sammlung gibt es, solange mindestens ein Rezept in ihr steckt. Die Namen stehen am Rezept,
// so kommen sich zwei Handys beim Einsortieren verschiedener Rezepte nicht in die Quere.
let offeneSammlung = '';
let rueckAnsicht = 'liste';   // wohin „Zurück“ aus einem Rezept führt
let importZiel = '';   // Sammlung, in die ein neues Rezept gleich einsortiert wird

function sammlungsName(text) {
  return String(text || '').replace(/[,\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function gleicherName(a, b) {
  return a.toLocaleLowerCase('de') === b.toLocaleLowerCase('de');
}

function inSammlung(r, name) {
  return (r.sammlungen || []).some((s) => gleicherName(s, name));
}

function alleSammlungen() {
  const nachName = new Map();
  for (const r of daten.rezepte) {
    for (const s of r.sammlungen || []) {
      const schluessel = s.toLocaleLowerCase('de');
      if (!nachName.has(schluessel)) nachName.set(schluessel, { name: s, rezepte: [] });
      nachName.get(schluessel).rezepte.push(r);
    }
  }
  return [...nachName.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

function sammlungsRezepte(name) {
  return daten.rezepte.filter((r) => inSammlung(r, name)).sort((a, b) => a.titel.localeCompare(b.titel, 'de'));
}

// Ordnet ein Rezept ein oder aus (alt = bisheriger Name beim Umbenennen). Liefert true bei einer Änderung.
function setzeSammlung(r, name, drin, alt = name) {
  const vorher = JSON.stringify(r.sammlungen || []);
  const rest = (r.sammlungen || []).filter((s) => !gleicherName(s, name) && !gleicherName(s, alt));
  r.sammlungen = drin ? [...rest, name] : rest;
  return JSON.stringify(r.sammlungen) !== vorher;
}

function sammlungsBild(sammlung) {
  const mitBild = sammlung.rezepte.filter((r) => r.foto || r.bild).sort((a, b) => b.erstellt - a.erstellt);
  if (mitBild.length >= 4) return `<div class="mosaik">${mitBild.slice(0, 4).map((r) => bildHtml(r)).join('')}</div>`;
  if (mitBild.length) return bildHtml(mitBild[0]);
  return '<div class="bild" aria-hidden="true">📁</div>';
}

// Ob der Sammlungsbereich aufgeklappt ist, merkt sich nur dieses Handy.
const SAMMLUNGEN_OFFEN = 'rezepte-sammlungen-offen';
function sammlungenOffen() {
  try { return localStorage.getItem(SAMMLUNGEN_OFFEN) === '1'; } catch { return false; }
}
function setzeSammlungenOffen(offen) {
  try { localStorage.setItem(SAMMLUNGEN_OFFEN, offen ? '1' : '0'); } catch { /* egal */ }
}

function zeichneSammlungen() {
  const bereich = $('#sammlungen');
  const zeigen = daten.rezepte.length > 0 && !$('#suche').value.trim() && filter === 'alle';
  bereich.hidden = !zeigen;
  if (!zeigen) return;
  const liste = alleSammlungen();
  // Ab drei Karten (mit „Neue Sammlung“) passt nicht mehr alles in die Reihe.
  const umschaltbar = liste.length >= 2;
  const offen = umschaltbar && sammlungenOffen();
  bereich.innerHTML = `<div class="abschnitt-kopf">
      <h2 class="abschnitt-titel">Sammlungen</h2>
      ${umschaltbar ? `<button type="button" class="text-knopf" data-aktion="sammlungen-umschalten" aria-expanded="${offen}">${offen ? 'Weniger anzeigen' : `Alle anzeigen (${liste.length})`}</button>` : ''}
    </div>
    <div class="sammlung-reihe${offen ? ' offen' : ''}">
      ${liste.map((s) => `<button type="button" class="sammlung-karte" data-sammlung="${esc(s.name)}">
        ${sammlungsBild(s)}
        <span class="karte-text"><span class="karte-titel">${esc(s.name)}</span><span class="karte-meta">${s.rezepte.length} ${s.rezepte.length === 1 ? 'Rezept' : 'Rezepte'}</span></span>
      </button>`).join('')}
      <button type="button" class="sammlung-karte sammlung-neu" data-aktion="neue-sammlung">
        <span class="bild" aria-hidden="true">＋</span>
        <span class="karte-text"><span class="karte-titel">Neue Sammlung</span><span class="karte-meta">${liste.length ? 'anlegen' : 'z. B. Weihnachten'}</span></span>
      </button>
    </div>`;
  fuelleFotos(bereich);
}

function zeigeSammlung(name, verlauf = true) {
  const echt = alleSammlungen().find((s) => gleicherName(s.name, name));
  if (!echt) { zeigeAnsicht('liste'); return; }
  offeneSammlung = echt.name;
  if (verlauf) history.pushState({ sammlung: echt.name }, '');
  zeigeAnsicht('sammlung');
}

function zeichneSammlung() {
  const liste = sammlungsRezepte(offeneSammlung);
  // Leer geworden (z. B. vom anderen Handy aufgelöst)
  if (!liste.length) { zeigeAnsicht('liste'); return; }
  $('#titel').textContent = `📁 ${offeneSammlung}`;
  $('#sammlung-anzahl').textContent = `${liste.length} ${liste.length === 1 ? 'Rezept' : 'Rezepte'}`;
  $('#sammlung-liste').innerHTML = liste.map(karteHtml).join('');
  fuelleFotos($('#sammlung-liste'));
}

// Eigenes Foto vor Bild von der Rezeptseite; fuelleFotos() setzt noch nicht geladene Fotos ein.
function bildHtml(r, klasse = '') {
  const fehler = 'onerror="this.parentNode.textContent=\'🍲\'"';
  if (r.foto) {
    const u = fotoUrls.get(r.foto);
    return `<div class="bild ${klasse}"><img ${u ? `src="${esc(u)}" ` : ''}data-foto="${esc(r.foto)}" data-ersatz="${esc(r.bild || '')}" alt="" referrerpolicy="no-referrer" ${fehler}></div>`;
  }
  if (!r.bild) return `<div class="bild ${klasse}" aria-hidden="true">🍲</div>`;
  return `<div class="bild ${klasse}"><img src="${esc(r.bild)}" alt="" loading="lazy" referrerpolicy="no-referrer" ${fehler}></div>`;
}

function passtZurSuche(r, begriffe) {
  const heu = [r.titel, ...(r.zutaten || []), ...(r.kategorien || []), ...(r.sammlungen || [])].join(' ').toLowerCase();
  return begriffe.every((b) => heu.includes(b));
}

function zeichneFilter() {
  const zaehler = new Map();
  for (const r of daten.rezepte) for (const k of r.kategorien || []) zaehler.set(k, (zaehler.get(k) || 0) + 1);
  const kategorien = [...zaehler.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'de')).slice(0, 15);
  if (filter.startsWith('k:') && !zaehler.has(filter.slice(2))) filter = 'alle';
  const favoriten = daten.rezepte.filter((r) => r.favorit).length;
  const chips = [['alle', 'Alle', daten.rezepte.length]];
  if (favoriten) chips.push(['favoriten', '♥ Favoriten', favoriten]);
  for (const [k, n] of kategorien) chips.push([`k:${k}`, k, n]);
  $('#filter').hidden = daten.rezepte.length === 0;
  $('#filter').innerHTML = chips.map(([wert, text, n]) =>
    `<button type="button" data-filter="${esc(wert)}" class="${filter === wert ? 'aktiv' : ''}" aria-pressed="${filter === wert}">${esc(text)}<small>${n}</small></button>`).join('');
}

function zeichneListe() {
  zeichneFilter();
  zeichneSammlungen();
  const begriffe = $('#suche').value.toLowerCase().split(/\s+/).filter(Boolean);
  let liste = daten.rezepte.filter((r) => {
    if (filter === 'favoriten' && !r.favorit) return false;
    if (filter.startsWith('k:') && !(r.kategorien || []).includes(filter.slice(2))) return false;
    return passtZurSuche(r, begriffe);
  });
  const sortierung = $('#sortierung').value;
  if (sortierung === 'titel') liste.sort((a, b) => a.titel.localeCompare(b.titel, 'de'));
  else if (sortierung === 'zeit') liste.sort((a, b) => (gesamtMinuten(a) || 1e9) - (gesamtMinuten(b) || 1e9));
  else liste.sort((a, b) => b.erstellt - a.erstellt);

  $('#anzahl').textContent = daten.rezepte.length ? `${liste.length} ${liste.length === 1 ? 'Rezept' : 'Rezepte'}` : '';
  $('.sortierung').hidden = daten.rezepte.length === 0;

  if (!daten.rezepte.length) {
    $('#liste').innerHTML = `<div class="leer" style="grid-column: 1 / -1"><span class="gross" aria-hidden="true">👩‍🍳</span>
      Noch keine Rezepte.<br>Füge einen Link von Chefkoch oder einer anderen Rezeptseite ein.<br>
      <button class="haupt" type="button" data-aktion="neu">+ Erstes Rezept hinzufügen</button></div>`;
    return;
  }
  if (!liste.length) {
    $('#liste').innerHTML = '<p class="leer" style="grid-column: 1 / -1">Nichts gefunden.</p>';
    return;
  }
  $('#liste').innerHTML = liste.map(karteHtml).join('');
  fuelleFotos($('#liste'));
}

function karteHtml(r) {
  const min = gesamtMinuten(r);
  const meta = [min ? `⏱ ${zeitText(min)}` : '', r.zutaten.length ? `${r.zutaten.filter((z) => !istUeberschrift(z)).length} Zutaten` : ''].filter(Boolean).join(' · ');
  return `<button type="button" class="karte" data-rezept="${esc(r.id)}">
      ${bildHtml(r)}
      ${r.favorit ? '<span class="karte-herz" aria-label="Favorit">♥</span>' : ''}
      <span class="karte-text"><span class="karte-titel">${esc(r.titel)}</span><span class="karte-meta">${esc(meta)}</span></span>
    </button>`;
}

/* ---------- Rezept-Detail ---------- */

function oeffneRezept(id, verlauf = true) {
  const r = rezeptMitId(id);
  if (!r) return;
  if (!offenesRezept || offenesRezept.id !== id) {
    offenesRezept = { id, portionen: r.portionen || null, faktor: 1, zutatenAus: new Set(), schritteAus: new Set() };
  }
  if (verlauf) {
    // Zurück führt in den Wochenplan, wenn das Rezept dort geöffnet wurde.
    if (ansicht !== 'rezept') rueckAnsicht = ansicht === 'plan' ? 'plan' : 'liste';
    history.pushState({ rezept: id }, '');
  }
  zeigeAnsicht('rezept');
  zeichneRezept();
}

function faktor() {
  const r = rezeptMitId(offenesRezept.id);
  if (r.portionen && offenesRezept.portionen) return offenesRezept.portionen / r.portionen;
  return offenesRezept.faktor;
}

function zeichneRezept() {
  const r = rezeptMitId(offenesRezept.id);
  if (!r) { zeigeAnsicht('liste'); return; }
  const f = faktor();
  const fakten = [];
  if (r.arbeitszeit) fakten.push(`🔪 Arbeitszeit ${zeitText(r.arbeitszeit)}`);
  if (r.kochzeit) fakten.push(`🔥 Koch-/Backzeit ${zeitText(r.kochzeit)}`);
  const gesamt = gesamtMinuten(r);
  if (gesamt && (r.arbeitszeit || r.kochzeit) && gesamt !== r.arbeitszeit && gesamt !== r.kochzeit) fakten.push(`⏱ Gesamt ${zeitText(gesamt)}`);
  else if (gesamt && !r.arbeitszeit && !r.kochzeit) fakten.push(`⏱ ${zeitText(gesamt)}`);
  if (r.kalorien) fakten.push(`⚡ ${r.kalorien}${/portion/i.test(r.kalorien) ? '' : ' pro Portion'}`);

  const quelle = [];
  if (r.quelle) quelle.push(`<a href="${esc(r.quelle)}" target="_blank" rel="noopener noreferrer">${esc(domain(r.quelle) || 'Original')} ↗</a>`);
  if (r.bewertung) {
    quelle.push(`<span><span class="stern">★</span> ${esc(String(r.bewertung.wert).replace('.', ','))}${r.bewertung.max && r.bewertung.max !== 5 ? `/${esc(r.bewertung.max)}` : ''}${r.bewertung.anzahl ? ` (${esc(r.bewertung.anzahl.toLocaleString('de-DE'))})` : ''}</span>`);
  }

  const portionText = r.portionen
    ? `${formatZahl(offenesRezept.portionen)} ${offenesRezept.portionen === 1 ? 'Portion' : 'Portionen'}`
    : `Menge ×${formatZahl(offenesRezept.faktor)}`;

  const zutaten = r.zutaten.map((z, i) => {
    if (istUeberschrift(z)) return `<li class="unterpunkt">${esc(ueberschriftText(z))}</li>`;
    const t = zerlegeZutat(z, f);
    return `<li class="zutat${offenesRezept.zutatenAus.has(i) ? ' erledigt' : ''}" data-zutat="${i}"><span class="menge">${esc(t.menge)}</span><span>${esc(t.rest)}</span></li>`;
  }).join('');

  let nummer = 0;
  const schritte = r.schritte.map((s, i) => {
    if (istUeberschrift(s)) return `<li class="unterpunkt">${esc(ueberschriftText(s))}</li>`;
    nummer++;
    return `<li class="schritt${offenesRezept.schritteAus.has(i) ? ' erledigt' : ''}" data-schritt="${i}">${esc(s)}</li>`;
  }).join('');

  $('#rezept-detail').innerHTML = `
    ${bildHtml(r, 'rezept-bild')}
    <div class="rezept-kopf">
      <h2>${esc(r.titel)}</h2>
      ${quelle.length ? `<div class="quelle">${quelle.join('')}</div>` : ''}
      ${fakten.length || (r.kategorien || []).length ? `<ul class="fakten">${fakten.map((t) => `<li>${esc(t)}</li>`).join('')}${(r.kategorien || []).map((k) => `<li class="kategorie">${esc(k)}</li>`).join('')}</ul>` : ''}
      ${(r.sammlungen || []).length ? `<div class="rezept-sammlungen">${r.sammlungen.map((s) => `<button type="button" class="sammlung-link" data-sammlung-link="${esc(s)}">📁 ${esc(s)}</button>`).join('')}</div>` : ''}
    </div>
    <div class="aktionen">
      <button type="button" data-aktion="favorit" class="${r.favorit ? 'an' : ''}" aria-pressed="${Boolean(r.favorit)}"><span aria-hidden="true">${r.favorit ? '♥' : '♡'}</span>Favorit</button>
      <button type="button" data-aktion="sammlungen"><span aria-hidden="true">📁</span>Sammlung</button>
      <button type="button" data-aktion="einkaufen" ${r.zutaten.length ? '' : 'disabled'}><span aria-hidden="true">🛒</span>Einkaufsliste</button>
      <button type="button" data-aktion="kochmodus" class="${kochmodus ? 'an' : ''}" aria-pressed="${kochmodus}"><span aria-hidden="true">👩‍🍳</span>Kochmodus</button>
    </div>
    ${r.beschreibung ? `<p class="beschreibung">${esc(r.beschreibung)}</p>` : ''}
    <section class="block">
      <div class="block-kopf">
        <h3>Zutaten</h3>
        <div class="portionen">
          <button type="button" data-portion="-1" aria-label="Weniger">−</button>
          <output aria-live="polite">${esc(portionText)}</output>
          <button type="button" data-portion="1" aria-label="Mehr">+</button>
        </div>
      </div>
      ${r.zutaten.length ? `<ul class="zutaten">${zutaten}</ul>` : '<p class="hinweis">Keine Zutaten eingetragen.</p>'}
    </section>
    <section class="block">
      <h3>Zubereitung</h3>
      ${nummer || r.schritte.length ? `<ol class="schritte">${schritte}</ol>` : '<p class="hinweis">Keine Zubereitung eingetragen.</p>'}
    </section>
    ${r.notizen ? `<section class="block"><h3>Meine Notizen</h3><p class="notizen">${esc(r.notizen)}</p></section>` : ''}
    <div class="fuss">
      <button type="button" data-aktion="bearbeiten">✎ Bearbeiten</button>
      <button type="button" data-aktion="planen">📅 Planen</button>
      ${r.quelle && navigator.share ? '<button type="button" data-aktion="teilen">📤 Teilen</button>' : ''}
      <span class="platz"></span>
      <button type="button" class="gefahr" data-aktion="loeschen">🗑 Löschen</button>
    </div>`;
  fuelleFotos($('#rezept-detail'));
}

function aenderePortionen(richtung) {
  const r = rezeptMitId(offenesRezept.id);
  if (r.portionen) {
    // Unter einer Portion in halben Schritten, darüber in ganzen.
    const p = offenesRezept.portionen;
    let neu;
    if (richtung > 0) neu = p < 1 ? p + 0.5 : Math.floor(p) + 1;
    else neu = p > 1 ? Math.ceil(p) - 1 : p - 0.5;
    offenesRezept.portionen = Math.min(99, Math.max(0.5, neu));
  } else {
    offenesRezept.faktor = Math.min(20, Math.max(0.5, offenesRezept.faktor + richtung * 0.5));
  }
  zeichneRezept();
}

async function setzeKochmodus(an) {
  kochmodus = an;
  if (an) {
    try {
      if ('wakeLock' in navigator) {
        wachSperre = await navigator.wakeLock.request('screen');
        zeigeStatus('Kochmodus: Der Bildschirm bleibt an. Tippe auf Zutaten und Schritte zum Abhaken.', 4000);
      } else {
        zeigeStatus('Tippe auf Zutaten und Schritte zum Abhaken. (Bildschirm-anlassen geht in diesem Browser nicht.)', 4000);
      }
    } catch (e) {
      zeigeStatus('Der Bildschirm kann gerade nicht wach gehalten werden.');
    }
  } else if (wachSperre) {
    wachSperre.release().catch(() => {});
    wachSperre = null;
  }
  if (ansicht === 'rezept') zeichneRezept();
}

function beendeKochmodus() {
  if (kochmodus) setzeKochmodus(false);
}

document.addEventListener('visibilitychange', () => {
  // Die Sperre fällt beim Wechsel in den Hintergrund weg und muss neu geholt werden.
  if (document.visibilityState === 'visible' && kochmodus && 'wakeLock' in navigator) {
    navigator.wakeLock.request('screen').then((s) => { wachSperre = s; }).catch(() => {});
  }
});

/* ---------- Einkaufsliste ---------- */

function aktualisiereEinkaufZahl() {
  const offen = daten.einkauf.filter((p) => !p.erledigt).length;
  $('#einkauf-zahl').hidden = !offen;
  $('#einkauf-zahl').textContent = offen;
}

function zeichneEinkauf() {
  aktualisiereEinkaufZahl();
  const liste = $('#einkauf-liste');
  $('#einkauf-knoepfe').hidden = !daten.einkauf.length;
  $('#einkauf-aufraeumen').disabled = !daten.einkauf.some((p) => p.erledigt);
  if (!daten.einkauf.length) {
    liste.innerHTML = `<div class="leer"><span class="gross" aria-hidden="true">🛒</span>Die Einkaufsliste ist leer.<br>
      Im Rezept fügst du mit <b>🛒 Einkaufsliste</b> die Zutaten hinzu.</div>`;
    return;
  }
  const posten = (p) => `<button type="button" class="posten${p.erledigt ? ' erledigt' : ''}" data-posten="${esc(p.id)}" aria-pressed="${p.erledigt}">
      <span class="haken" aria-hidden="true">✓</span>
      <span class="posten-text">${esc(p.text)}</span>
    </button>`;
  const offen = daten.einkauf.filter((p) => !p.erledigt);
  const erledigt = daten.einkauf.filter((p) => p.erledigt);
  // Offene Posten nach Rezept gruppieren, damit man sieht, wofür man einkauft.
  const gruppen = new Map();
  for (const p of offen) {
    const g = p.rezept || '';
    if (!gruppen.has(g)) gruppen.set(g, []);
    gruppen.get(g).push(p);
  }
  let html = '';
  const sortiert = [...gruppen.entries()].sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : 0));
  for (const [name, eintraege] of sortiert) {
    if (gruppen.size > 1 || name) html += `<p class="gruppe-titel">${esc(name || 'Sonstiges')}</p>`;
    html += `<div>${eintraege.map(posten).join('')}</div>`;
  }
  if (!offen.length) html += '<p class="leer">Alles erledigt! 🎉</p>';
  if (erledigt.length) html += `<p class="gruppe-titel">Erledigt (${erledigt.length})</p><div>${erledigt.map(posten).join('')}</div>`;
  liste.innerHTML = html;
}

function einkaufText() {
  const offen = daten.einkauf.filter((p) => !p.erledigt);
  return `Einkaufsliste:\n${offen.map((p) => `• ${p.text}`).join('\n')}`;
}

/* ---------- Dialoge ---------- */

function oeffneDialog(dlg) {
  if (!dlg.open) dlg.showModal();
}

for (const dlg of document.querySelectorAll('dialog')) {
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-schliessen]')) dlg.close();
  });
}

let importAbbruch = null;

function importStatus(text, art = '') {
  const el = $('#import-status');
  el.hidden = !text;
  el.textContent = text;
  el.className = `import-status ${art}`;
}

function oeffneImport(url = '') {
  const form = $('#form-import');
  form.url.value = url;
  importStatus('');
  $('#import-ziel').hidden = !importZiel;
  $('#import-ziel').textContent = importZiel ? `📁 Kommt in die Sammlung „${importZiel}“.` : '';
  $('#laden').disabled = false;
  oeffneDialog($('#dlg-import'));
  if (url) form.requestSubmit();
  else setTimeout(() => form.url.focus(), 50);
}

$('#dlg-import').addEventListener('close', () => {
  if (importAbbruch) importAbbruch.abort();
});

$('#einfuegen').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    const url = urlAusText(text) || text.trim();
    $('#form-import').url.value = url;
    if (url) $('#form-import').requestSubmit();
  } catch (e) {
    zeigeStatus('Kein Zugriff auf die Zwischenablage – lange ins Feld tippen und „Einfügen“ wählen.');
    $('#form-import').url.focus();
  }
});

$('#form-import').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  let url = urlAusText(form.url.value) || form.url.value.trim();
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = absoluteUrl(url);
  if (!url) {
    importStatus('Bitte einen gültigen Link einfügen, z. B. https://www.chefkoch.de/rezepte/…', 'fehler');
    return;
  }
  form.url.value = url;

  const vorhanden = daten.rezepte.find((r) => r.quelle === url);
  if (vorhanden) {
    $('#dlg-import').close();
    // Aus einer Sammlung heraus geteilt: das vorhandene Rezept dort einsortieren.
    const einsortiert = importZiel && setzeSammlung(vorhanden, importZiel, true);
    if (einsortiert) {
      merke('rezepte', vorhanden);
      speichere();
    }
    oeffneRezept(vorhanden.id);
    zeigeStatus(einsortiert ? `Schon gespeichert – jetzt auch in „${importZiel}“.` : 'Dieses Rezept hast du schon gespeichert.');
    return;
  }

  if (importAbbruch) importAbbruch.abort();
  const abbruch = new AbortController();
  importAbbruch = abbruch;
  $('#laden').disabled = true;
  importStatus('Lade Rezeptseite …', 'laedt');
  try {
    const r = await importiereUrl(url, abbruch.signal, (text) => importStatus(text, 'laedt'));
    if (abbruch.signal.aborted) return;
    const rezept = neuesRezept({ ...r, quelle: url, sammlungen: importZiel ? [importZiel] : [] });
    if (r.unvollstaendig) {
      $('#dlg-import').close();
      oeffneFormular(rezept, 'Auf der Seite wurden keine Zutaten gefunden. Bitte ergänze sie von Hand (z. B. per Kopieren und Einfügen).');
      return;
    }
    daten.rezepte.push(rezept);
    merke('rezepte', rezept);
    speichere();
    $('#dlg-import').close();
    oeffneRezept(rezept.id);
    zeigeStatus(`„${rezept.titel}“ gespeichert.`);
  } catch (err) {
    if (abbruch.signal.aborted) return;
    importStatus('Die Seite ließ sich nicht laden. Prüfe den Link und deine Verbindung – oder trage das Rezept von Hand ein.', 'fehler');
  } finally {
    if (importAbbruch === abbruch) importAbbruch = null;
    $('#laden').disabled = false;
  }
});

$('#manuell').addEventListener('click', () => {
  const url = absoluteUrl(urlAusText($('#form-import').url.value));
  $('#dlg-import').close();
  oeffneFormular(neuesRezept({ quelle: url, sammlungen: importZiel ? [importZiel] : [] }));
});

function neuesRezept(werte) {
  return {
    id: neueId(),
    titel: '',
    quelle: '',
    bild: '',
    foto: '',
    beschreibung: '',
    portionen: null,
    arbeitszeit: null,
    kochzeit: null,
    gesamtzeit: null,
    zutaten: [],
    schritte: [],
    kategorien: [],
    sammlungen: [],
    kalorien: '',
    bewertung: null,
    notizen: '',
    favorit: false,
    erstellt: Date.now(),
    geaendert: Date.now(),
    ...werte,
    unvollstaendig: undefined,
  };
}

/* ---------- Formular ---------- */

let formularRezept = null;
// Foto-Änderung im offenen Formular: neues verkleinertes Foto oder „entfernt“.
let formularFoto = { neu: null, url: '', entfernt: false };

function setzeFormularFoto(neu, entfernt = false) {
  if (formularFoto.url) URL.revokeObjectURL(formularFoto.url);
  formularFoto = { neu, url: neu ? URL.createObjectURL(neu) : '', entfernt };
  zeichneFormularFoto();
}

function zeichneFormularFoto() {
  const vorschau = $('#foto-vorschau');
  const alt = !formularFoto.entfernt && formularRezept && formularRezept.foto;
  const da = Boolean(formularFoto.neu || alt);
  vorschau.hidden = !da;
  $('#foto-entfernen').hidden = !da;
  $('#foto-waehlen').textContent = da ? '📷 Anderes Foto' : '📷 Foto aufnehmen oder wählen';
  vorschau.innerHTML = '';
  if (!da) return;
  const img = document.createElement('img');
  img.alt = 'Vorschau des Fotos';
  vorschau.append(img);
  if (formularFoto.neu) img.src = formularFoto.url;
  else {
    const id = formularRezept.foto;
    fotoUrl(id).then((u) => {
      if (u && formularRezept && formularRezept.foto === id && !formularFoto.neu) img.src = u;
      else if (!u) vorschau.textContent = verbunden() ? 'Foto wird geladen, sobald das Google Sheet erreichbar ist.' : 'Foto nicht gefunden.';
    });
  }
}

$('#foto-waehlen').addEventListener('click', () => {
  if (!fotosMoeglich()) {
    zeigeStatus('Fotos speichern geht in diesem Browser leider nicht.');
    return;
  }
  $('#foto-datei').click();
});

$('#foto-datei').addEventListener('change', async (e) => {
  const datei = e.target.files[0];
  e.target.value = '';
  if (!datei) return;
  const knopf = $('#foto-waehlen');
  knopf.disabled = true;
  knopf.textContent = 'Foto wird verkleinert …';
  try {
    setzeFormularFoto(await verkleinereFoto(datei));
  } catch (err) {
    zeigeStatus('Dieses Bild lässt sich nicht öffnen. Bitte ein JPG- oder PNG-Foto wählen.', 5000);
    zeichneFormularFoto();
  } finally {
    knopf.disabled = false;
  }
});

$('#foto-entfernen').addEventListener('click', () => setzeFormularFoto(null, true));

$('#dlg-formular').addEventListener('close', () => {
  // Nach dem Speichern gehört die Objekt-URL dem Foto-Speicher (url ist dann leer).
  if (formularFoto.url) URL.revokeObjectURL(formularFoto.url);
  formularFoto = { neu: null, url: '', entfernt: false };
});

function oeffneFormular(rezept, hinweis = '') {
  formularRezept = rezept;
  setzeFormularFoto(null);
  const neu = !rezeptMitId(rezept.id);
  const f = $('#form-rezept');
  $('#formular-titel').textContent = neu ? 'Rezept eintragen' : 'Rezept bearbeiten';
  $('#formular-hinweis').textContent = hinweis;
  $('#formular-hinweis').hidden = !hinweis;
  f.querySelector('.fehler').hidden = true;
  f.titel.value = rezept.titel || '';
  f.portionen.value = rezept.portionen || '';
  f.kategorien.value = (rezept.kategorien || []).join(', ');
  f.arbeitszeit.value = rezept.arbeitszeit || '';
  f.kochzeit.value = rezept.kochzeit || '';
  f.gesamtzeit.value = rezept.gesamtzeit || '';
  f.zutaten.value = (rezept.zutaten || []).join('\n');
  f.schritte.value = (rezept.schritte || []).join('\n\n');
  f.beschreibung.value = rezept.beschreibung || '';
  f.notizen.value = rezept.notizen || '';
  f.bild.value = rezept.bild || '';
  f.quelle.value = rezept.quelle || '';
  oeffneDialog($('#dlg-formular'));
  $('#dlg-formular').scrollTop = 0;
  if (!rezept.titel) setTimeout(() => f.titel.focus(), 50);
}

function zahlFeld(wert) {
  const z = parseFloat(String(wert).replace(',', '.'));
  return z > 0 ? z : null;
}

$('#form-rezept').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const fehler = f.querySelector('.fehler');
  const titel = f.titel.value.trim();
  if (!titel) {
    fehler.textContent = 'Bitte gib dem Rezept einen Namen.';
    fehler.hidden = false;
    f.titel.focus();
    return;
  }
  const speichernKnopf = f.querySelector('button[type="submit"]');
  if (speichernKnopf.disabled) return;
  let fotoId = null;   // null = Foto unverändert
  if (formularFoto.neu) {
    fotoId = `lokal-${neueId()}`;
    fotosInArbeit.add(fotoId);
    speichernKnopf.disabled = true;
    try {
      await speichereFoto(fotoId, formularFoto.neu);
    } catch (err) {
      fotosInArbeit.delete(fotoId);
      fehler.textContent = 'Das Foto ließ sich nicht speichern – ist der Speicher des Handys voll?';
      fehler.hidden = false;
      return;
    } finally {
      speichernKnopf.disabled = false;
    }
    fotoUrls.set(fotoId, formularFoto.url);
    formularFoto.url = '';
  } else if (formularFoto.entfernt) {
    fotoId = '';
  }
  // Ein Abgleich kann das Rezept inzwischen ersetzt haben – immer das aktuelle Objekt ändern.
  const r = rezeptMitId(formularRezept.id) || formularRezept;
  const altePortionen = r.portionen;
  if (fotoId !== null) r.foto = fotoId;
  Object.assign(r, {
    titel,
    portionen: zahlFeld(f.portionen.value),
    kategorien: kategorienAus(f.kategorien.value),
    arbeitszeit: zahlFeld(f.arbeitszeit.value) && Math.round(zahlFeld(f.arbeitszeit.value)),
    kochzeit: zahlFeld(f.kochzeit.value) && Math.round(zahlFeld(f.kochzeit.value)),
    gesamtzeit: zahlFeld(f.gesamtzeit.value) && Math.round(zahlFeld(f.gesamtzeit.value)),
    zutaten: f.zutaten.value.split('\n').map((z) => z.trim()).filter(Boolean),
    schritte: teileSchritte(f.schritte.value),
    beschreibung: f.beschreibung.value.trim(),
    notizen: f.notizen.value.trim(),
    bild: absoluteUrl(f.bild.value.trim()),
    quelle: absoluteUrl(f.quelle.value.trim()),
    geaendert: Date.now(),
  });
  const neu = !rezeptMitId(r.id);
  if (neu) daten.rezepte.push(r);
  if (!speichere()) {
    if (neu) daten.rezepte = daten.rezepte.filter((x) => x !== r);
    if (fotoId) fotosInArbeit.delete(fotoId);
    return;
  }
  merke('rezepte', r);
  speichere();
  if (fotoId) fotosInArbeit.delete(fotoId);
  if (fotoId !== null) raeumeFotosAuf();
  $('#dlg-formular').close();
  if (offenesRezept && offenesRezept.id === r.id) {
    if (altePortionen !== r.portionen) offenesRezept.portionen = r.portionen;
    offenesRezept.zutatenAus.clear();
    offenesRezept.schritteAus.clear();
  }
  if (ansicht === 'rezept' && offenesRezept && offenesRezept.id === r.id) zeichneRezept();
  else oeffneRezept(r.id);
  zeigeStatus(neu ? `„${r.titel}“ gespeichert.` : 'Änderungen gespeichert.');
});

/* ---------- Zutaten auf die Einkaufsliste ---------- */

// Quellen: [{ rezept, faktor, titel? }] – ein Rezept aus der Detailansicht oder alle Gerichte einer Woche.
let einkaufQuellen = [];

function oeffneEinkaufen(quellen, hinweis) {
  if (!quellen) {
    const r = rezeptMitId(offenesRezept.id);
    quellen = [{ rezept: r, faktor: faktor() }];
    hinweis = r.portionen ? `${r.titel} – für ${formatZahl(offenesRezept.portionen)} ${offenesRezept.portionen === 1 ? 'Portion' : 'Portionen'}` : r.titel;
  }
  einkaufQuellen = quellen;
  $('#einkaufen-hinweis').textContent = hinweis;
  $('#einkaufen-zutaten').innerHTML = quellen.map((q, nr) => {
    const kopf = quellen.length > 1 ? `<p class="gruppe-titel einkauf-rezept">${esc(q.titel || q.rezept.titel)}</p>` : '';
    return kopf + q.rezept.zutaten.map((z, i) => istUeberschrift(z)
      ? `<p class="gruppe-titel">${esc(ueberschriftText(z))}</p>`
      : `<label><input type="checkbox" value="${nr}:${i}" checked> <span>${esc(zutatText(z, q.faktor))}</span></label>`).join('');
  }).join('');
  aktualisiereEinkaufenKnopf();
  oeffneDialog($('#dlg-einkaufen'));
  $('#dlg-einkaufen').scrollTop = 0;
}

function aktualisiereEinkaufenKnopf() {
  const boxen = [...document.querySelectorAll('#einkaufen-zutaten input')];
  const n = boxen.filter((b) => b.checked).length;
  $('#einkaufen-ok').textContent = `Hinzufügen (${n})`;
  $('#einkaufen-ok').disabled = !n;
  $('#einkaufen-alle').textContent = n ? 'Keine auswählen' : 'Alle auswählen';
}

$('#einkaufen-zutaten').addEventListener('change', aktualisiereEinkaufenKnopf);
$('#einkaufen-alle').addEventListener('click', () => {
  const boxen = [...document.querySelectorAll('#einkaufen-zutaten input')];
  const an = !boxen.some((b) => b.checked);
  boxen.forEach((b) => { b.checked = an; });
  aktualisiereEinkaufenKnopf();
});

$('#form-einkaufen').addEventListener('submit', (e) => {
  e.preventDefault();
  const neu = [...document.querySelectorAll('#einkaufen-zutaten input:checked')].map((b) => {
    const [nr, i] = b.value.split(':').map(Number);
    const q = einkaufQuellen[nr];
    return { id: neueId(), text: zutatText(q.rezept.zutaten[i], q.faktor), erledigt: false, rezept: q.rezept.titel };
  });
  daten.einkauf.push(...neu);
  neu.forEach((p) => merke('einkauf', p));
  speichere();
  aktualisiereEinkaufZahl();
  $('#dlg-einkaufen').close();
  zeigeStatus(`${neu.length} ${neu.length === 1 ? 'Zutat' : 'Zutaten'} auf der Einkaufsliste.`);
});

/* ---------- Wochenplan ---------- */

const ISO_TAG = /^\d{4}-\d{2}-\d{2}$/;
const WOCHENTAGE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
let planWoche = montagVon(new Date());   // angezeigte Woche (Montag)
let planTag = '';                         // Tag, für den gerade Gerichte ausgewählt werden
let planFilter = 'alle';                  // zuletzt gewählter Filter im Auswahldialog (z. B. eine Sammlung)
let planAuswahl = new Set();
let tagRezept = null;                     // Rezept, das über „📅 Planen“ eingeplant wird

function isoTag(d) {
  const zwei = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${zwei(d.getMonth() + 1)}-${zwei(d.getDate())}`;
}

function ausIso(tag) {
  const [j, m, t] = tag.split('-').map(Number);
  return new Date(j, m - 1, t);
}

function plusTage(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function montagVon(d) {
  return plusTage(d, -((d.getDay() + 6) % 7));
}

function heuteIso() {
  return isoTag(new Date());
}

function tagText(tag, lang = true) {
  const d = ausIso(tag);
  const name = WOCHENTAGE[d.getDay()];
  return `${lang ? name : name.slice(0, 2)}, ${d.getDate()}.${d.getMonth() + 1}.`;
}

function planRezept(p) {
  if (p.rezept) return rezeptMitId(p.rezept) || null;
  // Von Hand im Sheet eingetragen: über den Namen zuordnen.
  return p.name ? daten.rezepte.find((r) => gleicherName(r.titel, p.name)) || null : null;
}

function eintraegeAm(tag) {
  return daten.plan.filter((p) => p.datum === tag);
}

function zeichnePlan() {
  const heute = heuteIso();
  const tage = Array.from({ length: 7 }, (_, i) => isoTag(plusTage(planWoche, i)));
  const ende = plusTage(planWoche, 6);
  const monat = (d) => d.toLocaleDateString('de-DE', { month: 'short' }).replace('.', '');
  $('#woche-titel').textContent = planWoche.getMonth() === ende.getMonth()
    ? `${planWoche.getDate()}.–${ende.getDate()}. ${monat(ende)} ${ende.getFullYear()}`
    : `${planWoche.getDate()}. ${monat(planWoche)} – ${ende.getDate()}. ${monat(ende)} ${ende.getFullYear()}`;
  $('#woche-heute').hidden = tage.includes(heute);
  $('#woche-tage').innerHTML = tage.map((tag) => {
    const liste = eintraegeAm(tag).map((p) => {
      const r = planRezept(p);
      const weg = `<button type="button" class="plan-weg" data-plan-weg="${esc(p.id)}" aria-label="${esc(r ? r.titel : p.name)} entfernen">✕</button>`;
      if (!r) return `<li class="plan-eintrag"><span class="plan-frei">${esc(p.name || 'Gelöschtes Rezept')}</span>${weg}</li>`;
      const min = gesamtMinuten(r);
      return `<li class="plan-eintrag">
          <button type="button" class="plan-rezept" data-rezept="${esc(r.id)}">
            ${bildHtml(r)}
            <span class="plan-text"><span>${esc(r.titel)}</span>${min ? `<small>⏱ ${esc(zeitText(min))}</small>` : ''}</span>
          </button>${weg}</li>`;
    }).join('');
    const klasse = tag === heute ? ' heute' : tag < heute ? ' vorbei' : '';
    return `<section class="tag${klasse}" aria-label="${esc(tagText(tag))}">
        <div class="tag-kopf">
          <span class="tag-name">${esc(tagText(tag))}${tag === heute ? '<small>Heute</small>' : ''}</span>
          <button type="button" data-plan-tag="${tag}">＋ Gericht</button>
        </div>
        ${liste ? `<ul class="plan-eintraege">${liste}</ul>` : ''}
      </section>`;
  }).join('');
  fuelleFotos($('#woche-tage'));
  const mitZutaten = tage.flatMap(eintraegeAm).some((p) => { const r = planRezept(p); return r && r.zutaten.length; });
  $('#woche-einkaufen').disabled = !mitZutaten;
}

function neuerPlanEintrag(tag, rezept, name) {
  const eintrag = { id: neueId(), datum: tag, rezept: rezept ? rezept.id : '', name: rezept ? rezept.titel : name };
  daten.plan.push(eintrag);
  merke('plan', eintrag);
  return eintrag;
}

// Alte Wochen nach zwei Monaten wegräumen, damit Plan und Sheet nicht endlos wachsen.
function raeumePlanAuf() {
  const grenze = isoTag(plusTage(new Date(), -60));
  const alt = daten.plan.filter((p) => p.datum < grenze);
  if (!alt.length) return;
  alt.forEach((p) => merkeGeloescht('plan', p.id));
  daten.plan = daten.plan.filter((p) => p.datum >= grenze);
  speichere();
}

/* Auswahl: mehrere Rezepte für einen Tag */

function oeffnePlanen(tag) {
  planTag = tag;
  planAuswahl = new Set();
  const form = $('#form-planen');
  form.frei.value = '';
  $('#planen-suche').value = '';
  $('#planen-titel').textContent = `Gerichte für ${tagText(tag)}`;
  if (planFilter.startsWith('s:') && !alleSammlungen().some((s) => s.name === planFilter.slice(2))) planFilter = 'alle';
  if (planFilter === 'favoriten' && !daten.rezepte.some((r) => r.favorit)) planFilter = 'alle';
  zeichnePlanenFilter();
  zeichnePlanenListe();
  oeffneDialog($('#dlg-planen'));
  $('#dlg-planen').scrollTop = 0;
}

function zeichnePlanenFilter() {
  const chips = [['alle', 'Alle']];
  if (daten.rezepte.some((r) => r.favorit)) chips.push(['favoriten', '♥ Favoriten']);
  for (const s of alleSammlungen()) chips.push([`s:${s.name}`, `📁 ${s.name}`]);
  $('#planen-filter').hidden = chips.length < 2;
  $('#planen-filter').innerHTML = chips.map(([wert, text]) =>
    `<button type="button" data-filter="${esc(wert)}" class="${planFilter === wert ? 'aktiv' : ''}" aria-pressed="${planFilter === wert}">${esc(text)}</button>`).join('');
}

function zeichnePlanenListe() {
  const begriffe = $('#planen-suche').value.toLowerCase().split(/\s+/).filter(Boolean);
  const schonGeplant = new Set(eintraegeAm(planTag).map((p) => p.rezept));
  const liste = daten.rezepte.filter((r) => {
    if (planFilter === 'favoriten' && !r.favorit) return false;
    if (planFilter.startsWith('s:') && !inSammlung(r, planFilter.slice(2))) return false;
    return passtZurSuche(r, begriffe);
  }).sort((a, b) => a.titel.localeCompare(b.titel, 'de'));
  $('#planen-liste').innerHTML = liste.length ? liste.map((r) => {
    const min = gesamtMinuten(r);
    const info = [schonGeplant.has(r.id) ? '<span class="geplant">schon geplant</span>' : '', min ? `⏱ ${esc(zeitText(min))}` : ''].filter(Boolean).join(' · ');
    return `<label>
        <input type="checkbox" value="${esc(r.id)}" ${planAuswahl.has(r.id) ? 'checked' : ''}>
        ${bildHtml(r)}
        <span>${esc(r.titel)}${info ? `<small>${info}</small>` : ''}</span>
      </label>`;
  }).join('') : `<p class="hinweis">${daten.rezepte.length ? 'Nichts gefunden.' : 'Noch keine Rezepte gespeichert.'}</p>`;
  fuelleFotos($('#planen-liste'));
  zeigePlanenZahl();
}

function zeigePlanenZahl() {
  const n = planAuswahl.size + ($('#form-planen').frei.value.trim() ? 1 : 0);
  $('#planen-ok').textContent = n ? `Hinzufügen (${n})` : 'Hinzufügen';
  $('#planen-ok').disabled = !n;
}

$('#planen-filter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  planFilter = b.dataset.filter;
  zeichnePlanenFilter();
  zeichnePlanenListe();
});

$('#planen-suche').addEventListener('input', zeichnePlanenListe);
$('#form-planen').frei.addEventListener('input', zeigePlanenZahl);

$('#planen-liste').addEventListener('change', (e) => {
  const box = e.target.closest('input[type="checkbox"]');
  if (!box) return;
  if (box.checked) planAuswahl.add(box.value);
  else planAuswahl.delete(box.value);
  zeigePlanenZahl();
});

$('#form-planen').addEventListener('submit', (e) => {
  e.preventDefault();
  const frei = e.target.frei.value.replace(/\s+/g, ' ').trim().slice(0, 100);
  const rezepte = daten.rezepte.filter((r) => planAuswahl.has(r.id)).sort((a, b) => a.titel.localeCompare(b.titel, 'de'));
  if (!rezepte.length && !frei) return;
  rezepte.forEach((r) => neuerPlanEintrag(planTag, r));
  if (frei) neuerPlanEintrag(planTag, null, frei);
  speichere();
  $('#dlg-planen').close();
  zeichnePlan();
});

/* Ein Rezept aus der Detailansicht einplanen */

function oeffneTagWahl(r) {
  tagRezept = r;
  $('#tag-hinweis').textContent = r.titel;
  const heute = new Date();
  $('#tag-liste').innerHTML = Array.from({ length: 14 }, (_, i) => isoTag(plusTage(heute, i))).map((tag, i) => {
    const n = eintraegeAm(tag).length;
    const zusatz = [i === 0 ? 'heute' : i === 1 ? 'morgen' : '', n ? `${n} geplant` : ''].filter(Boolean).join(' · ');
    return `<button type="button" data-tag="${tag}"><span>${esc(tagText(tag))}</span><small>${esc(zusatz)}</small></button>`;
  }).join('');
  oeffneDialog($('#dlg-tag'));
}

$('#tag-liste').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tag]');
  if (!b || !tagRezept) return;
  neuerPlanEintrag(b.dataset.tag, tagRezept);
  speichere();
  $('#dlg-tag').close();
  zeigeStatus(`Für ${tagText(b.dataset.tag)} eingeplant.`);
});

/* Wochenansicht bedienen */

$('#woche-zurueck').addEventListener('click', () => { planWoche = plusTage(planWoche, -7); zeichnePlan(); });
$('#woche-vor').addEventListener('click', () => { planWoche = plusTage(planWoche, 7); zeichnePlan(); });
$('#woche-heute').addEventListener('click', () => { planWoche = montagVon(new Date()); zeichnePlan(); });

$('#woche-tage').addEventListener('click', (e) => {
  const neu = e.target.closest('[data-plan-tag]');
  if (neu) { oeffnePlanen(neu.dataset.planTag); return; }
  const weg = e.target.closest('[data-plan-weg]');
  if (weg) {
    daten.plan = daten.plan.filter((p) => p.id !== weg.dataset.planWeg);
    merkeGeloescht('plan', weg.dataset.planWeg);
    speichere();
    zeichnePlan();
    return;
  }
  const rezept = e.target.closest('[data-rezept]');
  if (rezept) oeffneRezept(rezept.dataset.rezept);
});

// Zutaten aller Gerichte der Woche – in der laufenden Woche erst ab heute.
$('#woche-einkaufen').addEventListener('click', () => {
  const heute = heuteIso();
  const tage = Array.from({ length: 7 }, (_, i) => isoTag(plusTage(planWoche, i)));
  const abHeute = tage.includes(heute);
  const quellen = tage.filter((t) => !abHeute || t >= heute).flatMap((tag) => eintraegeAm(tag).map((p) => {
    const r = planRezept(p);
    return r && r.zutaten.length ? { rezept: r, faktor: 1, titel: `${tagText(tag, false)} · ${r.titel}` } : null;
  })).filter(Boolean);
  if (!quellen.length) {
    zeigeStatus(abHeute ? 'Ab heute ist in dieser Woche nichts mit Zutaten geplant.' : 'In dieser Woche ist nichts mit Zutaten geplant.');
    return;
  }
  oeffneEinkaufen(quellen, `${quellen.length} ${quellen.length === 1 ? 'Gericht' : 'Gerichte'}${abHeute ? ' ab heute' : ''}, ${$('#woche-titel').textContent}. Was du schon da hast, wählst du ab.`);
});

/* ---------- Rezept in Sammlungen einordnen ---------- */

let zuordnenRezept = null;

function oeffneZuordnung(r) {
  zuordnenRezept = r;
  const form = $('#form-zuordnen');
  form.neu.value = '';
  $('#zuordnen-hinweis').textContent = r.titel;
  const liste = alleSammlungen();
  $('#zuordnen-liste').innerHTML = liste.length
    ? liste.map((s) => `<label><input type="checkbox" value="${esc(s.name)}" ${inSammlung(r, s.name) ? 'checked' : ''}> <span>📁 ${esc(s.name)} <small>(${s.rezepte.length})</small></span></label>`).join('')
    : '<p class="hinweis">Noch keine Sammlungen. Gib unten einen Namen ein, um die erste anzulegen.</p>';
  oeffneDialog($('#dlg-zuordnen'));
  if (!liste.length) setTimeout(() => form.neu.focus(), 50);
}

$('#form-zuordnen').addEventListener('submit', (e) => {
  e.preventDefault();
  const r = rezeptMitId(zuordnenRezept.id);
  if (!r) { $('#dlg-zuordnen').close(); return; }
  const gewaehlt = [...document.querySelectorAll('#zuordnen-liste input:checked')].map((b) => b.value);
  const neu = sammlungsName(e.target.neu.value);
  if (neu) {
    // Gibt es den Namen schon (andere Schreibweise), die vorhandene Sammlung nehmen.
    const vorhanden = alleSammlungen().find((s) => gleicherName(s.name, neu));
    const name = vorhanden ? vorhanden.name : neu;
    if (!gewaehlt.some((s) => gleicherName(s, name))) gewaehlt.push(name);
  }
  const vorher = JSON.stringify(r.sammlungen || []);
  r.sammlungen = gewaehlt;
  $('#dlg-zuordnen').close();
  if (JSON.stringify(r.sammlungen) === vorher) return;
  merke('rezepte', r);
  speichere();
  zeichneRezept();
  zeigeStatus(gewaehlt.length ? `In ${gewaehlt.length === 1 ? `„${gewaehlt[0]}“` : `${gewaehlt.length} Sammlungen`}.` : 'Aus allen Sammlungen genommen.');
});

/* ---------- Sammlung anlegen, bearbeiten, auflösen ---------- */

let sammlungDialog = { alt: '', auswahl: new Set() };

function oeffneSammlungsDialog(name) {
  sammlungDialog = { alt: name, auswahl: new Set(name ? sammlungsRezepte(name).map((r) => r.id) : []) };
  const form = $('#form-sammlung');
  $('#sammlung-titel').textContent = name ? 'Sammlung bearbeiten' : 'Neue Sammlung';
  form.name.value = name;
  $('#sammlung-suche').value = '';
  $('#sammlung-aufloesen').hidden = !name;
  form.querySelector('.fehler').hidden = true;
  const rezepte = [...daten.rezepte].sort((a, b) => a.titel.localeCompare(b.titel, 'de'));
  $('#sammlung-auswahl').innerHTML = rezepte.map((r) => `<label data-suchtext="${esc([r.titel, ...(r.kategorien || [])].join(' ').toLowerCase())}">
      <input type="checkbox" value="${esc(r.id)}" ${sammlungDialog.auswahl.has(r.id) ? 'checked' : ''}>
      <span>${esc(r.titel)}${(r.sammlungen || []).length ? `<small>📁 ${esc(r.sammlungen.join(', '))}</small>` : ''}</span>
    </label>`).join('');
  zeigeSammlungsZahl();
  oeffneDialog($('#dlg-sammlung'));
  $('#dlg-sammlung').scrollTop = 0;
  if (!name) setTimeout(() => form.name.focus(), 50);
}

function zeigeSammlungsZahl() {
  const n = sammlungDialog.auswahl.size;
  $('#sammlung-zahl').textContent = `(${n} ausgewählt)`;
}

$('#sammlung-auswahl').addEventListener('change', (e) => {
  const box = e.target.closest('input[type="checkbox"]');
  if (!box) return;
  if (box.checked) sammlungDialog.auswahl.add(box.value);
  else sammlungDialog.auswahl.delete(box.value);
  zeigeSammlungsZahl();
});

$('#sammlung-suche').addEventListener('input', (e) => {
  const begriffe = e.target.value.toLowerCase().split(/\s+/).filter(Boolean);
  for (const zeile of document.querySelectorAll('#sammlung-auswahl label')) {
    zeile.hidden = !begriffe.every((b) => zeile.dataset.suchtext.includes(b));
  }
});

$('#form-sammlung').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  const fehler = form.querySelector('.fehler');
  const zeigeFehler = (text) => { fehler.textContent = text; fehler.hidden = false; };
  const name = sammlungsName(form.name.value);
  const alt = sammlungDialog.alt;
  if (!name) { zeigeFehler('Bitte gib der Sammlung einen Namen.'); form.name.focus(); return; }
  const andere = alleSammlungen().find((s) => gleicherName(s.name, name) && !(alt && gleicherName(s.name, alt)));
  if (andere) { zeigeFehler(`Eine Sammlung „${andere.name}“ gibt es schon.`); return; }
  if (!sammlungDialog.auswahl.size) {
    zeigeFehler(alt ? 'Wähle mindestens ein Rezept aus – oder löse die Sammlung mit „Auflösen“ auf.' : 'Wähle mindestens ein Rezept für die Sammlung aus.');
    return;
  }
  let geaendert = 0;
  for (const r of daten.rezepte) {
    if (setzeSammlung(r, name, sammlungDialog.auswahl.has(r.id), alt || name)) {
      merke('rezepte', r);
      geaendert++;
    }
  }
  if (geaendert) speichere();
  $('#dlg-sammlung').close();
  if (ansicht === 'sammlung') {
    offeneSammlung = name;
    history.replaceState({ sammlung: name }, '');
    zeichneSammlung();
  } else {
    zeigeSammlung(name);
  }
  zeigeStatus(alt ? 'Sammlung gespeichert.' : `Sammlung „${name}“ angelegt.`);
});

$('#sammlung-aufloesen').addEventListener('click', () => {
  const name = sammlungDialog.alt;
  if (!confirm(`Sammlung „${name}“ auflösen? Die Rezepte selbst bleiben erhalten.`)) return;
  for (const r of daten.rezepte) {
    if (setzeSammlung(r, name, false)) merke('rezepte', r);
  }
  speichere();
  $('#dlg-sammlung').close();
  if (history.state && history.state.sammlung) history.back();
  else zeigeAnsicht('liste');
  zeigeStatus(`Sammlung „${name}“ aufgelöst.`);
});

/* ================= Ereignisse ================= */

document.querySelector('.navi').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ansicht]');
  if (!b) return;
  if (ansicht === 'rezept' || ansicht === 'sammlung') history.replaceState(null, '');
  zeigeAnsicht(b.dataset.ansicht);
});

$('#zurueck').addEventListener('click', () => {
  if (history.state && (history.state.rezept || history.state.sammlung)) history.back();
  else zeigeAnsicht(ansicht === 'rezept' ? rueckAnsicht : 'liste');
});

window.addEventListener('popstate', (e) => {
  if (e.state && e.state.rezept && rezeptMitId(e.state.rezept)) oeffneRezept(e.state.rezept, false);
  else if (e.state && e.state.sammlung) zeigeSammlung(e.state.sammlung, false);
  else if (ansicht === 'rezept' || ansicht === 'sammlung') zeigeAnsicht(ansicht === 'rezept' ? rueckAnsicht : 'liste');
});

$('#neu').addEventListener('click', () => {
  importZiel = ansicht === 'sammlung' ? offeneSammlung : '';
  oeffneImport();
});
$('#bearbeiten').addEventListener('click', () => {
  if (ansicht === 'sammlung') oeffneSammlungsDialog(offeneSammlung);
  else oeffneFormular(rezeptMitId(offenesRezept.id));
});
$('#sammlung-bearbeiten').addEventListener('click', () => oeffneSammlungsDialog(offeneSammlung));
$('#sammlung-liste').addEventListener('click', (e) => {
  const karte = e.target.closest('[data-rezept]');
  if (karte) oeffneRezept(karte.dataset.rezept);
});
$('#sammlungen').addEventListener('click', (e) => {
  const karte = e.target.closest('[data-sammlung]');
  if (karte) zeigeSammlung(karte.dataset.sammlung);
  else if (e.target.closest('[data-aktion="neue-sammlung"]')) oeffneSammlungsDialog('');
  else if (e.target.closest('[data-aktion="sammlungen-umschalten"]')) {
    const offen = !sammlungenOffen();
    setzeSammlungenOffen(offen);
    zeichneSammlungen();
    if (!offen) $('#sammlungen').scrollIntoView({ block: 'nearest' });
  }
});
$('#suche').addEventListener('input', zeichneListe);
$('#sortierung').addEventListener('change', zeichneListe);

$('#filter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  filter = b.dataset.filter;
  zeichneListe();
});

$('#liste').addEventListener('click', (e) => {
  const karte = e.target.closest('[data-rezept]');
  if (karte) oeffneRezept(karte.dataset.rezept);
  if (e.target.closest('[data-aktion="neu"]')) {
    importZiel = '';
    oeffneImport();
  }
});

$('#rezept-detail').addEventListener('click', async (e) => {
  const r = rezeptMitId(offenesRezept.id);
  const zutat = e.target.closest('[data-zutat]');
  if (zutat) {
    const i = Number(zutat.dataset.zutat);
    if (!offenesRezept.zutatenAus.delete(i)) offenesRezept.zutatenAus.add(i);
    zutat.classList.toggle('erledigt');
    return;
  }
  const schritt = e.target.closest('[data-schritt]');
  if (schritt) {
    const i = Number(schritt.dataset.schritt);
    if (!offenesRezept.schritteAus.delete(i)) offenesRezept.schritteAus.add(i);
    schritt.classList.toggle('erledigt');
    return;
  }
  const portion = e.target.closest('[data-portion]');
  if (portion) { aenderePortionen(Number(portion.dataset.portion)); return; }
  const sammlungLink = e.target.closest('[data-sammlung-link]');
  if (sammlungLink) { zeigeSammlung(sammlungLink.dataset.sammlungLink); return; }

  const aktion = e.target.closest('[data-aktion]');
  if (!aktion) return;
  switch (aktion.dataset.aktion) {
    case 'favorit':
      r.favorit = !r.favorit;
      merke('rezepte', r);
      speichere();
      zeichneRezept();
      break;
    case 'einkaufen':
      oeffneEinkaufen();
      break;
    case 'planen':
      oeffneTagWahl(r);
      break;
    case 'sammlungen':
      oeffneZuordnung(r);
      break;
    case 'kochmodus':
      setzeKochmodus(!kochmodus);
      break;
    case 'bearbeiten':
      oeffneFormular(r);
      break;
    case 'teilen':
      navigator.share({ title: r.titel, url: r.quelle }).catch(() => {});
      break;
    case 'loeschen':
      if (!confirm(`„${r.titel}“ wirklich löschen?`)) return;
      daten.rezepte = daten.rezepte.filter((x) => x.id !== r.id);
      merkeGeloescht('rezepte', r.id);
      speichere();
      raeumeFotosAuf();
      offenesRezept = null;
      if (history.state && history.state.rezept) history.back();
      else zeigeAnsicht('liste');
      zeigeStatus('Rezept gelöscht.');
      break;
    default:
  }
});

$('#form-einkauf').addEventListener('submit', (e) => {
  e.preventDefault();
  const feld = e.target.text;
  const text = feld.value.trim();
  if (!text) return;
  const posten = { id: neueId(), text, erledigt: false, rezept: '' };
  daten.einkauf.push(posten);
  merke('einkauf', posten);
  speichere();
  feld.value = '';
  zeichneEinkauf();
  feld.focus();
});

$('#einkauf-liste').addEventListener('click', (e) => {
  const b = e.target.closest('[data-posten]');
  if (!b) return;
  const p = daten.einkauf.find((x) => x.id === b.dataset.posten);
  if (!p) return;
  p.erledigt = !p.erledigt;
  merke('einkauf', p);
  speichere();
  zeichneEinkauf();
});

$('#einkauf-aufraeumen').addEventListener('click', () => {
  daten.einkauf.filter((p) => p.erledigt).forEach((p) => merkeGeloescht('einkauf', p.id));
  daten.einkauf = daten.einkauf.filter((p) => !p.erledigt);
  speichere();
  zeichneEinkauf();
});

$('#einkauf-teilen').addEventListener('click', async () => {
  const text = einkaufText();
  if (navigator.share) {
    navigator.share({ title: 'Einkaufsliste', text }).catch(() => {});
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    zeigeStatus('Einkaufsliste kopiert.');
  } catch (err) {
    zeigeStatus('Teilen ist hier nicht möglich.');
  }
});

/* ---------- Einstellungen und Sicherung ---------- */

function zeitpunktText(ms) {
  if (!ms) return 'noch nie';
  const d = new Date(ms);
  const heute = new Date().toDateString() === d.toDateString();
  return heute ? `heute um ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr`
    : d.toLocaleString('de-DE', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function zeichneSyncEinstellungen() {
  const an = verbunden();
  $('#sync-aus').hidden = an;
  $('#sync-an').hidden = !an;
  $('#sicherung-hinweis').textContent = an
    ? 'Deine Rezepte liegen auch im Google Sheet. Eine Sicherungsdatei ab und zu schadet trotzdem nicht.'
    : 'Deine Rezepte sind nur auf diesem Handy gespeichert. Mit einer Sicherungsdatei kannst du sie aufbewahren oder auf ein anderes Handy übertragen.';
  if (!an) return;
  const s = daten.einstellungen.sync;
  const offen = Object.keys(daten.ausstehend.rezepte).length + Object.keys(daten.ausstehend.einkauf).length + Object.keys(daten.ausstehend.plan).length;
  let text = `✅ Verbunden mit deinem Google Sheet. Zuletzt abgeglichen: ${zeitpunktText(s.zuletzt)}.`;
  if (offen) text += ` ${offen} ${offen === 1 ? 'Änderung wartet' : 'Änderungen warten'} noch auf den Abgleich.`;
  if (s.fehler) text += ` ⚠ ${s.fehler}`;
  $('#sync-info').textContent = text;
}

$('#einstellungen').addEventListener('click', () => {
  $('#proxy').value = daten.einstellungen.proxy || '';
  zeichneSyncEinstellungen();
  oeffneDialog($('#dlg-einstellungen'));
});

$('#form-sync').addEventListener('submit', async (e) => {
  e.preventDefault();
  const feld = e.target.url;
  const knopf = e.target.querySelector('button');
  const url = feld.value.trim();
  if (/\/dev$/.test(url)) {
    zeigeStatus('Das ist die Test-Adresse (…/dev). Bitte die Adresse der Bereitstellung nehmen, sie endet auf …/exec.', 6000);
    return;
  }
  if (!SKRIPT_RE.test(url)) {
    zeigeStatus('Die Adresse muss so aussehen: https://script.google.com/macros/s/…/exec', 5000);
    feld.focus();
    return;
  }
  knopf.disabled = true;
  knopf.textContent = 'Verbinde …';
  try {
    await verbinde(url);
    feld.value = '';
    zeichneSyncEinstellungen();
    zeigeStatus('Verbunden! Teile jetzt den Einladungs-Link mit der anderen Person.', 5000);
  } catch (err) {
    zeigeStatus(err.code === 'schluessel'
      ? 'Dieses Sheet ist schon mit einem anderen Handy eingerichtet. Lass dir dort unter ⚙ den Einladungs-Link schicken.'
      : err.message, 7000);
  } finally {
    knopf.disabled = false;
    knopf.textContent = 'Verbinden';
  }
});

$('#sync-einladen').addEventListener('click', async () => {
  const link = einladungsLink();
  if (navigator.share) {
    navigator.share({ title: 'Unsere Rezepte', text: 'Tippe auf den Link, um meine Rezepte und unsere Einkaufsliste in der Rezepte-App zu öffnen:', url: link }).catch(() => {});
    return;
  }
  try {
    await navigator.clipboard.writeText(link);
    zeigeStatus('Einladungs-Link kopiert.');
  } catch (err) {
    prompt('Einladungs-Link zum Kopieren:', link);
  }
});

$('#sync-jetzt').addEventListener('click', () => gleicheAb({ laut: true }));
$('#sync').addEventListener('click', () => gleicheAb({ laut: true }));

$('#sync-trennen').addEventListener('click', () => {
  if (!confirm('Dieses Handy vom Google Sheet trennen? Die Rezepte bleiben auf dem Handy, werden aber nicht mehr abgeglichen.')) return;
  trenne();
  zeichneSyncEinstellungen();
  zeigeStatus('Getrennt.');
});

async function nimmEinladungAn(einladung) {
  if (verbunden() && daten.einstellungen.sync.url === einladung.url && daten.einstellungen.sync.schluessel === einladung.schluessel) {
    gleicheAb();
    return;
  }
  const frage = verbunden()
    ? 'Dieses Handy ist schon mit einem anderen Google Sheet verbunden. Stattdessen mit der neuen Rezeptsammlung verbinden?'
    : 'Mit der gemeinsamen Rezeptsammlung verbinden? Rezepte, die schon auf diesem Handy sind, kommen dazu.';
  if (!confirm(frage)) return;
  zeigeStatus('Verbinde …', 30000);
  try {
    await verbinde(einladung.url, einladung.schluessel);
    zeigeStatus(`Verbunden! ${daten.rezepte.length} ${daten.rezepte.length === 1 ? 'Rezept' : 'Rezepte'} in der Sammlung.`, 5000);
  } catch (err) {
    zeigeStatus(err.message, 7000);
  }
}

$('#proxy').addEventListener('change', (e) => {
  const wert = e.target.value.trim();
  daten.einstellungen.proxy = /^https:\/\//i.test(wert) ? wert : '';
  e.target.value = daten.einstellungen.proxy;
  speichere();
  if (wert && !daten.einstellungen.proxy) zeigeStatus('Der Umweg muss mit https:// beginnen.');
});

$('#exportieren').addEventListener('click', async () => {
  // Ohne Zugangsdaten zum Google Sheet, die gehören nicht in eine Datei auf Google Drive.
  const sicherung = { version: daten.version, rezepte: daten.rezepte, einkauf: daten.einkauf, plan: daten.plan, einstellungen: { proxy: daten.einstellungen.proxy } };
  // Eigene Fotos kommen mit in die Datei, damit sie beim Zurückholen nicht fehlen.
  const fotos = {};
  for (const r of daten.rezepte) {
    if (!r.foto || fotos[r.foto]) continue;
    const blob = await fotoBlob(r.foto);
    if (blob) fotos[r.foto] = { typ: blob.type || 'image/jpeg', daten: await blobAlsBase64(blob) };
  }
  if (Object.keys(fotos).length) sicherung.fotos = fotos;
  const blob = new Blob([JSON.stringify(sicherung, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rezepte-sicherung-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});

$('#importieren').addEventListener('click', () => $('#import-datei').click());

$('#import-datei').addEventListener('change', async (e) => {
  const datei = e.target.files[0];
  e.target.value = '';
  if (!datei) return;
  try {
    const neu = JSON.parse(await datei.text());
    if (!neu || !Array.isArray(neu.rezepte)) throw new Error('kein Format');
    const ids = new Set(daten.rezepte.map((r) => r.id));
    const quellen = new Set(daten.rezepte.map((r) => r.quelle).filter(Boolean));
    let dazu = 0;
    const fotos = neu.fotos && typeof neu.fotos === 'object' ? neu.fotos : {};
    for (const r of neu.rezepte) {
      if (!r || !r.titel || ids.has(r.id) || (r.quelle && quellen.has(r.quelle))) continue;
      let foto = typeof r.foto === 'string' ? r.foto : '';
      const gesichert = foto && fotos[foto];
      if (gesichert && gesichert.daten && fotosMoeglich()) {
        // Als neues Foto übernehmen; mit Google Sheet wird es beim nächsten Abgleich hochgeladen.
        foto = `lokal-${neueId()}`;
        fotosInArbeit.add(foto);
        try {
          await speichereFoto(foto, base64AlsBlob(gesichert.daten, gesichert.typ));
        } catch (err) {
          fotosInArbeit.delete(foto);
          foto = '';
        }
      } else if (istLokalesFoto(foto)) {
        foto = '';
      }
      const rezept = neuesRezept({
        ...r, foto, id: r.id || neueId(), zutaten: alsListe(r.zutaten).map(String), schritte: alsListe(r.schritte).map(String),
        sammlungen: alsListe(r.sammlungen).map(sammlungsName).filter(Boolean),
      });
      daten.rezepte.push(rezept);
      merke('rezepte', rezept);
      dazu++;
    }
    const postenIds = new Set(daten.einkauf.map((p) => p.id));
    for (const p of alsListe(neu.einkauf)) {
      if (!p || !p.text || postenIds.has(p.id)) continue;
      const posten = { id: p.id || neueId(), text: String(p.text), erledigt: Boolean(p.erledigt), rezept: p.rezept || '' };
      daten.einkauf.push(posten);
      merke('einkauf', posten);
    }
    const planIds = new Set(daten.plan.map((p) => p.id));
    for (const p of alsListe(neu.plan)) {
      if (!p || !ISO_TAG.test(p.datum || '') || planIds.has(p.id) || !(p.rezept || p.name)) continue;
      const eintrag = { id: p.id || neueId(), datum: p.datum, rezept: String(p.rezept || ''), name: String(p.name || '') };
      daten.plan.push(eintrag);
      merke('plan', eintrag);
    }
    speichere();
    for (const r of daten.rezepte) if (istLokalesFoto(r.foto)) fotosInArbeit.delete(r.foto);
    $('#dlg-einstellungen').close();
    zeigeAnsicht('liste');
    zeigeStatus(`${dazu} ${dazu === 1 ? 'Rezept' : 'Rezepte'} importiert.`);
  } catch (err) {
    zeigeStatus('Die Datei ist keine Rezepte-Sicherung.');
  }
});

/* ================= Start ================= */

// Geteilte Links (Teilen-Menü in Chrome oder der Chefkoch-App) direkt importieren.
function geteilteUrl() {
  const p = new URLSearchParams(location.search);
  const url = urlAusText(p.get('url')) || urlAusText(p.get('text')) || urlAusText(p.get('title'));
  if (p.has('url') || p.has('text') || p.has('title')) history.replaceState(null, '', location.pathname);
  return url;
}

raeumePlanAuf();
const einladung = leseEinladung();
history.replaceState(null, '');
zeigeAnsicht('liste');
aktualisiereEinkaufZahl();
setzeSyncAnzeige(verbunden() && daten.einstellungen.sync.fehler ? 'fehler' : 'ok');
const geteilt = geteilteUrl();
if (geteilt) oeffneImport(geteilt);
if (einladung) setTimeout(() => nimmEinladungAn(einladung), 300);
else gleicheAb();

// Regelmäßig abgleichen, solange die App sichtbar ist – in der Einkaufsliste öfter,
// damit man beim gemeinsamen Einkaufen sieht, was der andere schon im Wagen hat.
setInterval(() => {
  if (!verbunden() || document.visibilityState !== 'visible' || abgleichLaeuft) return;
  const abstand = ansicht === 'einkauf' ? 20000 : 120000;
  if (Date.now() - Math.max(daten.einstellungen.sync.zuletzt || 0, letzterVersuch) >= abstand) gleicheAb();
}, 10000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') gleicheAb();
});

window.addEventListener('online', () => gleicheAb());

// Chrome soll die Daten nicht bei Speicherknappheit wegräumen.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

if ('serviceWorker' in navigator) {
  // Ist schon eine ältere Version aktiv, wird nach einem Update einmal neu geladen.
  const hatteVersion = Boolean(navigator.serviceWorker.controller);
  let neuGeladen = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hatteVersion || neuGeladen) return;
    if (document.querySelector('dialog[open]') || kochmodus) {
      zeigeStatus('Neue Version geladen. Sie ist beim nächsten Öffnen der App aktiv.');
      return;
    }
    neuGeladen = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').then((anmeldung) => {
    // Die installierte App bleibt oft im Hintergrund offen; beim Zurückholen nach Updates schauen.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') anmeldung.update().catch(() => {});
    });
  }).catch(() => {});
}
