import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";

/**
 * FAA Releasable Aircraft Database importer (MASTER.txt, optional ACFTREF.txt) -> the registry tables of migration 0003.
 *
 * Flow (one transaction): purge expired raw rows -> create the import run ("staging") -> stage each row in
 * airintel_private.faa_registry_raw (accepted or quarantined, 30-day retention) -> write accepted rows to
 * public.aircraft_registry_records -> mark the run "validated" (or "rejected" when too many rows fail) and, with
 * publish, "published". server/registry.ts then resolves exact Mode-S matches against the newest published snapshot.
 *
 * Privacy rules applied at ingestion (docs/phase-three-aircraft-intelligence.md):
 *  - Street address lines and ZIP codes are never stored, not even in the private raw staging table.
 *  - Natural-person owners (TYPE REGISTRANT 1 individual, 4/9 co-owned) are stored as `individual_redacted` with no
 *    display name. Only business / government / partnership / LLC registrants get a displayable name.
 */
export const IMPORTER_VERSION = "faa-import-v1";
export const SCHEMA_VERSION = "faa-master-2024";
export const DEFAULT_SOURCE_URL = "https://www.faa.gov/licenses_certificates/aircraft_certification/aircraft_registry/releasable_aircraft_download";
export const MAX_REJECTED_RATIO = 0.05;

const MAX_FILE_BYTES = 1_000_000_000;
const MAX_LINE_LENGTH = 65_536;
const BATCH = 1_000;
export const REQUIRED_HEADERS = ["N-NUMBER", "SERIAL NUMBER", "MFR MDL CODE", "TYPE REGISTRANT", "NAME", "STATUS CODE", "TYPE AIRCRAFT", "UNIQUE ID", "MODE S CODE HEX"];
/** Never stored anywhere (address lines). */
export const DROPPED_FIELDS = new Set(["STREET", "STREET2", "ZIP CODE"]);
const N_NUMBER = /^(?:[1-9][0-9]{0,4}|[1-9][0-9]{0,3}[A-HJ-NP-Z]|[1-9][0-9]{0,2}[A-HJ-NP-Z]{2})$/;
const MODE_S_HEX = /^[0-9A-F]{6}$/;

export function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') { field += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { fields.push(field.trim()); field = ""; }
    else field += character;
  }
  if (quoted) throw new Error("Unclosed CSV quote");
  fields.push(field.trim());
  return fields;
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const blankToNull = (value) => (value && value.trim() ? value.trim() : null);

/** TYPE REGISTRANT code -> registrant kind and whether the name may be displayed. */
export function registrantFor(code, name) {
  const displayName = blankToNull(name)?.replace(/\s+/g, " ") ?? null;
  const kinds = { "1": "individual", "2": "business", "3": "business", "4": "other", "5": "government", "7": "business", "8": "business", "9": "other" };
  const kind = kinds[String(code ?? "").trim()] ?? "unknown";
  // Individuals and co-owners (usually people) are natural persons: never displayed, never stored by name.
  if (kind === "individual" || kind === "other") return { kind, visibility: "individual_redacted", displayName: null };
  if (!displayName) return { kind, visibility: "unavailable", displayName: null };
  if (kind === "unknown") return { kind, visibility: "withheld", displayName: null };
  return { kind, visibility: "displayable_entity", displayName: displayName.slice(0, 200) };
}

/**
 * Pure: one MASTER row (header -> value) to a registry record, or the reasons it is quarantined.
 * `models` maps MFR MDL CODE -> { manufacturer, model } from ACFTREF.txt (optional).
 */
export function toRegistryRecord(row, models = new Map()) {
  const errors = [];
  const nRaw = String(row["N-NUMBER"] ?? "").trim().toUpperCase().replace(/^N/, "");
  if (!N_NUMBER.test(nRaw)) errors.push("invalid_n_number");
  const hexRaw = String(row["MODE S CODE HEX"] ?? "").trim().toUpperCase();
  if (hexRaw !== "" && !MODE_S_HEX.test(hexRaw)) errors.push("invalid_mode_s_hex");
  if (errors.length > 0) return { record: null, errors };
  const mfrModel = blankToNull(row["MFR MDL CODE"]);
  const model = mfrModel ? models.get(mfrModel) : undefined;
  const registrant = registrantFor(row["TYPE REGISTRANT"], row["NAME"]);
  return {
    errors,
    record: {
      registry_unique_id: blankToNull(row["UNIQUE ID"]) ?? `N${nRaw}`,
      n_number: `N${nRaw}`,
      mode_s_hex: hexRaw ? hexRaw.toLowerCase() : null,
      serial_number: blankToNull(row["SERIAL NUMBER"]),
      manufacturer_code: mfrModel,
      manufacturer_name: model?.manufacturer ?? null,
      model_code: mfrModel,
      model_name: model?.model ?? null,
      aircraft_type_code: blankToNull(row["TYPE AIRCRAFT"]),
      registration_status: blankToNull(row["STATUS CODE"]),
      registrant_display_name: registrant.displayName,
      registrant_kind: registrant.kind,
      owner_visibility: registrant.visibility,
    },
  };
}

async function* csvRows(path) {
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let headers = null;
  let number = 0;
  for await (const line of lines) {
    if (!headers) {
      headers = parseCsvLine(line.replace(/^﻿/, "")).map((header) => header.toUpperCase());
      yield { headers };
      continue;
    }
    number += 1;
    if (line.trim() === "") continue;
    if (line.length > MAX_LINE_LENGTH) { yield { number, line: "", error: "line_too_long" }; continue; }
    if (/[^\x09\x20-\x7E]/.test(line)) { yield { number, line, error: "unsupported_control_character" }; continue; }
    let fields;
    try { fields = parseCsvLine(line); } catch { yield { number, line, error: "invalid_csv_quoting" }; continue; }
    if (fields.length < headers.length - 1 || fields.length > headers.length + 1) { yield { number, line, error: "column_count_mismatch" }; continue; }
    yield { number, line, row: Object.fromEntries(headers.map((header, index) => [header, fields[index] ?? ""])) };
  }
}

/** ACFTREF.txt -> Map(CODE -> { manufacturer, model }). */
export async function loadModels(path) {
  const models = new Map();
  if (!path) return models;
  for await (const item of csvRows(path)) {
    if (item.headers) continue;
    if (!item.row) continue;
    const code = blankToNull(item.row.CODE);
    if (code) models.set(code, { manufacturer: blankToNull(item.row.MFR), model: blankToNull(item.row.MODEL) });
  }
  return models;
}

async function fileSha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Imports one MASTER file. `db` needs only `query(text, params)` (a pg Client, or PGlite in tests).
 * Returns a secret-free summary (no names, no rows).
 */
export async function importSnapshot(db, { inputPath, acftrefPath = null, snapshotDate, sourceUrl = DEFAULT_SOURCE_URL, publish = false, log = () => {} }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate ?? "") || Number.isNaN(Date.parse(`${snapshotDate}T00:00:00Z`))) throw new Error("snapshotDate must be YYYY-MM-DD");
  if (snapshotDate > new Date().toISOString().slice(0, 10)) throw new Error("snapshotDate cannot be in the future");
  if (!String(sourceUrl).startsWith("https://www.faa.gov/")) throw new Error("sourceUrl must be an https://www.faa.gov/ URL");
  const size = statSync(inputPath).size;
  if (size <= 0 || size > MAX_FILE_BYTES) throw new Error("FAA input size is outside the accepted boundary");
  const sourceSha = await fileSha256(inputPath);
  const sourceFile = basename(inputPath);

  const existing = await db.query("select id, status, snapshot_date::text as snapshot_date from airintel_private.faa_import_runs where source_sha256 = $1", [sourceSha]);
  if (existing.rows[0]) {
    const run = existing.rows[0];
    if (publish && run.status === "validated") {
      await db.query("update airintel_private.faa_import_runs set status = 'published', finished_at = coalesce(finished_at, now()) where id = $1", [run.id]);
      return { runId: run.id, status: "published", alreadyImported: true, snapshotDate: run.snapshot_date };
    }
    return { runId: run.id, status: run.status, alreadyImported: true, snapshotDate: run.snapshot_date };
  }

  const models = await loadModels(acftrefPath);
  await db.query("begin");
  try {
    const purged = await db.query("select public.purge_expired_faa_registry_raw() as deleted");
    const { rows: [run] } = await db.query(
      `insert into airintel_private.faa_import_runs (source_url, source_filename, source_sha256, snapshot_date, importer_version, schema_version, status)
       values ($1, $2, $3, $4::date, $5, $6, 'staging') returning id`,
      [sourceUrl, sourceFile, sourceSha, snapshotDate, IMPORTER_VERSION, SCHEMA_VERSION],
    );
    let received = 0;
    let accepted = 0;
    let rejected = 0;
    const errorCounts = new Map();
    const seenIds = new Set();
    let raw = [];
    let records = [];
    const flush = async () => {
      if (raw.length > 0) {
        await db.query(
          `insert into airintel_private.faa_registry_raw (import_run_id, source_file, source_row_number, source_row_hash, raw_row, validation_status, error_codes)
           select $1::uuid, $2, r.n, r.h, r.raw, r.status, r.errors
             from jsonb_to_recordset($3::jsonb) as r(n integer, h text, raw jsonb, status text, errors text[])`,
          [run.id, sourceFile, JSON.stringify(raw)],
        );
        raw = [];
      }
      if (records.length > 0) {
        await db.query(
          `insert into public.aircraft_registry_records
             (import_run_id, snapshot_date, registry_unique_id, n_number, mode_s_hex, serial_number, manufacturer_code, manufacturer_name,
              model_code, model_name, aircraft_type_code, registration_status, registrant_display_name, registrant_kind, owner_visibility, source_row_hash)
           select $1::uuid, $2::date, r.registry_unique_id, r.n_number, r.mode_s_hex, r.serial_number, r.manufacturer_code, r.manufacturer_name,
                  r.model_code, r.model_name, r.aircraft_type_code, r.registration_status, r.registrant_display_name, r.registrant_kind, r.owner_visibility, r.source_row_hash
             from jsonb_to_recordset($3::jsonb) as r(registry_unique_id text, n_number text, mode_s_hex text, serial_number text, manufacturer_code text,
                  manufacturer_name text, model_code text, model_name text, aircraft_type_code text, registration_status text,
                  registrant_display_name text, registrant_kind text, owner_visibility text, source_row_hash text)`,
          [run.id, snapshotDate, JSON.stringify(records)],
        );
        records = [];
      }
    };
    const quarantine = (number, line, codes, rowObject = {}) => {
      rejected += 1;
      for (const code of codes) errorCounts.set(code, (errorCounts.get(code) ?? 0) + 1);
      raw.push({ n: number, h: sha256(line), raw: stripAddress(rowObject), status: "quarantined", errors: codes });
    };

    let headersChecked = false;
    for await (const item of csvRows(inputPath)) {
      if (item.headers) {
        const missing = REQUIRED_HEADERS.filter((header) => !item.headers.includes(header));
        if (missing.length > 0) throw new Error(`FAA header mismatch; missing: ${missing.join(", ")}`);
        headersChecked = true;
        continue;
      }
      received += 1;
      if (item.error) { quarantine(item.number, item.line, [item.error]); }
      else {
        const { record, errors } = toRegistryRecord(item.row, models);
        if (!record) quarantine(item.number, item.line, errors, item.row);
        else if (seenIds.has(record.registry_unique_id)) quarantine(item.number, item.line, ["duplicate_unique_id"], item.row);
        else {
          seenIds.add(record.registry_unique_id);
          accepted += 1;
          const hash = sha256(item.line);
          raw.push({ n: item.number, h: hash, raw: stripAddress(item.row), status: "accepted", errors: [] });
          records.push({ ...record, source_row_hash: hash });
        }
      }
      if (raw.length >= BATCH) await flush();
      if (received % 50_000 === 0) log(`staged ${received.toLocaleString("en-US")} rows`);
    }
    if (!headersChecked) throw new Error("FAA input is missing a header row");
    await flush();

    const tooManyRejected = received === 0 || rejected / received > MAX_REJECTED_RATIO;
    const status = tooManyRejected ? "rejected" : publish ? "published" : "validated";
    await db.query(
      `update airintel_private.faa_import_runs
          set status = $2, rows_received = $3, rows_accepted = $4, rows_rejected = $5, finished_at = now(), error_code = $6
        where id = $1`,
      [run.id, status, received, accepted, rejected, tooManyRejected ? "rejected_ratio_exceeded" : null],
    );
    await db.query("commit");
    return {
      runId: run.id, status, alreadyImported: false, snapshotDate, sourceSha256: sourceSha,
      rows: { received, accepted, rejected }, errors: Object.fromEntries([...errorCounts].sort(([a], [b]) => a.localeCompare(b))),
      purgedExpiredRawRows: Number(purged.rows[0]?.deleted ?? 0), models: models.size,
    };
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  }
}

function stripAddress(row) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !DROPPED_FIELDS.has(key)));
}
