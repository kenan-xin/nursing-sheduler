# Singapore guidance on rest for shift workers (healthcare/nursing focus)

Researched 2026-09-24. Primary/high-trust sources only. Anything not confirmed from a primary
source is marked **[UNCERTAIN]**.

## 1. MOM Employment Act - hours of work, rest days

Source of law: Employment Act 1968, Part IV (hours of work, rest days, overtime). Part IV
applies only to workmen earning ≤ $4,500/month basic and non-workmen earning ≤ $2,600/month
basic - not to managers/executives. MOM's plain-English restatement is at
[mom.gov.sg/employment-practices/hours-of-work-overtime-and-rest-days](https://www.mom.gov.sg/employment-practices/hours-of-work-overtime-and-rest-days).

| Finding | Quote | Source | Type | Number |
|---|---|---|---|---|
| Daily cap incl. OT | "not allowed to work more than 12 hours a day" | mom.gov.sg (above) | LAW (EA Part IV) | 12 h/day |
| Ordinary daily/weekly hours | "up to 9 hours per day or 44 hours a week" | mom.gov.sg (above) | LAW (EA s.38) | 8–9 h/day, 44 h/week |
| Rest day | "employer must provide 1 rest day per week", unpaid | mom.gov.sg (above) | LAW (EA s.36) | 1 rest day/week |
| Overtime monthly cap | "An employee must not be permitted to work overtime for more than 72 hours a month" | Employment Act s.38(5), quoted via [sso.agc.gov.sg/Act/EmA1968](https://sso.agc.gov.sg/Act/EmA1968?ProvIds=pr38-) and Rajah & Tann Asia commentary | LAW (EA s.38(5)) | 72 h/month |
| Exceeding the OT cap | employer needs Commissioner for Labour approval. ~245 employers exempted under s.41A over 5 years | mom.gov.sg parliamentary reply, [sso.agc.gov.sg](https://sso.agc.gov.sg/Act/EmA1968) | LAW (EA s.38(3), s.41A) | - |
| Shift-worker averaging | "average number of hours worked over any continuous period of 3 weeks must not exceed 44 hours" - shift workers may exceed 6 consecutive hours, 8 h/day or 44 h/week on any single day as long as the 3-week rolling average holds | Employment Act s.40, via [sso.agc.gov.sg/Act-Rev/91](https://sso.agc.gov.sg/Act-Rev/91/Published?DocDate=20090731&ProvIds=pr38-) and mom.gov.sg FAQ ["How should overtime hours for shift workers be calculated?"](https://www.mom.gov.sg/faq/hours-of-work-overtime-and-rest-days/how-should-overtime-hours-for-shift-workers-be-calculated) | LAW (EA s.40) | 44 h avg / rolling 3 weeks |
| Hours above the 3-week average | paid at ≥1.5x basic hourly rate | EA s.40, mom.gov.sg | LAW | 1.5x rate |

Key nuance worth carrying into the assistant: the 3-week average in s.40 is a **rolling** window
("any continuous period of 3 weeks"), not a fixed roster cycle - a pattern can pass weeks 1–3 and
still fail weeks 2–4, so any automated check must slide the window, not reset it every 3 weeks.

## 2. MOM / Tripartite guidelines on shift work and fatigue

- No standalone "Tripartite Advisory on Managing Workplace Fatigue" was found. The closest
  tripartite artifact is the **Tripartite Advisory on Mental Well-being at Workplaces** (MOM,
  NTUC, SNEF), which addresses burnout/rest more broadly, not shift-specific fatigue -
  [mom.gov.sg/employment-practices/tripartism-in-singapore/tripartite-guidelines-and-advisories/tripartite-advisory-on-mental-well-being-at-workplaces](https://www.mom.gov.sg/employment-practices/tripartism-in-singapore/tripartite-guidelines-and-advisories/tripartite-advisory-on-mental-well-being-at-workplaces).
  Type: RECOMMENDATION. **[UNCERTAIN]** whether a fatigue-specific tripartite advisory exists -
  none surfaced in search.
- **WSH Council (WSHC) - WSH Guidelines on Fatigue Management** (published 13 Jan 2014), hosted
  at [tal.sg/wshc/resources/publications/wsh-guidelines/wsh-guidelines-on-fatigue-management](https://www.tal.sg/wshc/resources/publications/wsh-guidelines/wsh-guidelines-on-fatigue-management).
  Type: RECOMMENDATION (WSH Council guideline, not law). The landing page states: "Fatigue is a
  state of tiredness leading to reduced mental and/or physical performance, and excessively long
  working hours and poorly planned shift work can result in workers' fatigue," and that employers
  should manage fatigue risk by "organising shift work arrangements, optimising work schedules to
  minimise fatigue and providing rest breaks." **[UNCERTAIN]**: the underlying PDF
  (`Fatigue_Management.pdf`) returned 403/404 on direct fetch, so specific numeric thresholds
  (e.g. hours between shifts, max consecutive nights) inside that document could not be confirmed
  and are not quoted here - only the general duty-of-care language above is sourced.

## 3. MOH / public healthcare cluster guidance on nurse duty hours

MOH has answered this repeatedly in Parliament. the consistent position is that MOH does **not**
set a numeric minimum rest period or a maximum-consecutive-nights rule of its own - it defers to
the Employment Act and cluster employment contracts:

| Finding | Quote | Source | Type | Number |
|---|---|---|---|---|
| No MOH-imposed minimum rest hours | "the Ministry does not impose a minimum number of rest hours" | [moh.gov.sg/newsroom/ensuring-adequate-rest-for-nurses](https://www.moh.gov.sg/newsroom/ensuring-adequate-rest-for-nurses/) | RECOMMENDATION / policy stance | none set |
| Roster planning principle | "duty rosters for nurses are planned in advance to ensure staff have adequate rest between shifts" | same, moh.gov.sg | RECOMMENDATION | - |
| Legal basis deferred | "rest day provisions and work hour limits for public healthcare workers are stipulated in the Employment Act or set out in the public healthcare clusters' employment contracts" | moh.gov.sg (above) and [moh.gov.sg/news-highlights/details/ensuring-sufficient-rest-for-nurses-and-doctors](https://www.moh.gov.sg/news-highlights/details/ensuring-sufficient-rest-for-nurses-and-doctors) | mixed LAW + contract | - |
| No additional caps planned | "The Ministry does not intend to impose any additional caps on the working hours for healthcare workers beyond what is already stipulated in the Employment Act or the public healthcare cluster's employment contracts" | [moh.gov.sg/newsroom/cap-on-work-hours-for-doctors-and-nurses](https://www.moh.gov.sg/newsroom/cap-on-work-hours-for-doctors-and-nurses/) | policy stance | - |
| Unionised staff weekly hours | "a stipulated maximum of 38 to 42 hours per week" depending on shift type | [moh.gov.sg/newsroom/setting-limits-for-healthcare-workers...](https://www.moh.gov.sg/newsroom/setting-limits-for-healthcare-workers-such-as-maximum-number-of-hours-worked-and-call-backs-allowed-and-mandating-guaranteed-time-off/) | GUIDELINE (cluster/union contract) | 38–42 h/week |
| No hard call-back cap | "The Ministry does not impose a hard cap on the number of working hours and number of call backs" | same | policy stance | none |
| Junior doctors (context, not nurses) | "total work hours per week of junior doctors should not exceed 80 hours" averaged monthly | moh.gov.sg (above) | GUIDELINE (hospital) | 80 h/week avg/month |

No Singapore Nursing Board (SNB) publication specifically on duty-hour/roster fatigue limits was
found on healthprofessionals.gov.sg/snb or snb.gov.sg in this search. **[UNCERTAIN]** - mark as
not publicly documented. SNB's "Guidelines and Standards" page exists
([snb.gov.sg/for-professionals/guidelines-and-standards](https://www.snb.gov.sg/for-professionals/guidelines-and-standards/))
but no rostering/fatigue-specific standard surfaced.

## 4. Union norms (HSEU / SNU)

- HSEU represents nurses across SingHealth, NHG, NUHS. Public collective agreements exist for
  2025/2026 (SingHealth, NHG, NUHS, ALPS Staff Agreements) at
  [hseu.org.sg/resources/collective-agreements](https://www.hseu.org.sg/resources/collective-agreements),
  and an older SingHealth Staff Agreement of 2010 PDF is publicly hosted at
  [hseu.org.sg .../SINGHEALTH+STAFF+AGREEMENT+OF+2010.pdf](https://www.hseu.org.sg/wps/wcm/connect/3066088f-9e27-4355-8a2f-ca199aa4cb7a/SINGHEALTH+STAFF+AGREEMENT+OF+2010.pdf?MOD=AJPERES).
- Concrete figure found: nurses' contractual weekly hours under HSEU agreements with
  NUHS/SingHealth/NHG are commonly cited as **42 hours for regular shift, 40 hours for rotating
  shift, and 38 hours for permanent night shift** (search-derived from MOH/HSEU
  parliamentary-answer commentary referencing these agreements. The exact clause text was not
  directly re-verified inside the PDF in this pass - treat the 42/40/38 figures as
  **[UNCERTAIN]** pending a direct read of a current agreement PDF). Type: GUIDELINE / collective
  agreement (contract), not law.
- No SNU (Singapore Nurses' Association / any body abbreviated "SNU")-specific public document on
  shift patterns or rest was found. HSEU is the operative union body for nurses in the public
  clusters. **[UNCERTAIN]** on SNU specifically - likely refers to a body not distinctly findable
  under that acronym in this search.

## Recommended soft rules

These are meant as **warning-level, non-blocking** nudges the scheduling assistant surfaces to a
nurse manager - never a hard stop, since no Singapore source imposes most of these as binding
minimums (only the Employment Act items are actual law).

1. **Minimum rest between consecutive shifts**
   Tag: [GUIDELINE] - WSH Council fatigue-management duty of care (general "optimise schedules,
   provide rest breaks" principle; no SG-specific hour figure confirmed, MOH explicitly does not
   set one). No specific SG number to cite. treat as a general practice recommendation.
   Warning text: *"This roster leaves a short gap between shifts for at least one nurse. Adequate
   rest between shifts helps prevent fatigue - consider adjusting if possible."*

2. **Max consecutive night shifts**
   Tag: [GUIDELINE] - no confirmed SG-specific cap found (neither MOM, MOH, nor WSHC state a
   number); flag as general fatigue-management practice, not a sourced Singapore rule.
   Warning text: *"[Nurse] has been rostered for several night shifts in a row. Long runs of
   night duty are a known fatigue risk - consider capping consecutive nights where possible."*

3. **Rest day per week**
   Tag: [LAW] - Employment Act s.36, MOM guidance.
   Warning text: *"[Nurse] has no rest day in this week's roster. The Employment Act requires at
   least one rest day per week - please check this before publishing."*

4. **Weekly/monthly hours cap**
   Tag: [LAW] - Employment Act s.38 (12 h/day incl. OT) and s.40 (3-week rolling average of 44
   h/week for shift workers).
   Warning text: *"This schedule pushes [nurse]'s hours above the Employment Act's 3-week average
   of 44 hours/week (or 12 hours in a single day). Please review before confirming."*

5. **Overtime cap**
   Tag: [LAW] - Employment Act s.38(5).
   Warning text: *"[Nurse] is approaching the legal overtime limit of 72 hours this month. Any
   further overtime this month may require approval or breach the Employment Act."*

6. **Day(s) off after a stretch of night duty**
   Tag: [GUIDELINE] - no confirmed Singapore-specific rule. MOH states rosters should be "planned
   in advance to ensure staff have adequate rest between shifts" but sets no numeric recovery
   requirement. Flag as a general recovery-practice nudge, not a cited legal figure.
   Warning text: *"[Nurse] moves straight from night shifts into day shifts with little recovery
   time. Consider adding a rest day after a run of nights before switching shift types."*

### Notes on confidence

- Rules 3 and 5 are the only ones grounded directly in binding Employment Act text (LAW) - these
  are the safest to phrase with numeric confidence in the UI.
- Rule 4 combines two different legal mechanisms (daily 12h cap and shift-worker 3-week 44h
  rolling average) - the assistant should compute both and warn on either trigger.
- Rules 1, 2, and 6 have **no confirmed Singapore-specific numeric threshold** from any primary
  source in this research pass (MOM, MOH, WSHC, SNB, HSEU). Do not hardcode a specific hour count
  (e.g. "11 hours between shifts" or "max 3 nights") into the warning copy or logic without
  flagging it as a product decision, not a cited Singapore standard - those numbers, if adopted,
  should be sourced from international practice (e.g. NHS/other jurisdictions) explicitly labeled
  as such, not implied to be an SG rule.
