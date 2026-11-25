#!/usr/bin/env node
/**
 * Adds usage snapshots to usage/snapshots.jsonl from Claude Code session events.
 *
 *   node scripts/snapshot-from-events.mjs --status
 *       list each recorded session with the time of its newest snapshot
 *
 *   node scripts/snapshot-from-events.mjs --session <id> --since <created_at> <file>
 *       read a saved `list_events` result (kinds ["result"]) and add the
 *       newest finished turn's cumulative usage
 *
 *   node scripts/snapshot-from-events.mjs --session <id> --since <created_at> --stdin <<'EOF'
 *   {"created_at": "...", "total_cost_usd": 1.23, "modelUsage": {...}}
 *   EOF
 *       the same, from pasted JSON: a whole events page, one result event, or
 *       just created_at, total_cost_usd and modelUsage copied from the newest
 *       result event
 *
 * Add --print to only print the line. A snapshot that is already recorded for
 * the same session and time is skipped. Only numbers are copied, never any
 * conversation text.
 *
 * No dependencies. Node 18 or newer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOTS = path.join(ROOT, 'usage', 'snapshots.jsonl');

function fail(message, code = 1) {
  console.error(`error: ${message}`);
  process.exit(code);
}

/** Parses the complete JSON object that starts at `start`, ignoring text around it. */
function parseObjectAt(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('the JSON object never closes');
}

/** Finds result events in any of the accepted shapes. */
function readEvents(text) {
  let root;
  try {
    const marker = text.indexOf('{"ccr"');
    if (marker >= 0) root = parseObjectAt(text, marker).ccr;
    else root = parseObjectAt(text, text.indexOf('{'));
  } catch (e) {
    fail(`could not read JSON (${e.message})`);
  }
  if (Array.isArray(root)) return { data: root };
  if (root && (Array.isArray(root.data) || 'has_more' in root)) return { ...root, data: root.data || [] };
  if (root && (root.result || root.modelUsage)) return { data: [root] };
  fail('found no events: expected a "data" list, one result event, or an object with modelUsage');
  return null;
}

function newestResult(events) {
  let newest = null;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const result = ev.result && typeof ev.result === 'object' ? ev.result : ev;
    const body = result.internal_anthropic_catchall || result;
    if (!body.modelUsage || !Object.keys(body.modelUsage).length) continue;
    const at = ev.created_at || body.created_at;
    if (!at) fail('a result has no created_at time');
    if (!newest || new Date(at) > new Date(newest.at)) newest = { at, body };
  }
  return newest;
}

function readSnapshots() {
  if (!fs.existsSync(SNAPSHOTS)) return [];
  return fs.readFileSync(SNAPSHOTS, 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      return fail(`usage/snapshots.jsonl line ${i + 1} is not valid JSON`);
    }
  });
}

function status() {
  const newest = new Map();
  for (const s of readSnapshots()) {
    const prev = newest.get(s.session);
    if (!prev || new Date(s.at) > new Date(prev)) newest.set(s.session, s.at);
  }
  if (!newest.size) console.log('no snapshots yet');
  for (const [session, at] of newest) console.log(`${session}  ${at}`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--status')) return status();
  const take = (name) => {
    const i = args.indexOf(name);
    return i < 0 ? null : args.splice(i, 2)[1];
  };
  const session = take('--session');
  const since = take('--since');
  const printOnly = args.includes('--print');
  const fromStdin = args.includes('--stdin');
  const file = args.find((a) => !a.startsWith('--'));
  if (!session || (!file && !fromStdin)) {
    fail('usage: snapshot-from-events.mjs --session <id> [--since <created_at>] (<file> | --stdin) [--print], or --status');
  }

  const page = readEvents(fs.readFileSync(fromStdin ? 0 : file, 'utf8'));
  const newest = newestResult(page.data);
  if (!newest) {
    const hint = page.has_more ? `page back with before_id "${page.first_id}"` : 'the session has no finished turn yet';
    fail(`no finished turn in this page: ${hint}`, 2);
  }

  const models = {};
  for (const [id, m] of Object.entries(newest.body.modelUsage)) {
    models[id] = {
      inputTokens: m.inputTokens ?? 0,
      outputTokens: m.outputTokens ?? 0,
      cacheCreationInputTokens: m.cacheCreationInputTokens ?? 0,
      cacheReadInputTokens: m.cacheReadInputTokens ?? 0,
      costUSD: m.costUSD ?? 0,
    };
  }
  const snapshot = { session, ...(since ? { since } : {}), at: newest.at };
  if (typeof newest.body.total_cost_usd === 'number') snapshot.totalCostUSD = newest.body.total_cost_usd;
  snapshot.models = models;
  const line = JSON.stringify(snapshot);
  if (printOnly) return console.log(line);

  const atTime = new Date(snapshot.at).getTime();
  if (readSnapshots().some((o) => o.session === session && new Date(o.at).getTime() === atTime)) {
    return console.log(`unchanged: ${session} already has a snapshot at ${snapshot.at}`);
  }
  const existing = fs.existsSync(SNAPSHOTS) ? fs.readFileSync(SNAPSHOTS, 'utf8') : '';
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(SNAPSHOTS, `${sep}${line}\n`);
  return console.log(`added: ${session} at ${snapshot.at}`);
}

main();
