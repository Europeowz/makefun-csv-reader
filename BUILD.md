# Entry build: csv-reader-speed-01-run-20261121

Bounty: "Read broken CSV files faster, 21 November 2026" — write a faster
drop-in for make.fun's csv-reader 1.0.0 whose answers are identical on every
case; ranking is by CPU time, and a reward requires beating the house
baseline (csv-reader itself) at 95% confidence. Deadline 2026-11-23 02:42 UTC.

## Files

- `main.ts` — the harness driver, kept from the house baseline unchanged
  (reads /input/cases.json, answers each case with run() from solve.js,
  writes /output/answers.json; sets --no-incremental-marking before import).
- `solve.js` — my faster reader (the actual entry work).
- `LICENSE` — MIT.
- `.makefun/owner.json` — {"wallet": "BaBStLSXxkAQJ5JL6BiM11w79XVqZeKS8Faphem6hjcs"}.
- Total size ~11.5 KB, far under the 1 MiB repository cap.

## What solve.js does

Same broken-row policy as the reference, re-implemented around native
`indexOf` scans instead of one character at a time:

- **Unquoted fields:** one slice up to the next comma/LF. A bounded CR check
  inside that slice handles the two CR cases exactly as the reference does:
  a CR immediately before the terminating LF is the CRLF's CR (consumed with
  the break, no error); any other CR in the slice is dropped with a
  `stray_cr` error (only then does it fall back to a per-char loop over that
  one slice).
- **Quoted fields:** chunks between quotes are taken as slices. A chunk with
  no CR is appended as-is (only its LFs are counted, via indexOf); a chunk
  containing CR is normalised piece by piece (CRLF and lone CR each become
  one LF, line count updated). Doubled quotes are handled by accumulating
  chunk parts. After the closing quote, comma/LF/CRLF/end finish the field;
  anything else is read as unquoted junk and `quote_junk` is raised when the
  field ends if the junk added characters — same order of errors as the
  reference (stray CRs inside the junk come before the quote_junk).
- **Unterminated quote:** the one case a fast scan cannot settle (no closing
  quote exists). That field alone falls back to a character-at-a-time port
  of the reference reader, so the `unterminated_quote` error, the line-count
  rollback and the unquoted re-read match bit for bit.
- Record assembly (blank-line skipping, only-stray-CR lines not counting as
  records, header handling, short_row padding / long_row cutting, error
  {code, line, row} ordering) mirrors the reference's control flow exactly.

Only Node.js built-ins are used (in fact solve.js imports nothing).

## Correctness (practice set + fuzz)

- Kit scorer on the practice set: **{"passed": 1, "cases_passed": 6,
  "cases_total": 6}** — identical to csv-reader on all 6 practice cases
  (~10.5 MB of CSV text, ~700k fields, incl. quote_junk / stray_cr /
  short_row / long_row / unterminated_quote cases).
- My answers.json is **byte-identical** to the baseline's answers.json on
  the practice set.
- Fuzz vs the vendor reference implementation: 30,000 random broken-CSV
  inputs (piecewise alphabet of quotes, CR, CRLF, LF, commas, BOM, junk,
  unclosed quotes) and 300 record-built longer inputs — **all identical**.

## Speed (local, indicative only)

Measured on this machine (Node v24.22.1, shared VM) against the house
baseline from the kit:

- **Whole driver process** (node startup + JSON.parse of the 11 MB
  cases.json + parse + JSON.stringify of the ~12 MB answers; 3 runs each):
  baseline user CPU 2.84 / 2.93 / 2.89 s; this entry 1.60 / 1.68 / 1.57 s —
  about **1.75× less CPU end to end**.
- **Parser only** (in-process process.cpuUsage over the 6 practice cases,
  best of 3 after warm-up): baseline 1118 ms; this entry 237 ms — about
  **4.7× faster**. The remaining process time is JSON input/output and
  startup, which every entry pays equally.

## Caveats

- The real heat runs Node 22.23.4 under gVisor on 1 CPU with an unseen
  scored set drawn after the deadline; local Node 24 numbers show the
  margin over the baseline, not a guaranteed placing. The margin is wide
  (the gate only requires beating csv-reader itself at 95% confidence),
  but the top-10 places go to the fastest correct entries overall.
- The scored set is drawn from the same published generator, so the
  practice set's profile (frequent quoted fields, rare errors) should be
  representative; the fuzz coverage guards the rarer broken-row paths.
- Nothing has been submitted anywhere; this directory is a ready-to-submit
  repository snapshot only.
