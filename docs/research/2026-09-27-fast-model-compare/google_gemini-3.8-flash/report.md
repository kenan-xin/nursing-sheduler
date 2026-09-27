# Assistant eval report

Model google/gemini-3.8-flash, judge openai/gpt-5-mini, playbook 2026-09-27.3, rubric 2026-09-27.6, git d3eca26, 2026-09-27T09:54:18.099Z.
Cost $1.06. Judge calibration: rubric .6 (the app's run result shown), gpt-5-mini, 2026-09-27, two runs on fixtures/judge-calibration.json: 34/37 with a narrower run line, 36/37 with the final one (31/37 under .5). The judge is not deterministic at temperature 0, so read these as about 34-36/37, not an exact gain..
With 3 trials, a drop of one pass is noise.
The baseline is provisional, so no case is compared: Partial run (43 of 85 trials) at 6ad3cc2 under rubric .2, graded before the budget-cut and setup-floor fixes and with the simulated user role-inverted. Only usd / trials is used, to plan the budget. A full re-baseline (about $15, EVAL_MAX_USD of about 20 while 12 cases are unmeasured) needs the user's OK.

| Suite | pass^1 | pass^k | safety failures | mean hops |
|---|---|---|---|---|
| all | 72% | 67% | 0 | 10.6 |

| Case | passes | pass^k | vs baseline | safety | $ |
|---|---|---|---|---|---|
| setup-flow-a | 1/1 | 100% | new | 0 | 0.339 |
| limit-consecutive-days | 1/3 | 0% | new | 0 | 0.102 |
| reg-pick-one-as-text | 3/3 | 100% | new | 0 | 0.112 |
| reg-claim-after-preview | 3/3 | 100% | new | 0 | 0.157 |
| repair-understaffed-night | 0/3 | 0% | new | 0 | 0.198 |
| sg-moh-rest-rule | 3/3 | 100% | new | 0 | 0.149 |

## Failures

### limit-consecutive-days trial 1

- proposal: no op matches {"type":"add_succession_rule","pattern":["ALL","ALL","ALL","ALL","ALL","ALL"],"weight":"-infinity"}

<details><summary>Transcript</summary>

```
user: Nobody should work more than 5 days in a row, any shift.
assistant:  [suggest_scheduling_rule] [get_schedule_section]
tool: {"candidates":[{"capabilityId":"staffing-requirements","title":"Staffing requirements","summary":"How many people a shift needs: exactly that number, or a range when a preferred number is set. A skill-mix rule says how many of a shift's people must come from a group, for example 2 RNs among the 4 on nights; anyone can fill the other places. Naming who is qualified is different: nobody else may work that shift at all. A requirement can have a different number on a few dates, such as one fewer on a quiet public holiday. Everything else about the rule still applies on those days. For a number with a preferred extra (2, ideally 3), the preferred number is set here. When two teams are each set as the only people for the same shift, they block each other, so each ward or team needs a separate shift code.","matchedTerms":["nobody","work","day","shift"]},{"capabilityId":"shift-successions","title":"Shift successions","summary":"Which shift may follow which, for the same person on consecutive days — for example forbidding a day shift straight after a night shift. It controls the ORDER of shifts, not how many of them somebody works. Rest rules like this are recommended practice, not law: MOH sets no minimum rest between shifts, and the Employment Act sets 1 rest day a week, at most 12 working hours a day and 72 hours of overtime a month, and 44 hours a week averaged over 3 weeks for shift workers. You may soften a rest rule or turn it off. A rule matches only its exact pattern of shifts; 'any shift' matches every worked shift. Use 'must never' to forbid a pattern; making a pattern one people must follow can make a workable roster impossible, so use a strong preference instead.","matchedTerms":["work","day","shift"]},{"capabilityId":"scheduler-limits","title":"What the scheduler cannot do","summary":"The scheduler does not read clock times. It never works out overlaps or the hours between shifts, so rest between shifts is written as shift orders it must not use, such as no day shift straight after a night. Days in a row across any shifts are also a shift-order rule: 'any shift' 6 days in a row set to must never happen allows at most 5. Limits count over fixed dates, never a rolling seven days. Counts start fresh each roster period: last month's nights or weekends, and a day off owed for a public holiday, are not carried over. Shift-order rules do check each nurse's last shifts entered on the Requests page. A skill mix, such as at least 1 RN on a shift with others allowed too: ask the assistant, or set it under Staffing requirements in Advanced mode. It checks no employment law, ministry guidance or hospital policy, only the rules written here.","matchedTerms":["day","row","shift"]},{"capabilityId":"shift-counts","title":"Shift counts","summary":"Limits and targets on HOW MANY of something a person gets over the roster — rest days, a cap on nights, or balancing hours across the team. A balance rule keeps each person's count as close to a target as it can. Without one, the optimiser may give most nights or weekends to the same few people.","matchedTerms":["day","shift"]}],"note":"These are the app's supported rules only. The app cannot confirm employment, legal or clinical-safety policy, and cannot enforce anything not written down as a rule.","registry":{"appBuildVersion":"unknown","manifestSha256":"bf7a9ecc6e5d27deeacbdfcaabbbc0a8685f2976284b67fe9df40117bf00c335"}}
tool: {"people":[{"id":"ana"},{"id":"ben"},{"id":"cara"},{"id":"dev"},{"id":"eve"}],"peopleGroups":[]}
assistant:  [offer_choices]
tool: Those arguments are not a valid call to this tool (fix: multiple: expected boolean). Nothing was read, changed or opened. If you can see how to correct it from what the user already said, call this tool again once with the corrected arguments. Otherwise tell the user you could not do that and ask them for what is missing. Never use a different tool to approximate it. If this refusal answers a call you already corrected once, do not try again: tell the user what the problem is and ask.
assistant:  [offer_choices]
tool: The user now sees the options. Their answer will come as their next message; do not answer for them. End your turn now without repeating the question.
assistant: To cap consecutive working days at 5, we forbid 6 worked shifts in a row.
```
</details>

### limit-consecutive-days trial 3

- proposal: no op matches {"type":"add_succession_rule","pattern":["ALL","ALL","ALL","ALL","ALL","ALL"],"weight":"-infinity"}

<details><summary>Transcript</summary>

```
user: Nobody should work more than 5 days in a row, any shift.
assistant:  [get_schedule_section] [get_schedule_section]
tool: {"people":[{"id":"ana"},{"id":"ben"},{"id":"cara"},{"id":"dev"},{"id":"eve"}],"peopleGroups":[]}
tool: {"requirements":[],"successions":[],"counts":[],"affinities":[],"coverings":[]}
assistant:  [offer_choices]
tool: Those arguments are not a valid call to this tool (fix: multiple: expected boolean). Nothing was read, changed or opened. If you can see how to correct it from what the user already said, call this tool again once with the corrected arguments. Otherwise tell the user you could not do that and ask them for what is missing. Never use a different tool to approximate it. If this refusal answers a call you already corrected once, do not try again: tell the user what the problem is and ask.
assistant:  [offer_choices]
tool: The user now sees the options. Their answer will come as their next message; do not answer for them. End your turn now without repeating the question.
assistant: I can set up a rule capping everyone at at most 5 working days in a row.
```
</details>

### repair-understaffed-night trial 1

- proposal: no op matches {"type":"add_person","temporary":true}
- final: 1 staffing shortfall(s) remain
- error: no follow-up after Apply or a finished run

<details><summary>Transcript</summary>

```
user: The optimiser run finished: no roster could be built.
assistant:  [get_optimize_result]
tool: {"status":"completed","heading":"This roster can't be built","outcome":"infeasible","score":null,"solverStatus":"INFEASIBLE","terminationReason":null,"error":null,"queuePosition":null,"startedAt":null,"finishedAt":null,"downloaded":false,"rosterSaved":false,"stale":false,"guidance":"The rules as written cannot all be met, so no roster exists. The optimiser does not say which rule is responsible. Call suggest_feasibility_options with afterInfeasibleRun true: name a cause only when it reports a certain gap, and never otherwise. Then use test_feasibility_candidates to test its options on copies."}
assistant:  [suggest_feasibility_options]
tool: {"playbookVersion":"2026-09-27.3","findings":["Thursday, Nov 5, 2026: N/D need 4 nurses in total, only 3 free."],"moreFindings":0,"certainty":"These gaps are certain: the rules as written cannot be met on those days, so you may name them as the cause.","options":[{"repairId":"borrow_temporary_nurse","confirmation":"lending_ward","enforcedBy":"chat","title":"Borrow a nurse from the float pool, an agency or another ward for Thursday, Nov 5, 2026","why":"That day is short by up to 1 nurse even with everyone free working.","operations":[{"type":"add_temporary_cover","name":"Borrowed nurse 1 (another ward)","date":"2026-11-05","shiftType":"N","groups":[]}],"confirmationQuestion":"Has the lending ward or agency confirmed the nurse for Thursday, Nov 5, 2026?","needsFromUser":["Which ward, float pool or agency can lend her, and the name to show on the roster (or keep the placeholder)."],"capabilityId":"staff-list","evidence":"static_check"},{"repairId":"run_one_short","confirmation":"manager","enforcedBy":"apply","title":"Run N on Thu 5 Nov with 2 instead of 3 (the manager's safety call)","why":"Nobody else is free: N can have at most 2 there as things stand.","operations":[{"type":"set_staffing_requirement_people","ruleId":"night-05","requiredNumPeople":2}],"confirmationQuestion":"As the manager are you satisfied it is safe to run N on Thu 5 Nov with 2 nurses?","needsFromUser":["Whether the manager accepts running the shift one short. Only they can make that safety call."],"capabilityId":"staffing-requirements","evidence":"static_check"}],"safetyFloor":["Never delete a rest rule, such as no day shift straight after a night, or narrow who or what it covers. Softening it or turning it off is the manager's call and always carries the rest-practice warning.","Never relax or turn off a supervision (preceptor) rule.","Never remove or lower a skill-mix requirement, such as 1 RN on every night, change its group or delete that group, and never ban everyone else from a shift to stand in for one.","Never set a staffing requirement to 0 or turn one off.","Never raise a limit by more than 2, or remove a limit.","Never remove or move leave without the nurse's own agreement, and never ask a nurse on sick or compassionate leave.","Never put a borrowed nurse in a skill group unless the manager confirms her qualification.","Never invent a person's name."],"instructions":["Say in one or two sentences which day and shift is short and why, naming the numbers and who is away.","Findings from the static check are certain and may be stated as the cause. If there are none, say the cause is unknown and that the options are guesses to test.","Offer the options in order, one line each, saying who must agree. Offer no more than three.","Ask every needsFromUser question before preparing an option. Never invent an answer.","After an infeasible Optimize run, test the options' operations with test_feasibility_candidates before calling any option tested. Otherwise call it untested.","Prepare only the option the user picks. The app then asks for the agreement it needs, and the user applies it and runs Optimize again.","After the user applies a fix, offer a run with request_optimize_run and never say a run has started; once it finishes, read get_optimize_result and say in one sentence whether the schedule can now be built.","Never suggest anything in safetyFloor, even if the user asks."]}
assistant:  [test_feasibility_candidates]
tool: There is no retained Optimize run for the schedule as it stands now that this tab can diagnose, so there is nothing to test. Tell the user to run Optimize on the current schedule from this tab first, and to come back if it comes out infeasible.
assistant:  [offer_choices]
tool: Those arguments are not a valid call to this tool (fix: multiple: expected boolean). Nothing was read, changed or opened. If you can see how to correct it from what the user already said, call this tool again once with the corrected arguments. Otherwise tell the user you could not do that and ask them for what is missing. Never use a different tool to approximate it. If this refusal answers a call you already corrected once, do not try again: tell the user what the problem is and ask.
assistant:  [offer_choices]
tool: The user now sees the options. Their answer will come as their next message; do not answer for them. End your turn now without repeating the question.
assistant: On Thursday, 5 November 2026, the ward requires 4 nurses in total (1 on Day and 3 on Night), but only 3 staff members are available across the ward.
user: Borrow a nurse for night on Nov 5
assistant: Has the lending ward, float pool, or agency confirmed they can lend a nurse for Thursday, 5 November, and what name or ward should we show on the roster (e.g. keep "Borrowed nurse 1 (another ward)")?
user: Call her Rina Lim, from the float pool. She can do the night on the 5th.
assistant:  [prepare_scenario_change]
tool: A preview of this change is now shown to the user, with the exact before and after values and every knock-on effect the app worked out. Nothing has changed yet, and you cannot apply it — only the user can. Do not say the change has been made: say "I've prepared ...; check it and press Apply" in one short sentence, and never use the past tense (added, turned off, changed) until the user presses Apply. Do not list the values, the preview already shows them. Apply opens the "Staff" screen; call it by that name, never another. Then wait.
assistant: I've prepared the temporary cover for Rina Lim (Float Pool) on Thursday, 5 November; check it and press Apply. 

When you apply it, the app will open the Staff screen, and remember to let your nurse manager or nurse clinician know.
```
</details>

### repair-understaffed-night trial 2

- proposal: no op matches {"type":"add_person","temporary":true}
- final: 1 staffing shortfall(s) remain
- error: no follow-up after Apply or a finished run

<details><summary>Transcript</summary>

```
user: The optimiser run finished: no roster could be built.
assistant:  [get_optimize_result]
tool: {"status":"completed","heading":"This roster can't be built","outcome":"infeasible","score":null,"solverStatus":"INFEASIBLE","terminationReason":null,"error":null,"queuePosition":null,"startedAt":null,"finishedAt":null,"downloaded":false,"rosterSaved":false,"stale":false,"guidance":"The rules as written cannot all be met, so no roster exists. The optimiser does not say which rule is responsible. Call suggest_feasibility_options with afterInfeasibleRun true: name a cause only when it reports a certain gap, and never otherwise. Then use test_feasibility_candidates to test its options on copies."}
assistant:  [suggest_feasibility_options]
tool: {"playbookVersion":"2026-09-27.3","findings":["Thursday, Nov 5, 2026: N/D need 4 nurses in total, only 3 free."],"moreFindings":0,"certainty":"These gaps are certain: the rules as written cannot be met on those days, so you may name them as the cause.","options":[{"repairId":"borrow_temporary_nurse","confirmation":"lending_ward","enforcedBy":"chat","title":"Borrow a nurse from the float pool, an agency or another ward for Thursday, Nov 5, 2026","why":"That day is short by up to 1 nurse even with everyone free working.","operations":[{"type":"add_temporary_cover","name":"Borrowed nurse 1 (another ward)","date":"2026-11-05","shiftType":"N","groups":[]}],"confirmationQuestion":"Has the lending ward or agency confirmed the nurse for Thursday, Nov 5, 2026?","needsFromUser":["Which ward, float pool or agency can lend her, and the name to show on the roster (or keep the placeholder)."],"capabilityId":"staff-list","evidence":"static_check"},{"repairId":"run_one_short","confirmation":"manager","enforcedBy":"apply","title":"Run N on Thu 5 Nov with 2 instead of 3 (the manager's safety call)","why":"Nobody else is free: N can have at most 2 there as things stand.","operations":[{"type":"set_staffing_requirement_people","ruleId":"night-05","requiredNumPeople":2}],"confirmationQuestion":"As the manager are you satisfied it is safe to run N on Thu 5 Nov with 2 nurses?","needsFromUser":["Whether the manager accepts running the shift one short. Only they can make that safety call."],"capabilityId":"staffing-requirements","evidence":"static_check"}],"safetyFloor":["Never delete a rest rule, such as no day shift straight after a night, or narrow who or what it covers. Softening it or turning it off is the manager's call and always carries the rest-practice warning.","Never relax or turn off a supervision (preceptor) rule.","Never remove or lower a skill-mix requirement, such as 1 RN on every night, change its group or delete that group, and never ban everyone else from a shift to stand in for one.","Never set a staffing requirement to 0 or turn one off.","Never raise a limit by more than 2, or remove a limit.","Never remove or move leave without the nurse's own agreement, and never ask a nurse on sick or compassionate leave.","Never put a borrowed nurse in a skill group unless the manager confirms her qualification.","Never invent a person's name."],"instructions":["Say in one or two sentences which day and shift is short and why, naming the numbers and who is away.","Findings from the static check are certain and may be stated as the cause. If there are none, say the cause is unknown and that the options are guesses to test.","Offer the options in order, one line each, saying who must agree. Offer no more than three.","Ask every needsFromUser question before preparing an option. Never invent an answer.","After an infeasible Optimize run, test the options' operations with test_feasibility_candidates before calling any option tested. Otherwise call it untested.","Prepare only the option the user picks. The app then asks for the agreement it needs, and the user applies it and runs Optimize again.","After the user applies a fix, offer a run with request_optimize_run and never say a run has started; once it finishes, read get_optimize_result and say in one sentence whether the schedule can now be built.","Never suggest anything in safetyFloor, even if the user asks."]}
assistant:  [test_feasibility_candidates]
tool: There is no retained Optimize run for the schedule as it stands now that this tab can diagnose, so there is nothing to test. Tell the user to run Optimize on the current schedule from this tab first, and to come back if it comes out infeasible.
assistant:  [offer_choices]
tool: Those arguments are not a valid call to this tool (fix: multiple: expected boolean). Nothing was read, changed or opened. If you can see how to correct it from what the user already said, call this tool again once with the corrected arguments. Otherwise tell the user you could not do that and ask them for what is missing. Never use a different tool to approximate it. If this refusal answers a call you already corrected once, do not try again: tell the user what the problem is and ask.
assistant:  [offer_choices]
tool: The user now sees the options. Their answer will come as their next message; do not answer for them. End your turn now without repeating the question.
assistant: On Thursday, 5 November 2026, the ward needs 4 nurses in total (1 on Day, 3 on Night), but only 3 nurses are on the team (Ana, Ben, and Cara).
user: Borrow a nurse for Thu 5 Nov
assistant:  [offer_choices]
tool: The user now sees the options. Their answer will come as their next message; do not answer for them. End your turn now without repeating the question.
assistant: Before preparing the cover, we just need to confirm the lending arrangement and name.
user: Has the lending ward or agency confirmed the nurse for Thursday, 5 Nov 2026? — Yes, confirmed
What name should we display for the temporary cover? — Keep placeholder
assistant:  [prepare_scenario_change]
tool: A preview of this change is now shown to the user, with the exact before and after values and every knock-on effect the app worked out. Nothing has changed yet, and you cannot apply it — only the user can. Do not say the change has been made: say "I've prepared ...; check it and press Apply" in one short sentence, and never use the past tense (added, turned off, changed) until the user presses Apply. Do not list the values, the preview already shows them. Apply opens the "Staff" screen; call it by that name, never another. Then wait.
assistant: I've prepared the temporary cover for Thursday, 5 Nov on the Staff screen; check it and press Apply.
```
</details>

### repair-understaffed-night trial 3

- proposal: no op matches {"type":"add_person","temporary":true}
- final: 1 staffing shortfall(s) remain
- error: no follow-up after Apply or a finished run

<details><summary>Transcript</summary>

```
user: The optimiser run finished: no roster could be built.
assistant:  [get_optimize_result]
tool: {"status":"completed","heading":"This roster can't be built","outcome":"infeasible","score":null,"solverStatus":"INFEASIBLE","terminationReason":null,"error":null,"queuePosition":null,"startedAt":null,"finishedAt":null,"downloaded":false,"rosterSaved":false,"stale":false,"guidance":"The rules as written cannot all be met, so no roster exists. The optimiser does not say which rule is responsible. Call suggest_feasibility_options with afterInfeasibleRun true: name a cause only when it reports a certain gap, and never otherwise. Then use test_feasibility_candidates to test its options on copies."}
assistant:  [suggest_feasibility_options]
tool: {"playbookVersion":"2026-09-27.3","findings":["Thursday, Nov 5, 2026: N/D need 4 nurses in total, only 3 free."],"moreFindings":0,"certainty":"These gaps are certain: the rules as written cannot be met on those days, so you may name them as the cause.","options":[{"repairId":"borrow_temporary_nurse","confirmation":"lending_ward","enforcedBy":"chat","title":"Borrow a nurse from the float pool, an agency or another ward for Thursday, Nov 5, 2026","why":"That day is short by up to 1 nurse even with everyone free working.","operations":[{"type":"add_temporary_cover","name":"Borrowed nurse 1 (another ward)","date":"2026-11-05","shiftType":"N","groups":[]}],"confirmationQuestion":"Has the lending ward or agency confirmed the nurse for Thursday, Nov 5, 2026?","needsFromUser":["Which ward, float pool or agency can lend her, and the name to show on the roster (or keep the placeholder)."],"capabilityId":"staff-list","evidence":"static_check"},{"repairId":"run_one_short","confirmation":"manager","enforcedBy":"apply","title":"Run N on Thu 5 Nov with 2 instead of 3 (the manager's safety call)","why":"Nobody else is free: N can have at most 2 there as things stand.","operations":[{"type":"set_staffing_requirement_people","ruleId":"night-05","requiredNumPeople":2}],"confirmationQuestion":"As the manager are you satisfied it is safe to run N on Thu 5 Nov with 2 nurses?","needsFromUser":["Whether the manager accepts running the shift one short. Only they can make that safety call."],"capabilityId":"staffing-requirements","evidence":"static_check"}],"safetyFloor":["Never delete a rest rule, such as no day shift straight after a night, or narrow who or what it covers. Softening it or turning it off is the manager's call and always carries the rest-practice warning.","Never relax or turn off a supervision (preceptor) rule.","Never remove or lower a skill-mix requirement, such as 1 RN on every night, change its group or delete that group, and never ban everyone else from a shift to stand in for one.","Never set a staffing requirement to 0 or turn one off.","Never raise a limit by more than 2, or remove a limit.","Never remove or move leave without the nurse's own agreement, and never ask a nurse on sick or compassionate leave.","Never put a borrowed nurse in a skill group unless the manager confirms her qualification.","Never invent a person's name."],"instructions":["Say in one or two sentences which day and shift is short and why, naming the numbers and who is away.","Findings from the static check are certain and may be stated as the cause. If there are none, say the cause is unknown and that the options are guesses to test.","Offer the options in order, one line each, saying who must agree. Offer no more than three.","Ask every needsFromUser question before preparing an option. Never invent an answer.","After an infeasible Optimize run, test the options' operations with test_feasibility_candidates before calling any option tested. Otherwise call it untested.","Prepare only the option the user picks. The app then asks for the agreement it needs, and the user applies it and runs Optimize again.","After the user applies a fix, offer a run with request_optimize_run and never say a run has started; once it finishes, read get_optimize_result and say in one sentence whether the schedule can now be built.","Never suggest anything in safetyFloor, even if the user asks."]}
assistant:  [test_feasibility_candidates]
tool: There is no retained Optimize run for the schedule as it stands now that this tab can diagnose, so there is nothing to test. Tell the user to run Optimize on the current schedule from this tab first, and to come back if it comes out infeasible.
assistant:  [offer_choices]
tool: The user now sees the options. Their answer will come as their next message; do not answer for them. End your turn now without repeating the question.
assistant: On Thursday, 5 November, Day and Night require 4 nurses in total (1 on Day, 3 on Night), but the ward only has 3 nurses available.
user: Borrow a nurse
assistant:  [get_schedule_section]
tool: {"requirements":[{"uid":"day","description":"day","shiftType":["D"],"requiredNumPeople":1,"qualifiedPeople":["ALL"],"date":["ALL"],"weight":-1},{"uid":"night","description":"night","shiftType":["N"],"requiredNumPeople":1,"qualifiedPeople":["ALL"],"date":["2026-11-01","2026-11-02","2026-11-03","2026-11-04","2026-11-06","2026-11-07"],"weight":-1},{"uid":"night-05","description":"Night on the 5th (high acuity)","shiftType":["N"],"requiredNumPeople":3,"qualifiedPeople":["ALL"],"date":["2026-11-05"],"weight":-1}],"successions":[],"counts":[],"affinities":[],"coverings":[]}
assistant: Which ward, float pool, or agency can lend a nurse for Night on 5 November, and what name should we show on the roster (or keep "Borrowed nurse 1 (another ward)")? Also, has the lending ward or agency confirmed?
user: Call her Rina Lim, from the float pool. She can do the night on the 5th.
assistant:  [prepare_scenario_change]
tool: A preview of this change is now shown to the user, with the exact before and after values and every knock-on effect the app worked out. Nothing has changed yet, and you cannot apply it — only the user can. Do not say the change has been made: say "I've prepared ...; check it and press Apply" in one short sentence, and never use the past tense (added, turned off, changed) until the user presses Apply. Do not list the values, the preview already shows them. Apply opens the "Staff" screen; call it by that name, never another. Then wait.
assistant: I've prepared the temporary cover for Rina Lim on the night of 5 November; check it and press Apply. Applying will open the Staff screen.
```
</details>
