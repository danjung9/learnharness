# Adaptive teaching

Approved 2026-10-30. This supersedes the fixed predict → teach → check
teaching rhythm and the session-wide teaching question-format switch.
Probing still follows `agent.tools.explain` (false/absent = multiple choice;
true = free response). Teaching always has both `quiz` and `explain`.

## Question contract

Each new teaching question carries `nodeId`, `type`, `arrival`, and `solution`.

- `type`: `predict` anticipates an idea; `attempt` supports learner-generated
  work; `check` examines understanding or application. There is no required order.
- `arrival`: `open` appears immediately; `after_reading` waits behind
  “Check your understanding”.
- `solution`: `deferred` withholds the answer key, verdict styling and
  explanation after submission; `on_submit` retains immediate disclosure.
- Predictions and attempts require open arrival and deferred solutions.

The reference answer is committed in the original question. Multiple-choice
grading remains deterministic. Free responses are assessed by the teacher
against substantive requirements, accepting equivalent valid approaches.

## Retry and disclosure

`retry_question({questionToolCallId})` references the latest answered attempt
in a chain. The question, options, commitment and node come from the saved
original call. A new occurrence opens immediately, defers its solution and
ends the turn. Each answer remains a separate record. The model-facing retry
result identifies assisted performance and includes the original reference
answer/reasoning, including after context compaction.

`reveal_solution({questionToolCallId})` reveals an answered question's original
commitment across its retry chain. A successful saved result is the authority;
calling the tool alone or returning an error does not reveal anything. The
tool does not end the turn. Repeated reveals are idempotent.

The learner's **Show solution** control sends
`{type: "request_solution", toolCallId}`. A pending question receives a
solution-request result without a fabricated incorrect answer, followed by
a durable reveal marker in the same write-ahead save. The teacher receives
the request in context. Requesting a solution is not mastery evidence.

References resolve within the current chat; unresolved or ambiguous ids,
failed calls and dismissed sources are rejected. Retries additionally reject
revealed sources, unanswered sources, stale attempts and missing plan nodes.
Saved history is not rewritten. Existing question calls retain their recorded
disclosure behavior. Rendering derives disclosure from saved results/markers,
so reload cannot reveal a deferred solution accidentally.

## Instructional verification

The automated tests cover tool availability, contract validation, native
turn termination/persistence, retry chains, learner requests and rendered
disclosure. `chat-flow.test.ts` also runs a scripted engine through attempt →
hint → retry → reveal → fresh free response → learner-requested solution.
Scripted tests establish the harness mechanics; they do not establish that
a particular live model makes good instructional decisions.

Use these cases when evaluating a configured teaching model:

| Learner evidence | Expected teaching behavior |
| --- | --- |
| Sound independent reasoning | Avoid redundant explanation; advance or vary the task |
| Correct selection with confused reasoning | Seek justification or a fresh application |
| Novice overwhelmed by a procedure | Work an example, then fade guidance |
| Local misconception | Target the gap; offer a hint and an immutable retry |
| Repeated failure despite hints | Explain directly rather than prolong struggle |
| Successful hinted retry | Use a fresh task before claiming independence |
| Familiar calculation succeeds, changed assumptions fail | Repair conceptual transfer rather than marking the node mastered |

Inspect the composed prompt as well as source files. Enabled user overrides
can replace these instructions; preserve user-authored overrides and audit
them before attributing a live model's behavior to the shipped defaults.
