---
title: "Contract C5 — Exporter Output"
kind: spec
---

# Contract C5 — Exporter Output

## Purpose & Scope

This contract documents the FIXED, observable output format produced by the Python core exporter (`core/nurse_scheduling/exporter.py) and the backend anonymization pass (core/nurse_scheduling/anonymize_scheduling_data.py). The Python core is NOT being rebuilt; the frontend rebuild MUST consume these outputs exactly as specified here.`

The exporter produces:

1. A people×date pandas `DataFrame from get_people_versus_date_dataframe(ctx, prettify=False) — the plain solved-schedule grid.`
2. A prettified/styled variant from `get_people_versus_date_dataframe(ctx, prettify=True) — adds history columns, extra columns/rows, default styling, custom formatting, and cell annotations.`
3. An XLSX file via `export_to_excel(df, output_buffer, cell_export_info=None) (exporter.py:728).`
4. A CSV file via `export_to_csv(df, output_buffer) (exporter.py:837).`

Both DataFrame functions return a 2-tuple: `(df_or_styler, cell_export_info) where cell_export_info is {"comments": cell_comment_info, "styles": style_info} (exporter.py:720, exporter.py:725).`

This document is CONFORMANCE-ONLY: it describes what the frontend must render/parse, not how the core computes it. All line citations are against the sources listed in front-matter.

## Base DataFrame Layout [CON-OUT-nn]

The base grid is built in `get_people_versus_date_dataframe (exporter.py:470). It applies to BOTH prettify=False and prettify=True (prettify only adds regions on top of this base).`

**[CON-OUT-01] Region counts. **`n_leading_rows, n_leading_cols = 2, 1 and n_trailing_rows, n_trailing_cols = 2, 0 (exporter.py:472-473). The DataFrame is created with dtype=object and initialized to empty string "" (exporter.py:490-496).`

- Index length = `n_leading_rows + len(ctx.people.items) + n_trailing_rows + extra_rows (exporter.py:492).`
- Column length = `n_leading_cols + n_history_cols + len(ctx.dates.items) + n_trailing_cols + extra_cols (exporter.py:493).`
- In base (non-prettify) mode `n_history_cols = 0, extra_rows = 0, extra_cols = 0.`

**[CON-OUT-02] Two leading rows = date headers. For each date column **`col_idx = n_leading_cols + n_history_cols + d (exporter.py:510):`

- Row 0 = day number, with year/month collapsing (`exporter.py:511-516):`
  - If first and last item years differ: `f"{date.year}/{date.month}/{date.day}" (Y/M/D).`
  - Else if first and last months differ: `f"{date.month}/{date.day}" (M/D).`
  - Else: `date.day (D only, written as an integer, not a string).`
- Row 1 = weekday abbreviation via `date.strftime("%a") (exporter.py:517).`

**[CON-OUT-03] One leading column = person id. For each person **`p, df.iloc[n_leading_rows + p, 0] = person.id (exporter.py:522-523). Person rows begin at DataFrame row index n_leading_rows + p (i.e., index 2 for the first person).`

**[CON-OUT-04] Cell body = comma-joined assigned shift-type ids. For each **`(d, p) in ctx.map_dp_s (exporter.py:581-597), the cell value is built by concatenating, for each assigned shift type s where solver.get_value(ctx.shifts[(d, s, p)]) == 1, the string ctx.shiftTypes.items[s].id, joined by ", " (comma + space) (exporter.py:585-589). An OFF/unassigned cell remains the empty string "".`

**[CON-OUT-05] Off-cell sanity invariant (base mode only). When **`prettify is False, for every (d, p) in ctx.offs: if offs == 1 the cell is asserted == ""; otherwise asserted != "" (exporter.py:607-613). Frontend MUST treat an empty cell as "off / no assignment".`

**[CON-OUT-06] Two trailing rows = Score and Status. After the people rows (**`exporter.py:600-604):`

- Row `n_leading_rows + len(ctx.people.items), column 0 = literal "Score"; the value cell at column n_leading_cols + n_history_cols = solver.get_objective_value().`
- Row `n_leading_rows + len(ctx.people.items) + 1, column 0 = literal "Status"; the value cell at column n_leading_cols + n_history_cols = ctx.solver_status.`

Note: the Score/Status VALUE is placed at the first date/history column position, not column 0 (column 0 holds the label).

**[CON-OUT-07] Return shape. Base mode returns **`(df, {"comments": cell_comment_info, "styles": style_info}) (exporter.py:722-725). Even in base mode a style_info is computed via _build_custom_export_style_info(...), but styling is only physically applied to XLSX (see CON-OUT-30). cell_comment_info is empty in base mode (annotations are prettify-only, exporter.py:538).`

## Prettify Additions

Prettify additions apply only when `prettify=True.`

**[CON-OUT-10] History columns. **`n_history_cols = max((len(person.history) for person in ctx.people.items if person.history), default=0) (exporter.py:481). History columns occupy columns n_leading_cols .. n_leading_cols + n_history_cols - 1 (i.e., immediately after the person-id column). Headers (exporter.py:499-504):`

- Row 0 of history column `h = f"H-{n_history_cols - h}" (so left-to-right reads H-n .. H-1; the most recent entry H-1 is rightmost, adjacent to the date grid).`
- Row 1 of every history column = literal `"History".`

Per-person history values are right-aligned within the block: `padded_history = [""] * max(0, n_history_cols - len(history)) + history (front-padded with empty strings), then written across the history columns (exporter.py:526-536). People with no history get empty strings.`

**[CON-OUT-11] Extra columns and rows sizing. **`extra_column_rules = ctx.export.extraColumns and extra_row_rules = ctx.export.extraRows (only when prettify and ctx.export) (exporter.py:484-485). Sizing (exporter.py:487-488):`

- `extra_cols = (1 + len(extra_column_rules)) if extra_column_rules else 0 — one EMPTY separator column, then one column per rule.`
- `extra_rows = (1 + len(extra_row_rules)) if extra_row_rules else 0 — one EMPTY separator row, then one row per rule.`

**[CON-OUT-12] Extra column placement & count semantics. **`extra_col_start = n_leading_cols + n_history_cols + len(ctx.dates.items) + 1 (the + 1 skips the empty separator) (exporter.py:616). For rule index rule_idx, column = extra_col_start + rule_idx. Row 1 of that column = rule.header (exporter.py:622). Each person row holds _count_extra_column_for_person(...).`

Count semantics (`_count_extra_column_for_person, exporter.py:259-270): over count_dates = parse_dates(rule.countDates), for each date: if OFF_sid is in count_shift_types and that person is off, add coefficients[OFF_sid] and skip; otherwise add sum(coefficients[s] for s in count_shift_types if 0 <= s < n_shift_types and shifts[(d,s,p)]==1).`

**[CON-OUT-13] Extra-column coefficient rules. **`_parse_extra_column_coefficients (exporter.py:233-256): coefficients default to 1 for every selected countShiftTypes (dict.fromkeys(count_shift_types, 1)). For each (shift_type_id, coefficient) in rule.countShiftTypeCoefficients:`

- Coefficient MUST be `>= 1, else ValueError: f"Export extra column coefficient for '{shift_type_id}' must be at least 1." (exporter.py:240-241).`
- Expanded sids MUST be a subset of `countShiftTypes (covered), else ValueError: f"Export extra column coefficient for '{shift_type_id}' must be covered by countShiftTypes." (exporter.py:244-247).`
- No duplicate coverage across coefficient entries, else `ValueError: f"Duplicate export extra column coefficient for '{shift_type_id}'." (exporter.py:248-250).`

**[CON-OUT-14] Extra row placement & count semantics. **`extra_row_start = n_leading_rows + len(ctx.people.items) + n_trailing_rows + 1 (the + 1 skips the empty separator row) (exporter.py:632). For rule index rule_idx, row = extra_row_start + rule_idx. Column 0 = rule.header (exporter.py:637). Each date column holds _count_extra_row_for_date(...).`

Count semantics (`_count_extra_row_for_date, exporter.py:273-283): over count_people = parse_pids(rule.countPeople), for each person: if OFF_sid in count_shift_types and person off, add 1 and skip; otherwise add 1 if ANY of count_shift_types is assigned that date. Extra ROWS use a plain head-count (no coefficients), unlike extra columns.`

**[CON-OUT-15] Default styling (prettify). **`apply_styling (exporter.py:649-703) produces CSS via a pandas Styler:`

- Center alignment on EVERY cell: `"text-align: center" (exporter.py:656).`
- Boundary borders 2px solid `#374151:`
  - `"border-bottom: 2px solid #374151" on rows header_row_end (=n_leading_rows-1=1), people_row_end, summary_row_end, extra_rows_end (exporter.py:678-684).`
  - `"border-right: 2px solid #374151" on columns name_col_end (=n_leading_cols-1=0), history_col_end, date_col_end, extra_columns_end (exporter.py:687-693).`
- Region boundary indices: `people_row_end = header_row_end + len(people.items); summary_row_end = people_row_end + n_trailing_rows; extra_rows_end = summary_row_end + len(extra_row_rules) + 1 (exporter.py:660-663); history_col_end = name_col_end + n_history_cols; date_col_end = history_col_end + len(dates.items); extra_columns_end = date_col_end + len(extra_column_rules) + 1 (exporter.py:666-669).`

Prettify returns a Styler (`df.style.apply(..., axis=None), exporter.py:706) plus cell_export_info (exporter.py:720).`

## Custom Formatting Rules

Custom formatting comes from `ctx.export.formatting and is compiled by _build_custom_export_style_info (exporter.py:43) and _build_cell_annotation_rules (exporter.py:336). Style info is keyed in 1-based Excel coordinates (row_idx+1, col_idx+1) (exporter.py:67).`

**[CON-OUT-20] Rule types. Supported **`rule.type values and their target regions:`

- `"row" — every column of each targeted person's row (exporter.py:106-117).`
- `"people header" — column 0 of each targeted person's row (exporter.py:119-129).`
- `"column" — every row of each targeted date column EXCEPT the Score and Status summary rows (exporter.py:131-147; the two summary rows are explicitly skipped, exporter.py:137-139).`
- `"date header" — row 0 of each targeted date column (exporter.py:149-159).`
- `"history header" — row 0 of every history column (exporter.py:161-170).`
- `"cell" — specific person×date×shift-type cells (exporter.py:172-215).`
- `"history" — the history columns of each targeted person's row (exporter.py:217-228).`

Column index for a date `d = n_leading_cols + n_history_cols + d (exporter.py:135,151,182,207); row for person p = n_leading_rows + p.`

**[CON-OUT-21] Style properties. Each rule may set **`backgroundColor, bottomBorderColor, rightBorderColor, fontColor (exporter.py:57-77). Only non-null properties are recorded (set_style skips falsy values). Out-of-range coordinates are ignored (exporter.py:65-66).`

**[CON-OUT-22] Precedence — later wins. Rules are processed in list order (**`exporter.py:79). set_style overwrites existing keys for the same property (exporter.py:70-77), so a LATER rule setting the same property on the same cell overrides an earlier one.`

**[CON-OUT-23] Target validation. People targets must exist in **`ctx.map_pid_p else ValueError f"Invalid person identifier '{target}' in export formatting rule with type '{rule.type}'" (exporter.py:88-91). Cell shift-type targets must exist in ctx.map_sid_s else ValueError f"Invalid shift type identifier '{target}' in export formatting rule with type 'cell'" (exporter.py:100-103). Dates are expanded via utils.parse_dates(target, ctx.map_did_d, ctx.dates.range) (exporter.py:95-96).`

**[CON-OUT-24] Cell ****`when`**** condition (SHIFT_REQUEST only). For **`type: "cell" with a when clause, matches are found by _iter_matching_cell_preferences (exporter.py:434-467). Only models.SHIFT_REQUEST preferences with non-zero weight are considered (exporter.py:443-445). The condition (_export_preference_condition_matches, exporter.py:374-394):`

- `preference.types MUST be a subset of {SHIFT_REQUEST} else ValueError f"Unsupported export formatting preference condition type(s): {sorted(unsupported_types)}" (exporter.py:376-378).`
- `satisfied (bool|null): matched against _is_shift_request_satisfied (exporter.py:425-431): for positive weight, satisfied = requested state assigned; for negative weight, satisfied = requested state NOT assigned.`
- `weightRange ([min, max]): MUST have exactly two values (ValueError "export formatting preference weightRange must contain exactly two values", exporter.py:384-385) and min <= max (ValueError "export formatting preference weightRange minimum must be less than or equal to maximum", exporter.py:387-388); pref.weight must fall inside [min, max] inclusive (exporter.py:389-390).`
- `requestShape: unless constants.ALL is present, request_shape must be in the set (exporter.py:391-393). Shape strings are "{person_shape}-to-{date_shape}" where person ∈ {person-item, people-group}, date ∈ {date-item, date-group}, or "unknown" (_get_shift_request_shape, exporter.py:293-320; _iter_expanded_shift_request_targets, exporter.py:397-422).`

**[CON-OUT-25] ****`when`****-less cell rules. Without **`when, type: "cell" matches by actual assigned shift types: actual_target_shift_types filters to OFF_sid or 0 <= s < n_shift_types (exporter.py:192-193); a cell is styled if any assigned shift type (including OFF_sid when offs==1) is in the target set (exporter.py:195-215).`

**[CON-OUT-26] appendText / note — cell rules only. **`_validate_export_formatting_rule_usage (exporter.py:286-290) raises ValueError "export formatting 'when' is only supported for rules with type 'cell'" if a non-cell rule has when, and ValueError "export formatting annotations are only supported for rules with type 'cell'" if a non-cell rule has appendText or note. Annotations are built only for cell rules that have BOTH a when and at least one of appendText/note (exporter.py:344).`

**[CON-OUT-27] Annotation rendering. **`_render_export_template (exporter.py:323-329) substitutes {shiftType} → requested shift type string, {weight} → pref.weight, {absWeight} → abs(pref.weight), {totalAbsWeight} → sum of abs(weight) across all matches for that cell (exporter.py:556). Requested shift type string = comma-joined targets via _format_requested_shift_type = ", ".join(...) (exporter.py:332-333). appendText is concatenated directly onto the cell body text (exporter.py:590-592); note text is collected into cell_comment_info[(excel_row, excel_col)] in 1-based Excel coordinates (exporter.py:593-596). Only the FIRST match's (pref, requested_shift_type) is used for a note's per-match substitutions, but totalAbsWeight still sums all matches (exporter.py:567-576).`

## XLSX & CSV Output

**[CON-OUT-30] XLSX structure. **`export_to_excel (exporter.py:728-834) writes the DataFrame with index=False, header=False (exporter.py:740), reloads with openpyxl, and sets ws.freeze_panes = "B3" — freezes the first two rows and first column (exporter.py:747-748). cell_export_info must be a dict whose keys are a subset of {"comments", "styles"} else ValueError "cell_export_info must be a dictionary with optional 'comments' and 'styles' keys" (exporter.py:752-754).`

**[CON-OUT-31] Notes sheet. When comments exist, a second sheet named **`"Notes" is created (exporter.py:761) with header row ["Cell", "Schedule Value", "Note"] (exporter.py:762), freeze_panes = "A2", auto-filter A1:C1, and column widths A=14, B=24, C=80 (exporter.py:763-767). For each (row, col) -> notes, one row per note is appended as [cell.coordinate, cell.value, note]; the Notes-sheet Cell (column A) cell gets a hyperlink back to the schedule sheet #'{schedule_sheet_name}'!{coordinate} with style = "Hyperlink", and the schedule cell gets a forward hyperlink #'{notes_sheet_name}'!A{first_note_row} (exporter.py:772-783). Sheet names have single quotes escaped by doubling (exporter.py:769-770). Notes MUST be lists of strings else ValueError "cell_export_info comments must be lists of strings" (exporter.py:774-775).`

**[CON-OUT-32] Style application to XLSX. For each **`(row, col) -> styles (exporter.py:786-830):`

- `backgroundColor: converted #RRGGBB → FF + uppercase 6 hex = ARGB FFRRGGBB (exporter.py:792), applied as PatternFill(fill_type="solid", ...); the font color is auto-set for contrast (see CON-OUT-33).`
- `fontColor: #RRGGBB → FFRRGGBB, applied to a copy of the cell font (exporter.py:798-802).`
- `bottomBorderColor / rightBorderColor: applied as Side on a copied Border, reusing any existing border style or defaulting to "medium" (exporter.py:804-830).`

**[CON-OUT-33] Auto-contrast font. **`_get_font_color_for_background (exporter.py:33-40): parses #RRGGBB, computes luminance = (0.299*r + 0.587*g + 0.114*b) / 255, returns "FF000000" (black) if luminance > 0.6 else "FFFFFFFF" (white). The 0.6 threshold matches the frontend getPickerDisplay() (exporter.py:39).`

**[CON-OUT-34] Extra-column/row border overlay. Before returning the styler, per-rule border colors are overlaid into **`style_info (exporter.py:710-719): extra-column rightBorderColor applied down every row of that column; extra-row bottomBorderColor applied across every column of that row.`

**[CON-OUT-35] CSV output. **`export_to_csv (exporter.py:837-852): writes df.to_csv(..., index=False, header=False, lineterminator="\n") to a StringIO, then encodes with "utf-8-sig" (UTF-8 BOM) into the output buffer (exporter.py:846-851). CSV has NO header row and NO index column. CSV is CLI-only and incompatible with prettify (the styler/annotations are not representable in plain CSV; only the base DataFrame is exportable this way).`

## Backend Anonymization (Sentry-only — not used by /optimize or the xlsx path)

`anonymize_scheduling_data.py is `**only used in the current code as a**
**Sentry attachment sanitizer when an optimize exception is captured**
(`core/nurse_scheduling/sentry.py:69-95). The HTTP /optimize`
endpoint does **not call it: **`core/nurse_scheduling/serve.py:292-298`
passes the parsed YAML directly to `scheduler.schedule(...). The`
anonymized-XLSX-restore roundtrip is **frontend-side only:**
`web-frontend/src/utils/anonymizeSchedulingState.ts:102-157 produces`
an anonymized `YAML payload for POST /optimize, and`
`web-frontend/src/utils/restorePeopleIdsInXlsx.ts:34-48 substitutes`
original IDs in the downloaded XLSX. A rebuilt frontend that does not
anonymize before upload will send real person IDs to `/optimize and`
the exported XLSX will already contain those real IDs (no restore is
possible because the XLSX was never anonymized in the first place).

**[CON-OUT-40] Backend anonymizer surface (Sentry-only). The**
`anonymize_scheduling_data_in_yaml function`
(`anonymize_scheduling_data.py:113-118) is the only entry point and`
is currently called from `sentry.py only. Its mapping`
(`_anonymize_yaml_content, :64-103): removes all description`
fields (`_remove_description_fields, lines 51-61), then maps each`
`people.items[*].id to f"P{next_index}" starting at next_index = 1,`
skipping any anonymized id that collides with a retained group id
(`:80-93). References under keys`
`{"person", "qualifiedPeople", "people1", "people2", "people", "countPeople"} are rewritten via the id map (_PEOPLE_REFERENCE_KEYS,`
line 27; `_anonymize_people_references, lines 36-48). Group`
`members lists are also remapped (lines 99-101). On any exception`
the original content is returned unchanged (`:113-118). Output is`
dumped with `ruamel.yaml YAML(typ="safe") (lines 106-110).`
**Note on ****`shift type covering: the backend anonymizer's`**
`_PEOPLE_REFERENCE_KEYS (anonymize_scheduling_data.py:27) does`
**not include **`preceptors or preceptees, so a Sentry attachment`
that contains a covering preference will leave those fields in plain
text. The frontend-side anonymizer does cover them.

**[CON-OUT-41] Restore dependency (frontend, half-open Excel rows).**
The exported schedule places person IDs in column A (the single
leading column, CON-OUT-03), on Excel rows `3 through 2 + peopleCount`
inclusive — i.e. the half-open interval `[3, 3 + peopleCount) in`
1-based Excel terms (rows begin after the two frozen header rows;
`exporter.py:470-473, 522-523). The frontend`
`restorePeopleIdsInXlsx (web-frontend/src/utils/restorePeopleIdsInXlsx.ts:34-36)`
MUST read the anonymized person IDs from those rows and substitute the
original (pre-anonymization) IDs there. This is why person id occupies
exactly column 0 / Excel column A and why person rows start at Excel
row 3 (DataFrame index 2 = `n_leading_rows). The Score and Status`
summary rows follow immediately after the last person row
(`exporter.py:599-604); a half-open range of [3, 3 + peopleCount)`
avoids reading those. Any layout change to CON-OUT-01/CON-OUT-03
breaks restore.

## Conformance Notes

- The two return values are ALWAYS `(dataframe_or_styler, {"comments": ..., "styles": ...}). Frontend code that only used the DataFrame must not assume a bare return.`
- Score/Status LABELS live in column 0; their VALUES live at column `n_leading_cols + n_history_cols (first date/history column), NOT column 0 (CON-OUT-06).`
- Day-number row uses collapsing Y/M/D → M/D → D based on whether the schedule spans multiple years/months; single-day-number cells are integers, not strings (CON-OUT-02).
- History header `H-k numbering is reversed relative to column order: leftmost history column is H-n, rightmost is H-1 (CON-OUT-10).`
- Empty separator column/row are intentionally left blank between the main grid and extra columns/rows (CON-OUT-11); do not treat them as data.
- Color conversion is uniform: any `#RRGGBB becomes FFRRGGBB (uppercased) for openpyxl ARGB (CON-OUT-32); background fills auto-pick black/white font at luminance threshold 0.6 (CON-OUT-33).`
- `when, appendText, and note are valid ONLY on type: "cell" rules; violations raise ValueError (CON-OUT-26).`
- CSV is CLI-only, has no BOM-less variant (always `utf-8-sig), and cannot carry prettify styling/annotations (CON-OUT-35).`
- Custom-formatting precedence is list-order, later-wins, per property (CON-OUT-22).

## Cross-References

- Contract C? (Solver / Context): source of `ctx.solver, ctx.shifts, ctx.offs, ctx.map_dp_s, ctx.solver_status, get_objective_value() consumed at exporter.py:579-604.`
- Contract C? (Export config schema): `ctx.export.extraColumns, ctx.export.extraRows, ctx.export.formatting, and rule fields (header, countDates, countShiftTypes, countPeople, countShiftTypeCoefficients, people, dates, shiftTypes, when, appendText, note, backgroundColor, bottomBorderColor, rightBorderColor, fontColor).`
- Contract C? (Preferences / SHIFT_REQUEST): `models.SHIFT_REQUEST, preference weight/person/date/shiftType used by _iter_matching_cell_preferences (exporter.py:434).`
- Contract C? (Constants): `constants.OFF_sid, constants.ALL, constants.MAP_DATE_KEYWORD_TO_FILTER, constants.MAP_WEEKDAY_TO_STR.`
- Frontend `restorePeopleIdsInXlsx: depends on CON-OUT-03 / CON-OUT-41 (person IDs in Excel column A, rows 3..3+count).`
- `anonymize_scheduling_data.py: upstream of the restore dependency (CON-OUT-40/41).`
