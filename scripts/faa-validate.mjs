import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline";

const MAX_FILE_BYTES = 1_000_000_000;
const MAX_LINE_LENGTH = 65_536;
const REQUIRED_HEADERS = ["N-NUMBER", "SERIAL NUMBER", "MFR MDL CODE", "NAME", "MODE S CODE HEX"];
const N_NUMBER_PATTERN = /^(?:[1-9][0-9]{0,4}|[1-9][0-9]{0,3}[A-HJ-NP-Z]|[1-9][0-9]{0,2}[A-HJ-NP-Z]{2})$/;
const MODE_S_HEX_PATTERN = /^[0-9A-F]{6}$/;

const inputIndex = process.argv.indexOf("--input");
if (inputIndex === -1 || !process.argv[inputIndex + 1]) {
  throw new Error("Usage: npm run faa:validate -- --input <official FAA MASTER.txt>");
}

const inputPath = resolve(process.argv[inputIndex + 1]);
const fileStat = statSync(inputPath);
if (!fileStat.isFile()) throw new Error("FAA input must be a regular file");
if (fileStat.size <= 0 || fileStat.size > MAX_FILE_BYTES) throw new Error("FAA input size is outside the accepted boundary");

function parseCsvLine(line) {
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

const hash = createHash("sha256");
const hashStream = createReadStream(inputPath);
for await (const chunk of hashStream) hash.update(chunk);

const lines = createInterface({ input: createReadStream(inputPath, { encoding: "utf8" }), crlfDelay: Infinity });
let headers;
let nNumberIndex = -1;
let modeSHexIndex = -1;
let rowCount = 0;
let rejectedRows = 0;
const safeErrorCounts = new Map();

const reject = (code) => {
  rejectedRows += 1;
  safeErrorCounts.set(code, (safeErrorCounts.get(code) ?? 0) + 1);
};

for await (const line of lines) {
  if (line.length > MAX_LINE_LENGTH) { reject("line_too_long"); continue; }
  if (!headers) {
    headers = parseCsvLine(line.replace(/^\uFEFF/, "")).map((header) => header.toUpperCase());
    const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
    if (missing.length > 0) throw new Error(`FAA header mismatch; missing: ${missing.join(", ")}`);
    nNumberIndex = headers.indexOf("N-NUMBER");
    modeSHexIndex = headers.indexOf("MODE S CODE HEX");
    continue;
  }
  rowCount += 1;
  if (/[^\x09\x20-\x7E]/.test(line)) { reject("unsupported_control_character"); continue; }
  try {
    const fields = parseCsvLine(line);
    if (fields.length !== headers.length) { reject("column_count_mismatch"); continue; }
    const nNumber = fields[nNumberIndex]?.toUpperCase() ?? "";
    const modeSHex = fields[modeSHexIndex]?.toUpperCase() ?? "";
    if (!N_NUMBER_PATTERN.test(nNumber)) { reject("invalid_n_number"); continue; }
    if (modeSHex !== "" && !MODE_S_HEX_PATTERN.test(modeSHex)) reject("invalid_mode_s_hex");
  } catch {
    reject("invalid_csv_quoting");
  }
}

if (!headers) throw new Error("FAA input is missing a header row");

process.stdout.write(`${JSON.stringify({
  file: basename(inputPath),
  bytes: fileStat.size,
  sha256: hash.digest("hex"),
  rows: rowCount,
  rejectedRows,
  errors: Object.fromEntries([...safeErrorCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
  validationOnly: true,
}, null, 2)}\n`);

if (rejectedRows > 0) process.exitCode = 2;
