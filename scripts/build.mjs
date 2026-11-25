#!/usr/bin/env node
/**
 * Builds the Claude token usage display from usage/snapshots.jsonl.
 *
 *   node scripts/build.mjs                         rebuild everything
 *   node scripts/build.mjs --now 2026-11-25T12:00Z  pin the "Updated" date
 *
 * A snapshot is the cumulative per-model usage of one session at one moment,
 * copied from the newest finished turn of that session. The usage between two
 * snapshots of the same session is their difference, so adding the same data
 * twice never double counts.
 *
 * Writes cards/usage-light.svg, cards/usage-dark.svg, usage/summary.json,
 * usage/badge.json and the tables between the usage markers in README.md.
 *
 * No dependencies. Node 18 or newer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = {
  config: path.join(ROOT, 'usage', 'config.json'),
  snapshots: path.join(ROOT, 'usage', 'snapshots.jsonl'),
  summary: path.join(ROOT, 'usage', 'summary.json'),
  badge: path.join(ROOT, 'usage', 'badge.json'),
  readme: path.join(ROOT, 'README.md'),
  cards: path.join(ROOT, 'cards'),
};

// Field names in a per-model snapshot, as Claude Code reports them in a
// finished turn's modelUsage.
const FIELDS = {
  input: 'inputTokens',
  output: 'outputTokens',
  cacheWrite: 'cacheCreationInputTokens',
  cacheRead: 'cacheReadInputTokens',
};
// Field names in a session-total snapshot, as get_session reports them in
// external_metadata.usage. These totals are not split by model.
const USAGE_FIELDS = {
  input: 'input_tokens',
  output: 'output_tokens',
  cacheWrite: 'cache_write_tokens',
  cacheRead: 'cache_read_tokens',
};
const KINDS = Object.keys(FIELDS);
const UNSPLIT = 'unsplit';

const DEFAULT_CONFIG = { timezone: 'Europe/Oslo', title: 'Claude token usage', weeks: 12 };

// Colors are GitHub's own surfaces and inks, plus three model hues that pass
// the colorblind and contrast checks against both surfaces in every pairing.
// Any model outside the three families shares the neutral "other" gray.
const THEMES = {
  light: {
    surface: '#ffffff', border: '#d1d9e0', text: '#1f2328', muted: '#59636e',
    grid: '#eaeef2', axis: '#d1d9e0',
    group: { opus: '#f47230', sonnet: '#257de0', haiku: '#00b894', other: '#8c959f' },
  },
  dark: {
    surface: '#0d1117', border: '#3d444d', text: '#f0f6fc', muted: '#9198a1',
    grid: '#21262d', axis: '#3d444d',
    group: { opus: '#e76624', sonnet: '#338ced', haiku: '#00a888', other: '#6e7681' },
  },
};
const GROUP_ORDER = ['opus', 'sonnet', 'haiku', 'other'];

// ---------------------------------------------------------------- helpers

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseTime(value, where) {
  const d = typeof value === 'string' ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) fail(`${where} must be an ISO date and time, got ${JSON.stringify(value)}`);
  return d;
}

function count(value, where) {
  if (!Number.isInteger(value) || value < 0) fail(`${where} must be a whole number of 0 or more, got ${JSON.stringify(value)}`);
  return value;
}

function money(value, where) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`${where} must be a number of 0 or more, got ${JSON.stringify(value)}`);
  return value;
}

const zero = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
const tokensOf = (u) => u.input + u.output + u.cacheWrite + u.cacheRead;
const isZero = (u) => KINDS.every((k) => u[k] === 0) && Math.abs(u.cost) < 1e-9;

function add(into, u) {
  for (const k of KINDS) into[k] += u[k];
  into.cost += u.cost;
  return into;
}

function sub(a, b) {
  const d = { cost: a.cost - b.cost };
  for (const k of KINDS) d[k] = a[k] - b[k];
  return d;
}

const sumModels = (models) => Object.values(models).reduce((acc, u) => add(acc, u), zero());

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const intFmt = new Intl.NumberFormat('en-US');
const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmtInt = (n) => intFmt.format(Math.round(n));
const fmtUsd = (n) => usdFmt.format(n);

/** 999 / 12.3K / 2.35M / 140.4M / 1.24B, rolling over to the next unit cleanly. */
function compact(n) {
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (let i = units.length - 1; i >= 0; i -= 1) {
    const [size, suffix] = units[i];
    const bigger = units[i - 1];
    if (n >= size && (!bigger || n < bigger[0])) {
      const x = n / size;
      const text = x.toFixed(x >= 10 ? 1 : 2).replace(/\.?0+$/, '');
      if (Number(text) >= 1000 && bigger) return compact(bigger[0]);
      return text + suffix;
    }
  }
  return String(Math.round(n));
}

function percent(share) {
  const p = share * 100;
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${p.toFixed(1)}%`;
}

// ------------------------------------------------------------------ dates

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function makeDates(timeZone) {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = (day) => day.split('-').map(Number);
  const toUtc = (day) => new Date(`${day}T00:00:00Z`);
  const iso = (d) => d.toISOString().slice(0, 10);
  return {
    /** Local calendar day of an instant, as YYYY-MM-DD. */
    day: (instant) => ymd.format(instant),
    /** Monday of the week that a YYYY-MM-DD day falls in. */
    weekOf(day) {
      const d = toUtc(day);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return iso(d);
    },
    addDays(day, n) {
      const d = toUtc(day);
      d.setUTCDate(d.getUTCDate() + n);
      return iso(d);
    },
    long(day) {
      const [y, m, d] = parts(day);
      return `${d} ${MONTHS[m - 1]} ${y}`;
    },
    short(day) {
      const [, m, d] = parts(day);
      return `${d} ${MONTHS[m - 1]}`;
    },
  };
}

// ----------------------------------------------------------------- models

/** "claude-opus-5-5" -> { group: "opus", label: "Opus 5.5" } */
function describeModel(id) {
  if (id === UNSPLIT) return { group: 'other', family: UNSPLIT, label: 'Not split by model' };
  const bare = id.replace(/\[.*\]$/, '');
  let family = null;
  let version = null;
  let m = bare.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/);
  if (m) [family, version] = [m[1], m[3] ? `${m[2]}.${m[3]}` : m[2]];
  m = bare.match(/^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/);
  if (m) [family, version] = [m[3], m[2] ? `${m[1]}.${m[2]}` : m[1]];
  if (!family) return { group: 'other', family: 'other', label: id };
  const name = family[0].toUpperCase() + family.slice(1);
  return {
    group: GROUP_ORDER.includes(family) ? family : 'other',
    family,
    label: `${name} ${version}`,
  };
}

// ------------------------------------------------------------------ input

function loadConfig() {
  const config = { ...DEFAULT_CONFIG };
  if (fs.existsSync(FILES.config)) Object.assign(config, JSON.parse(fs.readFileSync(FILES.config, 'utf8')));
  if (!Number.isInteger(config.weeks) || config.weeks < 4 || config.weeks > 52) fail('usage/config.json: "weeks" must be a whole number from 4 to 52');
  try {
    new Intl.DateTimeFormat('en', { timeZone: config.timezone });
  } catch {
    fail(`usage/config.json: unknown timezone ${JSON.stringify(config.timezone)}`);
  }
  return config;
}

function loadSnapshots() {
  if (!fs.existsSync(FILES.snapshots)) return [];
  const snapshots = [];
  fs.readFileSync(FILES.snapshots, 'utf8').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const where = `usage/snapshots.jsonl line ${i + 1}`;
    let o;
    try {
      o = JSON.parse(line);
    } catch (e) {
      fail(`${where} is not valid JSON (${e.message})`);
    }
    if (typeof o.session !== 'string' || !o.session) fail(`${where}: "session" must be a non-empty string`);
    let models = null;
    let totals = null;
    if (o.usage != null) {
      if (typeof o.usage !== 'object' || Array.isArray(o.usage)) fail(`${where}: "usage" must be an object`);
      totals = { cost: money(o.usage.cost_usd ?? 0, `${where}: usage.cost_usd`) };
      for (const [k, field] of Object.entries(USAGE_FIELDS)) totals[k] = count(o.usage[field] ?? 0, `${where}: usage.${field}`);
    } else {
      if (!o.models || typeof o.models !== 'object' || Array.isArray(o.models)) fail(`${where}: needs "models" or "usage"`);
      models = {};
      for (const [id, m] of Object.entries(o.models)) {
        const u = { cost: money(m.costUSD ?? 0, `${where}: ${id}.costUSD`) };
        for (const [k, field] of Object.entries(FIELDS)) u[k] = count(m[field] ?? 0, `${where}: ${id}.${field}`);
        models[id] = u;
      }
      if (o.totalCostUSD != null) {
        const sum = Object.values(models).reduce((a, u) => a + u.cost, 0);
        if (Math.abs(sum - money(o.totalCostUSD, `${where}: totalCostUSD`)) > 0.01) {
          fail(`${where}: the model costs add up to ${sum.toFixed(4)} but totalCostUSD is ${o.totalCostUSD}, so a number was copied wrong`);
        }
      }
    }
    snapshots.push({
      line: i + 1,
      session: o.session,
      at: parseTime(o.at, `${where}: "at"`),
      since: o.since == null ? null : parseTime(o.since, `${where}: "since"`),
      models,
      totals,
    });
  });
  return snapshots;
}

// ---------------------------------------------------------------- ledger

/**
 * Turns snapshots into usage entries. Each entry is the usage between two
 * snapshots of one session, dated to the day of the newer one. A session's
 * first snapshot covers everything since the session started, so its entry
 * runs from the start day (`from`) to the snapshot day (`to`).
 *
 * A session-total snapshot can run ahead of the newest per-model one (a turn
 * still in progress). The part beyond the per-model numbers is counted as
 * "not split by model", and moved back out once a later per-model snapshot
 * covers it, so nothing is counted twice.
 */
function buildLedger(snapshots, dates, warnings) {
  const bySession = new Map();
  for (const s of snapshots) {
    if (!bySession.has(s.session)) bySession.set(s.session, []);
    bySession.get(s.session).push(s);
  }
  const entries = [];
  for (const [session, list] of bySession) {
    list.sort((a, b) => a.at - b.at || a.line - b.line);
    const unique = [];
    for (const s of list) {
      const last = unique[unique.length - 1];
      if (last && last.at.getTime() === s.at.getTime()) unique[unique.length - 1] = s;
      else unique.push(s);
    }
    let perModel = {};
    let unsplit = zero();
    const freshStart = (s) => {
      warnings.push(`session ${session}: the numbers on line ${s.line} are lower than before, so they are counted as a fresh start`);
      perModel = {};
      unsplit = zero();
    };
    unique.forEach((s, index) => {
      const delta = {};
      if (s.models) {
        const dropped = Object.entries(s.models).some(([id, u]) => perModel[id] && KINDS.some((k) => u[k] < perModel[id][k]));
        if (dropped) {
          freshStart(s);
        } else if (!isZero(unsplit)) {
          delta[UNSPLIT] = sub(zero(), unsplit);
          unsplit = zero();
        }
        for (const [id, u] of Object.entries(s.models)) {
          const d = sub(u, perModel[id] || zero());
          d.cost = Math.max(0, d.cost);
          delta[id] = d;
        }
        perModel = { ...perModel, ...s.models };
      } else {
        let extra = sub(s.totals, sumModels(perModel));
        if (KINDS.some((k) => extra[k] < 0)) {
          freshStart(s);
          extra = { ...s.totals };
        }
        delta[UNSPLIT] = sub(extra, unsplit);
        unsplit = extra;
      }
      const models = Object.fromEntries(Object.entries(delta).filter(([, d]) => !isZero(d)));
      const to = dates.day(s.at);
      let from = index === 0 && s.since ? dates.day(s.since) : to;
      if (from > to) from = to;
      if (Object.keys(models).length) entries.push({ session, from, to, models });
    });
  }
  return entries;
}

// --------------------------------------------------------------- summary

function summarize(entries, config, dates, now) {
  const byModel = new Map();
  const total = zero();
  const sessions = new Set();
  const weeks = new Map();
  let since = null;
  for (const e of entries) {
    sessions.add(e.session);
    if (!since || e.from < since) since = e.from;
    const week = dates.weekOf(e.to);
    if (!weeks.has(week)) weeks.set(week, new Map());
    const weekModels = weeks.get(week);
    for (const [id, u] of Object.entries(e.models)) {
      if (!byModel.has(id)) byModel.set(id, zero());
      add(byModel.get(id), u);
      add(total, u);
      if (!weekModels.has(id)) weekModels.set(id, zero());
      add(weekModels.get(id), u);
    }
  }

  const models = [...byModel.entries()]
    .map(([id, u]) => ({ id, ...describeModel(id), ...u, tokens: tokensOf(u) }))
    .filter((m) => m.tokens !== 0 || Math.abs(m.cost) >= 0.005)
    .sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id));

  const totalTokens = tokensOf(total);
  const groups = GROUP_ORDER.map((key) => {
    const members = models.filter((m) => m.group === key);
    if (!members.length) return null;
    const tokens = members.reduce((a, m) => a + m.tokens, 0);
    const labels = [...new Set(members.map((m) => m.label))];
    let label = labels[0];
    if (labels.length > 1) label = key === 'other' ? 'Other' : key[0].toUpperCase() + key.slice(1);
    return { key, label, tokens, share: totalTokens ? tokens / totalTokens : 0 };
  }).filter(Boolean);

  const today = dates.day(now);
  const thisWeek = dates.weekOf(today);
  const chartWeeks = [];
  for (let i = config.weeks - 1; i >= 0; i -= 1) {
    const start = dates.addDays(thisWeek, -7 * i);
    const perGroup = Object.fromEntries(GROUP_ORDER.map((g) => [g, 0]));
    for (const [id, u] of weeks.get(start) || []) perGroup[describeModel(id).group] += tokensOf(u);
    // A "not split by model" correction can land in a later week than the
    // usage it corrects. Keep the week's total and draw no negative segment.
    const deficit = GROUP_ORDER.reduce((a, g) => a + Math.min(0, perGroup[g]), 0);
    if (deficit < 0) {
      for (const g of GROUP_ORDER) perGroup[g] = Math.max(0, perGroup[g]);
      const biggest = GROUP_ORDER.reduce((a, g) => (perGroup[g] > perGroup[a] ? g : a));
      perGroup[biggest] = Math.max(0, perGroup[biggest] + deficit);
    }
    chartWeeks.push({ start, groups: perGroup, tokens: Object.values(perGroup).reduce((a, b) => a + b, 0) });
  }

  const allWeeks = [...weeks.entries()]
    .map(([start, ms]) => {
      const byModelWeek = {};
      let tokens = 0;
      for (const [id, u] of ms) {
        byModelWeek[id] = tokensOf(u);
        tokens += tokensOf(u);
      }
      return { start, tokens, byModel: byModelWeek };
    })
    .sort((a, b) => (a.start < b.start ? 1 : -1));

  return {
    updated: now,
    today,
    since,
    sessions: sessions.size,
    total: { ...total, tokens: totalTokens },
    models,
    groups,
    chartWeeks,
    allWeeks,
  };
}

// ------------------------------------------------------------------- card

/** A rectangle with rounded top corners and a square bottom. */
function columnPath(x, top, width, bottom, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, bottom - top));
  return [
    `M${x} ${bottom}`,
    `V${top + r}`,
    `A${r} ${r} 0 0 1 ${x + r} ${top}`,
    `H${x + width - r}`,
    `A${r} ${r} 0 0 1 ${x + width} ${top + r}`,
    `V${bottom}`,
    'Z',
  ].join(' ').replace(/(\d+\.\d{2})\d+/g, '$1');
}

/** A clean axis maximum: 1, 2, 2.5, 5 or 10 times a power of ten. */
function niceMax(value) {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

function renderCard(s, config, dates, themeName) {
  const t = THEMES[themeName];
  const W = 800;
  const P = 28;
  const H = 476;
  const out = [];
  const text = (x, y, content, attrs = '') => out.push(`<text x="${x}" y="${y}" ${attrs}>${escapeXml(content)}</text>`);
  const r2 = (n) => Math.round(n * 100) / 100;

  const sinceText = s.since ? `since ${dates.long(s.since)}` : 'none recorded yet';
  const titleText = `${config.title}: ${compact(s.total.tokens)} tokens ${sinceText}`;
  const descParts = s.groups.map((g) => `${g.label} ${percent(g.share)}`);
  const peak = s.chartWeeks.reduce((best, w) => (w.tokens > (best ? best.tokens : 0) ? w : best), null);
  if (peak) descParts.push(`busiest week started ${dates.long(peak.start)} with ${compact(peak.tokens)} tokens`);

  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">`);
  out.push(`<title id="title">${escapeXml(titleText)}</title>`);
  out.push(`<desc id="desc">${escapeXml(descParts.join('. '))}</desc>`);
  out.push('<style>');
  out.push(`text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}`);
  out.push(`.t{fill:${t.text}}.m{fill:${t.muted}}.n{font-variant-numeric:tabular-nums}`);
  out.push('</style>');
  out.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="${t.surface}" stroke="${t.border}"/>`);

  // Header
  text(P, 44, config.title, 'class="t" font-size="16" font-weight="600"');
  text(W - P, 44, `Updated ${dates.long(s.today)}`, 'class="m" font-size="12" text-anchor="end"');

  // Hero figure
  text(P, 116, compact(s.total.tokens), 'class="t" font-size="52" font-weight="600" letter-spacing="-0.5"');
  text(P, 142, s.since ? `${fmtInt(s.total.tokens)} tokens ${sinceText}` : 'No usage recorded yet', 'class="m" font-size="13"');

  // Stat tiles
  const tiles = [
    ['Input', compact(s.total.input)],
    ['Output', compact(s.total.output)],
    ['Cache write', compact(s.total.cacheWrite)],
    ['Cache read', compact(s.total.cacheRead)],
    ['At API prices', fmtUsd(s.total.cost)],
    ['Sessions', fmtInt(s.sessions)],
  ];
  tiles.forEach(([label, value], i) => {
    const x = 340 + (i % 3) * 145;
    const y = 82 + Math.floor(i / 3) * 48;
    text(x, y, label, 'class="m" font-size="12"');
    text(x, y + 24, value, 'class="t" font-size="20" font-weight="600"');
  });

  out.push(`<path d="M${P} 180.5H${W - P}" stroke="${t.grid}"/>`);

  // Model split: a thin segmented bar plus a legend that carries the numbers
  text(P, 208, 'By model', 'class="t" font-size="13" font-weight="600"');
  const barY = 220;
  const barW = W - 2 * P;
  const visible = s.groups.filter((g) => g.share > 0);
  if (visible.length) {
    const gaps = 2 * (visible.length - 1);
    const minW = 3;
    let widths = visible.map((g) => g.share * (barW - gaps));
    const short = widths.reduce((a, w) => a + Math.max(0, minW - w), 0);
    const widest = widths.indexOf(Math.max(...widths));
    widths = widths.map((w, i) => (i === widest ? w - short : Math.max(w, minW)));
    out.push(`<clipPath id="bar"><rect x="${P}" y="${barY}" width="${barW}" height="8" rx="4"/></clipPath>`);
    out.push('<g clip-path="url(#bar)">');
    let x = P;
    visible.forEach((g, i) => {
      out.push(`<rect x="${r2(x)}" y="${barY}" width="${r2(widths[i])}" height="8" fill="${t.group[g.key]}"/>`);
      x += widths[i] + 2;
    });
    out.push('</g>');
  } else {
    out.push(`<rect x="${P}" y="${barY}" width="${barW}" height="8" rx="4" fill="${t.grid}"/>`);
  }
  s.groups.forEach((g, i) => {
    const x = P + i * 186;
    out.push(`<rect x="${x}" y="241" width="10" height="10" rx="2" fill="${t.group[g.key]}"/>`);
    text(x + 16, 250, g.label, 'class="t" font-size="13"');
    text(x + 16, 268, `${compact(g.tokens)} (${percent(g.share)})`, 'class="m" font-size="12"');
  });

  // Weekly columns, stacked by model in a fixed order
  text(P, 306, 'Tokens per week', 'class="t" font-size="13" font-weight="600"');
  text(W - P, 306, `Last ${config.weeks} weeks`, 'class="m" font-size="12" text-anchor="end"');
  const plotTop = 336;
  const base = 436;
  const plotH = base - plotTop;
  const plotX = P + 42;
  const slot = (W - P - plotX) / s.chartWeeks.length;
  const colW = Math.min(24, slot - 8);
  const labelEvery = Math.max(1, Math.ceil(46 / slot));
  const maxWeek = Math.max(0, ...s.chartWeeks.map((w) => w.tokens));
  const top = niceMax(maxWeek);
  for (const v of maxWeek ? [top / 2, top] : []) {
    const y = Math.round(base - (v / top) * plotH) + 0.5;
    out.push(`<path d="M${plotX} ${y}H${W - P}" stroke="${t.grid}"/>`);
  }
  for (const v of [0, top / 2, top]) {
    const y = base - (v / top) * plotH;
    text(plotX - 8, r2(y + 4), maxWeek ? compact(v) : '', 'class="m n" font-size="11" text-anchor="end"');
  }
  const labelled = new Set();
  if (maxWeek > 0) {
    labelled.add(s.chartWeeks.findIndex((w) => w.tokens === maxWeek));
    let latest = -1;
    s.chartWeeks.forEach((w, i) => {
      if (w.tokens > 0) latest = i;
    });
    labelled.add(latest);
  }
  s.chartWeeks.forEach((w, i) => {
    const cx = plotX + slot * (i + 0.5);
    const x = r2(cx - colW / 2);
    let cum = 0;
    const segments = [];
    for (const g of GROUP_ORDER) {
      const v = w.groups[g];
      if (!v) continue;
      const bottom = base - (cum / top) * plotH;
      cum += v;
      const segTop = base - (cum / top) * plotH;
      segments.push({ g, top: segTop, bottom });
    }
    const drawn = [];
    segments.forEach((seg, k) => {
      const bottom = k === 0 ? seg.bottom : seg.bottom - 2;
      if (bottom - seg.top >= 1) drawn.push({ ...seg, bottom });
    });
    drawn.forEach((seg, k) => {
      const radius = k === drawn.length - 1 ? 4 : 0;
      out.push(`<path d="${columnPath(x, seg.top, colW, seg.bottom, radius)}" fill="${t.group[seg.g]}"/>`);
    });
    if (labelled.has(i)) {
      const labelY = (drawn.length ? drawn[drawn.length - 1].top : base) - 6;
      text(r2(cx), r2(labelY), compact(w.tokens), 'class="t" font-size="12" font-weight="600" text-anchor="middle"');
    }
    if ((s.chartWeeks.length - 1 - i) % labelEvery === 0) {
      text(r2(cx), base + 18, dates.short(w.start), 'class="m" font-size="11" text-anchor="middle"');
    }
  });
  out.push(`<path d="M${plotX} ${base + 0.5}H${W - P}" stroke="${t.axis}"/>`);
  if (!maxWeek) {
    text(r2((plotX + W - P) / 2), r2(plotTop + plotH / 2), `No usage in the last ${config.weeks} weeks`, 'class="m" font-size="13" text-anchor="middle"');
  }

  out.push('</svg>');
  return `${out.join('\n')}\n`;
}

// ----------------------------------------------------------------- README

function readmeTables(s, dates) {
  const lines = [];
  lines.push('| Model | Input | Output | Cache write | Cache read | Total | At API prices |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const m of s.models) {
    lines.push(`| ${m.label} | ${fmtInt(m.input)} | ${fmtInt(m.output)} | ${fmtInt(m.cacheWrite)} | ${fmtInt(m.cacheRead)} | ${fmtInt(m.tokens)} | ${fmtUsd(m.cost)} |`);
  }
  const t = s.total;
  lines.push(`| **All models** | **${fmtInt(t.input)}** | **${fmtInt(t.output)}** | **${fmtInt(t.cacheWrite)}** | **${fmtInt(t.cacheRead)}** | **${fmtInt(t.tokens)}** | **${fmtUsd(t.cost)}** |`);
  lines.push('');
  if (s.allWeeks.length) {
    lines.push('| Week starting | Tokens |');
    lines.push('|---|---:|');
    for (const w of s.allWeeks) lines.push(`| ${dates.long(w.start)} | ${fmtInt(w.tokens)} |`);
    lines.push('');
  }
  const plural = s.sessions === 1 ? 'session' : 'sessions';
  lines.push(`Updated ${dates.long(s.today)} from ${fmtInt(s.sessions)} ${plural}.`);
  return lines.join('\n');
}

function updateReadme(block) {
  if (!fs.existsSync(FILES.readme)) return false;
  const start = '<!-- usage:start -->';
  const end = '<!-- usage:end -->';
  const readme = fs.readFileSync(FILES.readme, 'utf8');
  const a = readme.indexOf(start);
  const b = readme.indexOf(end);
  if (a < 0 || b < a) return false;
  const next = `${readme.slice(0, a + start.length)}\n${block}\n${readme.slice(b)}`;
  if (next !== readme) fs.writeFileSync(FILES.readme, next);
  return true;
}

// ------------------------------------------------------------------- main

function main() {
  const args = process.argv.slice(2);
  const nowArg = args.indexOf('--now');
  const now = nowArg >= 0 ? parseTime(args[nowArg + 1], '--now') : new Date();

  const config = loadConfig();
  const dates = makeDates(config.timezone);
  const warnings = [];
  const entries = buildLedger(loadSnapshots(), dates, warnings);
  const s = summarize(entries, config, dates, now);

  fs.mkdirSync(FILES.cards, { recursive: true });
  for (const theme of Object.keys(THEMES)) {
    fs.writeFileSync(path.join(FILES.cards, `usage-${theme}.svg`), renderCard(s, config, dates, theme));
  }

  const summary = {
    updated: now.toISOString(),
    timezone: config.timezone,
    since: s.since,
    sessions: s.sessions,
    totals: {
      tokens: s.total.tokens,
      input: s.total.input,
      output: s.total.output,
      cacheWrite: s.total.cacheWrite,
      cacheRead: s.total.cacheRead,
      costUSD: Math.round(s.total.cost * 100) / 100,
    },
    models: s.models.map((m) => ({
      id: m.id,
      label: m.label,
      tokens: m.tokens,
      input: m.input,
      output: m.output,
      cacheWrite: m.cacheWrite,
      cacheRead: m.cacheRead,
      costUSD: Math.round(m.cost * 100) / 100,
    })),
    weeks: s.allWeeks,
  };
  fs.writeFileSync(FILES.summary, `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(FILES.badge, `${JSON.stringify({
    schemaVersion: 1,
    label: 'Claude tokens',
    message: compact(s.total.tokens),
    color: 'e76624',
  })}\n`);
  const readme = updateReadme(readmeTables(s, dates));

  for (const w of warnings) console.warn(`warning: ${w}`);
  const sessions = `${fmtInt(s.sessions)} ${s.sessions === 1 ? 'session' : 'sessions'}`;
  console.log(`ok: ${fmtInt(s.total.tokens)} tokens from ${sessions}, ${fmtUsd(s.total.cost)} at API prices${readme ? '' : ' (README markers not found, tables skipped)'}`);
}

main();
