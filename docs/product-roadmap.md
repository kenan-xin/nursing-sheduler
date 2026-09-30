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

## Run the solver on AWS Lambda

Status: idea, raised 2026-09-30. Not scheduled.

Goal: pay for solver CPU only while a solve runs, and give each solve more cores than the shared 2-core server has. With 2 workers, CP-SAT runs only one full search strategy. With 4 workers, it proves the October ward optimal in about 0.4 s. The 87-person ward needs about 8.

Cost: Lambda gives up to 6 vCPU at 10 GB of memory and bills by the millisecond. A 15 s solve at 10 GB costs about $0.0025, from a remembered price of about $0.0000167 per GB-second (about 20% less on ARM). The Singapore price is not confirmed. For comparison, a 4-core EC2 instance in Singapore costs about $78 to $150 a month (`t4g.xlarge` on a 1-year plan to `m7g.xlarge` on-demand).

Approach: keep the web app, the API and the Redis queue on the current server. The worker calls a Lambda function instead of a local child process (`core/nurse_scheduling/server/jobs/process_executor.py`). The solver ships as a Lambda container image. OR-Tools is about 130 MB, well under the 10 GB image limit.

Effort:

1. Basic move, about 2 to 4 days. The worker waits for the Lambda result. Live progress, better-roster updates, "finish now" and cancel are lost.
2. Full parity, about 1 to 2 weeks. Lambda publishes events back, and the worker forwards "finish now" and cancel. This needs a secure channel from Lambda to the event store. Do not open Redis to the internet without authentication and a security review.

Before work starts:

- Run a 1-day spike: package the core as a Lambda container, solve October and the 87-person ward, and measure cold start, solve time and cost.
- Confirm that OR-Tools 9.15 gives the same results on ARM (Graviton).
- Set up an AWS account, IAM roles and a deploy pipeline next to Coolify.
- Agree the security design for the event channel.
