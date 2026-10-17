/** A real ai-propose response body without the LLM: the backend's own
 *  simulation and signing (`live.matrix.simulate_groups` / `simulate_hints`
 *  / `sign_proposal`) run on a fixed parsed reply via `manage.py shell` in
 *  the dev stack's backend container. The spec route-mocks `/ai-propose`
 *  with it, so ai-apply / ai-undo then run for real against the backend.
 *  Test-side only — no test endpoint in the app. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export interface ParsedGroup {
  cards: number[];
  title: string;
  description?: string;
  reason?: string;
}
export interface ParsedHint {
  cards: number[];
  reason?: string;
}

const SCRIPT = `
import json, sys
from live import matrix
from live.models import Run
from rooms.models import Question
data = json.loads(sys.stdin.read())
run = Run.objects.get(pk=data["run"])
question = Question.objects.get(pk=data["question"])
groups = [dict(g, index=i) for i, g in enumerate(data["groups"])]
hints = [dict(h, index=i) for i, h in enumerate(data["hints"])]
previews = matrix.simulate_groups(run, question, groups)
hint_previews = matrix.simulate_hints(run, question, hints)
skipped = sum(1 for g in previews if g["status"] != "ok")
print("@@" + json.dumps({
    "groups": previews,
    "hints": hint_previews,
    "dropped": skipped + len(hints) - len(hint_previews),
    "proposal": matrix.sign_proposal(run, question, matrix.with_tops(groups, previews), hints, 0),
}))
`;

export function signedProposal(
  runId: number,
  questionId: number,
  groups: ParsedGroup[],
  hints: ParsedHint[] = [],
): Record<string, unknown> {
  const out = execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'backend', 'python', 'manage.py', 'shell', '-c', SCRIPT],
    {
      cwd: REPO,
      input: JSON.stringify({
        run: runId,
        question: questionId,
        groups: groups.map((g) => ({ description: '', reason: '', ...g })),
        hints: hints.map((h) => ({ reason: '', ...h })),
      }),
      encoding: 'utf8',
    },
  );
  const line = out.split('\n').find((l) => l.startsWith('@@'));
  if (!line) throw new Error(`No proposal from the backend: ${out}`);
  return JSON.parse(line.slice(2));
}
