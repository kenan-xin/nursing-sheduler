# Product roadmap

This file lists planned product work that is not yet scheduled. Each item states the goal, the approach, and what must happen before work starts. Work that is scheduled lives in beads (`bd`).

## Import approved leave and off days from SAP SuccessFactors

Status: idea, raised 2026-09-26. Not scheduled.

Goal: the nurse manager imports each staff member's approved leave and off days from SAP SuccessFactors, instead of typing them into the Requests screen.

Source data: SuccessFactors Employee Central Time Off keeps time off in the OData v2 entity `EmployeeTime`. A query filters on `userId`, `approvalStatus eq 'APPROVED'`, `timeType` and a date range. Each record carries `startDate`, `endDate` and `timeType`. See the [EmployeeTime API reference](https://help.sap.com/docs/successfactors-platform/sap-successfactors-api-reference-guide-odata-v2/employeetime).

Mapping: each SuccessFactors `timeType` maps to LEAVE or OFF in the scenario. Each SuccessFactors `userId` maps to a staff member.

Phases:

1. CSV import. The hospital's SAP team schedules an Integration Center export of approved `EmployeeTime` records for the ward and the period. The Requests CSV import loads it, with the `timeType` and `userId` mapping. No new backend is needed.
2. Live import. An "Import from SuccessFactors" action calls the OData API through our backend. This needs a backend service that holds a read-only technical user with OAuth access, user authentication in the app, and approval from the hospital network team. The technical user must not have admin access to the MDF OData API, because admin writes bypass workflows ([SAP KBA 3288045](https://userapps.support.sap.com/sap/support/knowledge/en/3288045)).

Before work starts:

- Confirm that the hospital runs SAP SuccessFactors Employee Central Time Off.
- Get a sample export and the list of `timeType` values from the SAP team.
- Agree how SuccessFactors user ids match staff in the scenario.
